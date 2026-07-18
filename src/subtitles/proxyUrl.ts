/**
 * Build absolute OMSS-style proxy URLs for subtitle file downloads.
 * Same encoding as BaseProvider.createProxyUrl — browser can fetch without
 * the SPA's auth-gated /api/proxy.
 */

const SUBTITLE_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/plain, text/vtt, application/x-subrip, */*'
};

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
    headers: Record<string, string> = SUBTITLE_HEADERS
): string {
    const data = JSON.stringify({ url: upstreamUrl, headers });
    const encoded = encodeURIComponent(data);
    return `${getProxyBaseUrl()}/v1/proxy?data=${encoded}`;
}

/**
 * Rewrite a list of subtitle rows so each `.url` goes through core proxy.
 */
export function proxySubtitleUrls<T extends { url: string }>(
    subs: T[]
): T[] {
    return subs.map((sub) => {
        if (!sub.url || sub.url.includes('/v1/proxy?')) {
            return sub;
        }
        return {
            ...sub,
            url: createSubtitleProxyUrl(sub.url)
        };
    });
}
