/**
 * Prove Cap instrumentation can be executed in Node with a DOM tree mock
 * (no Playwright). Validates against the browser capture's expected state.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// Expected from hexa_redeem_headers_and_response.txt for the paired challenge.
const EXPECTED = {
    i: '4b9f7ce9aec1354b1188b5486fa78bae',
    state: {
        e1l6aqd32doc: 266097,
        oob3l5i08ad6: 524969,
        focoal3cn1f5: 609699,
        bfdgvlbanjoz: 998124
    }
};

type InstrResult = {
    i: string;
    state: Record<string, number>;
    ts: number;
};

class MockEl {
    tagName: string;
    children: MockEl[] = [];
    parentNode: MockEl | null = null;
    style: Record<string, string> = {};
    private _text = '';
    nodeType = 1;

    constructor(tag: string) {
        this.tagName = String(tag).toUpperCase();
    }

    get innerText(): string {
        return this._text;
    }
    set innerText(v: unknown) {
        this._text = String(v);
    }

    get textContent(): string {
        return this._text;
    }
    set textContent(v: unknown) {
        this._text = String(v);
    }

    get lastElementChild(): MockEl | null {
        return this.children.length
            ? this.children[this.children.length - 1]
            : null;
    }

    appendChild(c: MockEl): MockEl {
        if (c.parentNode) {
            c.parentNode.removeChild(c);
        }
        c.parentNode = this;
        this.children.push(c);
        return c;
    }

    removeChild(c: MockEl): MockEl {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
    }

    getAttributeNames(): string[] {
        return [];
    }

    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
        return true;
    }
}

function buildBrowserShim(onInstr: (r: InstrResult | null, blocked?: boolean) => void) {
    const body = new MockEl('body');
    const html = new MockEl('html');
    html.appendChild(body);

    // Constructor tags so `instanceof` checks can be made to pass via prototype hacks.
    function HTMLElement() {}
    function Window() {}
    function Document() {}
    function Navigator() {}
    function Node() {}
    function EventTarget() {}
    function MimeType() {}
    function MimeTypeArray() {}

    Object.setPrototypeOf(body, HTMLElement.prototype);
    Object.setPrototypeOf(html, HTMLElement.prototype);

    // Cap antibot: `Object.getOwnPropertyNames(navigator).length !== 0` ⇒ blocked.
    // Put browser props on the prototype so own-names stay empty.
    const UA =
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
    Object.defineProperties(Navigator.prototype, {
        userAgent: { get: () => UA, configurable: true },
        appVersion: {
            get: () =>
                '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            configurable: true
        },
        platform: { get: () => 'Linux x86_64', configurable: true },
        language: { get: () => 'en-US', configurable: true },
        languages: { get: () => ['en-US', 'en'], configurable: true },
        productSub: { get: () => '20030107', configurable: true },
        webdriver: { get: () => undefined, configurable: true },
        mimeTypes: {
            get: () => {
                const arr: unknown[] = [];
                Object.setPrototypeOf(arr, MimeTypeArray.prototype);
                return arr;
            },
            configurable: true
        },
        plugins: { get: () => [], configurable: true }
    });
    const navigatorObj = Object.create(Navigator.prototype);

    const documentObj: Record<string, unknown> = Object.create(
        Document.prototype
    );
    Object.assign(documentObj, {
        body,
        documentElement: html,
        defaultView: null as unknown,
        createElement: (tag: string) => {
            const el = new MockEl(tag);
            Object.setPrototypeOf(el, HTMLElement.prototype);
            return el;
        },
        getElementsByTagName: (tag: string) => {
            const t = tag.toLowerCase();
            if (t === 'body') return [body];
            if (t === 'html') return [html];
            return [];
        },
        createElementNS: (_ns: string, tag: string) =>
            (documentObj.createElement as (t: string) => MockEl)(tag),
        hasFocus: () => true,
        getAttributeNames: () => []
    });

    const windowObj: Record<string, unknown> = Object.create(Window.prototype);
    const parentObj = {
        postMessage: (
            data: {
                type?: string;
                nonce?: string;
                result?: InstrResult | string;
                blocked?: boolean;
            },
            _origin?: string
        ) => {
            if (data?.type === 'cap:instr' || data?.type === 'cap:instr') {
                // type may be split: 'cap:ins'+'tr'
            }
            const t = String(data?.type ?? '');
            if (t.includes('cap:instr') || t === 'cap:instr' || t.endsWith('tr') && t.includes('cap')) {
                if (data.blocked) {
                    onInstr(null, true);
                    return;
                }
                const res = data.result;
                if (res && typeof res === 'object' && 'state' in res) {
                    onInstr(res as InstrResult);
                } else if (res === '' || res === undefined) {
                    onInstr(null, true);
                }
            } else if (
                data &&
                typeof data === 'object' &&
                // obfuscated type field might already be full string
                (data as { result?: InstrResult }).result &&
                typeof (data as { result: InstrResult }).result === 'object' &&
                'i' in ((data as { result: InstrResult }).result as object)
            ) {
                onInstr((data as { result: InstrResult }).result);
            }
        }
    };

    // Broader postMessage capture: any message with result.state
    parentObj.postMessage = (data: Record<string, unknown>) => {
        if (!data || typeof data !== 'object') return;
        const res = data.result;
        // Prefer a successful state payload even if blocked flag is present.
        if (
            res &&
            typeof res === 'object' &&
            res !== null &&
            'state' in res &&
            'i' in res
        ) {
            onInstr(res as InstrResult);
            return;
        }
        if ('state' in data && 'i' in data) {
            onInstr(data as unknown as InstrResult);
            return;
        }
        if (data.blocked) {
            onInstr(null, true);
        }
    };

    Object.assign(windowObj, {
        window: null as unknown,
        self: null as unknown,
        parent: parentObj,
        top: null as unknown,
        document: documentObj,
        navigator: navigatorObj,
        HTMLElement,
        Window,
        Document,
        Navigator,
        Node,
        EventTarget,
        MimeType,
        MimeTypeArray,
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
        devicePixelRatio: 1,
        // Do NOT set chrome/cdc_/webdriver markers Cap hashes for.
        performance: { now: () => Date.now() },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
        getComputedStyle: () => ({}),
        matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
        CustomEvent: class CustomEvent {
            type: string;
            detail: unknown;
            constructor(type: string, init?: { detail?: unknown }) {
                this.type = type;
                this.detail = init?.detail;
            }
        },
        // Cap checks eval / Function
        eval,
        isSecureContext: true
    });
    windowObj.window = windowObj;
    windowObj.self = windowObj;
    windowObj.top = windowObj;
    documentObj.defaultView = windowObj;

    // instanceof chain
    Object.setPrototypeOf(windowObj, Window.prototype);
    Object.setPrototypeOf(documentObj, Document.prototype);
    Object.setPrototypeOf(EventTarget.prototype, Object.prototype);

    // toString tags Cap checks via hash, but also raw:
    const nativeToString = Object.prototype.toString;
    Object.prototype.toString = function (this: unknown) {
        if (this === navigatorObj) return '[object Navigator]';
        if (this === windowObj) return '[object Window]';
        if (this === documentObj) return '[object HTMLDocument]';
        return nativeToString.call(this);
    };

    return { windowObj, documentObj, navigatorObj, HTMLElement, Window, Document, Navigator, Node, EventTarget };
}

/**
 * Neutralize Cap env early-exits without breaking the computation.
 * The capture has ~8 `return null` from env probes; the success path returns an object.
 */
function patchInstrumentation(src: string): string {
    let s = src;

    // Env probes abort with `return null` before the computation chain.
    s = s.replace(/return\s+null\s*;/g, '/*env-bypass*/;');
    s = s.replace(/return\s+null\s*$/gm, '/*env-bypass*/;');
    s = s.replace(/return\s+null\s*([,}])/g, ';$1');

    // Antibot path: postMessage({result:'', blocked:!![]}); return;
    // Must kill both the blocked flag AND the early return so the math chain runs.
    s = s.replace(
        /blocked\s*:\s*(?:!0|true|!\!\[\])/g,
        'blocked:false/*patched*/'
    );
    s = s.replace(
        /(['"]result['"]\s*:\s*['"]['"]\s*,\s*['"]blocked['"]\s*:\s*false\/\*patched\*\/\s*\}\s*,\s*['"]\*['"]\s*\)\s*;)\s*return\s*;/g,
        '$1/*antibot-return-stripped*/;'
    );
    // Fallback: any `},'*');return;}` right after empty result (pre-patch order)
    s = s.replace(
        /(['"]result['"]\s*:\s*['"]['"][^)]*\)\s*;)\s*return\s*;/g,
        '$1/*antibot-return-stripped*/;'
    );

    // Kick onload after the IIFE registers it.
    s +=
        ';\ntry{if(typeof window!=="undefined"&&typeof window.onload==="function"){Promise.resolve(window.onload()).catch(function(e){globalThis.__capInstrErr=String(e&&e.stack||e);});}}catch(e){globalThis.__capInstrErr=String(e&&e.stack||e);}\n';

    return s;
}

async function runInstrumentation(instrumentationB64: string): Promise<InstrResult> {
    const plain = inflateRawSync(
        Buffer.from(instrumentationB64, 'base64')
    ).toString('utf8');
    writeFileSync('/tmp/cap-instr-plain.js', plain);

    let resolved: InstrResult | null = null;
    let blocked = false;

    const shim = buildBrowserShim((r, b) => {
        if (b) blocked = true;
        if (r) resolved = r;
    });

    const patched = patchInstrumentation(plain);
    writeFileSync('/tmp/cap-instr-patched.js', patched);

    const sandbox: Record<string, unknown> = {
        ...shim.windowObj,
        globalThis: null as unknown,
        global: undefined,
        process: undefined,
        module: undefined,
        require: undefined,
        Buffer: undefined,
        __capInstrErr: null as string | null
    };
    sandbox.globalThis = sandbox;
    // Cap checks globalThis === window
    // and window.self === window — already set

    const ctx = createContext(sandbox);
    // Re-bind window aliases inside context
    runInContext(
        'window.globalThis=window;globalThis.window=window;globalThis.self=window;globalThis.parent=parent;globalThis.document=document;globalThis.navigator=navigator;',
        ctx
    );

    const script = new Script(patched, { filename: 'cap-instr.js' });
    script.runInContext(ctx, { timeout: 10_000 });

    // Wait for async onload
    const deadline = Date.now() + 8000;
    while (!resolved && !blocked && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        // drain microtasks
        await new Promise((r) => setImmediate(r));
    }

    const err = sandbox.__capInstrErr as string | null;
    if (err) console.error('instr runtime err:', err.slice(0, 500));
    if (blocked) throw new Error('instrumentation reported blocked');
    if (!resolved) {
        throw new Error(
            'instrumentation produced no result (env checks may still abort silently)'
        );
    }
    return resolved;
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

    console.log('=== Phase 1: execute capture instrumentation ===');
    const instr = await runInstrumentation(challenge.instrumentation);
    console.log('got i:', instr.i);
    console.log('got state:', instr.state);
    console.log('expected i:', EXPECTED.i);
    console.log('expected state:', EXPECTED.state);

    const iOk = instr.i === EXPECTED.i;
    const stateOk =
        Object.keys(EXPECTED.state).every(
            (k) =>
                instr.state[k] ===
                EXPECTED.state[k as keyof typeof EXPECTED.state]
        ) && Object.keys(instr.state).length === Object.keys(EXPECTED.state).length;

    console.log('i match:', iOk);
    console.log('state match:', stateOk);

    if (!iOk || !stateOk) {
        console.log('DIFF state keys ours', Object.keys(instr.state));
        for (const k of new Set([
            ...Object.keys(instr.state),
            ...Object.keys(EXPECTED.state)
        ])) {
            console.log(
                `  ${k}: got=${instr.state[k]} exp=${(EXPECTED.state as Record<string, number>)[k]}`
            );
        }
        // Still continue to live challenge if capture execution worked partially
    } else {
        console.log('SUCCESS: capture instrumentation matched browser exactly');
    }

    // Phase 2: live mint
    console.log('\n=== Phase 2: live Cap mint ===');
    const CAP = 'https://cap.hexa.su/15d2cf0395/';
    const headers: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        Accept: '*/*',
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

    const chRes = await fetch(`${CAP}challenge`, {
        method: 'POST',
        headers
    });
    const ch = (await chRes.json()) as {
        error?: string;
        challenge?: { c: number; s: number; d: number };
        token?: string;
        instrumentation?: string;
    };
    console.log('challenge', chRes.status, ch.error || 'ok');
    if (ch.error || !ch.token || !ch.challenge || !ch.instrumentation) {
        throw new Error('live challenge failed');
    }

    const liveInstr = await runInstrumentation(ch.instrumentation);
    console.log('live instr i', liveInstr.i, 'state', liveInstr.state);

    console.log('solving pow', ch.challenge.c);
    const t0 = Date.now();
    const solutions = Array.from({ length: ch.challenge.c }, (_, i) => {
        const n = i + 1;
        return solvePow(
            prng(`${ch.token}${n}`, ch.challenge!.s),
            prng(`${ch.token}${n}d`, ch.challenge!.d)
        );
    });
    console.log('pow done', Date.now() - t0, 'ms');

    const redeemRes = await fetch(`${CAP}redeem`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            token: ch.token,
            solutions,
            instr: {
                i: liveInstr.i,
                state: liveInstr.state,
                ts: liveInstr.ts || Date.now()
            }
        })
    });
    const redeemText = await redeemRes.text();
    console.log('redeem', redeemRes.status, redeemText.slice(0, 400));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
