/**
 * vidupCrypto.ts
 *
 * Crypto helpers for the vidup.to provider.
 *
 * Vidup uses a custom base64 variant (o4 in the player bundle) that applies
 * a character-substitution step on top of standard URL-safe base64. The
 * forward and reverse alphabets were extracted from the player bundle
 * (294-*.js, function o4).
 *
 * The player also uses AES (via WebCrypto + a crypto-js polyfill) to decrypt
 * API responses. The exact AES mode and key derivation are determined by the
 * bytecode VM, which we cannot easily reproduce. However, the custom base64
 * encoder is straightforward and is used by the player to encode the `en`
 * token and other values.
 */

// ---------------------------------------------------------------------------
// Custom base64 encoder/decoder (reproduces the player's `o4` function)
// ---------------------------------------------------------------------------

/**
 * Standard base64 alphabet (URL-safe variant used by the player).
 */
const INPUT_ALPHABET =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';

/**
 * Player's substitution alphabet (output of `o4`).
 * Recovered from 294-*.js: `o3 = JSON.parse('["U","w","e",...]')`.
 */
const OUTPUT_ALPHABET =
    'UweQMzkV6RZpB8IhiWq-y3mo2n7EsGuL0bT5YAjDfSNrvHacFJdl4_1t9OKPgCx';

const FORWARD_MAP = new Map<string, string>(
    INPUT_ALPHABET.split('').map((c, i) => [c, OUTPUT_ALPHABET[i]!])
);

const REVERSE_MAP = new Map<string, string>(
    OUTPUT_ALPHABET.split('').map((c, i) => [c, INPUT_ALPHABET[i]!])
);

/**
 * Encode a Uint8Array using vidup's custom base64 variant.
 * Mirrors the player's `o4(t)` function:
 *   1. Standard base64
 *   2. URL-safe (+ → -, / → _, strip =)
 *   3. Character substitution via FORWARD_MAP
 */
export function encodeVidupBase64(input: Uint8Array | string): string {
    const bytes =
        typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const standard = Buffer.from(bytes).toString('base64');
    const urlSafe = standard
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    return urlSafe
        .split('')
        .map((c) => FORWARD_MAP.get(c) ?? c)
        .join('');
}

/**
 * Decode a vidup custom-base64 string back to a Uint8Array.
 * Reverses the substitution, then standard base64 decode.
 */
export function decodeVidupBase64(input: string): Uint8Array {
    const restored = input
        .split('')
        .map((c) => REVERSE_MAP.get(c) ?? c)
        .join('')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const padded = restored.padEnd(Math.ceil(restored.length / 4) * 4, '=');
    return new Uint8Array(Buffer.from(padded, 'base64'));
}

// ---------------------------------------------------------------------------
// AES helpers (for future use when we reproduce the VM's decryption)
// ---------------------------------------------------------------------------

/**
 * AES-GCM decrypt using WebCrypto.
 * The player's bytecode VM likely uses this for API response decryption.
 * Key derivation TBD — depends on the `en` token.
 */
export async function aesGcmDecrypt(
    ciphertext: Uint8Array,
    key: Uint8Array,
    iv: Uint8Array
): Promise<string | null> {
    try {
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            key,
            { name: 'AES-GCM' },
            false,
            ['decrypt']
        );
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            ciphertext
        );
        return new TextDecoder().decode(decrypted);
    } catch {
        return null;
    }
}

/**
 * AES-CBC decrypt using WebCrypto.
 * Fallback in case the VM uses CBC instead of GCM.
 */
export async function aesCbcDecrypt(
    ciphertext: Uint8Array,
    key: Uint8Array,
    iv: Uint8Array
): Promise<string | null> {
    try {
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            key,
            { name: 'AES-CBC' },
            false,
            ['decrypt']
        );
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv },
            cryptoKey,
            ciphertext
        );
        return new TextDecoder().decode(decrypted);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// XOR key derivation (reproduces the player's `af` generation)
// ---------------------------------------------------------------------------

/**
 * Reproduce the player's `af` (256-byte XOR key) derivation.
 *
 * From 294-*.js:
 *   var af = function(t) {
 *     for (var e = new Uint8Array(256), n = t >>> 0, r = 0; r < 256; r++) {
 *       var s = n = n + 0x9e3779b9 >>> 0;
 *       s = ((s = Math.imul((s = Math.imul(s ^ s >>> 16, 0x85ebca6b) >>> 0) ^ s >>> 13, 0xc2b2ae35) >>> 0) ^ s >>> 16) >>> 0;
 *       e[r] = 255 & s;
 *     }
 *     return e;
 *   }(ae._0x5217d4);  // ae._0x5217d4 = 0x6c0cf2e6
 *
 * The seed 0x6c0cf2e6 is a constant embedded in the bundle.
 */
export function deriveVidupXorKey(seed: number = 0x6c0cf2e6): Uint8Array {
    const out = new Uint8Array(256);
    let n = seed >>> 0;
    for (let r = 0; r < 256; r++) {
        n = (n + 0x9e3779b9) >>> 0;
        let s = n;
        s = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
        s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
        s = (s ^ (s >>> 16)) >>> 0;
        out[r] = 255 & s;
    }
    return out;
}
