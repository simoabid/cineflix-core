/**
 * enc-dec.app wraps every response in this envelope.
 * For enc-kisskh the `result` is the bare kkey string; for other endpoints it
 * is the typed payload. `error` is only present on failures.
 */
export interface EncDecEnvelope<T> {
    status: number;
    result: T;
    error?: string;
}

/**
 * a search hit from GET kisskh.do/api/DramaList/Search?q=...
 * KissKH returns a bare JSON array of these. Only `id` + `title` are used;
 * other fields vary by build and are optional.
 */
export interface KisskhSearchHit {
    id: number;
    title: string;
    type?: number;
    country?: string;
    status?: number;
    episodesCount?: number;
}

/**
 * an episode entry inside the drama detail
 * (GET kisskh.do/api/DramaList/Drama/{id}). `number` is a float in the wild
 * (e.g. 1.0), so compare numerically.
 */
export interface KisskhEpisode {
    id: number;
    number: number;
    sub?: number;
}

/**
 * drama detail payload. Only `episodes` is required for resolution; the rest
 * help the trace/logging and are optional.
 */
export interface KisskhDramaDetail {
    id?: number;
    title?: string;
    episodes?: KisskhEpisode[];
    episodesCount?: number;
}

/**
 * the video payload from GET .../DramaList/Episode/{episodeId}.png?...&kkey=...
 * `Video` is the direct (usually hls) url; `ThirdParty` is an embed fallback.
 * Field names are PascalCase in the KissKH api.
 */
export interface KisskhVideo {
    Video?: string;
    ThirdParty?: string;
}

/**
 * a subtitle entry from GET kisskh.do/api/Sub/{episodeId}?kkey=...
 * `src` points at an ENCRYPTED subtitle file; passing it through
 * enc-dec.app/api/dec-kisskh?url=<src> returns the decrypted subtitle text,
 * so we point the player's subtitle url at that dec endpoint directly.
 */
export interface KisskhSubtitle {
    src: string;
    label?: string;
    land?: string;
    default?: boolean;
}
