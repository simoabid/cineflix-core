/**
 * Prove Hexa native path:
 *   Cap.js PoW (x-cap-token) + vidsrc-identical WASM (HMAC + AES).
 */
import { createHash } from 'node:crypto';
import {
    clearVidsrcSession,
    ensureVidsrcWasm
} from '../src/providers/vidsrc/vidsrcWasm.js';

const API_BASE = 'https://theemoviedb.hexa.su';
const PAGE_ORIGIN = 'https://hexa.su';
const CAP_ENDPOINT = 'https://cap.hexa.su/15d2cf0395/';

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua':
        '"Chromium";v="137", "Google Chrome";v="137", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    Origin: PAGE_ORIGIN,
    Referer: `${PAGE_ORIGIN}/`
};

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

function solvePow(salt: string, target: string): number {
    const targetBits = target.length * 4;
    const fullBytes = Math.floor(targetBits / 8);
    const remainingBits = targetBits % 8;
    const paddedTarget = target.length % 2 === 0 ? target : `${target}0`;
    const targetBytes = Buffer.from(paddedTarget, 'hex');
    const partialMask =
        remainingBits > 0 ? (0xff << (8 - remainingBits)) & 0xff : 0;

    for (let nonce = 0; nonce < 50_000_000; nonce++) {
        const hash = createHash('sha256').update(salt + nonce).digest();
        let matches = true;
        for (let k = 0; k < fullBytes; k++) {
            if (hash[k] !== targetBytes[k]) {
                matches = false;
                break;
            }
        }
        if (
            matches &&
            remainingBits > 0 &&
            (hash[fullBytes]! & partialMask) !==
                (targetBytes[fullBytes]! & partialMask)
        ) {
            matches = false;
        }
        if (matches) return nonce;
    }
    throw new Error(`PoW failed for salt=${salt.slice(0, 12)}…`);
}

async function solveCap(): Promise<string> {
    const challengeRes = await fetch(`${CAP_ENDPOINT}challenge`, {
        method: 'POST',
        headers: {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/json'
        },
        body: '{}',
        signal: AbortSignal.timeout(20_000)
    });
    const challengeText = await challengeRes.text();
    console.log('cap challenge', challengeRes.status, challengeText.slice(0, 200));
    if (!challengeRes.ok) {
        throw new Error(`cap challenge HTTP ${challengeRes.status}`);
    }
    const challengeResp = JSON.parse(challengeText) as {
        error?: string;
        challenge?: { c: number; s: number; d: number } | [string, string][];
        token?: string;
        format?: number;
    };
    if (challengeResp.error) throw new Error(challengeResp.error);
    if (!challengeResp.token || !challengeResp.challenge) {
        throw new Error('cap challenge missing token/challenge');
    }

    let pairs: [string, string][];
    if (Array.isArray(challengeResp.challenge)) {
        pairs = challengeResp.challenge as [string, string][];
    } else {
        const ch = challengeResp.challenge;
        pairs = Array.from({ length: ch.c }, (_, i) => {
            const n = i + 1;
            return [
                prng(`${challengeResp.token}${n}`, ch.s),
                prng(`${challengeResp.token}${n}d`, ch.d)
            ];
        });
    }

    console.log(`solving ${pairs.length} PoW challenges…`);
    const t0 = Date.now();
    const solutions = pairs.map(([salt, target], i) => {
        const nonce = solvePow(salt, target);
        if ((i + 1) % 20 === 0) {
            console.log(`  ${i + 1}/${pairs.length} (${Date.now() - t0}ms)`);
        }
        return nonce;
    });
    console.log(`solved in ${Date.now() - t0}ms`);

    const redeemRes = await fetch(`${CAP_ENDPOINT}redeem`, {
        method: 'POST',
        headers: {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            token: challengeResp.token,
            solutions
        }),
        signal: AbortSignal.timeout(20_000)
    });
    const redeemText = await redeemRes.text();
    console.log('cap redeem', redeemRes.status, redeemText.slice(0, 300));
    const redeem = JSON.parse(redeemText) as {
        success?: boolean;
        token?: string;
        error?: string;
    };
    if (!redeem.success || !redeem.token) {
        throw new Error(redeem.error || 'cap redeem failed');
    }
    return redeem.token;
}

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
        headers: BROWSER_HEADERS,
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
    const capToken = await solveCap();
    console.log('cap token len', capToken.length);

    const { getImgKey, processImgData } = await ensureVidsrcWasm();
    clearVidsrcSession();
    const key = getImgKey();
    console.log('wasm key len', key.length);

    const tmdbId = process.argv[2] || '238';
    const url = `${API_BASE}/api/tmdb/movie/${tmdbId}/images`;
    const secure = await buildSecureHeaders(key, url);
    const res = await fetch(url, {
        headers: {
            ...BROWSER_HEADERS,
            Accept: 'text/plain',
            'Sec-Fetch-Site': 'cross-site',
            'X-Fingerprint-Lite': 'e9136c41504646444',
            'x-cap-token': capToken,
            bW90aGFmYWth: '1',
            ...secure
        },
        signal: AbortSignal.timeout(20_000)
    });
    console.log('list status', res.status);
    const text = await res.text();
    console.log('body len', text.length, 'prefix', text.slice(0, 100));
    if (!res.ok) process.exit(1);

    const decoded = JSON.parse(await processImgData(text, key)) as {
        sources?: Array<{ server?: string; url?: string }>;
        servers?: Record<string, unknown>;
    };
    console.log('decoded keys', Object.keys(decoded));
    console.log(JSON.stringify(decoded).slice(0, 2000));

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

    for (const server of servers.slice(0, 3)) {
        clearVidsrcSession();
        const h2 = await buildSecureHeaders(key, url);
        const r2 = await fetch(url, {
            headers: {
                ...BROWSER_HEADERS,
                Accept: 'text/plain',
                'Sec-Fetch-Site': 'cross-site',
                'X-Fingerprint-Lite': 'e9136c41504646444',
                'x-cap-token': capToken,
                'X-Only-Sources': '1',
                'X-Server': server,
                ...h2
            },
            signal: AbortSignal.timeout(20_000)
        });
        console.log('--- server', server, 'status', r2.status);
        const t2 = await r2.text();
        if (!r2.ok) {
            console.log(t2.slice(0, 300));
            continue;
        }
        const d2 = JSON.parse(await processImgData(t2, key));
        console.log(JSON.stringify(d2).slice(0, 1500));
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
