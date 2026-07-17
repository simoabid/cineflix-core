/**
 * Use browser captures to:
 * 1) decrypt offline list body with captured X-Api-Key
 * 2) attempt Cap mint in Node with correct instr.i extraction
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import {
    clearVidsrcSession,
    ensureVidsrcWasm
} from '../src/providers/vidsrc/vidsrcWasm.js';

const CAP = 'https://cap.hexa.su/15d2cf0395/';
const HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.8',
    Origin: 'https://hexa.su',
    Referer: 'https://hexa.su/',
    'sec-ch-ua':
        '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
};

const CAPTURED_KEY =
    '300e43601fcb813ce46da2b6a82f30fe86c1b766c102eaf7eee9e1bd451e397e';
const LIST_BODY =
    'pnX4HztNNafEeahlGAVIcHFNKjwrEcU6D+Qgpla77d117I1BmNgaYsxs+nbWsjd0mbSV0K57iC3YUXAtgIvJeLpmMOL5+2FjHSP6AyWa1Lm944FOhLFlMPRonEPV1oJze43yHTRs4B2NvsBMTvVH8RJVasT6anP4ExpAocPPgZNHpS49B+S5KGXUHKVtRln8b2GMD22yoY01QHW2Tl8wKNFXxggYV1rG15Cj9Y6LbTDaTuttqwBPlTMbGp8LxRonykBNRiIRRlpeqL+lOsb61bE/2NvGEp1oKVLNFgGBcaybqqo2gM7q/+O0RCjYFTZ0bzKQDdIgXJ6tjNx8vF/S+00rAaBIYq75GgVcl6w/qfNLgu5nJ8E4Wjdts4k/5A/pP+2ftCr/cYJKioE/5RlmJwKN04LFFAP+VIEtYfEqIoa3CAH774I2EEyunuYweyHUt9wJWOw5GfeHPF3rraTlT877Y5HzaGypBFnl9zxL8Df8qNwhbGa84tMNsI9RjKlFhCxzgHnQdYknfH4T2PTVRXD6m5Ub81hZRPgm7J4VlZ47vRrNEVvQ3jofJxDRI5MK4LrgO0g+mUi3jceAQg33aIMEn7eVPWGC0dugSSpCqre+H4JTCfV46mzLlvZ63eJzvvWihqmiaV3VC4sZBUfos1TDnZjxGGVhBJ3/VZsEXlhNvdZjcdtVMs12N8cjhq3eF8gRUIwMBB5FQ0Hq1f1c3ikCJ1Cy4cPAGQ==';
const ALPHA_BODY =
    'mOLMklCbueuksCg3CMlQpEYmjFuAIAbBFhHBVkEe+NwHpzeABGRPDnbGgAiBJ0DVXchz2HnoPmMlEDZrGzHfyELJcKWCnUYK7KHy8gp+e839CTbocp8jf8GKhht1EsNYJymsORb0m0ekXuNvM/qXuzjxElrj3YT9EnPGBsW+S5Jw7/0oCo8GJhwqDawr6hEVjKrx4wjnKWipgLZall8OjQNO1Zq4dIUo+yDLkPo46hDYgaIdL0W0CMuaYKNpSft09b20uNiwbA/VzVmGgr3/1NXjLUL1ly+3Fv6ppNUaFklu76buvK2qoJ9M2YUrPZeN/vChoAzjEmcdjPDTAPnyOq5IrYHY60od0tKfp/C6XuANN46MWsKPudD7xX9a0PgsH2pFCLpeg8pbRzOqkgRHF0WuJwdKmIiSg+hEQdxTPmeHgQ2ue1RKMAd2tO8a4msJgwabSmxio7UkAj3QXU2ryjjsfT+uUS+zcyFWT2Bd/s0uyXgHgZzWh6RjfA4jQNoNtN99Ch2tm9xVS7e9B+J3HScgI+Vh/nVtVnWYFWKdOsqsIcMBVsEnx8QMp94cLEjG3FLW/+p5rLXuqkLXbJsoFleWhW6oNcVIU9bBID6MzBiW0OfGUvnq3AXvrxTb21RZYEnVDZjP9rs7V1lFm7o40NYtyUh3TLbiK/RMq+pDw9M1Zt2o7QPzavo=';

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
    throw new Error('pow fail');
}

function extractInstrId(instrumentation: string): {
    id: string;
    plain: string;
} {
    const plain = inflateRawSync(
        Buffer.from(instrumentation, 'base64')
    ).toString('utf8');

    // Successful browser id was 32 hex chars.
    const hex32 = plain.match(/[0-9a-f]{32}/gi);
    if (hex32?.length) {
        return { id: hex32[0].toLowerCase(), plain };
    }

    // Reconstruct from 'aaa'+'bbb'+'cc' concatenations totaling 32 hex.
    const re =
        /['"]([0-9a-f]+)['"]\s*\+\s*['"]([0-9a-f]+)['"](?:\s*\+\s*['"]([0-9a-f]+)['"])?/gi;
    for (const m of plain.matchAll(re)) {
        const s = (m[1] + m[2] + (m[3] || '')).toLowerCase();
        if (s.length === 32 && /^[0-9a-f]+$/.test(s)) {
            return { id: s, plain };
        }
    }

    // Walk adjacent hex string literals.
    const lits = [...plain.matchAll(/['"]([0-9a-f]+)['"]/gi)].map((m) =>
        m[1].toLowerCase()
    );
    for (let i = 0; i < lits.length; i++) {
        let s = lits[i];
        for (
            let j = i + 1;
            j < Math.min(i + 5, lits.length) && s.length < 32;
            j++
        ) {
            s += lits[j];
        }
        if (s.length === 32) return { id: s, plain };
    }

    throw new Error(
        `could not extract instr id; plain[0:300]=${plain.slice(0, 300)}`
    );
}

/** Range used by Cap instr script: % 0xdbba0 + 0x186a0 → [100000, 1000000). */
function randStateVal(): number {
    return 100_000 + Math.floor(Math.random() * 900_000);
}

function browserShapedState(): Record<string, number> {
    // Keys are per-challenge; structure is what matters for soft checks.
    return {
        e1l6aqd32doc: randStateVal(),
        oob3l5i08ad6: randStateVal(),
        focoal3cn1f5: randStateVal(),
        bfdgvlbanjoz: randStateVal()
    };
}

async function mintCapToken(): Promise<string> {
    const chRes = await fetch(`${CAP}challenge`, {
        method: 'POST',
        headers: HEADERS
        // browser uses content-length: 0, no body
    });
    const ch = (await chRes.json()) as {
        error?: string;
        challenge?: { c: number; s: number; d: number };
        token?: string;
        instrumentation?: string;
    };
    console.log('challenge', chRes.status, ch.error || 'ok');
    if (ch.error || !ch.token || !ch.challenge || !ch.instrumentation) {
        throw new Error(`challenge failed: ${JSON.stringify(ch).slice(0, 200)}`);
    }

    const { id: instrId, plain } = extractInstrId(ch.instrumentation);
    console.log('instrId', instrId, 'len', instrId.length);
    console.log(
        '12-char lits',
        [...plain.matchAll(/['"]([a-z0-9]{12})['"]/g)]
            .map((m) => m[1])
            .slice(0, 12)
    );

    console.log('solving', ch.challenge.c, 'pow…');
    const t0 = Date.now();
    const solutions = Array.from({ length: ch.challenge.c }, (_, i) => {
        const n = i + 1;
        return solvePow(
            prng(`${ch.token}${n}`, ch.challenge!.s),
            prng(`${ch.token}${n}d`, ch.challenge!.d)
        );
    });
    console.log('solved in', Date.now() - t0, 'ms');

    const body = {
        token: ch.token,
        solutions,
        instr: {
            i: instrId,
            state: browserShapedState(),
            ts: Date.now()
        }
    };

    const r = await fetch(`${CAP}redeem`, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await r.text();
    console.log('redeem', r.status, text.slice(0, 300));
    const json = JSON.parse(text) as {
        success?: boolean;
        token?: string;
        error?: string;
        reason?: string;
    };
    if (!json.success || !json.token) {
        throw new Error(
            `redeem failed: ${json.error || json.reason || text.slice(0, 200)}`
        );
    }
    return json.token;
}

async function main(): Promise<void> {
    const { getImgKey, processImgData } = await ensureVidsrcWasm();
    clearVidsrcSession();
    const ourKey = getImgKey();
    console.log('our key', ourKey.slice(0, 16) + '…');
    console.log('captured key', CAPTURED_KEY.slice(0, 16) + '…');

    try {
        const dec = await processImgData(LIST_BODY, CAPTURED_KEY);
        console.log('LIST decrypt OK:', dec.slice(0, 500));
    } catch (e) {
        console.log('LIST decrypt FAIL', e);
    }

    try {
        const dec = await processImgData(ALPHA_BODY, CAPTURED_KEY);
        console.log('ALPHA decrypt OK:', dec.slice(0, 500));
    } catch (e) {
        console.log('ALPHA decrypt FAIL', e);
    }

    try {
        const dec = await processImgData(LIST_BODY, ourKey);
        console.log('LIST with our key:', dec.slice(0, 200));
    } catch (e) {
        console.log(
            'LIST with our key FAIL (expected if body encrypted for other key)'
        );
    }

    // Cap mint
    try {
        const capToken = await mintCapToken();
        console.log('CAP TOKEN:', capToken);

        // Live list with our WASM key + fresh cap token
        const API = 'https://theemoviedb.hexa.su';
        const url = `${API}/api/tmdb/movie/238/images`;
        const path = '/api/tmdb/movie/238/images';
        const timeRes = await fetch(`${API}/api/time?t=${Date.now()}`, {
            headers: HEADERS
        });
        const timeJson = (await timeRes.json()) as { timestamp?: number };
        const timestamp =
            typeof timeJson.timestamp === 'number'
                ? timeJson.timestamp
                : Math.floor(Date.now() / 1000);
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)))
            .toString('base64')
            .replace(/[/+=]/g, '')
            .slice(0, 22);
        const message = `${ourKey}:${timestamp}:${nonce}:${path}`;
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(ourKey),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const sigBuf = await crypto.subtle.sign(
            'HMAC',
            cryptoKey,
            new TextEncoder().encode(message)
        );
        const signature = Buffer.from(sigBuf).toString('base64');
        // fingerprint from shim algorithm used by vidsrcClient
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
        const fp = Math.abs(acc).toString(36);

        const listRes = await fetch(url, {
            headers: {
                ...HEADERS,
                Accept: 'text/plain',
                'X-Fingerprint-Lite': 'e9136c41504646444',
                'x-cap-token': capToken,
                'X-Api-Key': ourKey,
                'X-Request-Timestamp': String(timestamp),
                'X-Request-Nonce': nonce,
                'X-Request-Signature': signature,
                'X-Client-Fingerprint': fp,
                bW90aGFmYWth: '1'
            }
        });
        console.log('live list', listRes.status);
        const liveBody = await listRes.text();
        console.log('live body len', liveBody.length, liveBody.slice(0, 80));
        if (listRes.ok) {
            clearVidsrcSession();
            const decoded = await processImgData(liveBody, ourKey);
            console.log('LIVE DECODE:', decoded.slice(0, 800));
        }
    } catch (e) {
        console.error('cap/live path failed:', e);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
