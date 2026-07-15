/**
 * Patch @omss/framework ProxyService URL resolution.
 *
 * VidKing Oxygen masters emit some HLS URI attributes without a scheme:
 *   URI="ijzeczcdbzbhe.interkh.com/path/index.m3u8?key=..."
 *
 * The WHATWG resolver treats that as a relative path under the master host.
 * The site's player treats "hostname/path..." as https://hostname/path...
 *
 * CRITICAL: do NOT match bare media filenames like `seg-1-v1.ts?key=...`.
 * Those must stay relative to the playlist directory. The old regex treated
 * `.ts` as a TLD and produced `https://seg-1-v1.ts?key=...` → proxy HTTP 500
 * (see pm2_core_logs_v2).
 */
import { ProxyService } from '@omss/framework';

/**
 * host.tld/path... only — requires a slash after the host so that
 * `seg-1-v1.ts` / `playlist.m3u8` are NOT treated as hostnames.
 */
const HOST_THEN_PATH =
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+\/.+/;

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
            HOST_THEN_PATH.test(trimmed) &&
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
