/**
 * Loads the vidsrc wasm-bindgen module (img_data) in Node.
 *
 * The module derives a fixed 64-char key (`get_img_key`) and decrypts the
 * backend's AES-encrypted responses (`process_img_data`). Both read a browser
 * fingerprint (canvas / navigator / screen / localStorage) as an anti-tamper
 * gate, so we install a minimal browser shim before instantiating. The key is
 * a fixed embedded secret (stable across calls / environments), so plausible
 * shim values are sufficient.
 *
 * The `.wasm` bytes are fed directly to the glue's init (no network / no fetch
 * of the wasm), so instantiation works offline. The backend calls made later
 * (in vidsrcClient.ts) are the only part that needs the network.
 */
import { readFile } from 'node:fs/promises';

interface WasmGlue {
    default: (opts: { module_or_path: Uint8Array }) => Promise<unknown>;
    get_img_key: () => string;
    process_img_data: (a: string, apiKey: string) => Promise<string> | string;
}

export interface VidsrcWasm {
    getImgKey: () => string;
    processImgData: (payload: string, apiKey: string) => Promise<string>;
}

let cached: VidsrcWasm | null = null;

function installBrowserShim(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    if (g.__vidsrcShimInstalled) return;

    class Window {}
    class HTMLCanvasElement {}
    class CanvasRenderingContext2D {}

    const ctx = Object.assign(new CanvasRenderingContext2D(), {
        font: '',
        textBaseline: '',
        fillText: () => {}
    });
    const canvas = Object.assign(new HTMLCanvasElement(), {
        width: 0,
        height: 0,
        getContext: (type: string) => (type === '2d' ? ctx : null),
        toDataURL: () =>
            'data:image/png;base64,' +
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    });

    const store = new Map<string, string>();
    const localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => void store.clear()
    };

    const bodyEl = { nodeName: 'BODY' };
    const scriptEls = [
        { src: 'https://themoviedb.vidsrc.su/assets/wasm/img_data.js' },
        { src: 'https://1414.hexa.su/script.js' }
    ];
    const documentObj = {
        createElement: (t: string) => (t === 'canvas' ? canvas : {}),
        getElementsByTagName: (tag: string) => {
            const t = String(tag).toLowerCase();
            if (t === 'body' || t === 'html') return [bodyEl];
            if (t === 'script') return scriptEls;
            return [];
        }
    };

    const navigatorObj = {
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        platform: 'Win32',
        language: 'en-US'
    };
    const screenObj = { width: 1920, height: 1080, colorDepth: 24 };
    const perf =
        (g.performance as { now: () => number } | undefined) ??
        ({ now: () => Date.now() } as { now: () => number });

    const win = Object.assign(new Window(), {
        document: documentObj,
        localStorage,
        navigator: navigatorObj,
        screen: screenObj,
        performance: perf
    }) as unknown as Record<string, unknown>;
    win.window = win;
    win.self = win;

    g.Window = Window;
    g.HTMLCanvasElement = HTMLCanvasElement;
    g.CanvasRenderingContext2D = CanvasRenderingContext2D;
    g.window = win;
    g.self = win;
    g.document = documentObj;
    g.localStorage = localStorage;
    g.screen = screenObj;
    g.__vidsrcShimInstalled = true;
}

/**
 * Lazily instantiate the wasm module (cached for the process lifetime).
 */
export async function ensureVidsrcWasm(): Promise<VidsrcWasm> {
    if (cached) return cached;
    installBrowserShim();

    const glueUrl = new URL('./wasm/img_data.js', import.meta.url);
    const wasmUrl = new URL('./wasm/img_data_bg.wasm', import.meta.url);

    const glue = (await import(glueUrl.href)) as unknown as WasmGlue;
    const bytes = await readFile(wasmUrl);
    await glue.default({ module_or_path: new Uint8Array(bytes) });

    cached = {
        getImgKey: () => glue.get_img_key(),
        processImgData: async (payload, apiKey) =>
            String(await glue.process_img_data(payload, apiKey))
    };
    return cached;
}

/**
 * Reset the shim localStorage between resolutions. The wasm reads/writes
 * localStorage (call counter + session), and the site clears it at the start
 * of every resolution; mirroring that avoids the wasm refusing after repeated
 * calls in a long-lived server process.
 */
export function clearVidsrcSession(): void {
    const ls = (
        globalThis as unknown as { localStorage?: { clear?: () => void } }
    ).localStorage;
    ls?.clear?.();
}
