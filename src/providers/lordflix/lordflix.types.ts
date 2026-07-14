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
 * an entry from GET snowhouse.lordflix.club/servers ({ servers: [...] }).
 * only `name` is required (it becomes the ?server= query value); other fields
 * vary by build and are ignored.
 */
export interface LordflixServer {
    name: string;
    [key: string]: unknown;
}

/**
 * the ALTCHA-style hashcash challenge from GET
 * snowhouse.lordflix.club/challenge. Solve it by finding the integer `number`
 * in [0, maxnumber] whose sha256(`${salt}${number}`) hex digest equals
 * `challenge`, then echo these fields back (with the solved `number`) as a
 * base64-encoded JSON string in the x-attest header.
 */
export interface LordflixChallenge {
    algorithm: string;
    challenge: string;
    salt: string;
    signature: string;
    maxnumber: number;
}

/**
 * result of GET enc-dec.app/api/enc-lordflix?url=... - a signed snowhouse url
 * that we GET (with the x-attest header) to obtain the encrypted stream blob.
 */
export interface LordflixEncResult {
    url: string;
}

/**
 * a subtitle / caption track from the decrypted stream payload.
 * field names differ across builds, so all common aliases are covered.
 */
export interface LordflixTrack {
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
export interface LordflixStreamFile {
    url?: string;
    file?: string;
    type?: string;
    quality?: string;
    label?: string;
}

/**
 * an entry of the observed `stream` array, confirmed via lordflix_trace.py:
 *   { id: "primary", type: "hls", playlist: "<manifest url>", captions: [] }
 * `playlist` holds the (usually hls) manifest url; url/file are tolerated as
 * aliases, and subtitles may arrive under captions/subtitles/tracks.
 */
export interface LordflixStreamEntry {
    id?: string;
    type?: string;
    playlist?: string;
    url?: string;
    file?: string;
    quality?: string;
    captions?: LordflixTrack[];
    subtitles?: LordflixTrack[];
    tracks?: LordflixTrack[];
}

/**
 * the final decrypted stream object (dec-lordflix of a per-server blob).
 *
 * CONFIRMED shape (lordflix_trace.py): { stream: LordflixStreamEntry[] }. The
 * remaining single-url / `sources` array / `qualities` map fields are kept as
 * tolerant fallbacks for other builds; the normalizer reads whichever present.
 */
export interface LordflixDecryptedStream {
    stream?: LordflixStreamEntry[];
    url?: string;
    file?: string;
    type?: string;
    quality?: string;
    sources?: LordflixStreamFile[];
    qualities?: Record<string, { url?: string; file?: string; type?: string }>;
    tracks?: LordflixTrack[];
    subtitles?: LordflixTrack[];
    captions?: LordflixTrack[];
}
