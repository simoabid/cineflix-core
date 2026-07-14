/**
 * enc-dec.app wraps every response in this envelope.
 * `status` is a numeric http-style code (200 on success) and the payload
 * lives under `result`. `error` is only present on failures.
 */
export interface EncDecEnvelope<T> {
    status: number;
    result: T;
    error?: string;
}

/**
 * result of GET enc-dec.app/api/enc-vidsync.
 * enc-dec.app solves the Cloudflare Turnstile challenge server-side and returns
 * the token, which we send as the X-Cf-Turnstile header on the vidsync fetch.
 */
export interface VidsyncTurnstile {
    token: string;
}

/**
 * a subtitle / caption track from the decrypted stream payload.
 * field names differ across builds, so all common aliases are covered.
 */
export interface VidsyncTrack {
    url?: string;
    file?: string;
    lang?: string;
    language?: string;
    label?: string;
    kind?: string;
    type?: string;
}

/**
 * a single stream entry when the payload exposes a `sources` array.
 */
export interface VidsyncStreamFile {
    url?: string;
    file?: string;
    type?: string;
    quality?: string;
    label?: string;
}

/**
 * the final decrypted stream object (dec-vidsync of a per-server fetch blob).
 *
 * NOTE: the exact shape is not documented in the enc-dec.app sample (it only
 * prints the object). Based on the sibling vidcore payload it is most likely a
 * single adaptive manifest (`url`, hls .m3u8 or dash .mpd) plus a `tracks`
 * array of `{ file, label }` subtitles, but this interface also tolerates the
 * `sources` array / `qualities` map variants seen across vidsrc-style
 * providers. The normalizer reads whichever is present.
 */
export interface VidsyncDecryptedStream {
    url?: string;
    file?: string;
    type?: string;
    quality?: string;
    sources?: VidsyncStreamFile[];
    qualities?: Record<string, { url?: string; file?: string; type?: string }>;
    tracks?: VidsyncTrack[];
    subtitles?: VidsyncTrack[];
    captions?: VidsyncTrack[];
}
