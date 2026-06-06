import CryptoJS from 'crypto-js';

// ---------------------------------------------------------------------------
// WebCrypto helpers (AES-CBC)
// ---------------------------------------------------------------------------

/**
 * AES-CBC encrypt using WebCrypto.
 * Returns base64-encoded ciphertext.
 */
export async function aesCbcEncrypt(
    data: string,
    key: string,
    iv: string
): Promise<string> {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        enc.encode(key),
        { name: 'AES-CBC' },
        false,
        ['encrypt']
    );
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: enc.encode(iv) },
        cryptoKey,
        enc.encode(data)
    );
    return bufferToBase64(encrypted);
}

/**
 * AES-CBC decrypt using WebCrypto.
 * Accepts base64-encoded ciphertext.
 * Returns plaintext or null on failure.
 */
export async function aesCbcDecrypt(
    encrypted: string,
    key: string,
    iv: string
): Promise<string | null> {
    try {
        const enc = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            enc.encode(key),
            { name: 'AES-CBC' },
            false,
            ['decrypt']
        );
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: enc.encode(iv) },
            cryptoKey,
            base64ToBuffer(encrypted)
        );
        return new TextDecoder().decode(decrypted);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// WebCrypto helpers (AES-GCM)
// ---------------------------------------------------------------------------

/**
 * AES-GCM decrypt using WebCrypto.
 * Accepts base64-encoded ciphertext and base64-encoded key.
 * The ciphertext buffer is expected to contain the auth tag appended.
 * Returns plaintext or null on failure.
 */
export async function aesGcmDecrypt(
    encryptedBase64: string,
    keyBase64: string
): Promise<string | null> {
    try {
        const keyBytes = base64ToBuffer(keyBase64);
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['decrypt']
        );

        const encryptedData = base64ToBuffer(encryptedBase64);
        // AES-GCM auth tag is the last 16 bytes
        const ciphertext = encryptedData.slice(0, -16);
        const authTag = encryptedData.slice(-16);

        const combined = new Uint8Array(ciphertext.length + authTag.length);
        combined.set(new Uint8Array(ciphertext));
        combined.set(new Uint8Array(authTag), ciphertext.length);

        // Use first 12 bytes of ciphertext as IV (common pattern)
        // Callers should use the more specific overload if they need a custom IV
        const iv = new Uint8Array(12);

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            combined
        );
        return new TextDecoder().decode(decrypted);
    } catch {
        return null;
    }
}

/**
 * AES-GCM decrypt with explicit IV using WebCrypto.
 * Accepts raw Uint8Array inputs.
 * Returns plaintext or null on failure.
 */
export async function aesGcmDecryptWithIv(
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

// ---------------------------------------------------------------------------
// CryptoJS helpers
// ---------------------------------------------------------------------------

/**
 * AES decrypt using CryptoJS.
 * Supports CBC (with optional IV) and ECB (no IV) modes.
 * Returns plaintext or null on failure.
 */
export function aesDecryptCryptoJS(
    encrypted: string,
    key: string,
    iv?: string
): string | null {
    try {
        const keyParsed = CryptoJS.enc.Utf8.parse(key);
        const ivParsed = iv ? CryptoJS.enc.Utf8.parse(iv) : undefined;
        const decrypted = CryptoJS.AES.decrypt(encrypted, keyParsed, {
            iv: ivParsed,
            mode: ivParsed ? CryptoJS.mode.CBC : CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7,
        });
        return decrypted.toString(CryptoJS.enc.Utf8);
    } catch {
        return null;
    }
}

/**
 * TripleDES decrypt using CryptoJS.
 * Returns plaintext or null on failure.
 */
export function tripleDesDecryptCryptoJS(
    encrypted: string,
    key: string,
    iv?: string
): string | null {
    try {
        const keyParsed = CryptoJS.enc.Utf8.parse(key);
        const ivParsed = iv ? CryptoJS.enc.Utf8.parse(iv) : undefined;
        const decrypted = CryptoJS.TripleDES.decrypt(encrypted, keyParsed, {
            iv: ivParsed,
            mode: ivParsed ? CryptoJS.mode.CBC : CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7,
        });
        return decrypted.toString(CryptoJS.enc.Utf8);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Simple ciphers
// ---------------------------------------------------------------------------

/**
 * ROT13 transform.
 */
export function rot13(str: string): string {
    return str.replace(/[a-zA-Z]/g, (c) => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
}

/**
 * XOR decrypt a hex-encoded string with a key (hex string or Uint8Array).
 * Returns plaintext or empty string on failure.
 */
export function xorDecrypt(
    data: string,
    key: string | Uint8Array
): string {
    try {
        const src = hexToBytes(data);
        const keyBytes =
            typeof key === 'string' ? new TextEncoder().encode(key) : key;
        const out = new Uint8Array(src.length);
        for (let i = 0; i < src.length; i++) {
            out[i] = src[i] ^ keyBytes[i % keyBytes.length];
        }
        return new TextDecoder().decode(out);
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------
// Base64 utilities
// ---------------------------------------------------------------------------

/**
 * Base64 decode a string.
 * Handles URL-safe base64 (- and _ characters) and missing padding.
 */
export function base64Decode(str: string): string {
    try {
        // Convert URL-safe base64 to standard base64
        const standard = str.replace(/-/g, '+').replace(/_/g, '/');
        // Add padding if needed
        const padded = standard.padEnd(
            Math.ceil(standard.length / 4) * 4,
            '='
        );
        return atob(padded);
    } catch {
        return '';
    }
}

/**
 * Base64 encode a string.
 */
export function base64Encode(str: string): string {
    return btoa(str);
}

// ---------------------------------------------------------------------------
// Hex utilities
// ---------------------------------------------------------------------------

/**
 * Convert a hex string to Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) {
        throw new Error('Invalid hex string length');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
}

/**
 * Convert a Uint8Array to hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

// ---------------------------------------------------------------------------
// Buffer conversion utilities
// ---------------------------------------------------------------------------

/**
 * Convert an ArrayBuffer to base64 string.
 */
export function bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Convert a base64 string to Uint8Array.
 * Handles URL-safe base64 and missing padding.
 */
export function base64ToBuffer(str: string): Uint8Array {
    const standard = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
