import { readFileSync, writeFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';
import { inflateRawSync } from 'node:zlib';

const ch = JSON.parse(readFileSync('/tmp/hexa-challenge.json', 'utf8')) as {
    instrumentation: string;
};
const plain = inflateRawSync(
    Buffer.from(ch.instrumentation, 'base64')
).toString('utf8');

function patch(src: string): string {
    let s = src;
    s = s.replace(/return\s+null\s*;/g, '/*env-bypass*/;');
    s = s.replace(/return\s+null\s*$/gm, '/*env-bypass*/;');
    s = s.replace(/return\s+null\s*([,}])/g, ';$1');
    s = s.replace(
        /['"]blocked['"]\s*:\s*!!\[\]/g,
        "'blocked':false"
    );
    s = s.replace(
        /blocked\s*:\s*(?:!0|true|!!\[\])/g,
        'blocked:false/*patched*/'
    );
    s = s.replace(
        /(['"]result['"]\s*:\s*['"]['"][^)]*\)\s*;)\s*return\s*;/g,
        '$1/*ret-strip*/;'
    );
    // Capture U before the success-path guard `if(!U||typeof U!==… )return;`
    s = s.replace(
        /if\s*\(\s*!(\w+)\s*\|\|\s*typeof\s+\1\s*!==/g,
        'globalThis.__capU=$1;if(!$1||typeof $1!=='
    );
    s +=
        ';\ntry{if(typeof window.onload==="function"){Promise.resolve(window.onload()).catch(function(e){globalThis.__err=String(e&&e.stack||e);});}}catch(e){globalThis.__err=String(e);}\n';
    return s;
}

const patched = patch(plain);
writeFileSync('/tmp/cap-patched-debug.js', patched);
console.log('blocked false count', (patched.match(/blocked:false/g) || []).length);
console.log('ret-strip', patched.includes('ret-strip'));
console.log(
    'region',
    patched.match(/.{0,100}blocked:false.{0,100}/)?.[0]
);
console.log(
    'empty-result posts left',
    patched.match(/result['"]:\s*['"]['"].{0,80}/g)
);

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
        return this.children.at(-1) || null;
    }
    appendChild(c: El) {
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
function HTMLElement() {}
function Window() {}
function Document() {}
function Navigator() {}
function Node() {}
function EventTarget() {}
function MimeType() {}
function MimeTypeArray() {}

Object.defineProperties(Navigator.prototype, {
    userAgent: {
        get: () =>
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
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
    plugins: { get: () => [], configurable: true }
});
const nav = Object.create(Navigator.prototype);
console.log('own names nav', Object.getOwnPropertyNames(nav));

const body = new El('body');
Object.setPrototypeOf(body, HTMLElement.prototype);
const messages: unknown[] = [];
const parent = {
    postMessage(data: unknown) {
        messages.push(data);
        console.log('POSTMESSAGE', JSON.stringify(data).slice(0, 400));
    }
};
const doc: Record<string, unknown> = Object.create(Document.prototype);
Object.assign(doc, {
    body,
    documentElement: body,
    defaultView: null,
    createElement: (t: string) => {
        const e = new El(t);
        Object.setPrototypeOf(e, HTMLElement.prototype);
        return e;
    },
    hasFocus: () => true,
    getAttributeNames: () => [],
    getElementsByTagName: () => []
});
const win: Record<string, unknown> = Object.create(Window.prototype);
Object.assign(win, {
    window: null,
    self: null,
    parent,
    top: null,
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
const nativeToString = Object.prototype.toString;
Object.prototype.toString = function (this: unknown) {
    if (this === nav) return '[object Navigator]';
    if (this === win) return '[object Window]';
    if (this === doc) return '[object HTMLDocument]';
    return nativeToString.call(this);
};

const sandbox: Record<string, unknown> = {
    ...win,
    globalThis: null,
    global: undefined,
    process: undefined,
    module: undefined,
    require: undefined,
    Buffer: undefined
};
sandbox.globalThis = sandbox;
const ctx = createContext(sandbox);
runInContext(
    'window.globalThis=window;globalThis.window=window;globalThis.self=window;globalThis.parent=parent;globalThis.document=document;globalThis.navigator=navigator;',
    ctx
);
try {
    new Script(patched, { filename: 'x.js' }).runInContext(ctx, {
        timeout: 10000
    });
} catch (e) {
    console.log('run error', e);
}
await new Promise((r) => setTimeout(r, 2000));
console.log('err', sandbox.__err);
console.log('__capU', sandbox.__capU);
console.log('messages', messages.length);
console.log('ctx onload', runInContext('typeof window.onload', ctx));
// also try evaluating pure chain with mock after decode fails
if (!sandbox.__capU) {
    console.log('no U — checking if async IIFE threw silently');
}
