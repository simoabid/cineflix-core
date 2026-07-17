/**
 * m111moviesClient — Vidlove / 111movies resolver (2026-07 rewrite).
 *
 * 111movies.net now 302s to player.vidlove.cc. The SPA fans out to
 * momlover.notyourtype.dad servers with:
 *   1. POST {origin}/auth/generate-token  → x-request-token
 *   2. GET  {server}/movie|tv/...        + x-request-token + x-response-encryption: aes-gcm
 *   3. Decrypt { v: "gcm", payload } with RESPONSE_BASE_KEY
 *
 * Methodology: docs/SCRAPING-MASTERCLASS.md §2 (SPA recon → reproduce → decode).
 */
import type {
    M111ResolveResult,
    M111Server,
    M111StreamSource,
    M111Subtitle,
    MomloverDecrypted
} from './m111movies.types.js';
import { decryptVidloveBody } from './vidloveCrypto.js';

const PLAYER_ORIGIN = 'https://player.vidlove.cc';
const API_HOST = 'https://momlover.notyourtype.dad';
const WYZIE_API = 'https://sub.wyzie.ru/search';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: PLAYER_ORIGIN,
    Referer: `${PLAYER_ORIGIN}/`
};

/** Server list from vidlove SPA `allServers` (qe). */
const SERVERS: M111Server[] = [
    { name: 'Neta', path: 'moviebox' },
    { name: 'Gogo', path: 'cline' },
    { name: 'Mafia', path: 'self' },
    { name: 'Love', path: 'zebra' },
    { name: 'Fabric', path: 'fabric' }
];

type Media = {
    type: 'movie' | 'tv';
    tmdbId: string;
    season?: number;
    episode?: number;
};

type TokenCache = { token: string; expiresAt: number };
const tokenCache = new Map<string, TokenCache>();

function buildApiUrl(server: M111Server, media: Media): string {
    if (media.type === 'tv') {
        return `${API_HOST}/${server.path}/tv/${media.tmdbId}/${media.season}/${media.episode}`;
    }
    return `${API_HOST}/${server.path}/movie/${media.tmdbId}`;
}

async function mintRequestToken(origin: string = API_HOST): Promise<string> {
    const cached = tokenCache.get(origin);
    if (cached && cached.expiresAt > Date.now() + 1000) {
        return cached.token;
    }

    const res = await fetch(`${origin}/auth/generate-token`, {
        method: 'POST',
        headers: {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ clientData: {} }),
        signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
        throw new Error(`auth generate-token HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
        success?: boolean;
        token?: string;
        expiresMs?: number;
    };
    if (!data.token) {
        throw new Error('auth generate-token missing token');
    }
    const ttl = data.expiresMs ?? 25_000;
    tokenCache.set(origin, {
        token: data.token,
        expiresAt: Date.now() + Math.max(1000, ttl - 1000)
    });
    return data.token;
}

function pickStreamType(url: string, declared?: string): 'hls' | 'mp4' {
    if (declared === 'mp4' || url.includes('.mp4')) return 'mp4';
    if (declared === 'hls' || url.includes('.m3u8') || url.includes('m3u8')) {
        return 'hls';
    }
    return url.includes('mp4') ? 'mp4' : 'hls';
}

function extractHeaders(
    raw?: Record<string, string>
): Record<string, string> | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && v) out[k] = v;
    }
    // headers sometimes embedded as query on proxy URLs
    return Object.keys(out).length ? out : undefined;
}

function collectSources(
    data: MomloverDecrypted,
    serverName: string
): M111StreamSource[] {
    const out: M111StreamSource[] = [];
    const push = (
        url: string | undefined,
        quality: string,
        type?: string,
        headers?: Record<string, string>
    ) => {
        if (!url || !/^https?:\/\//i.test(url)) return;
        out.push({
            url,
            type: pickStreamType(url, type),
            quality: String(quality || 'Auto'),
            serverName,
            noReferrer: false,
            headers: extractHeaders(headers)
        });
    };

    if (typeof data.url === 'string') push(data.url, 'Auto');
    if (typeof data.stream === 'string') push(data.stream, 'Auto');
    if (typeof data.m3u8 === 'string') push(data.m3u8, 'Auto', 'hls');
    if (typeof data.playlist === 'string') push(data.playlist, 'Auto', 'hls');

    for (const s of data.sources ?? []) {
        push(
            s.url || s.file || s.proxiedUrl || s.streamUrl,
            s.quality != null ? String(s.quality) : 'Auto',
            s.type,
            s.headers
        );
    }
    for (const s of data.streams ?? []) {
        push(
            s.url || s.file,
            s.quality != null ? String(s.quality) : 'Auto',
            undefined,
            s.headers
        );
    }
    for (const lang of data.languages ?? []) {
        for (const s of lang.sources ?? []) {
            push(
                s.url || s.file,
                s.quality != null ? String(s.quality) : 'Auto',
                undefined,
                s.headers
            );
        }
    }

    // Prefer higher quality first
    out.sort((a, b) => {
        const qa = parseInt(String(a.quality).replace(/\D/g, ''), 10) || 0;
        const qb = parseInt(String(b.quality).replace(/\D/g, ''), 10) || 0;
        return qb - qa;
    });

    // Dedupe by URL
    const seen = new Set<string>();
    return out.filter((s) => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
    });
}

function collectSubtitles(data: MomloverDecrypted): M111Subtitle[] {
    const out: M111Subtitle[] = [];
    for (const sub of data.subtitles ?? []) {
        const url = sub.url || sub.file;
        if (!url || !/^https?:\/\//i.test(url)) continue;
        out.push({
            url,
            display: sub.label || sub.language || sub.lang || 'Unknown',
            language: sub.language || sub.lang
        });
    }
    for (const t of data.tracks ?? []) {
        if (t.kind && t.kind !== 'captions' && t.kind !== 'subtitles') continue;
        const url = t.url || t.file;
        if (!url || !/^https?:\/\//i.test(url)) continue;
        out.push({
            url,
            display: t.label || 'Unknown'
        });
    }
    return out;
}

async function fetchServer(
    server: M111Server,
    media: Media,
    token: string
): Promise<{ sources: M111StreamSource[]; subtitles: M111Subtitle[] } | null> {
    const url = buildApiUrl(server, media);
    const res = await fetch(url, {
        headers: {
            ...BROWSER_HEADERS,
            'x-request-token': token,
            'x-response-encryption': 'aes-gcm'
        },
        signal: AbortSignal.timeout(25_000)
    });
    if (!res.ok) return null;

    let body: unknown;
    try {
        body = await res.json();
    } catch {
        return null;
    }

    let decrypted: unknown;
    try {
        decrypted = await decryptVidloveBody(
            body as { v?: string | number; payload?: string }
        );
    } catch {
        return null;
    }

    const data = (decrypted ?? {}) as MomloverDecrypted;
    const sources = collectSources(data, server.name);
    const subtitles = collectSubtitles(data);
    if (sources.length === 0) return null;
    return { sources, subtitles };
}

export async function fetchSubtitles(media: Media): Promise<M111Subtitle[]> {
    try {
        let url = `${WYZIE_API}?id=${encodeURIComponent(media.tmdbId)}`;
        if (
            media.type === 'tv' &&
            media.season != null &&
            media.episode != null
        ) {
            url += `&season=${media.season}&episode=${media.episode}`;
        }
        const res = await fetch(url, {
            headers: BROWSER_HEADERS,
            signal: AbortSignal.timeout(12_000)
        });
        if (!res.ok) return [];
        const data = (await res.json()) as Array<{
            url?: string;
            display?: string;
            language?: string;
        }>;
        if (!Array.isArray(data)) return [];
        return data
            .filter((s) => s?.url)
            .map((s) => ({
                url: s.url!,
                display: s.display || s.language || 'Unknown',
                language: s.language
            }));
    } catch {
        return [];
    }
}

export async function resolveM111Streams(
    media: Media
): Promise<M111ResolveResult> {
    const [token, wyzieSubs] = await Promise.all([
        mintRequestToken(API_HOST),
        fetchSubtitles(media)
    ]);

    const settled = await Promise.allSettled(
        SERVERS.map((server) => fetchServer(server, media, token))
    );

    const sources: M111StreamSource[] = [];
    const subtitles: M111Subtitle[] = [...wyzieSubs];
    const okServers: M111Server[] = [];

    for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i]!;
        if (outcome.status !== 'fulfilled' || !outcome.value) continue;
        okServers.push(SERVERS[i]!);
        sources.push(...outcome.value.sources);
        subtitles.push(...outcome.value.subtitles);
    }

    // Dedupe sources by URL again after merge
    const seen = new Set<string>();
    const dedupedSources = sources.filter((s) => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
    });

    const seenSub = new Set<string>();
    const dedupedSubs = subtitles.filter((s) => {
        if (seenSub.has(s.url)) return false;
        seenSub.add(s.url);
        return true;
    });

    return {
        sources: dedupedSources,
        subtitles: dedupedSubs,
        servers: okServers
    };
}

export { PLAYER_ORIGIN, API_HOST, SERVERS, BROWSER_HEADERS };
