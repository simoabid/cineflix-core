/**
 * m111moviesClient.ts
 *
 * HTTP client for the 111movies provider.
 *
 * 111movies API flow:
 *   1. Embed page has a `data` blob in __NEXT_DATA__
 *   2. Player's bytecode VM decodes it → API URL (session-specific)
 *   3. GET {api_url} → JSON array of servers
 *   4. GET {api_url}/{server.data} → JSON {url, tracks, noReferrer}
 *   5. The `url` field is the direct m3u8/mp4 stream URL
 *   6. Subtitles from /wyzie?id={tmdbId} (same wyzie API as vidup)
 *
 * The `data` blob is decoded by the bytecode VM in Node.js (same approach
 * as vidup). However, the 111movies API is behind Cloudflare, so the
 * API calls return 404 from Node. The VM decodes the _data blob and
 * captures the API URL + servers list, but the per-server stream URL
 * fetch fails.
 *
 * The provider returns the embed URL as a source (the framework's proxy
 * resolves it) plus subtitles from the wyzie API.
 */
import type { M111Server, M111Subtitle } from './m111movies.types.js';
import { resolveViaVM } from './m111moviesVM.js';

const BASE_URL = 'https://111movies.net';
const WYZIE_API = 'https://111movies.net/wyzie';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HEADERS: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: BASE_URL + '/',
    Origin: BASE_URL
};

// ---------------------------------------------------------------------------
// Extract the `data` blob from the embed page (pure HTTP)
// ---------------------------------------------------------------------------

export async function extractM111Data(media: {
    type: 'movie' | 'tv';
    tmdbId: string;
    season?: number;
    episode?: number;
}): Promise<string | null> {
    try {
        const url =
            media.type === 'movie'
                ? `${BASE_URL}/movie/${media.tmdbId}`
                : `${BASE_URL}/tv/${media.tmdbId}/${media.season}/${media.episode}`;

        const res = await fetch(url, {
            headers: HEADERS,
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) return null;
        const html = await res.text();
        const match = html.match(/"data":"([^"]+)"/);
        return match?.[1] ?? null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Subtitles (pure HTTP — wyzie API works without browser)
// ---------------------------------------------------------------------------

export async function fetchSubtitles(media: {
    type: 'movie' | 'tv';
    tmdbId: string;
    season?: number;
    episode?: number;
}): Promise<M111Subtitle[]> {
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
            headers: HEADERS,
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) return [];
        const data = (await res.json()) as M111Subtitle[];
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Top-level resolver
// ---------------------------------------------------------------------------

export interface M111ResolveResult {
    sources: Array<{
        url: string;
        type: 'hls' | 'mp4' | 'embed';
        quality: string;
        serverName: string;
        noReferrer: boolean;
    }>;
    subtitles: M111Subtitle[];
    servers: M111Server[];
}

export async function resolveM111Streams(media: {
    type: 'movie' | 'tv';
    tmdbId: string;
    season?: number;
    episode?: number;
}): Promise<M111ResolveResult> {
    // Step 1: Extract _data blob + fetch subtitles in parallel (pure HTTP)
    const [_data, subtitles] = await Promise.all([
        extractM111Data(media),
        fetchSubtitles(media)
    ]);

    if (!_data) {
        return { sources: [], subtitles, servers: [] };
    }

    // Step 2: Run the VM in Node.js to decode _data → API URL + servers
    const vmResult = await resolveViaVM(_data);

    // Step 3: Build sources
    let sources: M111ResolveResult['sources'] = [];

    if (vmResult?.streams && vmResult.streams.length > 0) {
        // VM captured stream URLs directly
        sources = vmResult.streams.map((s) => ({
            url: s.url,
            type: s.type,
            quality: s.serverName,
            serverName: s.serverName,
            noReferrer: s.noReferrer
        }));
    }

    // Always add the embed URL as a fallback source.
    // The 111movies API is behind Cloudflare, so direct stream URLs
    // may not be available from Node. The embed URL is always accessible
    // and the framework's proxy can resolve it.
    const embedUrl =
        media.type === 'movie'
            ? `${BASE_URL}/movie/${media.tmdbId}`
            : `${BASE_URL}/tv/${media.tmdbId}/${media.season}/${media.episode}`;

    sources.push({
        url: embedUrl,
        type: 'embed',
        quality: 'Auto',
        serverName: 'Embed',
        noReferrer: false
    });

    return {
        sources,
        subtitles,
        servers: vmResult?.servers ?? []
    };
}
