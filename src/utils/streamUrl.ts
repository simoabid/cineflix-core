/**
 * Upstream media URL sanitization for OMSS proxy + provider scrape paths.
 *
 * Fixes malformed query strings seen in production (m111movies / vidlove):
 *   page-0.html?token=?token=
 * which parse as token value "?token=" and always 403 on CDN.
 */

/** True when a token-like query value is clearly corrupted. */
export function isMalformedQueryValue(value: string): boolean {
    if (!value) return false;
    // token=?token=  or  token=?anything
    if (value.startsWith('?')) return true;
    if (value.includes('?token=')) return true;
    if (value.includes('token=?')) return true;
    return false;
}

/**
 * Detect the double/empty token pattern that never plays.
 * Matches both raw and percent-encoded forms.
 */
export function hasMalformedMediaToken(url: string): boolean {
    if (!url) return true;
    if (/token=\?token=/i.test(url)) return true;
    if (/token=%3Ftoken%3D/i.test(url)) return true;
    try {
        const u = new URL(url);
        for (const [, v] of u.searchParams) {
            if (isMalformedQueryValue(v)) return true;
        }
    } catch {
        return true;
    }
    return false;
}

/**
 * Normalize upstream media URLs before proxy fetch or createProxyUrl.
 * - Drops malformed query values (value starts with `?`)
 * - Collapses accidental `?token=?token=` leftovers in the raw string
 * - Leaves legitimate empty tokens alone (`?token=`) unless malformed
 */
export function normalizeUpstreamMediaUrl(url: string): string {
    if (!url || typeof url !== 'string') return url;

    let cleaned = url
        .replace(/([?&])token=\?token=/gi, '$1')
        .replace(/([?&])token=%3Ftoken%3D/gi, '$1')
        .replace(/\?&/g, '?')
        .replace(/&&+/g, '&')
        .replace(/\?$/g, '')
        .replace(/&$/g, '');

    try {
        const u = new URL(cleaned);
        const drop: string[] = [];
        for (const [k, v] of u.searchParams) {
            if (isMalformedQueryValue(v)) {
                drop.push(k);
            }
        }
        for (const k of drop) {
            u.searchParams.delete(k);
        }
        return u.toString();
    } catch {
        return cleaned;
    }
}

/**
 * Merge non-empty query params from `parentUrl` onto `childUrl` safely.
 * Never produces `?token=?token=` style doubles.
 * Only used if a caller wants parent-query inheritance (not default HLS).
 */
export function mergeNonEmptyQuery(
    parentUrl: string,
    childUrl: string
): string {
    try {
        const parent = new URL(parentUrl);
        const child = new URL(childUrl);
        for (const [k, v] of parent.searchParams) {
            if (!v || isMalformedQueryValue(v)) continue;
            if (!child.searchParams.has(k)) {
                child.searchParams.set(k, v);
            }
        }
        return child.toString();
    } catch {
        return childUrl;
    }
}
