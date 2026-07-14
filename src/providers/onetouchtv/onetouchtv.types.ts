/**
 * enc-dec.app wraps every response in this envelope.
 * `status` is a numeric http-style code (200 on success); the payload lives
 * under `result`. `error` is only present on failures.
 */
export interface EncDecEnvelope<T> {
    status: number;
    result: T;
    error?: string;
}

/**
 * a search hit from the OneTouchTV (devcorp.me) catalogue. The exact field
 * names are unconfirmed (the enc-dec sample only shows the VOD endpoint), so
 * every plausible id/slug/title alias is optional and read defensively.
 */
export interface OnetouchtvSearchHit {
    id?: number | string;
    vodId?: number | string;
    title?: string;
    name?: string;
    slug?: string;
    permalink?: string;
    seoUrl?: string;
    type?: string;
    year?: number;
}

/**
 * a subtitle / caption track from the decrypted payload.
 * field names differ across builds, so all common aliases are covered.
 */
export interface OnetouchtvTrack {
    url?: string;
    file?: string;
    src?: string;
    lang?: string;
    language?: string;
    label?: string;
    kind?: string;
    type?: string;
    // confirmed live payload aliases (subtitles ride a singular `track` array)
    name?: string;
    code?: string;
    format?: string;
    sourceFormat?: string;
    default?: boolean;
}

/**
 * a single stream entry when the payload exposes a `sources`/`streams` array.
 */
export interface OnetouchtvStreamEntry {
    id?: string;
    contentId?: string;
    name?: string;
    type?: string;
    playlist?: string;
    url?: string;
    file?: string;
    src?: string;
    link?: string;
    quality?: string;
    label?: string;
    resolution?: string | number;
    captions?: OnetouchtvTrack[];
    subtitles?: OnetouchtvTrack[];
    tracks?: OnetouchtvTrack[];
    track?: OnetouchtvTrack[];
}

/**
 * the final decrypted payload (dec-onetouchtv).
 *
 * NOTE: the enc-dec sample only prints the object, so the shape is unconfirmed.
 * This interface tolerates the single-url, `sources`/`streams` array and
 * `qualities` map variants seen across the sibling providers; the normalizer
 * reads whichever is present. Tune once onetouchtv_trace.py reveals the real
 * payload.
 */
export interface OnetouchtvDecrypted {
    sources?: OnetouchtvStreamEntry[];
    streams?: OnetouchtvStreamEntry[];
    stream?: OnetouchtvStreamEntry[] | OnetouchtvStreamEntry;
    url?: string;
    file?: string;
    playlist?: string;
    link?: string;
    type?: string;
    quality?: string;
    qualities?: Record<
        string,
        { url?: string; file?: string; type?: string } | string
    >;
    tracks?: OnetouchtvTrack[];
    subtitles?: OnetouchtvTrack[];
    captions?: OnetouchtvTrack[];
    track?: OnetouchtvTrack[];
    // present when the content route resolves to a missing item
    success?: boolean;
    status?: string;
    code?: number;
}
