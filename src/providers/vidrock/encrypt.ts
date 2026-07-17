/**
 * VidRock stream URL crypto (vidrock.ru SPA, 2026-07).
 *
 * API now returns AES-GCM ciphertext for each server's `url` field.
 * Key is a fixed hex string from the frontend bundle; IV is the first
 * 12 bytes of the base64url-decoded payload; remainder is ciphertext+tag.
 */
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

const KEY_HEX =
    '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f';

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function base64UrlToBytes(input: string): Uint8Array {
    let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad === 2) b64 += '==';
    else if (pad === 3) b64 += '=';
    else if (pad === 1) {
        throw new Error('Invalid base64url length');
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Copy into a standalone ArrayBuffer (avoids SharedArrayBuffer typing issues). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

let cachedKey: webcrypto.CryptoKey | null = null;

async function getAesGcmKey(): Promise<webcrypto.CryptoKey> {
    if (cachedKey) return cachedKey;
    const raw = hexToBytes(KEY_HEX);
    cachedKey = await subtle.importKey(
        'raw',
        toArrayBuffer(raw),
        { name: 'AES-GCM' },
        false,
        ['decrypt']
    );
    return cachedKey;
}

/** Decrypt a VidRock stream URL field (base64url AES-GCM blob). */
export async function decryptStreamUrl(ciphertext: string): Promise<string> {
    const raw = base64UrlToBytes(ciphertext);
    if (raw.length < 28) {
        throw new Error('Ciphertext too short');
    }
    const iv = raw.slice(0, 12);
    const data = raw.slice(12);
    const key = await getAesGcmKey();
    const plain = await subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: toArrayBuffer(iv)
        },
        key,
        toArrayBuffer(data)
    );
    return new TextDecoder().decode(plain);
}

/** @deprecated Path encryption removed; API uses plain tmdb ids. */
export async function encryptItemId(_itemId: string): Promise<string> {
    throw new Error(
        'VidRock no longer encrypts path ids — use plain tmdbId paths'
    );
}
