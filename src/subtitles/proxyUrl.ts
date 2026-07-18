/**
 * Build absolute OMSS-style proxy URLs for subtitle file downloads.
 * Same encoding as BaseProvider.createProxyUrl — browser can fetch without
 * the SPA's auth-gated /api/proxy.
 */

const DEFAULT_SUBTITLE_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/plain, text/vtt, application/x-subrip, */*'
};

/**
 * OpenSubtitles free download API expects a classic subtitle client UA.
 * Browser Chrome UA often works from residential IPs; AWS still 403s —
 * residential PROXY_URL + this UA is the reliable combo.
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
    // HOST 0.0.0.0 is not a browser-reachable origin
    const browserHost = host === '0.0.0.0' ? 'localhost' : host;
    return `http://${browserHost}:${port}`;
}

/**
 * Absolute URL: {base}/v1/proxy?data={json url+headers}
 */
export function createSubtitleProxyUrl(
    upstreamUrl: string,
    headers?: Record<string, string>
): string {
    const hdrs = headers ?? headersForSubtitleUpstream(upstreamUrl);
    const data = JSON.stringify({ url: upstreamUrl, headers: hdrs });
    const encoded = encodeURIComponent(data);
    return `${getProxyBaseUrl()}/v1/proxy?data=${encoded}`;
}

/**
 * Rewrite a list of subtitle rows so each `.url` goes through core proxy.
 * Re-encodes existing proxy links if they still use a weak OpenSubtitles UA.
 */
export function proxySubtitleUrls<T extends { url: string }>(
    subs: T[]
): T[] {
    return subs.map((sub) => {
        if (!sub.url) return sub;
        if (sub.url.includes('/v1/proxy?')) {
            // Already proxied by provider createProxyUrl — leave as-is
            return sub;
        }
        return {
            ...sub,
            url: createSubtitleProxyUrl(sub.url)
        };
    });
}
