/**
 * Solve Hexa's Cap.js challenge in a real Chromium (instrumentation passes),
 * then resolve a movie via theemoviedb.hexa.su + vidsrc WASM.
 */
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import {
    clearVidsrcSession,
    ensureVidsrcWasm
} from '../src/providers/vidsrc/vidsrcWasm.js';

const CAP_ENDPOINT = 'https://cap.hexa.su/15d2cf0395/';
const API_BASE = 'https://theemoviedb.hexa.su';
const PAGE_ORIGIN = 'https://hexa.su';

const CHROME =
    process.env.CHROME_PATH ||
    `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;

async function solveCapInBrowser(): Promise<string> {
    // Full Chrome binary (not chrome-headless-shell) + stealth patches so
    // Cap's instrumentation iframe does not flag us as automated.
    const browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });
    try {
        const context = await browser.newContext({
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 },
            locale: 'en-US',
            timezoneId: 'America/New_York'
        });
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
            // Cap checks plugins / languages look non-empty
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(180_000);

        // Land on hexa.su origin, then wipe the SPA document so it cannot
        // navigate/destroy our Cap solve context. Keep the same origin for CORS.
        await page.goto(PAGE_ORIGIN, {
            waitUntil: 'commit',
            timeout: 60_000
        });
        await page.evaluate(() => {
            document.open();
            document.write(
                '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>'
            );
            document.close();
        });

        const token = await page.evaluate(async (endpoint) => {
                // Load Cap widget
                await new Promise<void>((resolve, reject) => {
                    if (customElements.get('cap-widget')) {
                        resolve();
                        return;
                    }
                    const s = document.createElement('script');
                    s.type = 'module';
                    s.src = 'https://cdn.jsdelivr.net/npm/@cap.js/widget';
                    s.onload = () => {
                        const wait = () => {
                            if (customElements.get('cap-widget')) resolve();
                            else setTimeout(wait, 50);
                        };
                        wait();
                    };
                    s.onerror = () =>
                        reject(new Error('failed to load cap widget'));
                    document.head.appendChild(s);
                });

                const widget = document.createElement(
                    'cap-widget'
                ) as HTMLElement & {
                    solve: () => Promise<{ success?: boolean; token?: string }>;
                    addEventListener: (
                        type: string,
                        listener: (e: CustomEvent) => void
                    ) => void;
                };
                widget.setAttribute('data-cap-api-endpoint', endpoint);
                widget.style.position = 'fixed';
                widget.style.bottom = '0';
                widget.style.right = '0';
                document.body.appendChild(widget);

                // Wait for connectedCallback
                await new Promise((r) => setTimeout(r, 800));

                return await new Promise<string>((resolve, reject) => {
                    const t = setTimeout(
                        () => reject(new Error('cap solve timeout')),
                        150_000
                    );
                    widget.addEventListener('solve', (e: CustomEvent) => {
                        clearTimeout(t);
                        const tok = (e as CustomEvent).detail?.token;
                        if (tok) resolve(tok);
                        else reject(new Error('solve without token'));
                    });
                    widget.addEventListener('error', (e: CustomEvent) => {
                        clearTimeout(t);
                        const d = (e as CustomEvent).detail || {};
                        reject(
                            new Error(
                                d.message || d.code || 'cap error event'
                            )
                        );
                    });
                    widget.solve().catch((err: Error) => {
                        clearTimeout(t);
                        reject(err);
                    });
                });
        }, CAP_ENDPOINT);

        await context.close();
        return token;
    } finally {
        await browser.close();
    }
}

function prng(seed: string, length: number): string {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash +=
            (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    let state = hash >>> 0;
    let result = '';
    const next = (): number => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    while (result.length < length) {
        result += next().toString(16).padStart(8, '0');
    }
    return result.substring(0, length);
}

// unused if browser solves, kept for reference
void prng;
void createHash;

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua':
        '"Chromium";v="137", "Google Chrome";v="137", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'X-Fingerprint-Lite': 'e9136c41504646444'
};

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
    const start = Date.now();
    const res = await fetch(`${API_BASE}/api/time?t=${start}`, {
        headers: {
            ...BROWSER_HEADERS,
            Origin: PAGE_ORIGIN,
            Referer: `${PAGE_ORIGIN}/`
        },
        signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) return Math.floor(Date.now() / 1000);
    const data = (await res.json()) as { timestamp?: number };
    return typeof data.timestamp === 'number'
        ? data.timestamp
        : Math.floor(Date.now() / 1000);
}

async function buildSecureHeaders(
    key: string,
    url: string
): Promise<Record<string, string>> {
    const path = new URL(url).pathname;
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

async function main(): Promise<void> {
    console.log('chrome', CHROME);
    console.log('solving cap in browser…');
    const t0 = Date.now();
    const capToken = await solveCapInBrowser();
    console.log(`cap token in ${Date.now() - t0}ms, len=${capToken.length}`);

    const { getImgKey, processImgData } = await ensureVidsrcWasm();
    clearVidsrcSession();
    const key = getImgKey();

    const tmdbId = process.argv[2] || '238';
    const url = `${API_BASE}/api/tmdb/movie/${tmdbId}/images`;
    const secure = await buildSecureHeaders(key, url);
    const res = await fetch(url, {
        headers: {
            ...BROWSER_HEADERS,
            Accept: 'text/plain',
            Origin: PAGE_ORIGIN,
            Referer: `${PAGE_ORIGIN}/`,
            'x-cap-token': capToken,
            bW90aGFmYWth: '1',
            ...secure
        },
        signal: AbortSignal.timeout(20_000)
    });
    console.log('list status', res.status);
    const text = await res.text();
    if (!res.ok) {
        console.log(text.slice(0, 400));
        process.exit(1);
    }
    const decoded = JSON.parse(await processImgData(text, key)) as {
        sources?: Array<{ server?: string; url?: string }>;
        servers?: Record<string, unknown>;
    };
    console.log('decoded', JSON.stringify(decoded).slice(0, 2000));

    const servers = decoded.servers
        ? Object.keys(decoded.servers)
        : Array.isArray(decoded.sources)
          ? [
                ...new Set(
                    decoded.sources
                        .map((s) => s.server)
                        .filter((s): s is string => !!s)
                )
            ]
          : [];
    console.log('servers', servers);

    for (const server of servers.slice(0, 4)) {
        clearVidsrcSession();
        const h2 = await buildSecureHeaders(key, url);
        const r2 = await fetch(url, {
            headers: {
                ...BROWSER_HEADERS,
                Accept: 'text/plain',
                Origin: PAGE_ORIGIN,
                Referer: `${PAGE_ORIGIN}/`,
                'x-cap-token': capToken,
                'X-Only-Sources': '1',
                'X-Server': server,
                ...h2
            },
            signal: AbortSignal.timeout(20_000)
        });
        console.log('---', server, r2.status);
        if (!r2.ok) {
            console.log((await r2.text()).slice(0, 200));
            continue;
        }
        const d2 = JSON.parse(await processImgData(await r2.text(), key));
        console.log(JSON.stringify(d2).slice(0, 1200));
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
