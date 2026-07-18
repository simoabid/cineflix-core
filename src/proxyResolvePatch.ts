/**
 * Patches for @omss/framework ProxyService used by VidKing (and similar CDNs).
 *
 * 1) Host-without-scheme HLS URIs:
 *      URI="ijzeczcdbzbhe.interkh.com/path/index.m3u8?key=..."
 *    must become https://…  (but NOT bare `seg-1-v1.ts` filenames).
 *
 * 2) Hydrogen disguises real MPEG-TS segments as file000.html / file001.jpg
 *    under /r2/cdn* with Content-Type: text/html. Force video/mp2t so hls.js
 *    will demux them.
 *
 * 3) Option B scrape egress: when SCRAPE_PROXY_STREAM is on (default) and the
 *    upstream host is allowlisted / mode=all, fetch via residential PROXY_URL
 *    so AWS-hosted /v1/proxy can pull playlists & segments that 403/410 direct.
 */
import { ProxyService } from '@omss/framework';
import {
    isScrapeProxyStreamEnabled,
    scrapeFetch
} from './utils/scrapeFetch.js';

/**
 * host.tld/path... only — requires a slash after the host so that
 * `seg-1-v1.ts` / `playlist.m3u8` are NOT treated as hostnames.
 */
const HOST_THEN_PATH =
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+\/.+/;

/** Hydrogen disguised MPEG-TS segment filenames. */
const DISGUISED_TS =
    /\/r2\/cdn\d*\/.+\/file\d+\.(?:html?|jpe?g|png|js)(?:\?|$)/i;

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

/**
 * Prefer our MIME guess over upstream text/html for disguised TS segments.
 * Monkey-patch handleStreamingRequest / handleBufferedRequest via wrapping
 * is impractical (private). Instead patch at the Response path by overriding
 * shouldStream patterns' consumers — the framework uses:
 *   contentType = response.headers.get('content-type') ?? getMimeType(url)
 * so we also patch the instance method used after construction by wrapping
 * the module-level fetch is not available.
 *
 * Practical approach: patch ProxyService.prototype.handleStreamingRequest
 * if present.
 */
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
        // Keep HLS type even if upstream lies
        if (!/mpegurl|m3u8/i.test(contentType)) {
            return 'application/vnd.apple.mpegurl';
        }
    }
    return contentType;
}

if (typeof protoAny.handleStreamingRequest === 'function') {
    const orig = protoAny.handleStreamingRequest;
    protoAny.handleStreamingRequest = async function patchedStream(
        this: unknown,
        proxyData: { url: string; headers?: Record<string, string> }
    ) {
        const result = await orig.call(this, proxyData);
        return {
            ...result,
            contentType: forceVideoContentType(
                proxyData.url,
                result.contentType
            )
        };
    };
}

if (typeof protoAny.handleBufferedRequest === 'function') {
    const orig = protoAny.handleBufferedRequest;
    protoAny.handleBufferedRequest = async function patchedBuffered(
        this: unknown,
        proxyData: { url: string; headers?: Record<string, string> }
    ) {
        const result = await orig.call(this, proxyData);
        // OpenSubtitles (and similar) subtitle URLs have no .srt extension.
        // On 403 AWS blocks, OMSS treats text/html as a "manifest" and rewrites
        // the body into garbage /v1/proxy lines. Pass through raw error bodies
        // for non-OK responses so the client can fail cleanly.
        const status = result.statusCode ?? 200;
        if (status < 200 || status >= 300) {
            return {
                ...result,
                contentType: result.contentType || 'text/plain',
                // Ensure browser/CORS clients see the real failure status
                statusCode: status
            };
        }
        // Caption files via /v1/proxy: force text/plain; reject HTML challenges.
        // OpenSubtitles should not use this path (browser downloads raw CDN).
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
