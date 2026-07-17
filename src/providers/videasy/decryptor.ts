// decryptor.ts
// calls enc-dec.app to decrypt videasy's encrypted blob.
// the blob is plain text hex returned directly from api.wingsdatabase.com.
// enc-dec.app handles the wasm/cryptojs decryption server-side, but it now
// needs the per-media `seed` (algorithm version enc=2) to decrypt correctly.

import { scrapeFetch } from '../../utils/scrapeFetch.js';

const DEC_API = 'https://enc-dec.app/api/dec-videasy';

// response shape from enc-dec.app
interface DecApiResponse {
    status: number;
    result: {
        sources: Array<{ quality?: string; url: string; type?: string }>;
        subtitles: Array<{ url: string; lang?: string; language?: string }>;
    };
}

export interface DecryptedPayload {
    sources: Array<{ quality?: string; url: string; type?: string }>;
    subtitles: Array<{ url: string; lang?: string; language?: string }>;
}

// simple in-memory cache: key = `${tmdbId}:${blobHash}`, value = decrypted payload
// avoids re-calling the api for the same blob within a server session
const cache = new Map<string, DecryptedPayload>();

function blobKey(tmdbId: string, blob: string, seed: string): string {
    // soo i think it's better to use first 32 chars of blob as a cheap fingerprint as blobs are unique per request
    // seed is part of the key now because videasy's payload is seed-dependent (enc=2)
    return `${tmdbId}:${seed}:${blob.slice(0, 32)}`;
}

export async function decryptResponse(
    blob: string,
    tmdbId: string,
    seed: string
): Promise<DecryptedPayload | null> {
    if (!blob || blob.length < 10) return null;

    const key = blobKey(tmdbId, blob, seed);
    if (cache.has(key)) return cache.get(key)!;

    try {
        const res = await scrapeFetch(DEC_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: blob, id: tmdbId, seed }),
            timeoutMs: 20_000,
            viaProxy: true
        });

        if (!res.ok) return null;

        const json = (await res.json()) as DecApiResponse;

        if (json.status !== 200 || !json.result?.sources) return null;

        const payload: DecryptedPayload = {
            sources: json.result.sources ?? [],
            subtitles: json.result.subtitles ?? []
        };

        cache.set(key, payload);
        return payload;
    } catch {
        return null;
    }
}
