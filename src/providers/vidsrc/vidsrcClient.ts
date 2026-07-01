/**
 * vidsrc stream resolver (Node port of the site's client logic).
 *
 * Faithful reimplementation of `enhanceTmdbImageData` from vidsrc's
 * tmdb-image-enhancer.js. The WASM is used only for two pure-compute steps:
 *   - getImgKey()      -> the 64-char HMAC/AES key
 *   - processImgData() -> decrypt the AES-encrypted backend responses
 * Everything else (server-time sync, nonce, fingerprint, HMAC request
 * signing, the NATO server loop) is reimplemented here.
 *
 * resolveVidsrc() returns the first working `.m3u8`/`.mp4` url (already the
 * real CDN url, e.g. mto.nexlunar99.site/....m3u8).
 */
import { ensureVidsrcWasm, clearVidsrcSession } from './vidsrcWasm.js';

const API_BASE = 'https://themoviedb.vidsrc.su';
const PAGE_ORIGIN = 'https://vidsrc.ru';

// Browser-like headers. themoviedb.vidsrc.su sits behind Cloudflare, which
// rejects the default `User-Agent: node` with a 403 before the app runs.
const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua':
        '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    // vidsrc.ru -> themoviedb.vidsrc.su is cross-site (different eTLD+1).
    'Sec-Fetch-Site': 'cross-site',
    // Constant anti-bot token the site's global fetch wrapper injects into
    // every API request (r.set("x-fingerprint-lite", ...) in index-*.js).
    'X-Fingerprint-Lite': 'e9136c41504646444'
};

// Canonical NATO order the site tries servers in.
const NATO_ORDER = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliet',
    'kilo',
    'lima',
    'mike',
    'november',
    'oscar',
    'papa',
    'quebec',
    'romeo',
    'sierra',
    'tango',
    'uniform',
    'victor',
    'whiskey',
    'xray',
    'yankee',
    'zulu'
];

export interface VidsrcMedia {
    type: 'movie' | 'tv';
    tmdbId: string;
    seasonId?: number;
    episodeId?: number;
}

export interface VidsrcResolved {
    url: string;
    server: string;
    servers: string[];
}

export interface VidsrcSource {
    server: string;
    url: string;
}

export interface ResolveOptions {
    /** Force a specific 64-char key instead of the WASM-derived one (debug). */
    keyOverride?: string;
    /** Force a specific X-Client-Fingerprint value (debug). */
    fpOverride?: string;
    /** Log the outgoing request + response status for the first call. */
    debug?: boolean;
    /** Max working servers to collect in resolveVidsrcAll (default 20 = all). */
    maxSources?: number;
    /** How many per-server requests to run at once (default 8). */
    concurrency?: number;
    /** Delay (ms) between a worker's requests (default 0). */
    delayMs?: number;
}

let serverTimeOffset: number | null = null;
let serverTimeLastFetched = 0;

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

function generateNonce(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return toBase64(bytes).replace(/[/+=]/g, '').substring(0, 22);
}

// Deterministic, browser-like fingerprint (matches the site's algorithm using
// stable shim values). The backend treats this as telemetry.
function generateClientFingerprint(override?: string): string {
    if (override) return override;
    const canvasHash = 'iVBORw0KGgoAAAANSUhE'.substring(0, 28);
    const raw =
        `1920x1080:24:` +
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebK:` +
        `Win32:en-US:0:${canvasHash}`;
    let acc = 0;
    for (let i = 0; i < raw.length; i++) {
        acc = (acc << 5) - acc + raw.charCodeAt(i);
        acc &= acc;
    }
    return Math.abs(acc).toString(36);
}

async function generateRequestSignature(
    key: string,
    timestamp: number,
    nonce: string,
    path: string
): Promise<string> {
    const message = `${key}:${timestamp}:${nonce}:${path}`;
    const enc = new TextEncoder();
    const cryptoKey = await globalThis.crypto.subtle.importKey(
        'raw',
        enc.encode(key),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await globalThis.crypto.subtle.sign(
        'HMAC',
        cryptoKey,
        enc.encode(message)
    );
    return toBase64(new Uint8Array(sig));
}

async function fetchServerTime(): Promise<number> {
    const now = Date.now();
    if (serverTimeOffset !== null && now - serverTimeLastFetched < 300_000) {
        return Math.floor((now + serverTimeOffset) / 1000);
    }
    try {
        const start = Date.now();
        const res = await fetch(`${API_BASE}/api/time?t=${start}`, {
            method: 'GET',
            headers: {
                ...BROWSER_HEADERS,
                'Cache-Control': 'no-cache',
                Origin: PAGE_ORIGIN,
                Referer: `${PAGE_ORIGIN}/`
            },
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) throw new Error(`time HTTP ${res.status}`);
        const end = Date.now();
        const rtt = end - start;
        const data = (await res.json()) as { timestamp?: number };
        if (typeof data.timestamp !== 'number') {
            throw new Error('invalid time response');
        }
        const serverMs = data.timestamp * 1000;
        serverTimeOffset = serverMs + rtt / 2 - end;
        serverTimeLastFetched = end;
        return Math.floor((end + serverTimeOffset) / 1000);
    } catch {
        return Math.floor(Date.now() / 1000);
    }
}

async function buildSecureHeaders(
    key: string,
    url: string,
    fpOverride?: string
): Promise<Record<string, string>> {
    let path = url;
    try {
        path = new URL(url).pathname;
    } catch {
        const m = url.match(/\/api\/tmdb\/.*/);
        if (m) path = m[0];
    }
    const timestamp = await fetchServerTime();
    const nonce = generateNonce();
    const fingerprint = generateClientFingerprint(fpOverride);
    const signature = await generateRequestSignature(
        key,
        timestamp,
        nonce,
        path
    );
    return {
        'X-Api-Key': key,
        'X-Request-Timestamp': timestamp.toString(),
        'X-Request-Nonce': nonce,
        'X-Request-Signature': signature,
        'X-Client-Fingerprint': fingerprint
    };
}

function buildImageApiUrl(media: VidsrcMedia): string {
    if (media.type === 'movie') {
        return `${API_BASE}/api/tmdb/movie/${media.tmdbId}/images`;
    }
    return `${API_BASE}/api/tmdb/tv/${media.tmdbId}/season/${media.seasonId}/episode/${media.episodeId}/images`;
}

async function vfetch(
    url: string,
    headers: Record<string, string>
): Promise<Response> {
    return fetch(url, {
        method: 'GET',
        headers: {
            ...BROWSER_HEADERS,
            Accept: 'text/plain',
            Origin: PAGE_ORIGIN,
            Referer: `${PAGE_ORIGIN}/`,
            ...headers
        },
        signal: AbortSignal.timeout(20_000)
    });
}

type DecodedSource = {
    server?: string;
    url?: string;
    file?: string;
};
type DecodedResponse = {
    sources?: DecodedSource[] | { file?: string; url?: string };
    servers?: Record<string, unknown>;
};

function extractServers(decoded: DecodedResponse): string[] {
    if (Array.isArray(decoded.sources)) {
        if (decoded.servers && Object.keys(decoded.servers).length > 0) {
            return Object.keys(decoded.servers);
        }
        const set = new Set<string>();
        for (const s of decoded.sources) if (s?.server) set.add(s.server);
        return [...set];
    }
    return decoded.servers ? Object.keys(decoded.servers) : [];
}

function extractUrl(decoded: DecodedResponse, server: string): string {
    const src = decoded.sources;
    if (Array.isArray(src)) {
        const match =
            src.find((s) => s?.server?.toLowerCase?.() === server) ??
            src.find((s) => s?.server);
        if (match && typeof match.url === 'string' && match.url.trim()) {
            return match.url;
        }
    } else if (src && typeof src === 'object') {
        const u = src.file ?? src.url ?? '';
        if (typeof u === 'string' && u.trim()) return u;
    }
    return '';
}

/**
 * Build the exact first (server-list) request we would send, for debugging.
 * Returns the url + full header map (browser headers + signed headers).
 */
export async function buildListRequest(
    media: VidsrcMedia,
    opts: ResolveOptions = {}
): Promise<{ url: string; headers: Record<string, string> }> {
    const { getImgKey } = await ensureVidsrcWasm();
    const key =
        opts.keyOverride && opts.keyOverride.length === 64
            ? opts.keyOverride
            : getImgKey();
    const url = buildImageApiUrl(media);
    const secure = await buildSecureHeaders(key, url, opts.fpOverride);
    const headers: Record<string, string> = {
        ...BROWSER_HEADERS,
        Accept: 'text/plain',
        Origin: PAGE_ORIGIN,
        Referer: `${PAGE_ORIGIN}/`,
        bW90aGFmYWth: '1',
        ...secure
    };
    return { url, headers };
}

/**
 * Resolve the first working stream url for a movie/episode.
 */
export async function resolveVidsrc(
    media: VidsrcMedia,
    opts: ResolveOptions = {}
): Promise<VidsrcResolved> {
    const { getImgKey, processImgData } = await ensureVidsrcWasm();
    clearVidsrcSession();
    const key =
        opts.keyOverride && opts.keyOverride.length === 64
            ? opts.keyOverride
            : getImgKey();
    if (!key || key.length !== 64) {
        throw new Error(`Invalid WASM key (length ${key?.length ?? 0})`);
    }
    if (opts.debug) {
        console.log(
            `[vidsrc] key source: ${opts.keyOverride ? 'OVERRIDE' : 'WASM'}, key: ${key}`
        );
    }

    const url = buildImageApiUrl(media);

    // Step 1: fetch + decrypt the available server list.
    const listHeaders = await buildSecureHeaders(key, url, opts.fpOverride);
    const listReqHeaders = { bW90aGFmYWth: '1', ...listHeaders };
    if (opts.debug) {
        console.log('[vidsrc] GET', url);
        console.log('[vidsrc] headers', JSON.stringify(listReqHeaders));
    }
    const listRes = await vfetch(url, listReqHeaders);
    if (!listRes.ok) {
        let body = '';
        try {
            body = (await listRes.text()).replace(/\s+/g, ' ').slice(0, 300);
        } catch {
            // ignore
        }
        throw new Error(
            `server list HTTP ${listRes.status}${body ? ` :: ${body}` : ''}`
        );
    }
    const listDecoded = JSON.parse(
        await processImgData(await listRes.text(), key)
    ) as DecodedResponse;
    const servers = extractServers(listDecoded);
    if (servers.length === 0) {
        throw new Error('No servers returned from backend');
    }

    // Step 2: try servers in NATO order, decrypt each, return first url.
    const ordered = NATO_ORDER.filter((n) => servers.includes(n)).concat(
        servers.filter((n) => !NATO_ORDER.includes(n))
    );

    for (const server of ordered) {
        try {
            const headers = await buildSecureHeaders(key, url, opts.fpOverride);
            const res = await vfetch(url, {
                'X-Only-Sources': '1',
                'X-Server': server,
                ...headers
            });
            if (!res.ok) continue;
            const decoded = JSON.parse(
                await processImgData(await res.text(), key)
            ) as DecodedResponse;
            const found = extractUrl(decoded, server);
            if (found) return { url: found, server, servers };
        } catch {
            // try next server
        }
    }

    throw new Error('No playable source from any server');
}

/**
 * Resolve ALL working servers' stream urls (one per server), in NATO order.
 * Per-server requests run in parallel; failed/empty servers are dropped.
 */
export async function resolveVidsrcAll(
    media: VidsrcMedia,
    opts: ResolveOptions = {}
): Promise<{ servers: string[]; sources: VidsrcSource[] }> {
    const { getImgKey, processImgData } = await ensureVidsrcWasm();
    clearVidsrcSession();
    const key =
        opts.keyOverride && opts.keyOverride.length === 64
            ? opts.keyOverride
            : getImgKey();
    if (!key || key.length !== 64) {
        throw new Error(`Invalid WASM key (length ${key?.length ?? 0})`);
    }

    const url = buildImageApiUrl(media);

    // Step 1: fetch + decrypt the available server list.
    const listHeaders = await buildSecureHeaders(key, url, opts.fpOverride);
    const listRes = await vfetch(url, { bW90aGFmYWth: '1', ...listHeaders });
    if (!listRes.ok) {
        let body = '';
        try {
            body = (await listRes.text()).replace(/\s+/g, ' ').slice(0, 300);
        } catch {
            // ignore
        }
        throw new Error(
            `server list HTTP ${listRes.status}${body ? ` :: ${body}` : ''}`
        );
    }
    const listDecoded = JSON.parse(
        await processImgData(await listRes.text(), key)
    ) as DecodedResponse;
    const servers = extractServers(listDecoded);
    if (servers.length === 0) {
        throw new Error('No servers returned from backend');
    }

    const ordered = NATO_ORDER.filter((n) => servers.includes(n)).concat(
        servers.filter((n) => !NATO_ORDER.includes(n))
    );

    // Step 2: resolve servers with a bounded concurrency pool (no delay by
    // default) and collect every server that yields a url, up to `maxSources`.
    // A pool is used instead of firing all at once so a huge burst doesn't
    // wipe out the whole batch; raise `concurrency` for more speed.
    const maxSources = opts.maxSources ?? 20;
    const concurrency = Math.max(1, opts.concurrency ?? 8);
    const delayMs = opts.delayMs ?? 0;

    const sources: VidsrcSource[] = [];
    let next = 0;

    const worker = async (): Promise<void> => {
        while (next < ordered.length && sources.length < maxSources) {
            const server = ordered[next++];
            try {
                const headers = await buildSecureHeaders(
                    key,
                    url,
                    opts.fpOverride
                );
                const res = await vfetch(url, {
                    'X-Only-Sources': '1',
                    'X-Server': server,
                    ...headers
                });
                if (res.ok) {
                    const decoded = JSON.parse(
                        await processImgData(await res.text(), key)
                    ) as DecodedResponse;
                    const found = extractUrl(decoded, server);
                    if (found) sources.push({ server, url: found });
                }
            } catch {
                // skip this server and continue
            }
            if (delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, ordered.length) }, () =>
            worker()
        )
    );

    if (sources.length === 0) {
        throw new Error('No playable source from any server');
    }

    // Keep a stable NATO-ish order for display.
    sources.sort(
        (a, b) => ordered.indexOf(a.server) - ordered.indexOf(b.server)
    );
    return { servers, sources };
}
