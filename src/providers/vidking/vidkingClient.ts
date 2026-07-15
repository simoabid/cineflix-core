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
 * Server map + order as shipped in the player (`Ti` / `Es`).
 *
 * Production observations (2026-07):
 *   - Hydrogen + Oxygen: reliable (HLS / multi-quality)
 *   - Titanium / Lithium: often HTTP 500
 *   - Helium: often HTTP 404
 * Dead backends stay enabled with a short fail-fast timeout so recovery is
 * automatic if the upstream comes back, without blocking the good servers.
 */
export const VIDKING_SERVERS: readonly VidkingServerDef[] = [
    {
        name: 'Hydrogen',
        endpoint: 'cdn/sources-with-title',
        isActive: true,
        timeoutMs: 30_000
    },
    {
        name: 'Oxygen',
        endpoint: 'neon2/sources-with-title',
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

    const res = await fetch(
        `${API_BASE}/seed?mediaId=${encodeURIComponent(mediaId)}`,
        {
            headers: BROWSER_HEADERS,
            signal: AbortSignal.timeout(timeoutMs)
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
    const res = await fetch(
        `${TMDB_PROXY}/${pathType}/${media.tmdbId}?append_to_response=external_ids`,
        {
            headers: BROWSER_HEADERS,
            signal: AbortSignal.timeout(timeoutMs)
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
        out.push({
            server,
            url: src.url,
            quality: normalizeQuality(src.quality),
            type: inferType(src)
        });
    }
    return out;
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
    const res = await fetch(url, {
        headers: {
            ...BROWSER_HEADERS,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0'
        },
        signal: AbortSignal.timeout(timeoutMs)
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

    const sources: VidkingResolvedSource[] = [];
    const inlineSubtitles: VidkingApiSubtitle[] = [];
    const seenUrls = new Set<string>();
    const seenSubUrls = new Set<string>();

    for (const item of settled) {
        if (!item.ok) continue;
        for (const src of item.sources) {
            if (seenUrls.has(src.url)) continue;
            seenUrls.add(src.url);
            sources.push(src);
        }
        for (const sub of item.subtitles) {
            if (!sub?.url || seenSubUrls.has(sub.url)) continue;
            seenSubUrls.add(sub.url);
            inlineSubtitles.push(sub);
        }
    }

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
        const res = await fetch(url, {
            headers: BROWSER_HEADERS,
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) return [];
        const data = (await res.json()) as VidkingApiSubtitle[];
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}
