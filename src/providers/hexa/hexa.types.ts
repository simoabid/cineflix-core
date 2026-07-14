/**
 * enc-dec.app wraps every response in this envelope.
 * `status` is a numeric http-style code (200 on success) and the payload lives
 * under `result`. `error` is only present on failures.
 */
export interface EncDecEnvelope<T> {
    status: number;
    result: T;
    error?: string;
}

/**
 * result of GET enc-dec.app/api/enc-hexa - a capability token sent as the
 * X-Cap-Token header on the hexa image request.
 */
export interface HexaCapToken {
    token: string;
}

/**
 * a subtitle / caption track from the decrypted payload.
 * field names differ across builds, so all common aliases are covered.
 */
export interface HexaTrack {
    url?: string;
    file?: string;
    lang?: string;
    language?: string;
    label?: string;
    kind?: string;
    type?: string;
}

/**
 * a single stream entry when the payload exposes a `sources` or `stream` array.
 */
export interface HexaStreamEntry {
    id?: string;
    type?: string;
    playlist?: string;
    url?: string;
    file?: string;
    quality?: string;
    label?: string;
    captions?: HexaTrack[];
    subtitles?: HexaTrack[];
    tracks?: HexaTrack[];
}

/**
 * the final decrypted stream object (dec-hexa).
 *
 * NOTE: the exact shape is not documented in the enc-dec.app sample (it only
 * prints the object). This interface tolerates the single-url, `stream` array,
 * `sources` array and `qualities` map variants seen across the sibling
 * providers; the normalizer reads whichever is present. Tune once
 * hexa_trace.py reveals the real payload.
 */
export interface HexaDecryptedStream {
    stream?: HexaStreamEntry[];
    url?: string;
    file?: string;
    playlist?: string;
    type?: string;
    quality?: string;
    sources?: HexaStreamEntry[];
    qualities?: Record<string, { url?: string; file?: string; type?: string }>;
    tracks?: HexaTrack[];
    subtitles?: HexaTrack[];
    captions?: HexaTrack[];
}
