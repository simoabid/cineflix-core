/**
 * VidKing payload decryptor (enc=2).
 *
 * Faithful port of the player bundle's seed-based XOR stream cipher:
 *   Df  – base64url → bytes
 *   Rf  – init PRNG state from seed + tmdbId
 *   Cf  – next 32-bit word of keystream
 *   xf  – expand keystream to N bytes
 *   Pf  – XOR decrypt, verify magic "mvm1", return UTF-8 JSON
 *
 * Discovered in VideoPlayer-*.js on www.vidking.net (api.speedracelight.com).
 */

const ROUND_CONSTS = [
    1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993,
    2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987,
    1925078388, 2162078206, 2614888103, 3248222580
] as const;

const HASH_IV = [1732584193, 4023233417, 2562383102, 271733878] as const;
const STATE_SIZE = 61;
const INIT_ROUNDS = 8;
const GOLDEN = 2654435769 >>> 0;
/** Magic prefix after successful decrypt: "mvm1". */
const MAGIC = new Uint8Array([109, 118, 109, 49]);

interface CipherState {
    S: unknown[];
    acc: number;
}

function mix(x: number): number {
    let l = x >>> 0;
    l ^= l >>> 16;
    l = Math.imul(l, 2246822507) >>> 0;
    l ^= l >>> 13;
    l = Math.imul(l, 3266489909) >>> 0;
    l ^= l >>> 16;
    return l >>> 0;
}

function rotl(x: number, n: number): number {
    const l = x >>> 0;
    const o = n & 31;
    if (o === 0) return l >>> 0;
    return ((l << o) | (l >>> (32 - o))) >>> 0;
}

function hashSeed(seed: string): number {
    let o = HASH_IV[0] >>> 0;
    for (let i = 0; i < seed.length; i++) {
        o = rotl(
            (o ^ Math.imul(seed.charCodeAt(i), ROUND_CONSTS[i & 15])) >>> 0,
            5
        );
    }
    return mix(o);
}

function initSbox(seed: string): number[] {
    const o = new Array<number>(256);
    for (let i = 0; i < 256; i++) o[i] = i;
    let e = 0;
    for (let i = 0; i < 256; i++) {
        e = (e + o[i] + seed.charCodeAt(i % seed.length)) & 255;
        const t = o[i];
        o[i] = o[e];
        o[e] = t;
    }
    return o;
}

function fnvLike(seed: string): number {
    let o = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        o = Math.imul(o ^ seed.charCodeAt(i), 16777619) >>> 0;
    }
    return mix(o);
}

function combine(a: number, b: number, c: number): number {
    return (((a ^ b) >>> 0) | ((a & b & c) >>> 0)) >>> 0;
}

/** Always-false for integer lengths (product of consecutives is even). */
function isOddTriangular(n: number): boolean {
    return ((n * (n + 1)) & 1) === 1;
}

/** Always-true for integer lengths. */
function isEvenTriangular(n: number): boolean {
    return ((n * (n + 1)) & 1) === 0;
}

function initState(seed: string, mediaId: number): CipherState {
    // Bundle keeps this branch for parity with the original; in practice
    // seed lengths always take the sparse path below.
    if (isOddTriangular(seed.length)) {
        return { S: initSbox(seed), acc: hashSeed(seed) };
    }

    const S = new Array(STATE_SIZE);
    let i = mix(fnvLike(seed) ^ mix((mediaId >>> 0) ^ GOLDEN)) >>> 0;
    for (let r = 0; r < INIT_ROUNDS; r++) {
        if (isEvenTriangular(r)) {
            const n = i % STATE_SIZE;
            i = rotl((i + GOLDEN) >>> 0, 7 + (r & 7));
            S[n] = (i ^ mix(i)) >>> 0;
            i = mix((i + n) >>> 0);
        } else {
            S[r] = ROUND_CONSTS[r & 15];
        }
    }
    return { S, acc: mix(i ^ 2779096485) >>> 0 };
}

function nextWord(state: CipherState, counter: number): number {
    const e = state.S;
    let i = state.acc;
    const r = i % STATE_SIZE;
    // Sparse-array `in` check from the original JS.
    const present = r in e ? -1 : 0;
    const rawSlot = e[r];
    const slot = (typeof rawSlot === 'number' ? rawSlot : 0) >>> 0;
    const d = Math.imul(GOLDEN, counter + 1) >>> 0;
    let g = combine(i, (slot ^ d) >>> 0, present >>> 0);
    g = (rotl((g + i) >>> 0, r & 31) ^ rotl(i, Math.imul(r, 7) & 31)) >>> 0;
    i = mix((g + GOLDEN) >>> 0);
    e[r] = i >>> 0;
    state.acc = i;
    return i >>> 0;
}

function keystream(seed: string, mediaId: number, length: number): Uint8Array {
    const state = initState(seed, mediaId);
    const out = new Uint8Array(length);
    let counter = 0;
    let offset = 0;
    while (offset < length) {
        const word = nextWord(state, counter++);
        out[offset++] = word & 255;
        if (offset < length) out[offset++] = (word >>> 8) & 255;
        if (offset < length) out[offset++] = (word >>> 16) & 255;
        if (offset < length) out[offset++] = (word >>> 24) & 255;
    }
    return out;
}

function decodeBase64Url(payload: string): Uint8Array {
    const padded = payload
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Decrypt an enc=2 response body into a UTF-8 JSON string.
 * @throws if the magic prefix does not match (bad seed / tampered payload).
 */
export function decryptVidkingPayload(
    payload: string,
    seed: string,
    tmdbId: number
): string {
    const cipher = decodeBase64Url(payload);
    const ks = keystream(seed, tmdbId, cipher.length);
    const plain = new Uint8Array(cipher.length);
    for (let i = 0; i < cipher.length; i++) {
        plain[i] = cipher[i] ^ ks[i];
    }
    for (let i = 0; i < MAGIC.length; i++) {
        if (plain[i] !== MAGIC[i]) {
            throw new Error('decrypt failed: bad seed or tampered payload');
        }
    }
    return new TextDecoder('utf-8').decode(plain.subarray(MAGIC.length));
}
