/**
 * Normalize subtitle download URLs for Path B.
 *
 * Architecture (client-side download):
 * - Core only searches Wyzie (secrets on server).
 * - OpenSubtitles CDN files are downloaded by the **browser** (user IP).
 * - Do NOT wrap opensubtitles.org into /v1/subtitles/file — EC2/DC IPs
 *   get Anubis, Cloudflare challenges, or login-wall fake SRTs.
 * - Provider VTT already on OMSS /v1/proxy (e.g. vdrk) is left alone.
 */

const DEFAULT_SUBTITLE_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/plain, text/vtt, application/x-subrip, */*'
};

/**
 * OpenSubtitles free download API expects a classic subtitle client UA.
 * Only used by optional debug endpoint GET /v1/subtitles/file.
 */
const OPENSUBTITLES_HEADERS: Record<string, string> = {
    'User-Agent': 'TemporaryUserAgent',
    'X-User-Agent': 'TemporaryUserAgent',
    Accept: 'text/plain, */*'
};

/** Pick outbound headers based on upstream host (debug file endpoint). */
export function headersForSubtitleUpstream(
    upstreamUrl: string
): Record<string, string> {
    try {
        const host = new URL(upstreamUrl).hostname.toLowerCase();
        if (host.includes('opensubtitles.org')) {
            return { ...OPENSUBTITLES_HEADERS };
        }
    } catch {
        /* fall through */
    }
    return { ...DEFAULT_SUBTITLE_HEADERS };
}

/**
 * Public base for proxy links (PUBLIC_URL preferred, else host:port).
 */
export function getProxyBaseUrl(): string {
    const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, '').trim();
    if (publicUrl) return publicUrl;
    const host = process.env.HOST ?? 'localhost';
    const port = process.env.PORT ?? '3005';
    const browserHost = host === '0.0.0.0' ? 'localhost' : host;
    return `http://${browserHost}:${port}`;
}

function unwrapProxyDataUrl(proxied: string): string | null {
    try {
        const u = new URL(proxied);
        const raw = u.searchParams.get('data');
        if (!raw) return null;
        // data may be encodeURIComponent'd JSON or raw JSON
        let decoded = raw;
        try {
            decoded = decodeURIComponent(raw);
        } catch {
            /* use raw */
        }
        const data = JSON.parse(decoded) as { url?: string };
        return typeof data.url === 'string' ? data.url : null;
    } catch {
        return null;
    }
}

function unwrapFileEndpointUrl(proxied: string): string | null {
    try {
        const u = new URL(proxied);
        if (!u.pathname.includes('/v1/subtitles/file')) return null;
        const inner = u.searchParams.get('url');
        return inner || null;
    } catch {
        return null;
    }
}

export function isOpenSubtitlesUrl(url: string): boolean {
    return /opensubtitles\.org/i.test(url);
}

/**
 * Peel core wrappers to get the real CDN URL (if any).
 */
export function unwrapSubtitleUpstream(url: string): string | null {
    if (!url) return null;
    const fromFile = unwrapFileEndpointUrl(url);
    if (fromFile) return fromFile;
    if (url.includes('/v1/proxy?') || url.includes('/v1/proxy&')) {
        return unwrapProxyDataUrl(url);
    }
    return null;
}

/**
 * Normalize one subtitle URL for SPA browser download.
 * OpenSubtitles → raw CDN. Non-OS core /v1/proxy → keep. Legacy OS wrappers → unwrap.
 *
 * @deprecated name kept for imports; prefer normalizeSubtitleDownloadUrl
 */
export function createSubtitleProxyUrl(upstreamUrl: string): string {
    return normalizeSubtitleDownloadUrl(upstreamUrl);
}

/**
 * Browser-downloadable URL: raw OpenSubtitles, or leave non-OS proxies alone.
 */
export function normalizeSubtitleDownloadUrl(upstreamUrl: string): string {
    if (!upstreamUrl) return upstreamUrl;

    // Already raw OpenSubtitles
    if (
        isOpenSubtitlesUrl(upstreamUrl) &&
        !upstreamUrl.includes('/v1/subtitles/file') &&
        !upstreamUrl.includes('/v1/proxy?')
    ) {
        return upstreamUrl;
    }

    // Unwrap /v1/subtitles/file?url=…
    const fromFile = unwrapFileEndpointUrl(upstreamUrl);
    if (fromFile) {
        return normalizeSubtitleDownloadUrl(fromFile);
    }

    // Unwrap or keep /v1/proxy?data=…
    if (upstreamUrl.includes('/v1/proxy?') || upstreamUrl.includes('/v1/proxy&')) {
        const inner = unwrapProxyDataUrl(upstreamUrl);
        if (inner) {
            if (isOpenSubtitlesUrl(inner)) {
                return normalizeSubtitleDownloadUrl(inner);
            }
            // Provider VTT (vdrk etc.) — keep public core proxy URL
            return upstreamUrl;
        }
    }

    return upstreamUrl;
}

/**
 * Normalize a list of subtitle rows for browser download (Path B catalog).
 */
export function proxySubtitleUrls<T extends { url: string }>(subs: T[]): T[] {
    return subs.map((sub) => {
        if (!sub.url) return sub;
        return {
            ...sub,
            url: normalizeSubtitleDownloadUrl(sub.url)
        };
    });
}
