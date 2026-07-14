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
 * result of GET enc-dec.app/api/enc-vidcore?text=<pageToken>.
 * - `servers` : url to POST to (with the X-CSRF-Token header) to obtain the
 *               encrypted server list.
 * - `stream`  : url prefix; the per-server stream url is `${stream}/${data}`.
 * - `token`   : csrf token that must be sent as X-CSRF-Token on the vidcore
 *               server/stream requests.
 */
export interface VidcoreHandshake {
    servers: string;
    stream: string;
    token: string;
}

/**
 * one entry from the decrypted server list (dec-vidcore of the servers blob).
 * `data` is the opaque id appended to the stream prefix. other fields (name,
 * label, etc.) are informational and vary by server.
 */
export interface VidcoreServer {
    data: string;
    name?: string;
    label?: string;
    description?: string;
    image?: string;
    [key: string]: unknown;
}

/**
 * a subtitle / caption track from the decrypted stream payload.
 * field names differ across vidcore builds, so all common aliases are covered.
 */
export interface VidcoreTrack {
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
export interface VidcoreStreamFile {
    url?: string;
    file?: string;
    type?: string;
    quality?: string;
    label?: string;
}

/**
 * the final decrypted stream object (dec-vidcore of a per-server stream blob).
 *
 * NOTE: the exact shape is not documented in the enc-dec.app sample (it only
 * prints the object), so this interface intentionally covers the common
 * variants seen across vidsrc-style providers:
 *   - a single playable url via `url` / `file`
 *   - a `sources` array
 *   - a `qualities` map keyed by resolution
 *   - subtitles under `tracks` / `subtitles` / `captions`
 * The normalizer in vidcore.ts reads whichever of these is present.
 */
export interface VidcoreDecryptedStream {
    url?: string;
    file?: string;
    type?: string;
    quality?: string;
    sources?: VidcoreStreamFile[];
    qualities?: Record<string, { url?: string; file?: string; type?: string }>;
    tracks?: VidcoreTrack[];
    subtitles?: VidcoreTrack[];
    captions?: VidcoreTrack[];
}
