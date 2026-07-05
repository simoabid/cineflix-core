/**
 * vidupClient.ts
 *
 * HTTP client for the vidup.to provider.
 *
 * Responsibilities:
 *   1. Fetch the embed page and extract the `en` token from the RSC payload.
 *   2. Call the vidup stream API (`/b2b6f6ee/inu/...`) with the `en` token.
 *   3. Fetch subtitles from the wyzie API (`/wyzie?id=...`).
 *   4. Fall back to the ythd.org embed if the primary API fails.
 *
 * The vidup player uses a bytecode VM to decrypt the `en` token into per-server
 * data tokens, then makes POST requests to the API. Reproducing the VM in
 * TypeScript is complex (see RECON.md), so this client takes a pragmatic
 * approach:
 *   - Attempt the direct API call with the `en` token as the data value
 *     (works if vidup accepts the raw token).
 *   - If that fails, fall back to the ythd.org embed URL as an `embed`-type
 *     source that the framework's proxy can resolve.
 *   - Always fetch subtitles from wyzie (this works independently).
 */
import type {
    VidupEmbedPayload,
    VidupResolveResult,
    VidupServer,
    VidupStream,
    VidupSubtitle,
    WyzieSubtitle
} from './vidup.types.js';

// ---------------------------------------------------------------------------
// Constants (recovered from the player bundle, see RECON.md)
// ---------------------------------------------------------------------------

const BASE_URL = 'https://vidup.to';
const FALLBACK_URL = 'https://ythd.org/embed/';

/**
 * The vidup stream API path. This is a constant baked into the player bundle
 * (string-table index 825 after rotation). It does not change between requests.
 */
const API_PATH =
    '/b2b6f6ee/inu/10ca6917-3e8b-5a4d-a249-98109c7f9e13/' +
    '72aa20c98f1586a9755903679a5ccbd86b522090/' +
    '248034bb6eaf469ebf04986a057d13e17648b08aae00143c4a81c77554c833cc';

/**
 * YouTube video IDs used as URL path segments by the player.
 * Index 674 (primary) and 845 (next-episode) in the string table.
 * These appear to be trailer/preview IDs hardcoded in the bundle.
 */
const PRIMARY_YT_ID = 'qlUmUUnAo_U';
const NEXT_EP_YT_ID = 'IP4lIdkHyP4';

/**
 * Constant anti-bot headers required by the API.
 * Recovered from string-table index 481.
 */
const CSRF_HEADERS: Record<string, string> = {
    'X-Requested-With': 'XMLHttpRequest',
    'X-Csrf-Token': 'PRXNAi2u5nlKPOd2akTf7Umma97GrjuH'
};

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua':
        '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
};

const WYZIE_API = 'https://vidup.to/wyzie';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VidupMedia {
    type: 'movie' | 'tv';
    tmdbId: string;
    imdbId?: string;
    season?: number;
    episode?: number;
}

// ---------------------------------------------------------------------------
// Embed page → en token extraction
// ---------------------------------------------------------------------------

/**
 * Fetch the embed page and extract the `en` token + metadata from the RSC
 * payload.
 *
 * The RSC payload is embedded in `<script>self.__next_f.push([...])</script>`
 * tags. The `en` field is a ~64-char custom-base64 string that changes per
 * page load.
 */
export async function extractVidupToken(
    media: VidupMedia,
    headers?: Record<string, string>
): Promise<VidupEmbedPayload | null> {
    try {
        const embedUrl =
            media.type === 'movie'
                ? `${BASE_URL}/movie/${media.tmdbId}`
                : `${BASE_URL}/tv/${media.tmdbId}/${media.season}/${media.episode}`;

        const res = await fetch(embedUrl, {
            headers: {
                ...BROWSER_HEADERS,
                Referer: `${BASE_URL}/`,
                ...headers
            },
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) return null;
        const html = await res.text();

        // The RSC payload contains the player props as an escaped JSON string:
        //   \"en\":\"ZQL5EXB44ki0-...\",\"host\":\"vidup.to\",\"id\":\"155\",...
        // We use a tolerant regex to extract the fields.
        const enMatch = html.match(/\\"en\\":\\"([^\\]+)\\"/);
        if (!enMatch?.[1]) return null;

        const hostMatch = html.match(/\\"host\\":\\"([^\\]+)\\"/);
        const idMatch = html.match(/\\"id\\":\\"([^\\]+)\\"/);
        const titleMatch = html.match(/\\"title\\":\\"([^\\]+)\\"/);
        const yearMatch = html.match(/\\"year\\":\\"([^\\]+)\\"/);
        const adMatch = html.match(/\\"ad\\":(true|false)/);
        const themeMatch = html.match(/\\"theme\\":\\"([^\\]+)\\"/);

        return {
            en: enMatch[1],
            host: hostMatch?.[1] ?? 'vidup.to',
            id: idMatch?.[1] ?? media.tmdbId,
            title: titleMatch?.[1] ?? '',
            year: yearMatch?.[1],
            ad: adMatch?.[1] === 'true',
            theme: themeMatch?.[1]
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Stream API
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve streams by calling the vidup API directly.
 *
 * The player's VM decrypts the `en` token into per-server `data` values, then
 * POSTs to `${API_PATH}/${YT_ID}/${data}`. Without reproducing the VM, we
 * try using the `en` token itself as the data value — if vidup's backend
 * accepts it, we get streams. If not, we fall back to ythd.org.
 *
 * This is a best-effort approach. The primary source of streams is the
 * ythd.org fallback (see `resolveVidupStreams`).
 */
export async function fetchVidupStreams(
    media: VidupMedia,
    embedPayload: VidupEmbedPayload,
    headers?: Record<string, string>
): Promise<{ sources: VidupStream[]; servers: VidupServer[] }> {
    const sources: VidupStream[] = [];
    const servers: VidupServer[] = [];

    try {
        const ytId = media.type === 'tv' ? NEXT_EP_YT_ID : PRIMARY_YT_ID;
        const apiUrl = `${BASE_URL}${API_PATH}/${ytId}/${embedPayload.en}`;

        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                ...BROWSER_HEADERS,
                ...CSRF_HEADERS,
                Referer: `${BASE_URL}/movie/${media.tmdbId}`,
                Origin: BASE_URL,
                ...headers
            },
            signal: AbortSignal.timeout(15_000)
        });

        if (res.ok) {
            const text = await res.text();
            // The response may be JSON (if our token was accepted) or
            // encrypted base64 (if the VM was needed). Try JSON first.
            try {
                const data = JSON.parse(text);
                if (Array.isArray(data?.sources)) {
                    for (const s of data.sources) {
                        if (s?.url) {
                            sources.push({
                                url: s.url,
                                type: s.type === 'mp4' ? 'mp4' : 'hls',
                                quality: s.quality,
                                headers: s.headers
                            });
                        }
                    }
                }
                if (Array.isArray(data?.servers)) {
                    for (const srv of data.servers) {
                        servers.push({
                            name: srv.name ?? 'Unknown',
                            data: srv.data ?? '',
                            image: srv.image
                        });
                    }
                }
            } catch {
                // Response is likely encrypted — would need the VM to decrypt.
                // Fall through to return empty (ythd fallback will be used).
            }
        }
    } catch {
        // network error — fall through
    }

    return { sources, servers };
}

// ---------------------------------------------------------------------------
// ythd.org fallback
// ---------------------------------------------------------------------------

/**
 * Build the ythd.org fallback embed URL.
 *
 * When all vidup servers fail, the player redirects to ythd.org. We use this
 * as a reliable fallback that returns an `embed`-type source the framework
 * can proxy.
 */
export function buildYthdFallbackUrl(media: VidupMedia): string {
    if (media.type === 'tv') {
        return `${FALLBACK_URL}${media.tmdbId}/${media.season}-${media.episode}`;
    }
    return `${FALLBACK_URL}${media.tmdbId}`;
}

// ---------------------------------------------------------------------------
// Subtitles (wyzie API — same as vidsrc)
// ---------------------------------------------------------------------------

/**
 * Fetch subtitles from the wyzie API.
 *
 * Vidup uses the same wyzie subtitle service as vidssrc. The endpoint is
 * `https://sub.wyzie.ru/search?id={tmdbId}[&season={s}&episode={e}]`.
 */
export async function fetchVidupSubtitles(
    media: VidupMedia,
    headers?: Record<string, string>
): Promise<VidupSubtitle[]> {
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
            headers: { ...BROWSER_HEADERS, ...headers },
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) return [];

        const data = (await res.json()) as WyzieSubtitle[];
        if (!Array.isArray(data)) return [];

        const seen = new Set<string>();
        const subtitles: VidupSubtitle[] = [];

        for (const sub of data) {
            if (!sub?.url || seen.has(sub.url)) continue;
            seen.add(sub.url);

            const label =
                (sub.display || sub.language || 'Unknown') +
                (sub.isHearingImpaired ? ' (SDH)' : '');

            subtitles.push({
                url: sub.url,
                label,
                format: detectSubtitleFormat(sub.format, sub.url),
                language: sub.language,
                isHearingImpaired: sub.isHearingImpaired
            });
        }

        return subtitles;
    } catch {
        return [];
    }
}

function detectSubtitleFormat(
    fmt: string | undefined,
    url: string
): 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' {
    const f = (fmt ?? '').toLowerCase();
    if (f === 'srt' || f === 'vtt' || f === 'ass' || f === 'ssa') return f;
    if (f === 'ttml') return 'ttml';
    const u = url.toLowerCase();
    if (u.includes('.srt')) return 'srt';
    if (u.includes('.ass')) return 'ass';
    if (u.includes('.ssa')) return 'ssa';
    if (u.includes('.ttml') || u.includes('.xml')) return 'ttml';
    return 'vtt';
}

// ---------------------------------------------------------------------------
// Top-level resolver
// ---------------------------------------------------------------------------

/**
 * Resolve all available streams + subtitles for a media item.
 *
 * Flow:
 *   1. Extract the `en` token from the embed page.
 *   2. Attempt the direct API call (best-effort — may fail without the VM).
 *   3. Always add the ythd.org fallback as an embed source.
 *   4. Fetch subtitles from wyzie in parallel.
 */
export async function resolveVidupStreams(
    media: VidupMedia,
    headers?: Record<string, string>
): Promise<VidupResolveResult> {
    // Step 1: extract the en token
    const embedPayload = await extractVidupToken(media, headers);

    // Step 2: attempt the direct API call (parallel with subtitles)
    const [apiResult, subtitles] = await Promise.all([
        embedPayload
            ? fetchVidupStreams(media, embedPayload, headers)
            : Promise.resolve({ sources: [], servers: [] }),
        fetchVidupSubtitles(media, headers)
    ]);

    // Step 3: always add the ythd.org fallback
    const sources: VidupStream[] = [...apiResult.sources];
    const ythdUrl = buildYthdFallbackUrl(media);
    sources.push({
        url: ythdUrl,
        type: 'embed',
        quality: 'Auto',
        server: 'ythd'
    });

    return {
        sources,
        subtitles,
        servers: apiResult.servers
    };
}
