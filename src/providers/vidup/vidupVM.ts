/**
 * vidupVM.ts
 *
 * Pure-Node.js bytecode VM loader for the vidup.to player.
 *
 * Loads the player's bytecode VM from the JS bundle, executes it with a
 * provided `en` token, and captures the resolved server list via the
 * `setServers` callback.
 *
 * This is the fast path (~800ms) — no browser needed. The VM's bytecode
 * decrypts the `en` token, makes an API call to vidup's backend, decrypts
 * the response, and produces a list of servers with per-server data tokens.
 *
 * Architecture:
 *   1. Fetch the player bundle (294-*.js) from vidup.to
 *   2. Extract module 9987's body (the VM code, before the React component)
 *   3. Provide mock webpack modules for React/MUI (the VM doesn't need them)
 *   4. Provide real modules for Buffer (5376), crypto-js (7358), and crypto (3018)
 *   5. Override globalThis.fetch to prepend the base URL and add CSRF headers
 *   6. Override Function.prototype.toString to make functions look native
 *    (the VM's anti-tamper checks for [native code])
 *   7. Call av({en, setServers, ...}) to run the VM
 *   8. Capture the server list via the setServers callback
 */
import { createRequire } from 'node:module';

const VIDUP_BASE = 'https://vidup.to';
const BUNDLE_CACHE_TTL = 3600_000; // re-fetch bundle every hour
const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CSRF_HEADERS: Record<string, string> = {
    'X-Requested-With': 'XMLHttpRequest',
    'X-Csrf-Token': 'PRXNAi2u5nlKPOd2akTf7Umma97GrjuH'
};

// Capture the ORIGINAL Function.prototype.toString at module load time.
// The VM's anti-tamper checks for [native code] in function toString.
const ORIGINAL_FN_TO_STRING = Function.prototype.toString;

function applyNativeFunctionBypass(): void {
    Function.prototype.toString = function (this: Function): string {
        const str = ORIGINAL_FN_TO_STRING.call(this);
        if (!str.includes('[native code]')) {
            return str.replace(/\{[\s\S]*\}/, '{ [native code] }');
        }
        return str;
    };
}

// ---------------------------------------------------------------------------
// Bundle fetching + caching
// ---------------------------------------------------------------------------

let cachedBundle: { code: string; fetchedAt: number } | null = null;

async function fetchBundle(): Promise<string> {
    if (
        cachedBundle &&
        Date.now() - cachedBundle.fetchedAt < BUNDLE_CACHE_TTL
    ) {
        return cachedBundle.code;
    }

    // Fetch the embed page to find the current bundle URL
    const pageRes = await fetch(`${VIDUP_BASE}/movie/155`, {
        headers: { 'User-Agent': UA, Referer: `${VIDUP_BASE}/` }
    });
    const html = await pageRes.text();
    const bundleMatch = html.match(
        /\/_next\/static\/chunks\/294-[a-f0-9]+\.js/
    );
    if (!bundleMatch) throw new Error('Could not find 294 bundle URL');
    const bundleUrl = `${VIDUP_BASE}${bundleMatch[0]}`;

    const res = await fetch(bundleUrl, {
        headers: { 'User-Agent': UA, Referer: `${VIDUP_BASE}/` }
    });
    if (!res.ok) throw new Error(`Bundle fetch HTTP ${res.status}`);
    const code = await res.text();
    cachedBundle = { code, fetchedAt: Date.now() };
    return code;
}

// ---------------------------------------------------------------------------
// Module extraction
// ---------------------------------------------------------------------------

function findBraceEnd(s: string, start: number): number {
    let depth = 1;
    let i = start + 1;
    let inStr = false;
    let strCh = '';
    let esc = false;
    while (i < s.length && depth > 0) {
        const ch = s[i];
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (inStr) {
            if (ch === strCh) inStr = false;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            inStr = true;
            strCh = ch;
        } else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return i;
}

function extractVMCode(bundle: string): string {
    const marker = '9987:(t,e,n)=>{';
    const modIdx = bundle.indexOf(marker);
    if (modIdx < 0) throw new Error('Module 9987 not found');
    const bodyStart = modIdx + marker.length;

    // Cut at "function aU(" (the React component — we don't need it)
    const aUIdx = bundle.indexOf('function aU(', bodyStart);
    if (aUIdx < 0) throw new Error('aU function not found');

    let vmCode = bundle.slice(bodyStart, aUIdx);

    // Ensure aB (string table) is included
    if (!vmCode.includes('function aB(')) {
        const aBMatch = bundle.indexOf('function aB(', aUIdx);
        if (aBMatch > 0) {
            const braceStart = bundle.indexOf('{', aBMatch);
            const braceEnd = findBraceEnd(bundle, braceStart);
            vmCode += '\n' + bundle.slice(aBMatch, braceEnd);
        }
    }

    // Patch the VM catch block to not re-throw on anti-tamper failures
    const catchPattern =
        '}catch(t){if(o[o8(1010)]){var I=o[o8(1301)]();I.v&&(n[I.v]=t),r=I.c}else throw t}';
    if (vmCode.includes(catchPattern)) {
        vmCode = vmCode.replace(catchPattern, catchPattern); // no-op, the catch is fine
    }

    // Append export code
    vmCode += `
        try {
            e.av = av; e.ag = ag; e.az = az;
            e.aB = aB; e.o7 = o7; e.o4 = o4;
            e.al = al; e.ay = ay; e.ad = ad; e.af = af;
        } catch(_) {}
    `;

    return vmCode;
}

// ---------------------------------------------------------------------------
// Webpack runtime
// ---------------------------------------------------------------------------

interface WpRuntime {
    require: (id: number) => any;
    modules: Record<number, any>;
}

function createWebpackRuntime(): WpRuntime {
    const modules: Record<number, any> = {};
    const cache: Record<number, any> = {};

    function req(id: number): any {
        if (cache[id]) return cache[id].exports;
        const mod: any = { exports: {} };
        cache[id] = mod;
        if (modules[id]) modules[id](mod, mod.exports, req);
        return mod.exports;
    }
    req.d = (e: any, d: any) => {
        for (const k in d)
            if (!e.hasOwnProperty(k))
                Object.defineProperty(e, k, { enumerable: true, get: d[k] });
    };
    req.o = (o: any, p: string) => Object.prototype.hasOwnProperty.call(o, p);
    req.r = (e: any) => Object.defineProperty(e, '__esModule', { value: true });
    req.n = (m: any) => {
        const g = m && m.__esModule ? () => m.default : () => m;
        req.d(g, { a: g });
        return g;
    };
    req.t = (v: any, m: number) => {
        if (m & 1) v = req(v);
        if (m & 8) return v;
        if (m & 4 && v && v.__esModule) return v;
        const ns = Object.create(null);
        req.r(ns);
        Object.defineProperty(ns, 'default', { enumerable: true, value: v });
        return ns;
    };
    req.g = globalThis;
    req.p = '/_next/';

    // Real modules — resolve from this file's location so it works on any machine
    const nodeRequire = createRequire(import.meta.url);
    const cryptoJs = nodeRequire('crypto-js');
    const nodeCrypto = nodeRequire('crypto');

    modules[5376] = (mod: any) => {
        mod.exports = { Buffer };
    };
    modules[7358] = (mod: any) => {
        mod.exports = cryptoJs;
    };
    modules[3018] = (mod: any) => {
        mod.exports = {
            ...nodeCrypto,
            subtle: crypto.subtle,
            getRandomValues: crypto.getRandomValues,
            randomUUID: crypto.randomUUID
        };
    };
    // Module 7457: webpack dynamic-import context (throws MODULE_NOT_FOUND)
    modules[7457] = (mod: any) => {
        function e(t: string) {
            return Promise.resolve().then(() => {
                const err: any = new Error("Cannot find module '" + t + "'");
                err.code = 'MODULE_NOT_FOUND';
                throw err;
            });
        }
        e.keys = () => [];
        e.resolve = e;
        e.id = 7457;
        mod.exports = e;
    };

    return { require: req, modules };
}

function mockRemainingModules(runtime: WpRuntime, vmCode: string): void {
    const ids = new Set<number>();
    const re = /n\((\d+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(vmCode)) !== null) {
        ids.add(parseInt(m[1], 10));
    }
    for (const id of ids) {
        if (runtime.modules[id]) continue;
        runtime.modules[id] = (mod: any) => {
            const h: ProxyHandler<any> = {
                get(_, p) {
                    return p === '__esModule' ? true : mockFn();
                },
                apply() {
                    return mockFn();
                },
                construct() {
                    return mockFn();
                }
            };
            function mockFn() {
                return new Proxy(function () {}, h);
            }
            mod.exports = new Proxy(function () {}, h);
        };
    }
}

// ---------------------------------------------------------------------------
// VM execution
// ---------------------------------------------------------------------------

export interface VidupServer {
    name: string;
    data: string;
    description?: string;
    image?: string;
}

export interface VidupVMResult {
    servers: VidupServer[];
    elapsed: number;
}

let vmExports: any = null;
let vmLoadTime = 0;

/**
 * Load the VM (once per process). Subsequent calls reuse the cached exports.
 */
async function ensureVMLoaded(): Promise<any> {
    if (vmExports && Date.now() - vmLoadTime < BUNDLE_CACHE_TTL) {
        return vmExports;
    }

    const bundle = await fetchBundle();
    const vmCode = extractVMCode(bundle);
    const runtime = createWebpackRuntime();
    mockRemainingModules(runtime, vmCode);

    const modObj: any = { exports: {} };

    // Apply anti-tamper bypass
    applyNativeFunctionBypass();

    // Override fetch to prepend base URL and add CSRF headers
    const origFetch = fetch;
    (globalThis as any).fetch = async function (url: any, opts: any) {
        let fullUrl = typeof url === 'string' ? url : String(url);
        if (fullUrl.startsWith('/')) {
            fullUrl = VIDUP_BASE + fullUrl;
        }
        opts = opts || {};
        const eh = opts.headers || {};
        const headers: Record<string, string> = {};
        if (eh instanceof Headers) {
            eh.forEach((v: string, k: string) => (headers[k] = v));
        } else if (typeof eh === 'string') {
            try {
                Object.assign(headers, JSON.parse(eh));
            } catch {}
        } else {
            Object.assign(headers, eh);
        }
        if (!headers['X-Requested-With'])
            headers['X-Requested-With'] = CSRF_HEADERS['X-Requested-With'];
        if (!headers['X-Csrf-Token'])
            headers['X-Csrf-Token'] = CSRF_HEADERS['X-Csrf-Token'];
        if (!headers['Referer']) headers['Referer'] = `${VIDUP_BASE}/`;
        if (!headers['Origin']) headers['Origin'] = VIDUP_BASE;
        opts.headers = headers;
        return origFetch(fullUrl, opts);
    };

    // Provide window.parent for VM's postMessage calls
    (globalThis as any).parent = {
        postMessage: () => {},
        addEventListener: () => {}
    };
    (globalThis as any).top = (globalThis as any).parent;

    // Execute the VM code
    const factoryCode = `(function(t, e, n) {\n${vmCode}\n})`;
    // eslint-disable-next-line no-eval
    const factory = eval(factoryCode);
    factory(modObj, modObj.exports, runtime.require);

    vmExports = modObj.exports;
    // Store the crypto module (module 3018) on the exports so resolveServersViaVM
    // can pass it to av() as props.crypto. The VM needs Node's crypto (randomBytes,
    // createCipheriv, etc.) — WebCrypto doesn't have these.
    vmExports._cryptoModule = runtime.require(3018);
    vmLoadTime = Date.now();
    return vmExports;
}

/**
 * Resolve the server list for a given `en` token by running the VM.
 *
 * @param enToken - The `en` token from the embed page's RSC payload
 * @param mediaType - "movie" or "tv" (affects the Referer header)
 * @param tmdbId - TMDB ID (for the Referer header)
 * @returns Array of servers with name + data fields
 */
export async function resolveServersViaVM(
    enToken: string,
    mediaType: 'movie' | 'tv',
    tmdbId: string
): Promise<VidupServer[]> {
    const exports = await ensureVMLoaded();
    if (typeof exports.av !== 'function') {
        throw new Error('VM not loaded: av function unavailable');
    }

    const servers: VidupServer[] = [];
    // Use the Node crypto module (stored during VM loading) — the VM needs
    // randomBytes, createCipheriv, etc. which WebCrypto doesn't provide.
    const cryptoModule = exports._cryptoModule || (globalThis as any).crypto;

    // Re-apply the Function.prototype.toString override (the VM code may
    // have reverted it during module initialization)
    applyNativeFunctionBypass();

    // Re-apply the fetch override with the correct Referer for this media
    const realFetch = fetch;
    const referer =
        mediaType === 'movie'
            ? `${VIDUP_BASE}/movie/${tmdbId}`
            : `${VIDUP_BASE}/tv/${tmdbId}`;
    (globalThis as any).fetch = async function (url: any, opts: any) {
        let fullUrl = typeof url === 'string' ? url : String(url);
        if (fullUrl.startsWith('/')) fullUrl = VIDUP_BASE + fullUrl;
        opts = opts || {};
        const eh = opts.headers || {};
        const headers: Record<string, string> = {};
        if (eh instanceof Headers) {
            eh.forEach((v: string, k: string) => (headers[k] = v));
        } else if (typeof eh === 'string') {
            try {
                Object.assign(headers, JSON.parse(eh));
            } catch {}
        } else {
            Object.assign(headers, eh);
        }
        if (!headers['X-Requested-With'])
            headers['X-Requested-With'] = CSRF_HEADERS['X-Requested-With'];
        if (!headers['X-Csrf-Token'])
            headers['X-Csrf-Token'] = CSRF_HEADERS['X-Csrf-Token'];
        if (!headers['Referer']) headers['Referer'] = referer;
        if (!headers['Origin']) headers['Origin'] = VIDUP_BASE;
        opts.headers = headers;
        return realFetch(fullUrl, opts);
    };

    // Re-apply window.parent
    (globalThis as any).parent = {
        postMessage: () => {},
        addEventListener: () => {}
    };
    (globalThis as any).top = (globalThis as any).parent;

    const props: any = {
        en: enToken,
        server: undefined,
        setServers: (s: any) => {
            if (Array.isArray(s)) {
                for (const srv of s) {
                    servers.push({
                        name: srv.name,
                        data: srv.data,
                        description: srv.description,
                        image: srv.image
                    });
                }
            }
        },
        setState: () => {},
        setFavServer: () => {},
        crypto: cryptoModule,
        encode: exports.o4,
        window: globalThis,
        document: {
            createElement: () => ({}),
            getElementsByTagName: () => [],
            addEventListener: () => {}
        },
        navigator: {
            userAgent: UA,
            platform: 'Win32',
            language: 'en-US',
            plugins: { length: 5 },
            maxTouchPoints: 0
        },
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
            clear: () => {}
        },
        console,
        JSON,
        Math,
        Date,
        RegExp,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Array,
        Object,
        Number,
        String,
        Boolean,
        Symbol,
        Function,
        screen: { width: 1920, height: 1080, colorDepth: 24 },
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        NaN,
        Infinity,
        undefined,
        Promise,
        Proxy,
        Reflect,
        Uint8Array,
        Int8Array,
        Uint16Array,
        Int16Array,
        Uint32Array,
        Int32Array,
        Float32Array,
        Float64Array,
        BigInt,
        fetch,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        AbortSignal,
        AbortController,
        Buffer,
        atob,
        btoa
    };

    await exports.av(props, {});

    // Wait a bit for async operations to complete
    await new Promise((r) => setTimeout(r, 2000));

    return servers;
}

// ---------------------------------------------------------------------------
// Per-server stream URL resolution
// ---------------------------------------------------------------------------

/**
 * The API path (constant from the bundle, string-table index 825).
 */
const API_PATH =
    '/b2b6f6ee/inu/10ca6917-3e8b-5a4d-a249-98109c7f9e13/' +
    '72aa20c98f1586a9755903679a5ccbd86b522090/' +
    '248034bb6eaf469ebf04986a057d13e17648b08aae00143c4a81c77554c833cc';

/**
 * YouTube IDs used as URL path segments (from string table indices 674, 845).
 */
const PRIMARY_YT_ID = 'qlUmUUnAo_U';

/**
 * Make a POST request to the vidup API for a specific server's stream URL.
 *
 * The response is encrypted. The player's VM decrypts it internally; we
 * return the raw encrypted response. Decryption will be handled by the VM
 * in a future enhancement, or we can attempt AES decryption using the `en`
 * token as the key.
 */
export async function fetchServerStream(
    serverData: string,
    mediaType: 'movie' | 'tv',
    tmdbId: string
): Promise<{ encryptedResponse: string; status: number } | null> {
    const apiUrl = `${VIDUP_BASE}${API_PATH}/${PRIMARY_YT_ID}/${serverData}`;
    const referer =
        mediaType === 'movie'
            ? `${VIDUP_BASE}/movie/${tmdbId}`
            : `${VIDUP_BASE}/tv/${tmdbId}`;

    try {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'User-Agent': UA,
                ...CSRF_HEADERS,
                Referer: referer,
                Origin: VIDUP_BASE,
                Accept: '*/*'
            },
            signal: AbortSignal.timeout(15_000)
        });

        if (!res.ok) return null;
        const body = await res.text();
        return { encryptedResponse: body, status: res.status };
    } catch {
        return null;
    }
}
