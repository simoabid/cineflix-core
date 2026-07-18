/**
 * Normalize subtitle download URLs for Path B.
 *
 * Core only searches Wyzie. OpenSubtitles files are downloaded by the browser
 * (user IP, CORS *). Never wrap opensubtitles.org through core egress.
 */

export function isOpenSubtitlesUrl(url: string): boolean {
    return /opensubtitles\.org/i.test(url);
}

function unwrapProxyDataUrl(proxied: string): string | null {
    try {
        const u = new URL(proxied);
        const raw = u.searchParams.get('data');
        if (!raw) return null;
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
        return u.searchParams.get('url');
    } catch {
        return null;
    }
}

/** Peel legacy core wrappers; return upstream CDN URL if present. */
export function unwrapSubtitleUpstream(url: string): string | null {
    if (!url) return null;
    return (
        unwrapFileEndpointUrl(url) ||
        (url.includes('/v1/proxy') ? unwrapProxyDataUrl(url) : null)
    );
}

/**
 * Browser-ready download URL:
 * - OpenSubtitles → raw CDN (unwrap legacy core wrappers)
 * - non-OS already on /v1/proxy → keep (e.g. provider VTT)
 * - otherwise unchanged
 */
export function normalizeSubtitleDownloadUrl(url: string): string {
    if (!url) return url;

    if (
        isOpenSubtitlesUrl(url) &&
        !url.includes('/v1/subtitles/file') &&
        !url.includes('/v1/proxy')
    ) {
        return url;
    }

    const fromFile = unwrapFileEndpointUrl(url);
    if (fromFile) return normalizeSubtitleDownloadUrl(fromFile);

    if (url.includes('/v1/proxy')) {
        const inner = unwrapProxyDataUrl(url);
        if (inner) {
            if (isOpenSubtitlesUrl(inner)) {
                return normalizeSubtitleDownloadUrl(inner);
            }
            return url;
        }
    }

    return url;
}

/** Normalize a list of subtitle rows for catalog / provider payloads. */
export function normalizeSubtitleUrls<T extends { url: string }>(
    subs: T[]
): T[] {
    return subs.map((sub) => {
        if (!sub.url) return sub;
        return { ...sub, url: normalizeSubtitleDownloadUrl(sub.url) };
    });
}

/**
 * Provider helper: raw OpenSubtitles for browser download;
 * other hosts may use OMSS createProxyUrl.
 */
export function resolveProviderSubtitleUrl(
    url: string,
    createProxy: (upstream: string) => string
): string {
    if (!url) return url;
    if (isOpenSubtitlesUrl(url)) {
        return normalizeSubtitleDownloadUrl(url);
    }
    const unwrapped = unwrapSubtitleUpstream(url);
    if (unwrapped && isOpenSubtitlesUrl(unwrapped)) {
        return normalizeSubtitleDownloadUrl(unwrapped);
    }
    return createProxy(url);
}
