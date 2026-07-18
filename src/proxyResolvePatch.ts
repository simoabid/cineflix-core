/**
 * Patches for @omss/framework ProxyService.
 *
 * 1) Host-without-scheme HLS URIs → https://…
 * 2) Hydrogen disguised MPEG-TS → video/mp2t
 * 3) Option B: allowlisted stream hosts via scrapeFetch PROXY_URL
 * 4) Range/seek fix for progressive MP4:
 *    - HTML5 <video> always sends Range
 *    - Hop-by-hop headers (Connection: keep-alive) from provider payloads
 *      can break upstream Range → 416 / hang spinner forever
 *    - Preserve 206 + Content-Range; fail hard on 4xx so player fail-forwards
 */
import { Readable } from 'node:stream';
import { ProxyService, OMSSError } from '@omss/framework';
import {
    isScrapeProxyStreamEnabled,
    scrapeFetch
} from './utils/scrapeFetch.js';

const HOST_THEN_PATH =
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+\/.+/;

const DISGUISED_TS =
    /\/r2\/cdn\d*\/.+\/file\d+\.(?:html?|jpe?g|png|js)(?:\?|$)/i;

/** Headers that must never be forwarded to upstream CDNs. */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
    'accept-encoding' // let runtime negotiate
]);

type ResolveUrlFn = (baseUrl: string, targetUrl: string) => string;
type GetMimeTypeFn = (url: string) => string;

const proto = ProxyService.prototype as unknown as {
    resolveUrl: ResolveUrlFn;
    getMimeType: GetMimeTypeFn;
};

const originalResolveUrl = proto.resolveUrl;
const originalGetMimeType = proto.getMimeType;

if (typeof originalResolveUrl === 'function') {
    proto.resolveUrl = function patchedResolveUrl(
        this: unknown,
        baseUrl: string,
        targetUrl: string
    ): string {
        const trimmed = targetUrl.trim();
        if (
            HOST_THEN_PATH.test(trimmed) &&
            !trimmed.startsWith('http://') &&
            !trimmed.startsWith('https://') &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('/')
        ) {
            return originalResolveUrl.call(this, baseUrl, `https://${trimmed}`);
        }
        return originalResolveUrl.call(this, baseUrl, targetUrl);
    };
}

if (typeof originalGetMimeType === 'function') {
    proto.getMimeType = function patchedGetMimeType(
        this: unknown,
        url: string
    ): string {
        if (DISGUISED_TS.test(url) || /\.ts(?:\?|$)/i.test(url)) {
            return 'video/mp2t';
        }
        if (/\.m3u8(?:\?|$)/i.test(url)) {
            return 'application/vnd.apple.mpegurl';
        }
        return originalGetMimeType.call(this, url);
    };
}

type HandleStreamingFn = (proxyData: {
    url: string;
    headers?: Record<string, string>;
}) => Promise<{
    stream: unknown;
    contentType: string;
    statusCode: number;
    headers: Record<string, string>;
}>;

type HandleBufferedFn = (proxyData: {
    url: string;
    headers?: Record<string, string>;
}) => Promise<{
    data: Buffer;
    contentType: string;
    statusCode: number;
    headers: Record<string, string>;
}>;

const protoAny = ProxyService.prototype as unknown as {
    handleStreamingRequest?: HandleStreamingFn;
    handleBufferedRequest?: HandleBufferedFn;
    fetchWithTimeout?: (
        url: string,
        init: RequestInit,
        timeoutMs?: number
    ) => Promise<Response>;
    getMimeType?: (url: string) => string;
};

// Option B: route allowlisted CDN fetches through scrape egress proxy.
if (typeof protoAny.fetchWithTimeout === 'function') {
    const origFetch = protoAny.fetchWithTimeout;
    protoAny.fetchWithTimeout = async function patchedFetchWithTimeout(
        this: unknown,
        url: string,
        init: RequestInit,
        timeoutMs = 30_000
    ): Promise<Response> {
        if (isScrapeProxyStreamEnabled()) {
            return scrapeFetch(url, {
                ...init,
                timeoutMs,
                viaProxy: 'auto'
            });
        }
        return origFetch.call(this, url, init, timeoutMs);
    };
}

function forceVideoContentType(url: string, contentType: string): string {
    if (DISGUISED_TS.test(url) || /\.ts(?:\?|$)/i.test(url)) {
        return 'video/mp2t';
    }
    if (/\.m3u8(?:\?|$)/i.test(url)) {
        if (!/mpegurl|m3u8/i.test(contentType)) {
            return 'application/vnd.apple.mpegurl';
        }
    }
    return contentType || 'application/octet-stream';
}

/**
 * Build clean upstream headers for media proxy.
 * Provider payloads often include Connection: keep-alive which breaks Range
 * on several CDNs (VidLink/vodvidl → 416, infinite player spinner).
 */
export function buildUpstreamMediaHeaders(
    raw: Record<string, string> | undefined,
    clientRange?: string
): Record<string, string> {
    const out: Record<string, string> = {};
    if (raw) {
        for (const [k, v] of Object.entries(raw)) {
            if (typeof v !== 'string') continue;
            const key = k.toLowerCase();
            if (HOP_BY_HOP.has(key)) continue;
            if (key === 'range') continue; // set once below
            out[k] = v;
        }
    }
    const range =
        clientRange ||
        raw?.['range'] ||
        raw?.['Range'] ||
        undefined;
    if (range) {
        out['Range'] = range;
    }
    return out;
}

function pickRange(
    headers: Record<string, string> | undefined
): string | undefined {
    if (!headers) return undefined;
    return headers['range'] || headers['Range'] || undefined;
}

/**
 * Replace handleStreamingRequest so Range seeks work for progressive MP4.
 */
if (typeof protoAny.handleStreamingRequest === 'function') {
    protoAny.handleStreamingRequest = async function patchedStream(
        this: {
            fetchWithTimeout: (
                url: string,
                init: RequestInit,
                timeoutMs?: number
            ) => Promise<Response>;
            getMimeType: (url: string) => string;
        },
        proxyData: { url: string; headers?: Record<string, string> }
    ) {
        const clientRange = pickRange(proxyData.headers);
        const headers = buildUpstreamMediaHeaders(
            proxyData.headers,
            clientRange
        );

        // Media segments can be large; allow longer than default scrape timeout.
        const response = await this.fetchWithTimeout(
            proxyData.url,
            { method: 'GET', headers },
            120_000
        );

        // 206 Partial Content is success for Range; 200 is OK for full GET.
        // 416 / other 4xx must fail so the player can try the next source.
        if (response.status === 416) {
            throw new OMSSError(
                'INTERNAL_ERROR',
                `Upstream returned 416 (Range Not Satisfiable) for ${proxyData.url.slice(0, 120)}`,
                416,
                { url: proxyData.url }
            );
        }
        if (response.status >= 400 && response.status !== 206) {
            throw new OMSSError(
                'INTERNAL_ERROR',
                `Upstream returned ${response.status}`,
                response.status >= 500 ? 502 : response.status,
                { url: proxyData.url }
            );
        }
        if (!response.body) {
            throw new OMSSError(
                'INTERNAL_ERROR',
                'Upstream returned empty body for streaming request',
                502,
                { url: proxyData.url }
            );
        }

        const nodeStream = Readable.fromWeb(
            response.body as import('stream/web').ReadableStream
        );
        const contentType = forceVideoContentType(
            proxyData.url,
            response.headers.get('content-type') ??
                this.getMimeType(proxyData.url)
        );

        const headersOut: Record<string, string> = {
            'Content-Disposition': 'inline; filename="stream"',
            'Cache-Control':
                response.headers.get('cache-control') ??
                'public, max-age=7200',
            'Access-Control-Expose-Headers':
                'Content-Disposition, Content-Length, Content-Range, Accept-Ranges, Last-Modified, ETag',
            'Accept-Ranges':
                response.headers.get('accept-ranges') ||
                response.headers.get('accept-range') ||
                'bytes'
        };

        const contentLength = response.headers.get('content-length');
        if (contentLength) headersOut['Content-Length'] = contentLength;

        const contentRange = response.headers.get('content-range');
        if (contentRange) headersOut['Content-Range'] = contentRange;

        const lastModified = response.headers.get('last-modified');
        if (lastModified) headersOut['Last-Modified'] = lastModified;

        const etag = response.headers.get('etag');
        if (etag) headersOut['ETag'] = etag;

        return {
            stream: nodeStream,
            contentType,
            statusCode: response.status, // preserve 206
            headers: headersOut
        };
    };
}

if (typeof protoAny.handleBufferedRequest === 'function') {
    const orig = protoAny.handleBufferedRequest;
    protoAny.handleBufferedRequest = async function patchedBuffered(
        this: unknown,
        proxyData: { url: string; headers?: Record<string, string> }
    ) {
        // Same hop-by-hop cleanup for playlists / small assets
        const cleaned = {
            ...proxyData,
            headers: buildUpstreamMediaHeaders(
                proxyData.headers,
                pickRange(proxyData.headers)
            )
        };
        const result = await orig.call(this, cleaned);
        const status = result.statusCode ?? 200;
        if (status < 200 || status >= 300) {
            return {
                ...result,
                contentType: result.contentType || 'text/plain',
                statusCode: status
            };
        }
        if (/\.(vtt|srt|ass|ssa)(\?|$)/i.test(proxyData.url)) {
            const body = result.data?.toString?.('utf-8') ?? '';
            if (
                /^\s*<(!DOCTYPE|html)/i.test(body) ||
                body.includes('Just a moment')
            ) {
                return {
                    data: Buffer.from(
                        'Upstream caption CDN blocked this request (HTML challenge).',
                        'utf-8'
                    ),
                    contentType: 'text/plain; charset=utf-8',
                    statusCode: 502,
                    headers: result.headers
                };
            }
            return {
                ...result,
                contentType: 'text/plain; charset=utf-8'
            };
        }
        return {
            ...result,
            contentType: forceVideoContentType(
                proxyData.url,
                result.contentType
            )
        };
    };
}
