/**
 * Build absolute browser-facing URLs for subtitle file downloads.
 *
 * OpenSubtitles / Wyzie Charlie must use `/v1/subtitles/file` (dedicated fetch),
 * NOT OMSS `/v1/proxy` — the latter rewrites Anubis HTML as a fake HLS manifest.
 */

const DEFAULT_SUBTITLE_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/plain, text/vtt, application/x-subrip, */*'
};

/**
 * OpenSubtitles free download API expects a classic subtitle client UA.
 * AWS IPs get Anubis 403; residential PROXY_URL is required on EC2.
 */
const OPENSUBTITLES_HEADERS: Record<string, string> = {
    'User-Agent': 'TemporaryUserAgent',
    'X-User-Agent': 'TemporaryUserAgent',
    Accept: 'text/plain, */*'
};

/** Pick outbound headers based on upstream host. */
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
        const data = JSON.parse(decodeURIComponent(raw)) as { url?: string };
        return typeof data.url === 'string' ? data.url : null;
    } catch {
        return null;
    }
}

function isOpenSubtitlesUrl(url: string): boolean {
    return /opensubtitles\.org/i.test(url);
}

/**
 * Browser-downloadable absolute URL for one subtitle file.
 * → `/v1/subtitles/file?url=…` (never OMSS /v1/proxy for OpenSubtitles).
 */
export function createSubtitleProxyUrl(upstreamUrl: string): string {
    let target = upstreamUrl;

    // Already our file endpoint
    if (target.includes('/v1/subtitles/file?')) {
        return target;
    }

    // Unwrap OMSS proxy wrappers (especially bad OpenSubtitles ones)
    if (target.includes('/v1/proxy?')) {
        const inner = unwrapProxyDataUrl(target);
        if (inner) {
            // Provider VTT (vdrk etc.) already works on /v1/proxy — keep it
            if (!isOpenSubtitlesUrl(inner) && !isOpenSubtitlesUrl(target)) {
                return target;
            }
            target = inner;
        }
    }

    return `${getProxyBaseUrl()}/v1/subtitles/file?url=${encodeURIComponent(target)}`;
}

/**
 * Rewrite a list of subtitle rows so each `.url` is browser-downloadable.
 */
export function proxySubtitleUrls<T extends { url: string }>(subs: T[]): T[] {
    return subs.map((sub) => {
        if (!sub.url) return sub;
        return {
            ...sub,
            url: createSubtitleProxyUrl(sub.url)
        };
    });
}
