/**
 * Patch @omss/framework ProxyService URL resolution.
 *
 * VidKing (and some other CDNs) emit HLS URI attributes without a scheme:
 *   URI="ijzeczcdbzbhe.interkh.com/path/index.m3u8?key=..."
 *
 * The WHATWG URL resolver treats that as a *relative path* under the master
 * playlist host, which is wrong. The site's player treats host-looking
 * relative URIs as `https://host/...`. We mirror that here so rewritten
 * proxy URLs point at the real CDN.
 */
import { ProxyService } from '@omss/framework';

/** host.tld/... or host.tld?query — no scheme, no leading slash */
const HOST_RELATIVE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(?:[/?#]|$)/;

type ResolveUrlFn = (baseUrl: string, targetUrl: string) => string;

const proto = ProxyService.prototype as unknown as {
    resolveUrl: ResolveUrlFn;
};

const originalResolveUrl = proto.resolveUrl;

if (typeof originalResolveUrl === 'function') {
    proto.resolveUrl = function patchedResolveUrl(
        this: unknown,
        baseUrl: string,
        targetUrl: string
    ): string {
        const trimmed = targetUrl.trim();
        if (
            HOST_RELATIVE.test(trimmed) &&
            !trimmed.startsWith('http://') &&
            !trimmed.startsWith('https://') &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('/')
        ) {
            return originalResolveUrl.call(this, baseUrl, `https://${trimmed}`);
        }
        return originalResolveUrl.call(this, baseUrl, targetUrl);
    };
}
