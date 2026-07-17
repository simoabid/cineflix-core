/**
 * Hexa stream resolver — same WASM crypto as vidsrc, plus Cap.js x-cap-token.
 *
 * Hosts:
 *   SPA:     https://hexa.su
 *   API:     https://theemoviedb.hexa.su
 *   Cap:     https://cap.hexa.su/15d2cf0395/
 *
 * Flow (browser-faithful):
 *   1. Mint Cap token (PoW + instrumentation math) → x-cap-token
 *   2. WASM getImgKey + HMAC-signed GET /api/tmdb/.../images (list)
 *   3. Decrypt list, fan out per-server with X-Only-Sources / X-Server
 *
 * CAVEATS: resolve ≠ playback (CDN may still 403/410 via proxy); local green
 * does not prove EC2/production. See hexa.ts header + docs/HEXA-SCRAPING.md.
 */
import { clearVidsrcSession, ensureVidsrcWasm } from '../vidsrc/vidsrcWasm.js';
import { mintCapToken } from './capSolver.js';

const API_BASE = 'https://theemoviedb.hexa.su';
const PAGE_ORIGIN = 'https://hexa.su';

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'X-Fingerprint-Lite': 'e9136c41504646444'
};

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

export interface HexaMedia {
    type: 'movie' | 'tv';
    tmdbId: string;
    seasonId?: number;
    episodeId?: number;
}

export interface HexaSource {
    server: string;
    url: string;
}

export interface ResolveOptions {
    maxSources?: number;
    concurrency?: number;
    debug?: boolean;
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
    crypto.getRandomValues(bytes);
    return toBase64(bytes).replace(/[/+=]/g, '').substring(0, 22);
}

function generateClientFingerprint(): string {
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
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        enc.encode(key),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign(
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
            headers: {
                ...BROWSER_HEADERS,
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
    url: string
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
    const fingerprint = generateClientFingerprint();
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

function buildImageApiUrl(media: HexaMedia): string {
    if (media.type === 'movie') {
        return `${API_BASE}/api/tmdb/movie/${media.tmdbId}/images`;
    }
    return `${API_BASE}/api/tmdb/tv/${media.tmdbId}/season/${media.seasonId}/episode/${media.episodeId}/images`;
}

async function hfetch(
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
 * Resolve all working Hexa servers for a title.
 */
export async function resolveHexaAll(
    media: HexaMedia,
    opts: ResolveOptions = {}
): Promise<{ servers: string[]; sources: HexaSource[] }> {
    const { getImgKey, processImgData } = await ensureVidsrcWasm();
    clearVidsrcSession();
    const key = getImgKey();
    if (!key || key.length !== 64) {
        throw new Error(`Invalid WASM key (length ${key?.length ?? 0})`);
    }

    const url = buildImageApiUrl(media);

    // Step 1: server list (bW90aGFmYWth list flag, same as vidsrc).
    // Cap tokens can be rejected mid-audit (captcha_required) even when mint
    // succeeded — re-mint with force and retry the list once.
    let capToken = await mintCapToken();
    let listRes: Response | null = null;
    let listBody = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        const listHeaders = await buildSecureHeaders(key, url);
        listRes = await hfetch(url, {
            bW90aGFmYWth: '1',
            'x-cap-token': capToken,
            ...listHeaders
        });
        if (listRes.ok) break;
        try {
            listBody = (await listRes.text()).replace(/\s+/g, ' ').slice(0, 300);
        } catch {
            listBody = '';
        }
        const needsFreshCap =
            listRes.status === 403 ||
            /captcha_required|cap.?token|invalid.?token/i.test(listBody);
        if (!needsFreshCap || attempt === 1) {
            throw new Error(
                `server list HTTP ${listRes.status}${listBody ? ` :: ${listBody}` : ''}`
            );
        }
        capToken = await mintCapToken({ force: true });
    }
    if (!listRes || !listRes.ok) {
        throw new Error(
            `server list HTTP ${listRes?.status ?? 0}${listBody ? ` :: ${listBody}` : ''}`
        );
    }
    const listDecoded = JSON.parse(
        await processImgData(await listRes.text(), key)
    ) as DecodedResponse;
    const servers = extractServers(listDecoded);
    if (servers.length === 0) {
        throw new Error('No servers returned from Hexa backend');
    }

    if (opts.debug) {
        console.log('[hexa] servers', servers);
    }

    const ordered = NATO_ORDER.filter((n) => servers.includes(n)).concat(
        servers.filter((n) => !NATO_ORDER.includes(n))
    );

    const maxSources = opts.maxSources ?? 20;
    const concurrency = Math.max(1, opts.concurrency ?? 8);
    const sources: HexaSource[] = [];
    let next = 0;

    const worker = async (): Promise<void> => {
        while (next < ordered.length && sources.length < maxSources) {
            const server = ordered[next++];
            try {
                clearVidsrcSession();
                const headers = await buildSecureHeaders(key, url);
                const res = await hfetch(url, {
                    'X-Only-Sources': '1',
                    'X-Server': server,
                    'x-cap-token': capToken,
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
                // skip server
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, ordered.length) }, () =>
            worker()
        )
    );

    if (sources.length === 0) {
        throw new Error('No playable source from any Hexa server');
    }

    sources.sort(
        (a, b) => ordered.indexOf(a.server) - ordered.indexOf(b.server)
    );
    return { servers, sources };
}
