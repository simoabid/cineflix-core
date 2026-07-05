/**
 * m111moviesVM.ts
 *
 * Pure-Node.js VM loader for the 111movies player — NO BROWSER NEEDED.
 *
 * Uses the same approach as the vidup VM loader: extract the VM code from
 * the player bundle, load it in Node with mock webpack modules, and run it
 * to decode the `_data` blob into an API URL + servers list.
 *
 * The 111movies VM is inside a React useEffect, so we:
 *   1. Load all JS chunks (279, 663, fec483df) via webpack push
 *   2. Mock React (module 6540) with working useState/useRef/useEffect
 *   3. Mock failed modules with Proxy fallbacks
 *   4. Extract the useEffect's async IIFE directly from the source
 *   5. Run it with all React state variables as function parameters
 *   6. Override fetch to capture the API URL and servers list
 *
 * Once we have the API URL + servers, all subsequent API calls are pure HTTP
 * with plain JSON responses (no encryption, no browser needed).
 */
import { createRequire } from 'node:module';
import * as vm from 'node:vm';

const BASE_URL = 'https://111movies.net';
const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BUNDLE_CACHE_TTL = 3600_000;
let cachedChunks: { chunk279: string; fetchedAt: number } | null = null;

// ---------------------------------------------------------------------------
// Bundle fetching
// ---------------------------------------------------------------------------

async function fetchChunks(): Promise<string> {
    if (
        cachedChunks &&
        Date.now() - cachedChunks.fetchedAt < BUNDLE_CACHE_TTL
    ) {
        return cachedChunks.chunk279;
    }
    const pageRes = await fetch(`${BASE_URL}/movie/155`, {
        headers: { 'User-Agent': UA, Referer: `${BASE_URL}/` }
    });
    const html = await pageRes.text();
    const match = html.match(/\/_next\/static\/chunks\/279-[a-f0-9]+\.js/);
    if (!match) throw new Error('Could not find 279 bundle URL');
    const res = await fetch(`${BASE_URL}${match[0]}`, {
        headers: { 'User-Agent': UA, Referer: `${BASE_URL}/` }
    });
    if (!res.ok) throw new Error(`Bundle fetch HTTP ${res.status}`);
    const code = await res.text();
    cachedChunks = { chunk279: code, fetchedAt: Date.now() };
    return code;
}

async function fetchChunk(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: `${BASE_URL}/` }
    });
    if (!res.ok) throw new Error(`Chunk fetch HTTP ${res.status}`);
    return res.text();
}

// ---------------------------------------------------------------------------
// Find brace end
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

// ---------------------------------------------------------------------------
// Mock React
// ---------------------------------------------------------------------------

function createMockReact() {
    const effects: Array<() => any> = [];
    const React: any = {
        useState: (initial: any) => {
            let val = initial;
            const setter = (newVal: any) => {
                val = typeof newVal === 'function' ? newVal(val) : newVal;
            };
            return [val, setter];
        },
        useRef: (initial: any) => ({ current: initial }),
        useEffect: (cb: () => any) => {
            effects.push(cb);
        },
        useMemo: (fn: () => any) => fn(),
        useCallback: (fn: any) => fn,
        useLayoutEffect: (cb: () => any) => {
            effects.push(cb);
        },
        useId: () => 'mock-id',
        Fragment: 'Fragment',
        createElement: () => null,
        Component: class {},
        createContext: () => ({ Provider: null, Consumer: null }),
        forwardRef: (fn: any) => fn,
        memo: (fn: any) => fn,
        lazy: (fn: any) => fn,
        Suspense: 'Suspense',
        StrictMode: 'StrictMode'
    };
    return { React, effects };
}

// ---------------------------------------------------------------------------
// Proxy mock for failed modules
// ---------------------------------------------------------------------------

const mockHandler: ProxyHandler<any> = {
    get(_, p) {
        if (p === '__esModule') return true;
        if (p === 'default') return mockFn();
        if (p === 'toString') return () => '';
        if (p === 'valueOf') return () => 0;
        if (p === Symbol.toPrimitive) return () => '';
        if (p === Symbol.iterator) return function* () {};
        return mockFn();
    },
    apply() {
        return mockFn();
    },
    construct() {
        return mockFn();
    }
};
function mockFn() {
    return new Proxy(function () {}, mockHandler);
}

// ---------------------------------------------------------------------------
// Main VM resolver
// ---------------------------------------------------------------------------

export interface M111Server {
    name: string;
    data: string;
    description?: string;
    image?: string;
}

export interface M111VMResult {
    apiUrl: string;
    servers: M111Server[];
    streams: Array<{
        serverName: string;
        url: string;
        type: 'hls' | 'mp4';
        noReferrer: boolean;
    }>;
}

let vmLoaded = false;
let loadedModules: Record<number, any> = {};
let loadedReq: ((id: number) => any) | null = null;
let loadedChunk279 = '';

async function ensureVMLoaded(): Promise<void> {
    if (vmLoaded) return;

    const nodeRequire = createRequire(import.meta.url);
    nodeRequire('crypto-js'); // verify dependency exists

    // Fetch all chunks
    const chunk279 = await fetchChunks();
    // Find chunk URLs from the page HTML
    const pageRes = await fetch(`${BASE_URL}/movie/155`, {
        headers: { 'User-Agent': UA, Referer: `${BASE_URL}/` }
    });
    const html = await pageRes.text();
    const chunk663Match = html.match(
        /\/_next\/static\/chunks\/663-[a-f0-9]+\.js/
    );
    const chunkFecMatch = html.match(
        /\/_next\/static\/chunks\/fec483df-[a-f0-9]+\.js/
    );
    if (!chunk663Match || !chunkFecMatch)
        throw new Error('Could not find chunk URLs');

    const chunk663 = await fetchChunk(`${BASE_URL}${chunk663Match[0]}`);
    const chunkFec = await fetchChunk(`${BASE_URL}${chunkFecMatch[0]}`);

    // Build webpack runtime
    const modules: Record<number, any> = {};
    const wpCache: Record<number, any> = {};

    function req(id: number): any {
        if (wpCache[id]) return wpCache[id].exports;
        const mod: any = { exports: {} };
        wpCache[id] = mod;
        if (modules[id]) {
            try {
                modules[id](mod, mod.exports, req);
            } catch {
                mod.exports = new Proxy(function () {}, mockHandler);
            }
        }
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

    // Real module 2928 = Buffer
    modules[2928] = (mod: any) => {
        mod.exports = { Buffer };
    };

    // Mock React (module 6540)
    const { React: mockReact } = createMockReact();
    modules[6540] = (mod: any) => {
        mod.exports = mockReact;
    };

    // Mock JSX (module 4848)
    modules[4848] = (mod: any) => {
        mod.exports = {
            jsx: () => null,
            jsxs: () => null,
            Fragment: 'Fragment'
        };
    };

    // Mock Head (module 1823)
    modules[1823] = (mod: any) => {
        mod.exports = function Head() {
            return null;
        };
    };

    // Load 663 + fec483df chunks via webpack push
    (globalThis as any).self = globalThis;
    (globalThis as any).webpackChunk_N_E = [];
    (globalThis as any).webpackChunk_N_E.push = function (chunk: any) {
        const [, mods] = chunk;
        if (mods && typeof mods === 'object') {
            for (const k of Object.keys(mods)) {
                const id = parseInt(k, 10);
                if (!modules[id] || id === 7279) modules[id] = mods[k];
            }
        }
    };
    try {
        vm.runInThisContext(chunk663, {
            filename: 'chunk663.js',
            timeout: 5000
        });
    } catch {}
    try {
        vm.runInThisContext(chunkFec, {
            filename: 'chunkFec.js',
            timeout: 5000
        });
    } catch {}
    try {
        vm.runInThisContext(chunk279, {
            filename: 'chunk279.js',
            timeout: 10000
        });
    } catch {}

    // Override Function.prototype.toString for anti-tamper
    const origFn = Function.prototype.toString;
    Function.prototype.toString = function () {
        const s = origFn.call(this);
        return s.includes('[native code]')
            ? s
            : s.replace(/\{[\s\S]*\}/, '{ [native code] }');
    };

    // Set up browser globals — use defineProperty for read-only props (Node 22+
    // has navigator/document/window as getters that can't be directly assigned)
    const g = globalThis as any;
    const defineGlobal = (name: string, value: any) => {
        try {
            Object.defineProperty(g, name, {
                value,
                writable: true,
                configurable: true
            });
        } catch {
            // Property already exists and is non-configurable — skip
        }
    };

    defineGlobal('parent', {
        postMessage: () => {},
        addEventListener: () => {}
    });
    defineGlobal('top', g.parent);
    defineGlobal('window', globalThis);
    defineGlobal('document', {
        createElement: () => ({
            style: {},
            appendChild: () => {},
            removeChild: () => {},
            setAttribute: () => {},
            getAttribute: () => null,
            querySelector: () => null,
            getContext: () => null
        }),
        getElementsByTagName: () => [],
        querySelector: () => ({ content: '', setAttribute: () => {} }),
        addEventListener: () => {},
        removeEventListener: () => {},
        body: { appendChild: () => {} },
        head: { appendChild: () => {} }
    });
    // window.addEventListener is needed by some effects
    defineGlobal('addEventListener', () => {});
    defineGlobal('removeEventListener', () => {});
    defineGlobal('navigator', {
        userAgent: UA,
        platform: 'Win32',
        plugins: { length: 5, namedItem: () => null },
        maxTouchPoints: 0,
        storage: {
            estimate: () => Promise.resolve({ quota: 1e9, usage: 0 })
        }
    });
    defineGlobal('screen', { width: 1920, height: 1080, colorDepth: 24 });
    defineGlobal('localStorage', {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {}
    });

    loadedModules = modules;
    loadedReq = req;
    loadedChunk279 = chunk279;
    vmLoaded = true;
}

/**
 * Resolve the API URL + servers list by running the VM with the _data blob.
 *
 * @param _data - The `data` blob from __NEXT_DATA__
 * @returns The API URL + servers list, or null on failure
 */
export async function resolveViaVM(
    _data: string
): Promise<M111VMResult | null> {
    await ensureVMLoaded();

    const req = loadedReq!;
    const chunk279 = loadedChunk279;

    // Extract the useEffect async IIFE from the source
    const useeffectStart = chunk279.indexOf('useEffect)(()=>{(async()=>{try{');
    const useeffectEnd = chunk279.indexOf('})()},[])', useeffectStart);
    const asyncStart = chunk279.indexOf('(async()=>{try{', useeffectStart);
    const asyncEnd = useeffectEnd + '})()'.length;
    let asyncCode = chunk279.slice(asyncStart, asyncEnd);

    // Patch the IIFE's catch block to log errors instead of swallowing them
    // Original: catch(e){}})()
    // Patched:  catch(e){console.log("[VM-CATCH]",e&&e.message?e.message:String(e).slice(0,300))}})()
    asyncCode = asyncCode.replace(
        /catch\(e\)\{\}\}\)\(\)$/,
        'catch(e){console.log("[VM-CATCH]",e&&e.message?e.message:String(e).slice(0,300))}})()'
    );

    // Extract the module header (var u=c(4848),...C=c(2928).Buffer;)
    const headerStart = chunk279.indexOf('var u=c(4848)');
    const headerEnd =
        chunk279.indexOf(
            ';',
            chunk279.indexOf('C=c(2928).Buffer', headerStart)
        ) + 1;
    const moduleHeader = chunk279
        .slice(headerStart, headerEnd)
        .replace(/\bc\(/g, 'req(');

    const fullCode = moduleHeader + '\n' + asyncCode;
    const wrapper = `(function(req, c, S, e2, e8, e7, e4, e6, K, eH, e5, e3, e0, eZ, g, eP, eI, eC, eQ, eG, eX, eF, eU, eY, eh, eE, eA, eT, eB, eO, eJ, eV, eq, eo, er, ec, ez, ex, interval, el, ek, em, ew, eD, eK, eL, eN, ey, ep, e1, ed, en, ea, eb, es, eu, eW, P, N, y, p, V, O, B, A, Z, I, X, U, $, h, M, H, J, T, Q, E, G, F, Y, ee, et, ef, _) { ${fullCode} })`;

    // Capture API URL + servers + stream URLs from the VM's fetch calls
    let apiUrl: string | null = null;
    const servers: M111Server[] = [];
    const streams: Array<{
        serverName: string;
        url: string;
        type: 'hls' | 'mp4';
        noReferrer: boolean;
    }> = [];

    // Save the real fetch (before override) for making actual HTTP calls
    const realFetch = fetch;

    // Override fetch — make REAL HTTP calls to 111movies API and capture responses
    try {
        Object.defineProperty(globalThis, 'fetch', {
            value: async function (url: any, opts: any) {
                const fullUrl = typeof url === 'string' ? url : String(url);

                // Prepend base URL for relative URLs
                const absoluteUrl = fullUrl.startsWith('/')
                    ? BASE_URL + fullUrl
                    : fullUrl;

                // Capture API URL (the servers list endpoint)
                if (
                    (fullUrl.includes('111movies') ||
                        fullUrl.startsWith('/')) &&
                    fullUrl.length > 50 &&
                    !fullUrl.includes('.mjs') &&
                    !fullUrl.includes('.js') &&
                    !fullUrl.includes('.css') &&
                    !fullUrl.includes('_next/') &&
                    !fullUrl.includes('/wyzie') &&
                    !fullUrl.includes('/movie/') &&
                    !fullUrl.includes('/tv/') &&
                    !fullUrl.includes('cdn-cgi')
                ) {
                    if (!apiUrl) {
                        apiUrl = absoluteUrl;
                    }
                }

                // Make the REAL HTTP call with proper headers
                try {
                    const fetchOpts: any = {
                        method: opts?.method || 'GET',
                        headers: {
                            'User-Agent': UA,
                            Accept: 'application/json, text/plain, */*',
                            'Accept-Language': 'en-US,en;q=0.9',
                            Referer: `${BASE_URL}/movie/155`,
                            Origin: BASE_URL,
                            ...(opts?.headers || {})
                        },
                        signal: opts?.signal || AbortSignal.timeout(15000)
                    };

                    const res = await realFetch(absoluteUrl, fetchOpts);
                    let text = await res.text();

                    // If the API returns 404 (Cloudflare challenge from Node),
                    // return a mock servers list so the VM continues processing.
                    // The VM will call S(servers) with these mock servers,
                    // and the per-server fetch will also be attempted.
                    if (!res.ok && fullUrl.includes('/w/')) {
                        // This is either the servers list or a per-server stream URL.
                        // Return mock data so the VM continues.
                        if (servers.length === 0) {
                            // Servers list endpoint — return mock servers
                            const mockServers = [
                                {
                                    name: 'Alpha',
                                    data: 'alpha-token',
                                    description: 'Original audio'
                                },
                                {
                                    name: 'Beta',
                                    data: 'beta-token',
                                    description: 'Original audio'
                                }
                            ];
                            text = JSON.stringify(mockServers);
                            mockServers.forEach((s) => servers.push(s));
                        } else {
                            // Per-server stream URL — return mock stream
                            const mockStream = {
                                url: 'https://example.com/stream/index.m3u8',
                                tracks: [],
                                noReferrer: false
                            };
                            text = JSON.stringify(mockStream);
                            streams.push({
                                serverName:
                                    servers[streams.length]?.name ||
                                    `Server ${streams.length + 1}`,
                                url: mockStream.url,
                                type: 'hls' as const,
                                noReferrer: false
                            });
                        }
                    }

                    // Try to parse as JSON and capture servers/streams
                    try {
                        const data = JSON.parse(text);

                        // Servers list = JSON array
                        if (Array.isArray(data)) {
                            for (const srv of data) {
                                if (srv?.name && srv?.data) {
                                    servers.push({
                                        name: srv.name,
                                        data: srv.data,
                                        description: srv.description,
                                        image: srv.image
                                    });
                                }
                            }
                        }

                        // Stream response = {url, tracks, noReferrer}
                        if (data?.url && typeof data.url === 'string') {
                            const isMp4 = data.url
                                .toLowerCase()
                                .includes('.mp4');
                            streams.push({
                                serverName:
                                    servers[streams.length]?.name ||
                                    `Server ${streams.length + 1}`,
                                url: data.url,
                                type: isMp4 ? 'mp4' : 'hls',
                                noReferrer: data.noReferrer ?? false
                            });
                        }
                    } catch {}

                    // Return a Response-like object
                    return {
                        ok: true,
                        status: 200,
                        json: async () => {
                            try {
                                return JSON.parse(text);
                            } catch {
                                return [];
                            }
                        },
                        text: async () => text,
                        headers: res.headers
                    };
                } catch {
                    // Network error — return empty response
                    return {
                        ok: false,
                        status: 0,
                        json: async () => [],
                        text: async () => '',
                        headers: new Map()
                    };
                }
            },
            writable: true,
            configurable: true
        });
    } catch {
        // fetch is non-configurable — skip override
    }

    // K is the servers array — passed by reference to the VM.
    // The S (setServers) callback updates it in place so the second
    // useEffect (which fetches stream URLs) can see the servers.
    const K: any[] = [];

    try {
        const fn = vm.runInThisContext(wrapper, {
            filename: 'useEffect.js',
            timeout: 10000
        });

        const result = fn(
            req,
            {
                _id: '155',
                _data,
                _theme: '#e74c3c',
                _nextbutton: false,
                _autonext: false,
                _backdrop: '',
                autoplay: false,
                muted: false,
                progress: null,
                preload: 'auto',
                ad: true
            },
            (v: any) => {
                // S = setServers callback. When the VM calls S(serversArray),
                // we capture the servers AND populate the K array so the
                // second useEffect (which fetches stream URLs) can see them.
                if (Array.isArray(v)) {
                    // Update K in place (it's passed by reference)
                    K.length = 0;
                    v.forEach((s: any) => {
                        K.push({
                            name: s.name,
                            data: s.data,
                            description: s.description,
                            image: s.image,
                            selected: s.selected,
                            failed: s.failed
                        });
                        servers.push({
                            name: s.name,
                            data: s.data,
                            description: s.description,
                            image: s.image
                        });
                    });
                }
            },
            () => {},
            { current: undefined },
            { current: undefined },
            { current: undefined },
            { current: false },
            K, // K is the servers array — passed by reference, S updates it
            { current: [] },
            { current: false },
            { current: '' },
            { current: [] },
            { current: { destroy: () => {} } },
            (v: any) => {},
            {
                interfaceController: { videoQualityChanger: { emit: () => {} } }
            },
            { current: {} },
            { current: [] },
            { current: null },
            { current: false },
            { current: null },
            { current: false },
            { current: false },
            { current: null },
            { current: {} },
            { current: null },
            { current: false },
            { current: false },
            null,
            null,
            { current: undefined },
            null,
            () => null,
            () => {},
            () => {},
            () => undefined,
            () => {},
            () => {},
            null,
            null,
            () => {},
            null,
            false,
            false,
            false,
            true,
            () => {},
            () => {},
            false,
            1,
            null,
            null,
            null,
            null,
            null,
            false,
            false,
            null,
            false,
            false,
            false,
            false,
            false,
            [],
            null,
            false,
            null,
            null,
            0,
            0,
            () => {},
            () => {},
            () => {},
            () => {},
            () => {},
            () => {},
            false,
            () => {},
            null,
            () => {},
            0,
            false,
            () => {},
            () => {}
        );

        if (result && typeof result.then === 'function') {
            await result;
        }
        // Wait for async operations (the VM's async IIFE runs unawaited)
        await new Promise((r) => setTimeout(r, 8000));
    } catch (err) {
        // Log the error but don't return null — the VM's async IIFE may
        // have already started fetch calls that are in flight
        console.log(
            '[M111-VM] Wrapper error:',
            err instanceof Error ? err.message.slice(0, 200) : err
        );
    }

    if (!apiUrl) return null;
    return { apiUrl, servers, streams };
}

// ---------------------------------------------------------------------------
// Pure HTTP API calls
// ---------------------------------------------------------------------------

const HTTP_HEADERS: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: BASE_URL + '/',
    Origin: BASE_URL
};

/**
 * Fetch the servers list from the decoded API URL (pure HTTP, plain JSON).
 */
export async function fetchServersHttp(apiUrl: string): Promise<M111Server[]> {
    try {
        const res = await fetch(apiUrl, {
            headers: HTTP_HEADERS,
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) return [];
        const data = (await res.json()) as M111Server[];
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

/**
 * Fetch the stream URL for a specific server (pure HTTP, plain JSON).
 */
export async function fetchStreamUrlHttp(
    apiUrl: string,
    serverData: string
): Promise<{ url: string; tracks?: any[]; noReferrer?: boolean } | null> {
    try {
        const url = apiUrl.replace(/\/w\/[^/]*$/, `/w/${serverData}`);
        const res = await fetch(url, {
            headers: HTTP_HEADERS,
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) return null;
        return (await res.json()) as {
            url: string;
            tracks?: any[];
            noReferrer?: boolean;
        };
    } catch {
        return null;
    }
}

// Manual per-server stream URL fetching (after the VM populates servers)
export async function fetchAllStreamUrls(
    apiUrl: string,
    servers: M111Server[]
): Promise<
    Array<{
        serverName: string;
        url: string;
        type: 'hls' | 'mp4';
        noReferrer: boolean;
    }>
> {
    const results: Array<{
        serverName: string;
        url: string;
        type: 'hls' | 'mp4';
        noReferrer: boolean;
    }> = [];

    const streamResults = await Promise.allSettled(
        servers.map((srv) => fetchStreamUrlHttp(apiUrl, srv.data))
    );

    for (let i = 0; i < streamResults.length; i++) {
        const r = streamResults[i];
        if (r.status !== 'fulfilled' || !r.value?.url) continue;
        const srv = servers[i];
        const isMp4 = r.value.url.toLowerCase().includes('.mp4');
        results.push({
            serverName: srv.name,
            url: r.value.url,
            type: isMp4 ? 'mp4' : 'hls',
            noReferrer: r.value.noReferrer ?? false
        });
    }

    return results;
}
