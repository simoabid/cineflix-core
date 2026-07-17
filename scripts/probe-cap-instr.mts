import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const CAP = 'https://cap.hexa.su/15d2cf0395/';
const headers: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: 'https://hexa.su',
    Referer: 'https://hexa.su/',
    'Content-Type': 'application/json',
    'sec-ch-ua':
        '"Chromium";v="137", "Google Chrome";v="137", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
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
    throw new Error('pow fail');
}

function extractInstrNonce(plain: string): string {
    // 'i':'aaa'+'bbb'+'cc' pattern from obfuscated postMessage
    const m = plain.match(
        /'i':'([0-9a-f]+)'\s*\+\s*'([0-9a-f]+)'\s*\+\s*'([0-9a-f]+)'/i
    );
    if (m) return m[1] + m[2] + m[3];
    const m2 = plain.match(
        /nonce':'([0-9a-f]+)'\s*\+\s*'([0-9a-f]+)'\s*\+\s*'([0-9a-f]+)'/i
    );
    if (m2) return m2[1] + m2[2] + m2[3];
    // fallback: 32-char hex
    const m3 = plain.match(/[0-9a-f]{32}/i);
    return m3?.[0] ?? '0'.repeat(32);
}

function extractStateKeys(plain: string): string[] {
    // Z['fajjd5yzoqeb']=M,Z[P(0x10e)]=S,...
    const keys: string[] = [];
    for (const m of plain.matchAll(/\['([a-z0-9]{8,})'\]/gi)) {
        keys.push(m[1]);
    }
    return [...new Set(keys)].slice(0, 10);
}

async function main(): Promise<void> {
    const chRes = await fetch(`${CAP}challenge`, {
        method: 'POST',
        headers,
        body: '{}'
    });
    const ch = (await chRes.json()) as {
        error?: string;
        challenge?: { c: number; s: number; d: number };
        token?: string;
        instrumentation?: string;
    };
    console.log('challenge', chRes.status, Object.keys(ch));
    if (ch.error || !ch.token || !ch.challenge) {
        console.log(ch);
        return;
    }

    const plain = inflateRawSync(
        Buffer.from(ch.instrumentation!, 'base64')
    ).toString('utf8');
    const instrNonce = extractInstrNonce(plain);
    const stateKeys = extractStateKeys(plain);
    console.log('instrNonce', instrNonce, 'len', instrNonce.length);
    console.log('stateKeys', stateKeys);

    const { challenge, token } = ch;
    console.log('solving', challenge.c);
    const t0 = Date.now();
    const solutions = Array.from({ length: challenge.c }, (_, i) => {
        const n = i + 1;
        return solvePow(
            prng(`${token}${n}`, challenge.s),
            prng(`${token}${n}d`, challenge.d)
        );
    });
    console.log('solved', Date.now() - t0, 'ms');

    const state: Record<string, number> = {};
    for (const k of stateKeys.slice(0, 4)) state[k] = 200_000 + Math.floor(Math.random() * 50_000);
    // also include known names from earlier decode
    state.fajjd5yzoqeb = 200_000;
    state.kh36rf64t6rx = 210_000;
    state.u3cbw3qcf9wi = 220_000;

    const variants: Array<{ name: string; body: Record<string, unknown> }> = [
        {
            name: 'instr-full',
            body: {
                token,
                solutions,
                instr: { i: instrNonce, state, ts: Date.now() }
            }
        },
        {
            name: 'instr-minimal',
            body: {
                token,
                solutions,
                instr: { i: instrNonce, state: {}, ts: Date.now() }
            }
        },
        {
            name: 'instr-timeout',
            body: { token, solutions, instr_timeout: true }
        },
        {
            name: 'instr-blocked',
            body: { token, solutions, instr_blocked: true }
        },
        {
            name: 'no-instr',
            body: { token, solutions }
        }
    ];

    for (const v of variants) {
        const r = await fetch(`${CAP}redeem`, {
            method: 'POST',
            headers,
            body: JSON.stringify(v.body)
        });
        const text = await r.text();
        console.log(v.name, r.status, text.slice(0, 250));
        if (r.ok && text.includes('"success":true')) {
            console.log('SUCCESS via', v.name);
            break;
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
