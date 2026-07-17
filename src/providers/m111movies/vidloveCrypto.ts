/**
 * Vidlove / momlover response crypto (player.vidlove.cc SPA, 2026-07).
 *
 * Live responses use AES-GCM envelope:
 *   { v: "gcm", payload: base64(salt16 || iv12 || ciphertext || tag16) }
 *
 * Key derivation: SHA-256( RESPONSE_BASE_KEY_bytes || salt )
 * Default key (from sec-constants): Sn00pD0g#RESP_B4SE_K3y_2026!
 *
 * decode4Layer path kept for v=4 payloads if the API ever falls back.
 */
const RESPONSE_BASE_KEY = 'Sn00pD0g#RESP_B4SE_K3y_2026!';

const L1_SECRET = 'Sn00pD0g#L1_X0R_M4st3rK3y!2026sex';
const L1_SALT = 'xK9!mR2@pL5#nQ8sex';
const L3_SECRET = 'Sn00pD0g#L3_AES_S3cur3K3y@2026$sex';
const L4_SECRETS = [
    'Sn00pD0g#L4_HMAC_F1n4lW4ll#2026!sex',
    'Sn00pD0g#L4_HMAC_F1n4lW4ll#2026',
    'Sn00pD0g#L4HMAC_S3xur3W4ll#2026!'
];

function base64ToBytes(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, 'base64'));
}

function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return Array.from(u8)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

async function pbkdf2(
    pass: string,
    salt: string,
    iterations: number,
    keyLen: number,
    hash: string
): Promise<Uint8Array> {
    const keyMat = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(pass),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );
    const derived = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: new TextEncoder().encode(salt),
            iterations,
            hash
        },
        keyMat,
        { name: 'AES-GCM', length: keyLen * 8 },
        true,
        ['encrypt', 'decrypt']
    );
    return new Uint8Array(await crypto.subtle.exportKey('raw', derived));
}

/** AES-GCM response decrypt used by momlover (v: "gcm"). */
export async function decryptResponseGcm(
    payloadB64: string,
    key: string = RESPONSE_BASE_KEY
): Promise<unknown> {
    const o = base64ToBytes(payloadB64);
    if (o.length < 44) {
        throw new Error('Invalid GCM payload (too short)');
    }
    const salt = o.slice(0, 16);
    const iv = o.slice(16, 28);
    const tag = o.slice(o.length - 16);
    const ciphertext = o.slice(28, o.length - 16);

    const material = concatBytes(new TextEncoder().encode(key), salt);
    const derived = new Uint8Array(
        await crypto.subtle.digest('SHA-256', material)
    );
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        derived,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
    );
    const data = concatBytes(ciphertext, tag);
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        cryptoKey,
        data
    );
    const text = new TextDecoder().decode(plain);
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function layer1Xor(hexStr: string, keyBytes: Uint8Array): string {
    const src = hexToBytes(hexStr);
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) {
        out[i] = src[i]! ^ keyBytes[i % 32]!;
    }
    return new TextDecoder().decode(out);
}

function layer2Binary(encoded: string): string {
    return atob(encoded)
        .split(' ')
        .map((s) => String.fromCharCode(parseInt(s, 2)))
        .join('');
}

async function layer3Aes(data: string): Promise<string> {
    const parts = data.split('.');
    if (parts.length !== 3) throw new Error(`L3: ${parts.length} parts`);
    const [ivB64, saltB64, ctB64] = parts;
    const salt = atob(saltB64);
    const keyBytes = await pbkdf2(L3_SECRET, salt, 100_000, 32, 'SHA-512');
    const aesKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
    );
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: base64ToBytes(ivB64) },
        aesKey,
        base64ToBytes(ctB64)
    );
    return new TextDecoder().decode(decrypted);
}

async function layer4Hmac(data: string, secret: string): Promise<string> {
    const sep = data.indexOf('|');
    if (sep === -1) throw new Error("L4: '|' separator not found");
    const receivedHmac = data.slice(0, sep);
    const payloadB64 = data.slice(sep + 1);
    const payloadStr = new TextDecoder().decode(base64ToBytes(payloadB64));
    const hmacKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-512' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign(
        'HMAC',
        hmacKey,
        new TextEncoder().encode(payloadStr)
    );
    if (receivedHmac !== bytesToHex(sig)) {
        throw new Error('L4: HMAC verification failed');
    }
    return payloadStr;
}

/** 4-layer decode for v=4 payloads (legacy / alternate envelope). */
export async function decode4Layer(payload: string): Promise<unknown> {
    const xorKey = await pbkdf2(L1_SECRET, L1_SALT, 50_000, 32, 'SHA-256');

    if (/^[0-9a-fA-F]+$/.test(payload) && payload.length % 2 === 0) {
        return JSON.parse(layer1Xor(payload, xorKey));
    }

    const sep = payload.indexOf('|');
    if (sep === -1) {
        throw new Error("L4: '|' separator not found and payload is not hex");
    }

    let mid: string | undefined;
    for (const secret of L4_SECRETS) {
        try {
            mid = await layer4Hmac(payload, secret);
            break;
        } catch {
            /* try next secret */
        }
    }
    if (!mid) {
        try {
            mid = new TextDecoder().decode(
                base64ToBytes(payload.slice(sep + 1))
            );
        } catch {
            mid = payload.slice(sep + 1);
        }
    }

    if (/^[0-9a-fA-F]+$/.test(mid) && mid.length % 2 === 0) {
        return JSON.parse(layer1Xor(mid, xorKey));
    }

    try {
        const l3 = await layer3Aes(mid);
        const l2 = layer2Binary(l3);
        return JSON.parse(layer1Xor(l2, xorKey));
    } catch (err) {
        if (/^\d{8}( \d{8})*$/.test(mid)) {
            const l2 = layer2Binary(mid);
            return JSON.parse(layer1Xor(l2, xorKey));
        }
        throw err;
    }
}

export async function decryptVidloveBody(body: {
    v?: number | string;
    payload?: string;
    [k: string]: unknown;
}): Promise<unknown> {
    if (
        (body.v === 'gcm' || body.v === 4 || body.v === '4') &&
        typeof body.payload === 'string'
    ) {
        if (body.v === 'gcm') {
            return decryptResponseGcm(body.payload);
        }
        return decode4Layer(body.payload);
    }
    return body;
}
