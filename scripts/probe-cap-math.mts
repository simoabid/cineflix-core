/**
 * Execute Cap instrumentation math by extracting the computation chain
 * (after antibot) and running it with a DOM-tree mock.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const EXPECTED = {
    i: '4b9f7ce9aec1354b1188b5486fa78bae',
    state: {
        e1l6aqd32doc: 266097,
        oob3l5i08ad6: 524969,
        focoal3cn1f5: 609699,
        bfdgvlbanjoz: 998124
    }
};

class El {
    children: El[] = [];
    parentNode: El | null = null;
    style: Record<string, string> = {};
    private _t = '';
    constructor(public tagName: string) {}
    get innerText() {
        return this._t;
    }
    set innerText(v: unknown) {
        this._t = String(v);
    }
    get lastElementChild() {
        return this.children.length
            ? this.children[this.children.length - 1]
            : null;
    }
    get childrenLength() {
        return this.children.length;
    }
    // Cap uses .children.length
    get childrenProxy() {
        return this.children;
    }
    appendChild(c: El) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    removeChild(c: El) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
    }
}

// Cap accesses el.children.length — need a real children array-like
Object.defineProperty(El.prototype, 'children', {
    get(this: El) {
        // return the private array - already a property, redefine carefully
        return (this as unknown as { _children?: El[] })._children;
    },
    set() {}
});

// Simpler: just use public children field (already there)

/**
 * Resolve instrumentation id by evaluating the `'nonce': <expr>` expression
 * after the string-array decoder (R) has been initialized.
 */
function extractInstrId(plain: string, evalExpr: (expr: string) => string): string {
    // Prefer the antibot/success postMessage nonce field (same id Cap embeds).
    const m = plain.match(/['"]nonce['"]\s*:\s*([^,]+)/);
    if (m) {
        const id = evalExpr(m[1].trim());
        if (/^[0-9a-f]{32}$/i.test(id)) return id.toLowerCase();
    }
    // Fallback: 'i': expr inside result object near the end
    const m2 = plain.match(/['"]i['"]\s*:\s*([^,]+)/g);
    if (m2?.length) {
        const last = m2[m2.length - 1].replace(/^['"]i['"]\s*:\s*/, '');
        const id = evalExpr(last.trim());
        if (/^[0-9a-f]{32}$/i.test(id)) return id.toLowerCase();
    }
    throw new Error('could not extract instr id');
}

/**
 * Pull string-array bootstrap + computation from `var n=0x…` through `return N`.
 */
function buildExecutable(plain: string): { code: string; idExpr: string } {
    const compMatch = plain.match(
        /var n=0x[0-9a-f]+,B=0x[0-9a-f]+,g=0x[0-9a-f]+,A=0x[0-9a-f]+;[\s\S]*?return N\[/
    );
    if (!compMatch || compMatch.index === undefined) {
        throw new Error('computation chain not found');
    }
    const compStart = compMatch.index;
    const nObj = plain.indexOf('var N={}', compStart);
    if (nObj < 0) throw new Error('var N not found');
    const retN = plain.indexOf('return N[', nObj);
    const afterRet = plain.indexOf(',N;}', retN);
    if (afterRet < 0) throw new Error('return N end not found');
    const compCode = plain.slice(compStart, afterRet + ',N;'.length);

    const bootEnd = plain.indexOf('(function(){window');
    if (bootEnd < 0) throw new Error('bootstrap end not found');
    let boot = plain.slice(0, bootEnd);
    // Original is a parenthesized comma expr ending with trailing comma — close group.
    boot = boot.replace(/,\s*$/, ');');

    // Capture nonce expression for id (uses decoder aliases t2/t9/R after boot).
    const nonceM = plain.match(/['"]nonce['"]\s*:\s*([^,]+)/);
    const idExpr = nonceM ? nonceM[1].trim() : "''";

    const code = `
${boot}
var t2 = typeof R === 'function' ? R : null;
var t9 = t2;
var t1 = t2;
if (typeof t2 !== 'function') {
  throw new Error('string decoder R not found');
}
function runCapMath(document, navigator) {
  ${compCode}
  return N;
}
function resolveInstrId() {
  return String(${idExpr});
}
`;

    return { code, idExpr };
}

function makeDocument() {
    const body = new El('body');
    const document = {
        body,
        createElement: (tag: string) => new El(tag),
        // Cap uses document['body'] via decoder and document.body
    };
    // Support document[decoded] access — body is enough if decoder returns 'body'
    return new Proxy(document, {
        get(t, p) {
            if (p in t) return (t as Record<string | symbol, unknown>)[p];
            // fallback: treat as body for appendChild chains
            if (p === 'body') return body;
            return (t as Record<string, unknown>)[String(p)];
        }
    });
}

async function solveInstrFromPlain(plain: string): Promise<{
    i: string;
    state: Record<string, number>;
    ts: number;
}> {
    const { code } = buildExecutable(plain);
    const document = makeDocument();
    const navigator = {
        userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    };

    const sandbox: Record<string, unknown> = {
        document,
        navigator,
        result: null as Record<string, number> | null,
        instrId: '' as string,
        Error,
        parseInt,
        console
    };
    const ctx = createContext(sandbox);
    const wrapped = `
${code}
result = runCapMath(document, navigator);
instrId = resolveInstrId();
`;
    try {
        new Script(wrapped, { filename: 'cap-math.js' }).runInContext(ctx, {
            timeout: 5000
        });
    } catch (e) {
        console.error('math exec error', e);
        throw e;
    }
    const state = sandbox.result as Record<string, number> | null;
    if (!state || typeof state !== 'object') {
        throw new Error('math produced no state');
    }
    const id = String(sandbox.instrId || '');
    if (!/^[0-9a-f]{32}$/i.test(id)) {
        // Last chance: use extract helper with eval in same context
        try {
            const fixed = extractInstrId(plain, (expr) =>
                String(
                    runInContext(
                        `var t2=R,t9=R,t1=R; (${expr})`,
                        ctx
                    )
                )
            );
            sandbox.instrId = fixed;
        } catch {
            throw new Error(`bad instr id from decoder: ${id}`);
        }
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(state)) {
        out[k] = Number(v);
    }
    const finalId = String(sandbox.instrId).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(finalId)) {
        throw new Error(`could not resolve 32-char instr id (got ${finalId})`);
    }
    return { i: finalId, state: out, ts: Date.now() };
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

async function main(): Promise<void> {
    const challenge = JSON.parse(
        readFileSync('/tmp/hexa-challenge.json', 'utf8')
    ) as {
        challenge: { c: number; s: number; d: number };
        token: string;
        instrumentation: string;
    };
    const plain = inflateRawSync(
        Buffer.from(challenge.instrumentation, 'base64')
    ).toString('utf8');

    console.log('=== Phase 1: pure math vs browser capture ===');
    const instr = await solveInstrFromPlain(plain);
    console.log('got', instr);
    console.log('expected', EXPECTED);
    const stateOk = Object.entries(EXPECTED.state).every(
        ([k, v]) => instr.state[k] === v
    );
    console.log('i match', instr.i === EXPECTED.i);
    console.log('state match', stateOk);
    if (!stateOk) {
        for (const k of Object.keys({ ...instr.state, ...EXPECTED.state })) {
            console.log(
                `  ${k}: got=${instr.state[k]} exp=${(EXPECTED.state as Record<string, number>)[k]}`
            );
        }
    }

    console.log('\n=== Phase 2: live Cap mint ===');
    const CAP = 'https://cap.hexa.su/15d2cf0395/';
    const headers: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        Accept: '*/*',
        Origin: 'https://hexa.su',
        Referer: 'https://hexa.su/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
    };
    const chRes = await fetch(`${CAP}challenge`, { method: 'POST', headers });
    const ch = (await chRes.json()) as {
        error?: string;
        challenge?: { c: number; s: number; d: number };
        token?: string;
        instrumentation?: string;
    };
    console.log('challenge', chRes.status, ch.error || 'ok');
    if (!ch.token || !ch.challenge || !ch.instrumentation) {
        throw new Error('challenge failed');
    }
    const livePlain = inflateRawSync(
        Buffer.from(ch.instrumentation, 'base64')
    ).toString('utf8');
    const liveInstr = await solveInstrFromPlain(livePlain);
    console.log('live instr', liveInstr);

    console.log('pow…');
    const t0 = Date.now();
    const solutions = Array.from({ length: ch.challenge.c }, (_, i) => {
        const n = i + 1;
        return solvePow(
            prng(`${ch.token}${n}`, ch.challenge!.s),
            prng(`${ch.token}${n}d`, ch.challenge!.d)
        );
    });
    console.log('pow', Date.now() - t0, 'ms');

    const redeemRes = await fetch(`${CAP}redeem`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            token: ch.token,
            solutions,
            instr: {
                i: liveInstr.i,
                state: liveInstr.state,
                ts: liveInstr.ts
            }
        })
    });
    console.log('redeem', redeemRes.status, await redeemRes.text());
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
