/**
 * VidKing stream resolver (Node port of the player client).
 *
 * Flow (from VideoPlayer-*.js on www.vidking.net):
 *   1. GET api.speedracelight.com/seed?mediaId=<tmdb>  → { seed, ttlMs }
 *   2. Resolve title/year/imdb (framework media or db.speedracelight.com)
 *   3. For each server (Hydrogen/Titanium/Oxygen/Lithium/Helium):
 *        GET api.speedracelight.com/<endpoint>?title&mediaType&year&…&enc=2&seed
 *        → base64url ciphertext → decrypt(seed, tmdbId) → { sources, subtitles }
 *   4. On HTTP 401, invalidate seed cache and retry once.
 *
 * Returns real CDN URLs (.m3u8 / .mpd / progressive). No ads — we never touch
 * the iframe embed path.
 */
import { scrapeFetch } from '../../utils/scrapeFetch.js';
import { decryptVidkingPayload } from './vidkingCrypto.js';
import type {
    VidkingApiSource,
    VidkingApiSubtitle,
    VidkingDecryptedPayload,
    VidkingMedia,
    VidkingResolveOptions,
    VidkingResolveResult,
    VidkingResolvedSource,
    VidkingServerDef,
    VidkingServerName
} from './vidking.types.js';

const API_BASE = 'https://api.speedracelight.com';
const TMDB_PROXY = 'https://db.speedracelight.com/3';
const PAGE_ORIGIN = 'https://www.vidking.net';

/**
 * Server map. Order = preference (tried in parallel, but listed best-first
 * for diagnostics / ranking).
 *
 * Production observations (2026-07, EC2 + browser):
 *   - Oxygen HLS (`nodash` / ironwallnet + interkh) — real multi-audio streams
 *   - Hydrogen HLS — sometimes real (lookcrew*.site .ts), sometimes anti-bot
 *     decoy playlists (bew.jpg / bex.html / bey.js) that 200 but cannot play
 *   - DASH (Oxygen .mpd) — OMSS proxy only rewrites line-based HLS, not full
 *     MPD BaseURL/SegmentTemplate → drop DASH in mapSources
 *   - Titanium / Lithium: often HTTP 500; Helium: often 404
 */
export const VIDKING_SERVERS: readonly VidkingServerDef[] = [
    {
        name: 'Oxygen',
        endpoint: 'neon2/sources-with-title',
        isActive: true,
        timeoutMs: 30_000
    },
    {
        name: 'Hydrogen',
        endpoint: 'cdn/sources-with-title',
        isActive: true,
        timeoutMs: 30_000
    },
    {
        name: 'Titanium',
        endpoint: 'tejo/sources-with-title',
        isActive: true,
        timeoutMs: 8_000
    },
    {
        name: 'Lithium',
        endpoint: 'downloader2/sources-with-title',
        isActive: true,
        timeoutMs: 8_000
    },
    {
        name: 'Helium',
        endpoint: '1movies/sources-with-title',
        isActive: true,
        timeoutMs: 6_000
    }
] as const;

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: PAGE_ORIGIN,
    Referer: `${PAGE_ORIGIN}/`,
    'sec-ch-ua':
        '"Chromium";v="137", "Google Chrome";v="137", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site'
};

/** Headers for probing playlists / segments (Hydrogen 403s if Referer set). */
const STREAM_PROBE_HEADERS: Record<string, string> = {
    'User-Agent': BROWSER_HEADERS['User-Agent'],
    Accept: '*/*'
};

interface SeedCacheEntry {
    seed: string;
    expiresAt: number;
}

/** Per-origin|mediaId seed cache (mirrors the site's Map). */
const seedCache = new Map<string, SeedCacheEntry>();
/** Refresh seed this many ms before its reported TTL. */
const SEED_SKEW_MS = 5_000;

function seedCacheKey(mediaId: string): string {
    return `${API_BASE}|${mediaId}`;
}

function clearSeed(mediaId: string): void {
    seedCache.delete(seedCacheKey(mediaId));
}

async function fetchSeed(mediaId: string, timeoutMs: number): Promise<string> {
    const key = seedCacheKey(mediaId);
    const now = Date.now();
    const cached = seedCache.get(key);
    if (cached && cached.expiresAt - SEED_SKEW_MS > now) {
        return cached.seed;
    }

    // Option B: force egress proxy — API + CDNs block AWS IPs (403/410/429).
    const res = await scrapeFetch(
        `${API_BASE}/seed?mediaId=${encodeURIComponent(mediaId)}`,
        {
            headers: BROWSER_HEADERS,
            timeoutMs,
            viaProxy: true
        }
    );
    if (!res.ok) {
        throw new Error(`seed request failed: ${res.status}`);
    }
    const data = (await res.json()) as { seed?: string; ttlMs?: number };
    if (!data.seed) {
        throw new Error('seed response missing seed field');
    }
    seedCache.set(key, {
        seed: data.seed,
        expiresAt: now + (data.ttlMs ?? 30_000)
    });
    return data.seed;
}

interface Meta {
    title: string;
    year: string;
    imdbId: string;
}

async function resolveMeta(
    media: VidkingMedia,
    timeoutMs: number
): Promise<Meta> {
    // Prefer values already provided by the OMSS framework (TMDB-validated).
    if (media.title && media.year) {
        return {
            title: media.title,
            year: String(media.year).slice(0, 4),
            imdbId: media.imdbId ?? ''
        };
    }

    const pathType = media.type === 'tv' ? 'tv' : 'movie';
    const res = await scrapeFetch(
        `${TMDB_PROXY}/${pathType}/${media.tmdbId}?append_to_response=external_ids`,
        {
            headers: BROWSER_HEADERS,
            timeoutMs,
            viaProxy: true
        }
    );
    if (!res.ok) {
        throw new Error(`TMDB proxy failed: ${res.status}`);
    }
    const data = (await res.json()) as {
        title?: string;
        name?: string;
        release_date?: string;
        first_air_date?: string;
        external_ids?: { imdb_id?: string };
    };

    const title =
        media.type === 'movie' ? (data.title ?? '') : (data.name ?? '');
    const date =
        media.type === 'movie'
            ? (data.release_date ?? '')
            : (data.first_air_date ?? '');
    return {
        title: media.title || title,
        year: media.year || (date ? date.slice(0, 4) : ''),
        imdbId: media.imdbId || data.external_ids?.imdb_id || ''
    };
}

function buildSourceUrl(
    endpoint: string,
    meta: Meta,
    media: VidkingMedia,
    seed: string
): string {
    const url = new URL(`${API_BASE}/${endpoint}`);
    url.searchParams.set('title', meta.title);
    url.searchParams.set('mediaType', media.type);
    url.searchParams.set('year', meta.year);
    url.searchParams.set(
        'episodeId',
        media.type === 'tv' && media.episodeId != null
            ? String(media.episodeId)
            : '1'
    );
    url.searchParams.set(
        'seasonId',
        media.type === 'tv' && media.seasonId != null
            ? String(media.seasonId)
            : '1'
    );
    url.searchParams.set('tmdbId', media.tmdbId);
    url.searchParams.set('imdbId', meta.imdbId || '');
    url.searchParams.set('enc', '2');
    url.searchParams.set('seed', seed);
    url.searchParams.set('_t', String(Date.now()));
    return url.toString();
}

function inferType(source: VidkingApiSource): string {
    const declared = (source.type ?? '').toLowerCase();
    if (declared === 'hls' || declared === 'dash' || declared === 'mp4') {
        return declared;
    }
    const u = (source.url ?? '').toLowerCase();
    if (u.includes('.mpd') || u.includes('/dash/')) return 'dash';
    if (u.includes('.m3u8') || u.includes('playlist')) return 'hls';
    if (u.includes('.mp4')) return 'mp4';
    return 'hls';
}

function normalizeQuality(q: string | undefined): string {
    if (!q) return 'Auto';
    const cleaned = q.replace(/p$/i, '').trim();
    if (!cleaned || cleaned.toLowerCase() === 'auto') return 'Auto';
    return cleaned;
}

function mapSources(
    server: VidkingServerName,
    payload: VidkingDecryptedPayload
): VidkingResolvedSource[] {
    if (!payload.sources || !Array.isArray(payload.sources)) return [];
    const out: VidkingResolvedSource[] = [];
    for (const src of payload.sources) {
        if (!src?.url) continue;
        const type = inferType(src);
        // OMSS ProxyService rewrites line-based HLS only — not full DASH MPD
        // (BaseURL / SegmentTemplate). Returning DASH causes silent playback
        // failure after a 200 MPD (see pm2_core_logs: mpd 200, zero segments).
        if (
            type === 'dash' ||
            src.url.includes('.mpd') ||
            src.url.includes('/dash/')
        ) {
            continue;
        }
        out.push({
            server,
            url: src.url,
            quality: normalizeQuality(src.quality),
            type
        });
    }
    return out;
}

const MEDIA_EXT = /\.(?:ts|m4s|m4a|mp4|aac|cmfv|cmfa)(?:\?|$)/i;
const NESTED_M3U8 = /\.m3u8(?:\?|$)/i;
/** Hydrogen disguises real MPEG-TS as file000.html / file001.jpg under /r2/cdn. */
const DISGUISED_SEG =
    /\/r2\/cdn\d*\/.+\/file\d+\.(?:html?|jpg|jpeg|png|js)(?:\?|$)/i;
const TINY_DECOY_NAME = /\/(?:bew|bex|bey)\.(?:jpg|html?|js)(?:\?|$)/i;

/**
 * Collect playlist references (URI="..." attrs + non-comment body lines).
 */
function playlistRefs(text: string): string[] {
    const refs: string[] = [];
    for (const m of text.matchAll(/URI\s*=\s*["']([^"']+)["']/gi)) {
        refs.push(m[1]);
    }
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        refs.push(t);
    }
    return refs;
}

function absRef(baseUrl: string, rel: string): string {
    const t = rel.trim();
    if (t.startsWith('http://') || t.startsWith('https://')) return t;
    if (t.startsWith('//')) return `https:${t}`;
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}\//.test(t)) {
        return `https://${t}`;
    }
    return new URL(t, baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)).href;
}

/**
 * Structural check only — Hydrogen "disguised" segments look like .html.
 * Real playability is confirmed by probing the first segment body.
 */
function looksLikePlayableHls(text: string): boolean {
    if (!text.includes('#EXTM3U')) return false;
    const refs = playlistRefs(text);
    if (refs.length === 0) return false;

    const hasMedia = refs.some((r) => MEDIA_EXT.test(r));
    const hasNested = refs.some((r) => NESTED_M3U8.test(r));
    const hasDisguised = refs.some((r) => DISGUISED_SEG.test(r));
    // Tiny anti-bot stubs (bew.jpg / bex.html) without real media
    const onlyTinyDecoy =
        refs.length > 0 &&
        refs.every((r) => TINY_DECOY_NAME.test(r)) &&
        !hasMedia &&
        !hasNested &&
        !hasDisguised;
    if (onlyTinyDecoy) return false;

    return hasMedia || hasNested || hasDisguised || refs.length >= 1;
}

function isMpegTs(buf: Uint8Array): boolean {
    if (buf.length < 188) return false;
    let sync = 0;
    const limit = Math.min(buf.length, 188 * 10);
    for (let i = 0; i < limit; i += 188) {
        if (buf[i] === 0x47) sync++;
    }
    return sync >= 3;
}

/**
 * Probe playlist + first segment. Drops:
 *  - Oxygen interkh segments that return HTTP 410 (CDN gone)
 *  - Tiny decoy playlists
 * Keeps Hydrogen streams whose "file000.html" bodies are real MPEG-TS.
 */
async function filterPlayableSources(
    sources: VidkingResolvedSource[],
    diagnostics: string[],
    timeoutMs = 12_000
): Promise<VidkingResolvedSource[]> {
    if (sources.length === 0) return sources;

    const checked = await Promise.all(
        sources.map(async (src) => {
            try {
                if (
                    src.type === 'mp4' ||
                    (src.url.includes('.mp4') && !src.url.includes('m3u8'))
                ) {
                    const res = await scrapeFetch(src.url, {
                        method: 'HEAD',
                        headers: STREAM_PROBE_HEADERS,
                        timeoutMs,
                        viaProxy: true
                    });
                    if (res.ok || res.status === 405) return src;
                    diagnostics.push(
                        `${src.server}/${src.quality}: mp4 HEAD ${res.status}`
                    );
                    return null;
                }

                const res = await scrapeFetch(src.url, {
                    headers: STREAM_PROBE_HEADERS,
                    timeoutMs,
                    viaProxy: true
                });
                if (!res.ok) {
                    diagnostics.push(
                        `${src.server}/${src.quality}: playlist HTTP ${res.status}`
                    );
                    return null;
                }
                const text = await res.text();
                if (!looksLikePlayableHls(text)) {
                    diagnostics.push(
                        `${src.server}/${src.quality}: empty/decoy playlist (skipped)`
                    );
                    return null;
                }

                // Resolve first media line / nested playlist and probe body.
                const refs = playlistRefs(text);
                const firstRef =
                    refs.find(
                        (r) => MEDIA_EXT.test(r) || DISGUISED_SEG.test(r)
                    ) ??
                    refs.find((r) => NESTED_M3U8.test(r)) ??
                    refs[0];
                if (!firstRef) return null;

                const firstUrl = absRef(src.url, firstRef);
                const segRes = await scrapeFetch(firstUrl, {
                    headers: STREAM_PROBE_HEADERS,
                    timeoutMs,
                    viaProxy: true
                });

                // Nested master/quality m3u8: recurse one level for a real segment
                if (
                    segRes.ok &&
                    (NESTED_M3U8.test(firstUrl) ||
                        (segRes.headers.get('content-type') || '').includes(
                            'mpegurl'
                        ))
                ) {
                    const nested = await segRes.text();
                    if (!nested.includes('#EXTM3U')) {
                        diagnostics.push(
                            `${src.server}/${src.quality}: nested not HLS`
                        );
                        return null;
                    }
                    const nestedRefs = playlistRefs(nested);
                    const segRef =
                        nestedRefs.find(
                            (r) => MEDIA_EXT.test(r) || DISGUISED_SEG.test(r)
                        ) ?? nestedRefs[0];
                    if (!segRef) {
                        diagnostics.push(
                            `${src.server}/${src.quality}: nested empty`
                        );
                        return null;
                    }
                    const segUrl = absRef(firstUrl, segRef);
                    const bodyRes = await scrapeFetch(segUrl, {
                        headers: STREAM_PROBE_HEADERS,
                        timeoutMs,
                        viaProxy: true
                    });
                    if (!bodyRes.ok) {
                        diagnostics.push(
                            `${src.server}/${src.quality}: segment HTTP ${bodyRes.status}`
                        );
                        return null;
                    }
                    const buf = new Uint8Array(await bodyRes.arrayBuffer());
                    if (buf.length < 10_000 && !isMpegTs(buf)) {
                        diagnostics.push(
                            `${src.server}/${src.quality}: tiny non-TS segment (${buf.length}B)`
                        );
                        return null;
                    }
                    // Accept large bodies or MPEG-TS sync even with .html type
                    if (buf.length >= 50_000 || isMpegTs(buf)) return src;
                    diagnostics.push(
                        `${src.server}/${src.quality}: segment not media-like`
                    );
                    return null;
                }

                if (!segRes.ok) {
                    // Oxygen interkh currently answers 410 Gone for .ts from
                    // datacenter IPs (pm2_core_logs_v3). Do not surface those.
                    diagnostics.push(
                        `${src.server}/${src.quality}: segment HTTP ${segRes.status}`
                    );
                    return null;
                }

                const buf = new Uint8Array(await segRes.arrayBuffer());
                if (buf.length >= 50_000 || isMpegTs(buf)) return src;
                diagnostics.push(
                    `${src.server}/${src.quality}: segment too small/non-TS (${buf.length}B)`
                );
                return null;
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'probe failed';
                diagnostics.push(`${src.server}/${src.quality}: ${msg}`);
                return null;
            }
        })
    );

    return checked.filter((s): s is VidkingResolvedSource => s != null);
}

class SeedRejectedError extends Error {
    readonly status = 401;
    constructor() {
        super('seed rejected');
        this.name = 'SeedRejectedError';
    }
}

async function fetchServerOnce(
    server: VidkingServerDef,
    media: VidkingMedia,
    meta: Meta,
    seed: string,
    timeoutMs: number
): Promise<{
    sources: VidkingResolvedSource[];
    subtitles: VidkingApiSubtitle[];
}> {
    const url = buildSourceUrl(server.endpoint, meta, media, seed);
    const res = await scrapeFetch(url, {
        headers: {
            ...BROWSER_HEADERS,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0'
        },
        timeoutMs,
        viaProxy: true
    });

    if (res.status === 401) {
        throw new SeedRejectedError();
    }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    const cipher = await res.text();
    const json = decryptVidkingPayload(
        cipher,
        seed,
        parseInt(media.tmdbId, 10)
    );
    const payload = JSON.parse(json) as VidkingDecryptedPayload;
    return {
        sources: mapSources(server.name, payload),
        subtitles: Array.isArray(payload.subtitles) ? payload.subtitles : []
    };
}

async function fetchServer(
    server: VidkingServerDef,
    media: VidkingMedia,
    meta: Meta,
    timeoutMs: number
): Promise<{
    sources: VidkingResolvedSource[];
    subtitles: VidkingApiSubtitle[];
}> {
    const attempt = async () => {
        const seed = await fetchSeed(media.tmdbId, timeoutMs);
        return fetchServerOnce(server, media, meta, seed, timeoutMs);
    };

    try {
        return await attempt();
    } catch (err) {
        if (err instanceof SeedRejectedError) {
            clearSeed(media.tmdbId);
            return attempt();
        }
        throw err;
    }
}

/**
 * Bounded-concurrency pool (same idea as vidsrcClient).
 */
async function mapPool<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;

    async function run(): Promise<void> {
        while (next < items.length) {
            const idx = next++;
            results[idx] = await worker(items[idx]);
        }
    }

    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(Array.from({ length: n }, () => run()));
    return results;
}

/**
 * Resolve streams from all active VidKing servers.
 */
export async function resolveVidking(
    media: VidkingMedia,
    options: VidkingResolveOptions = {}
): Promise<VidkingResolveResult> {
    const concurrency = options.concurrency ?? 3;
    const defaultTimeoutMs = options.timeoutMs ?? 30_000;
    const diagnostics: string[] = [];

    if (!media.tmdbId) {
        throw new Error('tmdbId is required');
    }
    if (
        media.type === 'tv' &&
        (media.seasonId == null || media.episodeId == null)
    ) {
        throw new Error('seasonId and episodeId are required for TV');
    }

    const meta = await resolveMeta(media, defaultTimeoutMs);

    const allow = options.servers ? new Set(options.servers) : null;
    const servers = VIDKING_SERVERS.filter(
        (s) => s.isActive && (!allow || allow.has(s.name))
    );

    const settled = await mapPool(servers, concurrency, async (server) => {
        const timeoutMs = server.timeoutMs ?? defaultTimeoutMs;
        try {
            const result = await fetchServer(server, media, meta, timeoutMs);
            return { server: server.name, ok: true as const, ...result };
        } catch (err) {
            const message =
                err instanceof Error ? err.message : 'Unknown error';
            diagnostics.push(`${server.name}: ${message}`);
            return {
                server: server.name,
                ok: false as const,
                sources: [] as VidkingResolvedSource[],
                subtitles: [] as VidkingApiSubtitle[]
            };
        }
    });

    const rawSources: VidkingResolvedSource[] = [];
    const inlineSubtitles: VidkingApiSubtitle[] = [];
    const seenUrls = new Set<string>();
    const seenSubUrls = new Set<string>();

    for (const item of settled) {
        if (!item.ok) continue;
        for (const src of item.sources) {
            if (seenUrls.has(src.url)) continue;
            seenUrls.add(src.url);
            rawSources.push(src);
        }
        for (const sub of item.subtitles) {
            if (!sub?.url || seenSubUrls.has(sub.url)) continue;
            seenSubUrls.add(sub.url);
            inlineSubtitles.push(sub);
        }
    }

    // Drop anti-bot decoy Hydrogen playlists before they reach the player.
    const sources = await filterPlayableSources(rawSources, diagnostics);

    return {
        sources,
        inlineSubtitles,
        imdbId: meta.imdbId,
        diagnostics
    };
}

/**
 * Subtitle search used by the player itself (subs.videasy.to, keyed by IMDb).
 */
export async function fetchVidkingSubtitles(
    imdbId: string,
    season?: number,
    episode?: number,
    timeoutMs = 15_000
): Promise<VidkingApiSubtitle[]> {
    if (!imdbId) return [];
    let url = `https://subs.videasy.to/search?id=${encodeURIComponent(imdbId)}`;
    if (season != null && episode != null) {
        url += `&season=${season}&episode=${episode}`;
    }
    try {
        const res = await scrapeFetch(url, {
            headers: BROWSER_HEADERS,
            timeoutMs,
            viaProxy: true
        });
        if (!res.ok) return [];
        const data = (await res.json()) as VidkingApiSubtitle[];
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}
