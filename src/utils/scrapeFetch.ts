/**
 * Scrape egress proxy (Option B).
 *
 * On AWS/EC2, many upstream scrapers return 403 / empty / WAF challenges because
 * they block datacenter IPs. This module routes selected HTTP(S) requests through
 * a residential (or other) HTTP proxy so resolve succeeds from production.
 *
 * Config (env):
 *   PROXY_URL | SCRAPE_PROXY_URL   HTTP proxy URL (user:pass@host:port)
 *   SCRAPE_PROXY_MODE             off | allowlist | all  (default: allowlist)
 *   SCRAPE_PROXY_HOSTS            comma-separated host suffixes to proxy
 *                                 (default: EC2-blocked scrape hosts from test-all)
 *   SCRAPE_PROXY_STREAM           true|false — also use proxy for OMSS /v1/proxy
 *                                 upstream fetches when host matches (default: true)
 *
 * Does NOT affect createProxyUrl / client-facing stream URLs. Only the server's
 * outbound fetch to third parties.
 */
import {
    ProxyAgent,
    fetch as undiciFetch,
    type RequestInit as UndiciRequestInit
} from 'undici';

export type ScrapeProxyMode = 'off' | 'allowlist' | 'all';

export type ScrapeFetchInit = RequestInit & {
    /**
     * auto = host allowlist (default)
     * true = always use proxy when configured
     * false = never use proxy
     */
    viaProxy?: boolean | 'auto';
    /** Abort after this many ms (sets signal if none provided). */
    timeoutMs?: number;
};

/** Hosts blocked on EC2 in diagnostic test-all (2026-07). Expand via env. */
const DEFAULT_PROXY_HOST_SUFFIXES = [
    // LookMovie
    'lmscript.xyz',
    'lookmovie2.to',
    // VixSrc
    'vixsrc.to',
    // VidKing API + page
    'speedracelight.com',
    'vidking.net',
    // VidKing CDN / probe hosts seen in production
    'interkh.com',
    'ironwallnet.com',
    // 111Movies / Vidlove (token 403 on AWS)
    'momlover.notyourtype.dad',
    'player.vidlove.cc',
    'vidlove.cc',
    // Borderline seed/token hosts that fail fast on EC2
    'wingsdatabase.com',
    'videasy.to',
    // Peachify API hosts (encrypted AES-GCM sources)
    'peachify.top',
    'eat-peach.sbs',
    // VidCore player + enc-dec (token scrape)
    'vidcore.net',
    'enc-dec.app',
    // Subtitle CDNs — OpenSubtitles / Wyzie Charlie download hosts block AWS
    // datacenter IPs (HTTP 403). Route /v1/proxy upstream via residential egress.
    'opensubtitles.org',
    'dl.opensubtitles.org',
    'rest.opensubtitles.org',
    'www.opensubtitles.org'
];

let agent: ProxyAgent | null | undefined;
let loggedStatus = false;

function envTruthy(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return defaultValue;
    return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function getScrapeProxyUrl(): string | null {
    const url =
        process.env.SCRAPE_PROXY_URL?.trim() ||
        process.env.PROXY_URL?.trim() ||
        '';
    return url || null;
}

export function getScrapeProxyMode(): ScrapeProxyMode {
    const raw = (process.env.SCRAPE_PROXY_MODE ?? 'allowlist')
        .trim()
        .toLowerCase();
    if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'disabled') {
        return 'off';
    }
    if (raw === 'all' || raw === '*') return 'all';
    return 'allowlist';
}

export function isScrapeProxyStreamEnabled(): boolean {
    return envTruthy('SCRAPE_PROXY_STREAM', true);
}

function parseHostSuffixes(): string[] {
    const raw = process.env.SCRAPE_PROXY_HOSTS?.trim();
    // Always keep built-in defaults (incl. OpenSubtitles). Custom env hosts
    // are ADDED — never replace, or Wyzie SRT downloads fall back to AWS IP
    // and hit Anubis 403 while stream VTT still works.
    const extra = raw
        ? raw
              .split(',')
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
        : [];
    return [...new Set([...DEFAULT_PROXY_HOST_SUFFIXES, ...extra])];
}

function hostMatchesSuffix(hostname: string, suffix: string): boolean {
    const h = hostname.toLowerCase();
    const s = suffix.toLowerCase().replace(/^\./, '');
    return h === s || h.endsWith(`.${s}`);
}

/**
 * Extra fuzzy matches for rotating CDN names (lookcrew*.site, etc.).
 */
function hostMatchesKnownPatterns(hostname: string): boolean {
    const h = hostname.toLowerCase();
    // Hydrogen / Oxygen style CDNs from VidKing recon
    if (/lookcrew/i.test(h) && h.endsWith('.site')) return true;
    if (/\.r2\.dev$/i.test(h)) return true;
    // Subtitle CDNs (Wyzie Charlie → OpenSubtitles) always want residential
    if (h.includes('opensubtitles.org')) return true;
    return false;
}

export function shouldProxyHost(hostname: string): boolean {
    const mode = getScrapeProxyMode();
    if (mode === 'off' || !getScrapeProxyUrl()) return false;
    if (mode === 'all') return true;
    const suffixes = parseHostSuffixes();
    if (suffixes.some((s) => hostMatchesSuffix(hostname, s))) return true;
    return hostMatchesKnownPatterns(hostname);
}

export function shouldProxyUrl(
    url: string | URL,
    viaProxy: boolean | 'auto' = 'auto'
): boolean {
    if (viaProxy === false) return false;
    if (!getScrapeProxyUrl() || getScrapeProxyMode() === 'off') return false;
    if (viaProxy === true) return true;
    try {
        const u = typeof url === 'string' ? new URL(url) : url;
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        return shouldProxyHost(u.hostname);
    } catch {
        return false;
    }
}

function getAgent(): ProxyAgent | null {
    if (agent !== undefined) return agent;
    const proxyUrl = getScrapeProxyUrl();
    if (!proxyUrl || getScrapeProxyMode() === 'off') {
        agent = null;
        return agent;
    }
    try {
        agent = new ProxyAgent(proxyUrl);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scrapeFetch] Failed to create ProxyAgent: ${msg}`);
        agent = null;
    }
    return agent;
}

/** Safe status for logs (no password). */
export function getScrapeProxyStatus(): {
    enabled: boolean;
    mode: ScrapeProxyMode;
    stream: boolean;
    hostCount: number;
    proxyDisplay: string | null;
} {
    const proxyUrl = getScrapeProxyUrl();
    const mode = getScrapeProxyMode();
    let proxyDisplay: string | null = null;
    if (proxyUrl) {
        try {
            const u = new URL(proxyUrl);
            const auth = u.username ? `${u.username}@` : '';
            proxyDisplay = `${u.protocol}//${auth}${u.host}`;
        } catch {
            proxyDisplay = '(invalid PROXY_URL)';
        }
    }
    return {
        enabled: Boolean(proxyUrl) && mode !== 'off',
        mode,
        stream: isScrapeProxyStreamEnabled(),
        hostCount: parseHostSuffixes().length,
        proxyDisplay
    };
}

export function logScrapeProxyStatus(prefix = '[scrapeFetch]'): void {
    if (loggedStatus) return;
    loggedStatus = true;
    const s = getScrapeProxyStatus();
    if (!s.enabled) {
        console.log(
            `${prefix} egress proxy OFF (set PROXY_URL or SCRAPE_PROXY_URL to enable Option B)`
        );
        return;
    }
    console.log(
        `${prefix} egress proxy ON mode=${s.mode} stream=${s.stream} hosts=${s.hostCount} via ${s.proxyDisplay}`
    );
}

/**
 * Drop hop-by-hop / compressed body headers that confuse undici when replaying.
 */
function normalizeHeaders(
    headers?: RequestInit['headers']
): Record<string, string> | undefined {
    if (!headers) return undefined;
    const out: Record<string, string> = {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((v, k) => {
            out[k] = v;
        });
    } else if (Array.isArray(headers)) {
        for (const pair of headers) {
            const k = pair[0];
            const v = pair[1];
            if (typeof k === 'string' && typeof v === 'string') out[k] = v;
        }
    } else {
        for (const [k, v] of Object.entries(
            headers as Record<string, string>
        )) {
            if (typeof v === 'string') out[k] = v;
        }
    }
    // Let undici handle encoding
    delete out['accept-encoding'];
    delete out['Accept-Encoding'];
    return out;
}

/**
 * Fetch that optionally routes through the scrape egress proxy.
 * Drop-in for global `fetch` in scrapers.
 */
export async function scrapeFetch(
    input: string | URL | Request,
    init: ScrapeFetchInit = {}
): Promise<Response> {
    const { viaProxy = 'auto', timeoutMs, ...rest } = init;

    let urlStr: string;
    if (typeof input === 'string') {
        urlStr = input;
    } else if (input instanceof URL) {
        urlStr = input.href;
    } else {
        urlStr = input.url;
    }

    let signal = rest.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (!signal && timeoutMs != null && timeoutMs > 0) {
        const ac = new AbortController();
        signal = ac.signal;
        timeout = setTimeout(() => ac.abort(), timeoutMs);
    }

    const useProxy = shouldProxyUrl(urlStr, viaProxy);
    const headers = normalizeHeaders(rest.headers);

    try {
        if (useProxy) {
            const dispatcher = getAgent();
            if (dispatcher) {
                const undiciInit: UndiciRequestInit = {
                    method: rest.method,
                    headers,
                    body: rest.body as UndiciRequestInit['body'],
                    signal: signal as UndiciRequestInit['signal'],
                    redirect: rest.redirect,
                    dispatcher
                };
                try {
                    // undici Response is web-compatible for our scrapers
                    return (await undiciFetch(
                        urlStr,
                        undiciInit
                    )) as unknown as Response;
                } catch (err) {
                    // Optional direct fallback (dev / flaky proxy). Default ON
                    // for viaProxy:'auto' only. viaProxy:true (OpenSubtitles)
                    // must NEVER fall back to AWS direct — that hits Anubis 403.
                    const allowFallback = !/^(0|false|off|no)$/i.test(
                        (
                            process.env.SCRAPE_PROXY_FALLBACK_DIRECT ?? 'true'
                        ).trim()
                    );
                    if (viaProxy === true) {
                        throw wrapProxyError(err, urlStr);
                    }
                    if (allowFallback) {
                        // auto mode: fall through to direct below
                    } else {
                        throw wrapProxyError(err, urlStr);
                    }
                }
            }
        }

        return await fetch(urlStr, {
            ...rest,
            headers,
            signal
        });
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function wrapProxyError(err: unknown, url: string): Error {
    const chain: string[] = [];
    let cur: unknown = err;
    for (let i = 0; i < 6 && cur; i++) {
        if (cur instanceof Error) {
            chain.push(cur.message);
            cur = (cur as Error & { cause?: unknown }).cause;
        } else {
            chain.push(String(cur));
            break;
        }
    }
    const joined = chain.join(' | ');
    if (/407|Proxy Authentication|Proxy response \(407\)/i.test(joined)) {
        return new Error(
            `scrape egress proxy auth failed (HTTP 407) for ${url} — check PROXY_URL credentials`
        );
    }
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR/i.test(joined)) {
        return new Error(
            `scrape egress proxy network error for ${url}: ${joined}`
        );
    }
    return err instanceof Error
        ? err
        : new Error(`scrape egress proxy error for ${url}: ${joined}`);
}

/**
 * Convenience: GET JSON (null on failure). Uses scrape egress when applicable.
 */
export async function scrapeFetchJson<T = unknown>(
    url: string,
    headers?: Record<string, string>,
    init?: ScrapeFetchInit
): Promise<T | null> {
    try {
        const res = await scrapeFetch(url, {
            headers: { Accept: 'application/json', ...headers },
            timeoutMs: 15_000,
            ...init
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

/**
 * Convenience: GET text (null on failure).
 */
export async function scrapeFetchText(
    url: string,
    headers?: Record<string, string>,
    init?: ScrapeFetchInit
): Promise<string | null> {
    try {
        const res = await scrapeFetch(url, {
            headers,
            timeoutMs: 15_000,
            ...init
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
}

/** Test helper: reset cached agent (e.g. after env change in tests). */
export function resetScrapeProxyAgent(): void {
    if (agent) {
        void agent.close().catch(() => undefined);
    }
    agent = undefined;
    loggedStatus = false;
}
