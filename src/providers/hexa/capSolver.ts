/**
 * Cap.js Standalone solver for Hexa (cap.hexa.su).
 *
 * PoW: SHA-256 salt+nonce vs target bits (standard Cap format-1).
 * Instrumentation: extract the server-generated computation chain from the
 * inflated challenge blob and re-run it with a minimal DOM-tree mock.
 * Cap verifies the resulting 4 state values server-side — they are not forgeable
 * without executing the chain (see Cap's generateInstrumentation).
 *
 * CAVEATS: Cap may treat datacenter IPs differently than local; mint retries
 * help with obfuscation variance but do not guarantee EC2 parity. Token cache
 * (~2h) is process-local. See docs/HEXA-SCRAPING.md.
 */
import { createHash } from 'node:crypto';
import { createContext, runInContext, Script } from 'node:vm';
import { inflateRawSync } from 'node:zlib';

const CAP_ENDPOINT = 'https://cap.hexa.su/15d2cf0395/';
const PAGE_ORIGIN = 'https://hexa.su';

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: PAGE_ORIGIN,
    Referer: `${PAGE_ORIGIN}/`,
    'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
};

export interface CapToken {
    token: string;
    expires: number;
}

let cached: CapToken | null = null;

class DomEl {
    children: DomEl[] = [];
    parentNode: DomEl | null = null;
    style: Record<string, string> = {};
    private _text = '';
    constructor(public tagName: string) {}
    get innerText(): string {
        return this._text;
    }
    set innerText(v: unknown) {
        this._text = String(v);
    }
    get lastElementChild(): DomEl | null {
        return this.children.length
            ? this.children[this.children.length - 1]
            : null;
    }
    appendChild(c: DomEl): DomEl {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    removeChild(c: DomEl): DomEl {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
    }
}

function prng(seed: string, length: number): string {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash +=
            (hash << 1) +
            (hash << 4) +
            (hash << 7) +
            (hash << 8) +
            (hash << 24);
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
        const hash = createHash('sha256')
            .update(salt + nonce)
            .digest();
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
    throw new Error('Cap PoW failed (exceeded nonce budget)');
}

function inflateInstrumentation(b64: string): string {
    return inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8');
}

/**
 * Locate the pure computation chain Cap embeds after antibot checks:
 *   return;}var a=0x..,b=0x..,c=0x..,d=0x..; ... var OUT={};return OUT[...],OUT;
 */
function extractComputation(plain: string): string {
    const startRe =
        /return;\s*\}(var [a-zA-Z0-9_$]+=0x[0-9a-f]+(?:,[a-zA-Z0-9_$]+=0x[0-9a-f]+){3};)/i;
    const sm = plain.match(startRe);
    if (!sm || sm.index === undefined) {
        throw new Error('Cap instr: computation start not found');
    }
    const compStart = sm.index + sm[0].indexOf('var');
    const rest = plain.slice(compStart);
    const em = rest.match(
        /^(?<comp>[\s\S]*?var (?<out>[a-zA-Z0-9_$]+)=\{\};return \k<out>[\s\S]*?,\k<out>;)/
    );
    if (!em?.groups?.comp) {
        throw new Error('Cap instr: computation end not found');
    }
    return em.groups.comp;
}

function makeDocument(): {
    body: DomEl;
    createElement: (t: string) => DomEl;
    [k: string]: unknown;
} {
    const body = new DomEl('body');
    const doc: {
        body: DomEl;
        createElement: (t: string) => DomEl;
        [k: string]: unknown;
    } = {
        body,
        createElement: (t: string) => new DomEl(t)
    };
    return doc;
}

/**
 * Execute instrumentation by running the full inflated script in a sandbox
 * with DOM mock + antibot/env patches, capturing the success postMessage.
 */
export function solveInstrumentation(instrumentationB64: string): {
    i: string;
    state: Record<string, number>;
    ts: number;
} {
    const plain = inflateInstrumentation(instrumentationB64);

    // Prefer pure-math extract (no env/antibot). Fall back to full script.
    try {
        return solveInstrumentationMath(plain);
    } catch (mathErr) {
        try {
            return solveInstrumentationFullScript(plain);
        } catch (fullErr) {
            throw new Error(
                `Cap instr solve failed. math=${mathErr instanceof Error ? mathErr.message : mathErr}; full=${fullErr instanceof Error ? fullErr.message : fullErr}`
            );
        }
    }
}

/**
 * Run the full inflated Cap instrumentation script in a Node sandbox.
 * Strips env early-returns + antibot early-return so the math chain executes.
 */
function solveInstrumentationFullScript(plain: string): {
    i: string;
    state: Record<string, number>;
    ts: number;
} {
    let captured: {
        i: string;
        state: Record<string, number>;
        ts: number;
    } | null = null;

    class El extends DomEl {}
    function HTMLElement() {}
    function Window() {}
    function Document() {}
    function Navigator() {}
    function Node() {}
    function EventTarget() {}
    function MimeType() {}
    function MimeTypeArray() {}
    function PluginArray() {}

    Object.defineProperties(Navigator.prototype, {
        userAgent: {
            get: () => BROWSER_HEADERS['User-Agent'],
            configurable: true
        },
        appVersion: { get: () => '5.0 (X11)', configurable: true },
        platform: { get: () => 'Linux x86_64', configurable: true },
        language: { get: () => 'en-US', configurable: true },
        languages: { get: () => ['en-US', 'en'], configurable: true },
        productSub: { get: () => '20030107', configurable: true },
        webdriver: { get: () => undefined, configurable: true },
        mimeTypes: {
            get: () => {
                const a: unknown[] = [];
                Object.setPrototypeOf(a, MimeTypeArray.prototype);
                return a;
            },
            configurable: true
        },
        plugins: {
            get: () => {
                const a: unknown[] = [];
                Object.setPrototypeOf(a, PluginArray.prototype);
                return a;
            },
            configurable: true
        }
    });
    const nav = Object.create(Navigator.prototype);
    const body = new El('body');
    Object.setPrototypeOf(body, HTMLElement.prototype);

    const parent = {
        postMessage(data: Record<string, unknown>) {
            if (!data || typeof data !== 'object') return;
            const res = data.result;
            if (
                res &&
                typeof res === 'object' &&
                res !== null &&
                'state' in res &&
                'i' in res
            ) {
                const r = res as {
                    i: string;
                    state: Record<string, number>;
                    ts?: number;
                };
                captured = {
                    i: String(r.i).toLowerCase(),
                    state: Object.fromEntries(
                        Object.entries(r.state).map(([k, v]) => [k, Number(v)])
                    ),
                    ts: typeof r.ts === 'number' ? r.ts : Date.now()
                };
            }
        }
    };

    const doc: Record<string, unknown> = Object.create(Document.prototype);
    Object.assign(doc, {
        body,
        documentElement: body,
        defaultView: null as unknown,
        createElement: (t: string) => {
            const e = new El(t);
            Object.setPrototypeOf(e, HTMLElement.prototype);
            // canvas stubs for env probes (we also strip return null)
            if (String(t).toLowerCase() === 'canvas') {
                Object.assign(e, {
                    getContext: () => ({
                        fillText: () => {},
                        getParameter: () => '',
                        VENDOR: 0x1f00,
                        RENDERER: 0x1f01
                    }),
                    toDataURL: () =>
                        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                    width: 100,
                    height: 100
                });
            }
            return e;
        },
        hasFocus: () => true,
        getAttributeNames: () => [],
        getElementsByTagName: () => []
    });

    const win: Record<string, unknown> = Object.create(Window.prototype);
    Object.assign(win, {
        window: null as unknown,
        self: null as unknown,
        parent,
        top: null as unknown,
        document: doc,
        navigator: nav,
        HTMLElement,
        Window,
        Document,
        Navigator,
        Node,
        EventTarget,
        MimeType,
        MimeTypeArray,
        PluginArray,
        Function,
        Object,
        Array,
        String,
        Number,
        Boolean,
        Date,
        Math,
        JSON,
        RegExp,
        Error,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        queueMicrotask,
        outerWidth: 1920,
        outerHeight: 1080,
        innerWidth: 1920,
        innerHeight: 1080,
        performance: { now: () => Date.now() },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
            return true;
        },
        eval,
        isSecureContext: true,
        CustomEvent: class {
            type: string;
            detail: unknown;
            constructor(t: string, i?: { detail?: unknown }) {
                this.type = t;
                this.detail = i?.detail;
            }
        },
        onload: null as unknown,
        __err: null as string | null
    });
    win.window = win;
    win.self = win;
    win.top = win;
    doc.defaultView = win;

    const nts = Object.prototype.toString;
    Object.prototype.toString = function (this: unknown) {
        if (this === nav) return '[object Navigator]';
        if (this === win) return '[object Window]';
        if (this === doc) return '[object HTMLDocument]';
        return nts.call(this);
    };

    // Patch script: bypass env returns + antibot early-return before math.
    let src = plain;
    src = src.replace(/return\s+null\s*;/g, '/*env*/;');
    src = src.replace(/['"]blocked['"]\s*:\s*!!\[\]/g, "'blocked':false");
    src = src.replace(
        /(['"]result['"]\s*:\s*['"]['"][^)]*\)\s*;)\s*return\s*;/g,
        '$1/*no-antibot-return*/;'
    );
    // Kick onload
    src += `;\ntry{var __ol=window.onload;if(typeof __ol==='function'){Promise.resolve(__ol.call(window)).catch(function(e){globalThis.__err=String(e&&e.stack||e);});}}catch(e){globalThis.__err=String(e&&e.stack||e);}\n`;

    const sandbox: Record<string, unknown> = {
        ...win,
        globalThis: null,
        process: undefined,
        module: undefined,
        require: undefined,
        Buffer: undefined,
        console
    };
    sandbox.globalThis = sandbox;
    const ctx = createContext(sandbox);
    runInContext(
        'window.globalThis=window;globalThis.window=window;globalThis.self=window;globalThis.parent=parent;globalThis.document=document;globalThis.navigator=navigator;',
        ctx
    );
    new Script(src, { filename: 'cap-full.js' }).runInContext(ctx, {
        timeout: 15000
    });

    // Wait briefly for async onload
    const start = Date.now();
    while (!captured && Date.now() - start < 3000) {
        // busy-wait with Atomics is heavy; use deasync alternative:
        // run pending timers via setTimeout 0 not available sync.
        break;
    }

    // Force microtask drain synchronously isn't possible; use atomics wait pattern:
    // Instead re-invoke by evaluating a sync wait in the script via Atomics.
    // Simpler: the script uses async onload - patch to strip async!

    if (!captured) {
        // Try sync invoke if onload still pending
        try {
            runInContext(
                `(function(){var o=window.onload; if(typeof o==='function'){ var r=o.call(window); if(r&&typeof r.then==='function'){ /*can't wait*/ } }})()`,
                ctx
            );
        } catch {
            /* ignore */
        }
    }

    // Use Atomics.wait for a short sleep so promises can settle when using
    // shared buffer — not available. Fall back to math-only.
    // Closure assignment to `captured` is invisible to TS control-flow analysis.
    const result = captured as {
        i: string;
        state: Record<string, number>;
        ts: number;
    } | null;
    if (!result) {
        throw new Error(
            `full script produced no result (err=${sandbox.__err || win.__err || 'none'})`
        );
    }
    if (!/^[0-9a-f]{32}$/.test(result.i)) {
        throw new Error(`full script bad id ${result.i}`);
    }
    return result;
}

function solveInstrumentationMath(plain: string): {
    i: string;
    state: Record<string, number>;
    ts: number;
} {
    const compCode = extractComputation(plain);

    // Newer Cap builds (2026-07): entire payload is
    //   (function(){ window['onload']=async function(){ … antibot … return;}
    //     var a=0x..,b=0x..,c=0x..,d=0x..; … var OUT={}; return OUT… })();
    // There is NO string-table bootstrap before the onload IIFE, and the
    // instr id is a literal hex string in the success postMessage.
    // Older builds still put rotate+decoder before onload — keep that path.
    const literalId =
        plain.match(
            /['"]result['"]\s*:\s*\{\s*['"]i['"]\s*:\s*['"]([0-9a-f]{32})['"]/i
        )?.[1] ||
        plain.match(/['"]i['"]\s*:\s*['"]([0-9a-f]{32})['"]/i)?.[1] ||
        plain.match(/['"]nonce['"]\s*:\s*['"]([0-9a-f]{32})['"]/i)?.[1];

    // Pure-math path: instr id is a literal hex string (not a decoder expr)
    // and the payload starts with the onload IIFE (no rotate/bootstrap prefix).
    const pureMath =
        !!literalId &&
        (/^\(function\(\)\{window/.test(plain.trimStart()) ||
            /^\(function\(\)\{window\['/.test(plain.trimStart()));

    if (pureMath && literalId) {
        const document = makeDocument();
        const navigator = {
            userAgent: BROWSER_HEADERS['User-Agent']
        };
        const sandbox: Record<string, unknown> = {
            document,
            navigator,
            result: null,
            parseInt,
            Error,
            console
        };
        const ctx = createContext(sandbox);
        const wrapped = `
function runCapMath(document, navigator) {
  return (function(document, navigator) {
    ${compCode}
  })(document, navigator);
}
result = runCapMath(document, navigator);
`;
        try {
            new Script(wrapped, { filename: 'cap-math-pure.js' }).runInContext(
                ctx,
                { timeout: 8000 }
            );
        } catch (e) {
            throw new Error(
                `Cap pure-math exec failed: ${e instanceof Error ? e.message : e}`
            );
        }
        const state = sandbox.result as Record<string, number> | null;
        if (!state || typeof state !== 'object') {
            throw new Error('Cap pure-math produced no state');
        }
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(state)) {
            out[k] = Number(v);
        }
        return { i: literalId.toLowerCase(), state: out, ts: Date.now() };
    }

    // --- Legacy path: string decoder + array rotate IIFE before onload ---
    // Cap joins rotate + onload as:  }(tableFn, SEED), (function(){ window.onload=… })
    // Cut at the onload IIFE (several obfuscation shapes).
    // NOTE: onload may start at index 0 (new pure-math format handled above).
    const onloadAnchors = [
        '(function(){window',
        "(function(){window['",
        '(function(){var ',
        '(function(){const '
    ];
    let bootEnd = -1;
    for (const a of onloadAnchors) {
        const idx = plain.indexOf(a);
        // idx === 0 is valid for pure-math (empty bootstrap); legacy needs >0
        if (idx > 0) {
            bootEnd = idx;
            break;
        }
    }
    if (bootEnd < 0) {
        // Fallback: last `,(function(){` before computation
        const compAt = plain.search(
            /return;\s*\}var [a-zA-Z0-9_$]+=0x[0-9a-f]+/i
        );
        const slice = plain.slice(0, compAt > 0 ? compAt : plain.length);
        bootEnd = slice.lastIndexOf(',(function(){');
        if (bootEnd < 0) bootEnd = slice.lastIndexOf(',(function (){');
        if (bootEnd > 0)
            bootEnd += 1; // keep leading content before comma
        else throw new Error('Cap instr: onload IIFE not found');
    }

    // Content before onload IIFE ends with `}(fn,0xSEED),` as part of a
    // parenthesized comma-expr `(rotateIIFE, onloadIIFE)`. Drop onload and
    // close the group: `}(fn,0xSEED),` → `}(fn,0xSEED));`
    let prefix = plain.slice(0, bootEnd);
    if (/,\s*$/.test(prefix)) {
        prefix = prefix.replace(/,\s*$/, ');');
    } else if (!prefix.trimEnd().endsWith(';')) {
        prefix += ';';
    }

    // Trailing string-array helper sometimes sits AFTER the onload IIFE
    const trailM = plain.match(
        /\}\s*\(\s*\)\s*\)\s*\)?\s*;?\s*(function\s+[a-zA-Z0-9_$]+\s*\(\s*\)\s*\{[\s\S]*)$/
    );
    const trailing = trailM ? trailM[1] : '';

    const nonceM = plain.match(/['"]nonce['"]\s*:\s*([^,]+)/);
    let nonceExpr = nonceM ? nonceM[1].trim() : "''";

    const decNameM = plain.match(/^function\s+([a-zA-Z0-9_$]+)\s*\(/);
    const decName = decNameM?.[1] || 'Z';

    // Rewrite decoder calls: any `alias(0xNNN)` → `__dec(0xNNN)`.
    // Cap's string decoder is always invoked with a single hex literal.
    // Local helpers take multiple args / identifiers, so they are left alone.
    // Also strip `var t4=t2` alias-to-alias bindings left after call rewrite.
    const rewriteDecCalls = (code: string): string => {
        let c = code.replace(
            /\b[a-zA-Z_$][\w$]*\s*\(\s*(0x[0-9a-fA-F]+)\s*\)/g,
            '__dec($1)'
        );
        // `var t4=t2,` or `var t4=t2;` → drop (t4 only existed to call decoder)
        c = c.replace(
            /\bvar\s+[a-zA-Z_$][\w$]*\s*=\s*[a-zA-Z_$][\w$]*\s*,/g,
            'var __cap_alias_drop=0,'
        );
        c = c.replace(
            /\bvar\s+[a-zA-Z_$][\w$]*\s*=\s*[a-zA-Z_$][\w$]*\s*;/g,
            '/*alias-drop*/;'
        );
        // Lone `,t4=t2,` mid-expression
        c = c.replace(/,\s*[a-zA-Z_$][\w$]*\s*=\s*[a-zA-Z_$][\w$]*\s*,/g, ',');
        return c;
    };

    const compRewritten = rewriteDecCalls(compCode);
    nonceExpr = rewriteDecCalls(nonceExpr);

    const program = `
${prefix}
${trailing}
function runCapMath(document, navigator) {
  var __dec = ${decName};
  return (function(document, navigator, __dec) {
    ${compRewritten}
  })(document, navigator, __dec);
}
function resolveInstrId() {
  var __dec = ${decName};
  return String(${nonceExpr});
}
`;

    const document = makeDocument();
    const navigator = {
        userAgent: BROWSER_HEADERS['User-Agent']
    };

    const sandbox: Record<string, unknown> = {
        document,
        navigator,
        result: null,
        instrId: '',
        parseInt,
        Error,
        console
    };
    const ctx = createContext(sandbox);
    const wrapped = `
${program}
result = runCapMath(document, navigator);
instrId = resolveInstrId();
`;
    try {
        new Script(wrapped, { filename: 'cap-math.js' }).runInContext(ctx, {
            timeout: 8000
        });
    } catch (e) {
        throw new Error(
            `Cap math exec failed: ${e instanceof Error ? e.message : e}`
        );
    }

    const state = sandbox.result as Record<string, number> | null;
    if (!state || typeof state !== 'object') {
        throw new Error('Cap math produced no state');
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(state)) {
        out[k] = Number(v);
    }
    const id = String(sandbox.instrId || literalId || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(id)) {
        throw new Error(`Cap instr id invalid: ${id}`);
    }
    return { i: id, state: out, ts: Date.now() };
}

function solvePowChallenges(
    token: string,
    challenge: { c: number; s: number; d: number }
): number[] {
    return Array.from({ length: challenge.c }, (_, i) => {
        const n = i + 1;
        return solvePow(
            prng(`${token}${n}`, challenge.s),
            prng(`${token}${n}d`, challenge.d)
        );
    });
}

/**
 * Mint a Cap token (cached until near expiry). Safe to call per-resolve.
 * Cap challenge blobs vary in obfuscation; we retry a few times on solve failures.
 */
export async function mintCapToken(
    opts: { force?: boolean; timeoutMs?: number; retries?: number } = {}
): Promise<string> {
    const now = Date.now();
    if (
        !opts.force &&
        cached &&
        cached.expires - now > 60_000 // refresh 1 min early
    ) {
        return cached.token;
    }

    const timeoutMs = opts.timeoutMs ?? 90_000;
    const retries = opts.retries ?? 4;
    let lastErr: unknown;

    for (let attempt = 0; attempt < retries; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const chRes = await fetch(`${CAP_ENDPOINT}challenge`, {
                method: 'POST',
                headers: BROWSER_HEADERS,
                signal: ac.signal
            });
            const ch = (await chRes.json()) as {
                error?: string;
                challenge?: { c: number; s: number; d: number };
                token?: string;
                instrumentation?: string;
            };
            if (ch.error || !ch.token || !ch.challenge || !ch.instrumentation) {
                throw new Error(
                    `Cap challenge failed: ${ch.error || chRes.status}`
                );
            }

            const instr = solveInstrumentation(ch.instrumentation);
            const solutions = solvePowChallenges(ch.token, ch.challenge);

            const redeemRes = await fetch(`${CAP_ENDPOINT}redeem`, {
                method: 'POST',
                headers: {
                    ...BROWSER_HEADERS,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    token: ch.token,
                    solutions,
                    instr: {
                        i: instr.i,
                        state: instr.state,
                        ts: instr.ts
                    }
                }),
                signal: ac.signal
            });
            const redeem = (await redeemRes.json()) as {
                success?: boolean;
                token?: string;
                expires?: number;
                error?: string;
                reason?: string;
            };
            if (!redeem.success || !redeem.token) {
                throw new Error(
                    `Cap redeem failed: ${redeem.error || redeem.reason || redeemRes.status}`
                );
            }

            cached = {
                token: redeem.token,
                expires:
                    typeof redeem.expires === 'number'
                        ? redeem.expires
                        : Date.now() + 2 * 60 * 60 * 1000
            };
            return cached.token;
        } catch (e) {
            lastErr = e;
            // Fresh challenge on next attempt (instr/pow are challenge-bound).
            continue;
        } finally {
            clearTimeout(timer);
        }
    }

    throw lastErr instanceof Error
        ? lastErr
        : new Error(`Cap mint failed after ${retries} attempts`);
}

export function clearCapTokenCache(): void {
    cached = null;
}

/** Test helper: solve instrumentation from a raw base64 blob. */
export function solveInstrumentationForTest(instrumentationB64: string) {
    return solveInstrumentation(instrumentationB64);
}
