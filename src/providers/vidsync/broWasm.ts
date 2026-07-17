/**
 * bro.wasm client for VidSync stream decryption.
 *
 * Browser flow (embed chunk 96fa5e81961f95b0.js):
 *   1. WebAssembly.instantiate(/bro.wasm, { env: { seed, abort } })
 *   2. Function(exports.serve())()  → sets window.X1..X50 + async window.hash
 *   3. exports.verify(window.hash)
 *   4. exports.decrypt(ciphertext, mediaId)  → JSON string
 *
 * The serve() payload is heavily obfuscated (anti-debug). Evaluating it in Node
 * OOMs. The hash is deterministic and much simpler:
 *
 *   SHA-512_hex( SERVE_HASH_PREFIX + window.X12 )
 *
 * PREFIX is constant for a given bro.wasm build (embedded in the obfuscated
 * string table). X12 is emitted as `window.X12 = "..."` in serve() output and
 * is extracted with a regex — no eval required.
 *
 * CAVEATS: resolve ≠ playback; local ≠ EC2. Same as Hexa/VidKing.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Constant prefix concatenated with window.X12 before SHA-512.
 * Captured 2026-07-15 from live bro.wasm serve() → crypto.subtle.digest hook.
 * Re-extract if wasm is updated and verify() starts failing.
 */
export const SERVE_HASH_PREFIX =
    '1nD9pVguvnD9pwfs1nD9acTg3LSlsfw9iqVgsfDuunD9smZgPcZaaGDj3SVqFmZjO';

export interface BroWasm {
    /** Decrypt a per-server ciphertext blob. mediaId is the numeric TMDB id. */
    decrypt(ciphertext: string, mediaId: number): string;
}

interface WasmMemory {
    buffer: ArrayBuffer;
}

interface BroExports {
    memory: WasmMemory;
    serve: () => number;
    verify: (ptr: number) => number;
    decrypt: (textPtr: number, mediaId: number) => number;
    __new: (size: number, id: number) => number;
}

let cachedBytes: Uint8Array | null = null;

async function loadWasmBytes(): Promise<Uint8Array> {
    if (cachedBytes) return cachedBytes;
    const wasmUrl = new URL('./wasm/bro.wasm', import.meta.url);
    cachedBytes = new Uint8Array(await readFile(wasmUrl));
    return cachedBytes;
}

function readAsString(exports: BroExports, ptr: number): string | null {
    if (!ptr) return null;
    const u32 = new Uint32Array(exports.memory.buffer);
    const byteLen = u32[(ptr - 4) >>> 2] || 0;
    const u16 = new Uint16Array(exports.memory.buffer);
    const start = ptr >>> 1;
    const end = start + (byteLen >>> 1);
    let s = '';
    for (let i = start; i < end; i += 1024) {
        s += String.fromCharCode(...u16.subarray(i, Math.min(i + 1024, end)));
    }
    return s;
}

function writeAsString(exports: BroExports, str: string): number {
    const ptr = exports.__new(str.length << 1, 2) >>> 0;
    const u16 = new Uint16Array(exports.memory.buffer);
    for (let i = 0; i < str.length; i++) {
        u16[(ptr >>> 1) + i] = str.charCodeAt(i);
    }
    return ptr;
}

function extractX12(serveJs: string): string {
    const m = serveJs.match(/window\.X12\s*=\s*"([^"]+)"/);
    if (!m?.[1]) {
        throw new Error('bro.wasm serve(): could not extract window.X12');
    }
    return m[1];
}

function computeHash(x12: string): string {
    return createHash('sha512')
        .update(SERVE_HASH_PREFIX + x12, 'utf8')
        .digest('hex');
}

/**
 * Create a fresh bro.wasm instance, run serve→verify, and return a decrypt
 * handle. Each call is independent (seed-randomized serve payload); the
 * returned decrypt is valid for this instance only.
 */
export async function createBroWasm(): Promise<BroWasm> {
    const bytes = await loadWasmBytes();
    let exportsRef: BroExports | null = null;

    // WebAssembly is a Node global; avoid DOM lib dependency in tsconfig.
    const WA = (
        globalThis as unknown as {
            WebAssembly: {
                instantiate: (
                    buf: ArrayBufferView | ArrayBuffer,
                    imports: Record<string, unknown>
                ) => Promise<{ instance: { exports: object } }>;
            };
        }
    ).WebAssembly;

    const { instance } = await WA.instantiate(bytes, {
        env: {
            seed: () => Date.now() * Math.random(),
            abort(msg: number, file: number, line: number, col: number) {
                const m = exportsRef
                    ? readAsString(exportsRef, msg)
                    : String(msg);
                const f = exportsRef
                    ? readAsString(exportsRef, file)
                    : String(file);
                throw new Error(
                    `bro.wasm abort: ${m ?? 'abort'} in ${f ?? 'unknown'}:${line}:${col}`
                );
            }
        }
    });

    const exp = instance.exports as unknown as BroExports;
    exportsRef = exp;

    const serveJs = readAsString(exp, exp.serve());
    if (!serveJs) {
        throw new Error('bro.wasm serve() returned empty string');
    }

    const x12 = extractX12(serveJs);
    const hash = computeHash(x12);
    if (exp.verify(writeAsString(exp, hash)) === 0) {
        throw new Error(
            'bro.wasm verify(hash) failed — SERVE_HASH_PREFIX may be stale'
        );
    }

    return {
        decrypt(ciphertext: string, mediaId: number): string {
            if (!Number.isFinite(mediaId)) {
                throw new Error(
                    'bro.wasm decrypt requires a numeric mediaId (TMDB id)'
                );
            }
            const out = readAsString(
                exp,
                exp.decrypt(writeAsString(exp, ciphertext), mediaId)
            );
            if (out == null) {
                throw new Error('bro.wasm decrypt returned null');
            }
            return out;
        }
    };
}

/**
 * One-shot helper: instantiate, verify, decrypt, discard instance.
 */
export async function decryptVidsyncPayload(
    ciphertext: string,
    mediaId: number
): Promise<string> {
    const bro = await createBroWasm();
    return bro.decrypt(ciphertext, mediaId);
}
