/**
 * vidupBrowser.ts
 *
 * Browser-based stream resolver for vidup.to.
 *
 * Vidup's player uses a bytecode VM to decrypt the `en` token into server
 * data tokens, then makes POST requests to its API and decrypts the
 * encrypted responses to get stream URLs. Reproducing the VM in pure TS is
 * impractical (40+ opcodes, XOR-encrypted bytecode, silent error catching).
 *
 * Instead, this resolver uses Playwright to load the embed page in a headless
 * browser, patches the anti-tamper check (`a_()`) to always return true, and
 * captures the m3u8/mp4 stream URLs that the player's hls.js loads.
 *
 * This mirrors the vidsrc provider's approach of running the site's own code
 * (vidsrc uses WASM, vidup uses a full page render) to resolve streams.
 *
 * Requirements:
 *   - Playwright + Chromium installed (`npm install playwright && npx playwright install chromium`)
 *   - Xvfb running on Linux headless servers (`Xvfb :99 -screen 0 1280x720x24 &`)
 *   - DISPLAY=:99 environment variable set
 *
 * If Playwright is not available, the provider falls back to the ythd.org
 * embed source (see vidupClient.ts).
 */
import type { VidupStream } from './vidup.types.js';

// ---------------------------------------------------------------------------
// Constants (from RECON.md)
// ---------------------------------------------------------------------------

const EMBED_BASE = 'https://vidup.to';
const STEALTH_INIT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
window.chrome = { runtime: {} };
console.clear = function() {};
const origLog = console.log;
console.log = function(...args) {
    if (args.length === 1 && Array.isArray(args[0]) && args[0].length > 10) return;
    return origLog.apply(this, args);
};
`;

/**
 * Find the end of a brace-delimited block starting at `start` (position of `{`).
 */
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

/**
 * The patched bundle body. We replace `a_()` (anti-tamper) with `()=>true`
 * so the player initializes in headless mode.
 */
function patchBundle(body: string): string {
    // Replace a_ function with a no-op that returns true
    const aStart = body.indexOf('let a_=()=>{');
    if (aStart >= 0) {
        const braceStart = body.indexOf('{', aStart);
        const braceEnd = findBraceEnd(body, braceStart);
        body =
            body.slice(0, aStart) +
            'let a_=()=>{return true}' +
            body.slice(braceEnd);
    }
    return body;
}

export interface BrowserResolveOptions {
    /** Timeout in ms for waiting for streams to appear (default 25000). */
    timeout?: number;
    /** Whether to run headless (default true, requires Xvfb on Linux). */
    headless?: boolean;
}

/**
 * Resolve direct stream URLs from vidup.to by loading the embed page in a
 * headless browser and capturing the m3u8 URLs the player loads.
 *
 * @param media - The media to resolve (movie or TV episode)
 * @returns Array of streams (m3u8 URLs with quality info), or null on failure
 */
export async function resolveVidupStreamsViaBrowser(
    media: {
        type: 'movie' | 'tv';
        tmdbId: string;
        season?: number;
        episode?: number;
    },
    _options?: BrowserResolveOptions
): Promise<VidupStream[] | null> {
    let chromium: any;
    try {
        // @ts-ignore
        chromium = (await import('playwright')).chromium;
    } catch {
        // Playwright not installed
        return null;
    }

    const timeout = _options?.timeout ?? 25000;
    const headless = _options?.headless ?? true;

    let browser: any = null;
    try {
        browser = await chromium.launch({
            headless,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        const context = await browser.newContext({
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 },
            locale: 'en-US',
            extraHTTPHeaders: {
                'sec-ch-ua':
                    '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="99"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"'
            }
        });

        await context.addInitScript(STEALTH_INIT);

        // Intercept the player bundle and patch a_()
        await context.route('**/294-*.js', async (route: any) => {
            const response = await route.fetch();
            let body = await response.text();
            body = patchBundle(body);
            await route.fulfill({
                status: 200,
                contentType: 'application/javascript',
                body
            });
        });

        const page = await context.newPage();

        // Collect stream URLs (m3u8/mp4) that the player loads via hls.js
        const streamUrls: Map<string, { url: string; quality?: string }> =
            new Map();
        const masterPlaylists: Map<string, string> = new Map();

        page.on('request', (req: any) => {
            const url = req.url();
            if (url.includes('.m3u8') && !streamUrls.has(url)) {
                streamUrls.set(url, { url });
            }
        });

        page.on('response', async (res: any) => {
            const url = res.request().url();
            if (url.includes('.m3u8')) {
                try {
                    const body = await res.text();
                    // Parse master playlist for quality variants
                    if (body.includes('#EXT-X-STREAM-INF')) {
                        masterPlaylists.set(url, body);
                        const lines = body.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].includes('#EXT-X-STREAM-INF')) {
                                const resMatch = lines[i].match(
                                    /RESOLUTION=(\d+)x(\d+)/
                                );
                                const bwMatch =
                                    lines[i].match(/BANDWIDTH=(\d+)/);
                                const nextLine = lines[i + 1]?.trim();
                                if (nextLine && resMatch) {
                                    const quality = `${resMatch[2]}p`;
                                    const fullUrl = nextLine.startsWith('http')
                                        ? nextLine
                                        : new URL(nextLine, url).toString();
                                    streamUrls.set(fullUrl, {
                                        url: fullUrl,
                                        quality
                                    });
                                }
                            }
                        }
                    }
                } catch {
                    // body consumed
                }
            }
        });

        // Build the embed URL
        const embedUrl =
            media.type === 'movie'
                ? `${EMBED_BASE}/movie/${media.tmdbId}?autoPlay=true`
                : `${EMBED_BASE}/tv/${media.tmdbId}/${media.season}/${media.episode}?autoPlay=true`;

        await page.goto(embedUrl, {
            waitUntil: 'networkidle',
            timeout: 30000
        });

        // Wait for the player to resolve streams
        await page.waitForTimeout(timeout);

        // Convert captured streams to VidupStream[]
        const streams: VidupStream[] = [];
        const seen = new Set<string>();
        for (const [, info] of streamUrls) {
            if (seen.has(info.url)) continue;
            seen.add(info.url);
            streams.push({
                url: info.url,
                type: 'hls',
                quality: info.quality ?? 'Auto'
            });
        }

        return streams.length > 0 ? streams : null;
    } catch {
        return null;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch {
                // ignore
            }
        }
    }
}
