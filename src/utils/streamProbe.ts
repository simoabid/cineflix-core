/**
 * Shared stream playability probe (VidKing pattern, generalized).
 *
 * Scrapes often return 200 with URLs that die on first segment (404/410/403)
 * from datacenter IPs. Probe playlist + first media ref via scrapeFetch so
 * providers never advertise unplayable sources.
 *
 * Does NOT retry rate-limits or defeat anti-bot — 429/403 simply fail the probe.
 */
import { scrapeFetch } from './scrapeFetch.js';
import {
    hasMalformedMediaToken,
    normalizeUpstreamMediaUrl
} from './streamUrl.js';

export type ProbeFailureReason =
    | 'malformed_token'
    | 'http_status'
    | 'fetch_failed'
    | 'empty_playlist'
    | 'decoy'
    | 'segment_http'
    | 'segment_not_media'
    | 'timeout';

export type ProbeableSource = {
    /** Raw upstream URL (not createProxyUrl-wrapped). */
    url: string;
    headers?: Record<string, string>;
    /** Label for diagnostics (server name / quality). */
    label?: string;
    type?: string;
};

export type ProbeResult<T extends ProbeableSource> =
    | { ok: true; source: T }
    | { ok: false; source: T; reason: ProbeFailureReason; detail: string };

export type FilterPlayableOptions = {
    /** Per-source timeout (ms). Default 8000. */
    timeoutMs?: number;
    /** Max sources to probe (rest dropped with diagnostic). Default 12. */
    maxSources?: number;
    /** scrapeFetch viaProxy. Default 'auto'. */
    viaProxy?: boolean | 'auto';
    /** Optional sink for human-readable diagnostics. */
    diagnostics?: string[];
};

const MEDIA_EXT = /\.(?:ts|m4s|m4a|mp4|aac|cmfv|cmfa)(?:\?|$)/i;
const NESTED_M3U8 = /\.m3u8(?:\?|$)/i;
const DISGUISED_SEG =
    /\/(?:r2\/cdn\d*\/.+\/file\d+|content\/[^/]+\/[^/]+\/page-\d+)\.(?:html?|jpe?g|png|js)(?:\?|$)/i;
const TINY_DECOY_NAME = /\/(?:bew|bex|bey)\.(?:jpg|html?|js)(?:\?|$)/i;

const DEFAULT_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    Accept: '*/*'
};

function playlistRefs(text: string): string[] {
    const refs: string[] = [];
    for (const m of text.matchAll(/URI\s*=\s*["']([^"']+)["']/gi)) {
        refs.push(m[1]!);
    }
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        refs.push(t);
    }
    return refs;
}

export function absRef(baseUrl: string, rel: string): string {
    const t = rel.trim();
    if (t.startsWith('http://') || t.startsWith('https://')) return t;
    if (t.startsWith('//')) return `https:${t}`;
    // host.tld/path without scheme (VidKing Oxygen style)
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}\//.test(t)) {
        return `https://${t}`;
    }
    const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
    return new URL(t, baseDir).href;
}

export function looksLikePlayableHls(text: string): boolean {
    if (!text.includes('#EXTM3U')) return false;
    const refs = playlistRefs(text);
    if (refs.length === 0) return false;

    const hasMedia = refs.some((r) => MEDIA_EXT.test(r));
    const hasNested = refs.some((r) => NESTED_M3U8.test(r));
    const hasDisguised = refs.some((r) => DISGUISED_SEG.test(r));
    const onlyTinyDecoy =
        refs.length > 0 &&
        refs.every((r) => TINY_DECOY_NAME.test(r)) &&
        !hasMedia &&
        !hasNested &&
        !hasDisguised;
    if (onlyTinyDecoy) return false;

    return hasMedia || hasNested || hasDisguised || refs.length >= 1;
}

export function isMpegTs(buf: Uint8Array): boolean {
    if (buf.length < 188) return false;
    let sync = 0;
    const limit = Math.min(buf.length, 188 * 10);
    for (let i = 0; i < limit; i += 188) {
        if (buf[i] === 0x47) sync++;
    }
    return sync >= 3;
}

function isLikelyMp4(url: string, type?: string): boolean {
    const t = (type ?? '').toLowerCase();
    if (t === 'mp4' || t.includes('mp4')) return true;
    const u = url.toLowerCase();
    return u.includes('.mp4') && !u.includes('m3u8');
}

/**
 * Probe a single raw stream URL for first-byte playability.
 */
export async function probeSource<T extends ProbeableSource>(
    source: T,
    opts: {
        timeoutMs?: number;
        viaProxy?: boolean | 'auto';
    } = {}
): Promise<ProbeResult<T>> {
    const timeoutMs = opts.timeoutMs ?? 8_000;
    const viaProxy = opts.viaProxy ?? 'auto';
    const label = source.label ?? source.url.slice(0, 60);

    // Reject corruption before normalize (normalize strips it for proxy path).
    if (hasMalformedMediaToken(source.url)) {
        return {
            ok: false,
            source,
            reason: 'malformed_token',
            detail: `${label}: malformed token query`
        };
    }

    const url = normalizeUpstreamMediaUrl(source.url);
    if (!url || !/^https?:\/\//i.test(url)) {
        return {
            ok: false,
            source,
            reason: 'malformed_token',
            detail: `${label}: invalid url`
        };
    }

    const headers = { ...DEFAULT_HEADERS, ...(source.headers ?? {}) };

    try {
        if (isLikelyMp4(url, source.type)) {
            const res = await scrapeFetch(url, {
                method: 'HEAD',
                headers,
                timeoutMs,
                viaProxy
            });
            if (res.ok || res.status === 405 || res.status === 206) {
                return { ok: true, source: { ...source, url } };
            }
            // Some CDNs reject HEAD — try tiny range GET
            const getRes = await scrapeFetch(url, {
                method: 'GET',
                headers: { ...headers, Range: 'bytes=0-1023' },
                timeoutMs,
                viaProxy
            });
            if (getRes.ok || getRes.status === 206) {
                return { ok: true, source: { ...source, url } };
            }
            return {
                ok: false,
                source,
                reason: 'http_status',
                detail: `${label}: mp4 HTTP ${getRes.status}`
            };
        }

        // HLS / unknown — fetch playlist
        const res = await scrapeFetch(url, {
            headers,
            timeoutMs,
            viaProxy
        });
        if (!res.ok) {
            return {
                ok: false,
                source,
                reason: 'http_status',
                detail: `${label}: playlist HTTP ${res.status}`
            };
        }

        const text = await res.text();
        if (!looksLikePlayableHls(text)) {
            // Non-HLS body: accept large binary-ish responses as progressive
            if (text.length >= 50_000) {
                return { ok: true, source: { ...source, url } };
            }
            return {
                ok: false,
                source,
                reason: 'empty_playlist',
                detail: `${label}: empty/decoy playlist`
            };
        }

        const refs = playlistRefs(text);
        const firstRef =
            refs.find((r) => MEDIA_EXT.test(r) || DISGUISED_SEG.test(r)) ??
            refs.find((r) => NESTED_M3U8.test(r)) ??
            refs[0];
        if (!firstRef) {
            return {
                ok: false,
                source,
                reason: 'empty_playlist',
                detail: `${label}: no media refs`
            };
        }

        let firstUrl = normalizeUpstreamMediaUrl(absRef(url, firstRef));
        if (hasMalformedMediaToken(firstUrl)) {
            return {
                ok: false,
                source,
                reason: 'malformed_token',
                detail: `${label}: malformed segment token`
            };
        }

        let segRes = await scrapeFetch(firstUrl, {
            headers,
            timeoutMs,
            viaProxy
        });

        // Nested quality playlist
        if (
            segRes.ok &&
            (NESTED_M3U8.test(firstUrl) ||
                (segRes.headers.get('content-type') || '').includes('mpegurl'))
        ) {
            const nested = await segRes.text();
            if (!nested.includes('#EXTM3U')) {
                return {
                    ok: false,
                    source,
                    reason: 'decoy',
                    detail: `${label}: nested not HLS`
                };
            }
            const nestedRefs = playlistRefs(nested);
            const segRef =
                nestedRefs.find(
                    (r) => MEDIA_EXT.test(r) || DISGUISED_SEG.test(r)
                ) ?? nestedRefs[0];
            if (!segRef) {
                return {
                    ok: false,
                    source,
                    reason: 'empty_playlist',
                    detail: `${label}: nested empty`
                };
            }
            firstUrl = normalizeUpstreamMediaUrl(absRef(firstUrl, segRef));
            if (hasMalformedMediaToken(firstUrl)) {
                return {
                    ok: false,
                    source,
                    reason: 'malformed_token',
                    detail: `${label}: malformed nested segment token`
                };
            }
            segRes = await scrapeFetch(firstUrl, {
                headers,
                timeoutMs,
                viaProxy
            });
        }

        if (!segRes.ok) {
            return {
                ok: false,
                source,
                reason: 'segment_http',
                detail: `${label}: segment HTTP ${segRes.status}`
            };
        }

        const buf = new Uint8Array(await segRes.arrayBuffer());
        if (buf.length >= 50_000 || isMpegTs(buf)) {
            return { ok: true, source: { ...source, url } };
        }
        // HTML disguise with modest size still OK if TS sync present
        if (buf.length >= 10_000 && isMpegTs(buf)) {
            return { ok: true, source: { ...source, url } };
        }
        return {
            ok: false,
            source,
            reason: 'segment_not_media',
            detail: `${label}: segment not media-like (${buf.length}B)`
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'probe failed';
        const reason: ProbeFailureReason = /abort|timeout/i.test(msg)
            ? 'timeout'
            : 'fetch_failed';
        return {
            ok: false,
            source,
            reason,
            detail: `${label}: ${msg}`
        };
    }
}

/**
 * Filter sources to those that pass first-segment playability.
 * Preserves order of survivors. Caps work with maxSources.
 */
export async function filterPlayableSources<T extends ProbeableSource>(
    sources: T[],
    opts: FilterPlayableOptions = {}
): Promise<T[]> {
    if (sources.length === 0) return sources;

    const timeoutMs = opts.timeoutMs ?? 8_000;
    const maxSources = opts.maxSources ?? 12;
    const viaProxy = opts.viaProxy ?? 'auto';
    const diagnostics = opts.diagnostics;

    const slice = sources.slice(0, maxSources);
    if (sources.length > maxSources && diagnostics) {
        diagnostics.push(
            `probe: skipped ${sources.length - maxSources} source(s) over maxSources=${maxSources}`
        );
    }

    const results = await Promise.all(
        slice.map((s) => probeSource(s, { timeoutMs, viaProxy }))
    );

    const kept: T[] = [];
    for (const r of results) {
        if (r.ok) {
            kept.push(r.source);
        } else if (diagnostics) {
            diagnostics.push(r.detail);
        }
    }
    return kept;
}
