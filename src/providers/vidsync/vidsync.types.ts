/**
 * Subtitle / caption track from the decrypted stream payload.
 * Browser uses `{ file, label }`; aliases cover older builds.
 */
export interface VidsyncTrack {
    url?: string;
    file?: string;
    lang?: string;
    language?: string;
    label?: string;
    kind?: string;
    type?: string;
    key?: string;
    default?: boolean;
}

/**
 * Single stream entry when the payload exposes a `sources` array.
 * Browser shape: `{ url, streamType }`.
 */
export interface VidsyncStreamFile {
    url?: string;
    file?: string;
    type?: string;
    streamType?: string;
    quality?: string;
    label?: string;
}

/**
 * Decrypted stream object from bro.wasm decrypt(ciphertext, mediaId).
 *
 * Observed browser shape:
 *   { sources: [{ url, streamType }], subtitles: [{ file, label, type? }] }
 *
 * Also tolerates single-url / qualities-map variants used by sibling providers.
 */
export interface VidsyncDecryptedStream {
    url?: string;
    file?: string;
    type?: string;
    streamType?: string;
    quality?: string;
    sources?: VidsyncStreamFile[];
    qualities?: Record<string, { url?: string; file?: string; type?: string }>;
    tracks?: VidsyncTrack[];
    subtitles?: VidsyncTrack[];
    captions?: VidsyncTrack[];
}
