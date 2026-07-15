/**
 * Types for the VidKing (vidking.net) stream resolver.
 *
 * The site is a Vite SPA whose player talks to api.speedracelight.com with
 * seed-based XOR encryption (enc=2). Servers map 1:1 to backend endpoint
 * paths under that API host.
 */

export type VidkingServerName =
    | 'Hydrogen'
    | 'Titanium'
    | 'Oxygen'
    | 'Lithium'
    | 'Helium';

export interface VidkingServerDef {
    name: VidkingServerName;
    endpoint: string;
    isActive: boolean;
    /**
     * Per-server fetch timeout (ms). Flaky/dead backends use a short
     * fail-fast budget so they don't steal time from Hydrogen/Oxygen.
     */
    timeoutMs?: number;
}

export interface VidkingMedia {
    type: 'movie' | 'tv';
    tmdbId: string;
    title?: string;
    year?: string;
    imdbId?: string;
    seasonId?: number;
    episodeId?: number;
}

export interface VidkingApiSource {
    url?: string;
    quality?: string;
    type?: string;
    originalTrackIndex?: number;
}

export interface VidkingApiSubtitle {
    id?: string | number;
    url?: string;
    format?: string;
    encoding?: string;
    display?: string;
    language?: string;
    isHearingImpaired?: boolean;
    flagUrl?: string;
}

export interface VidkingDecryptedPayload {
    sources?: VidkingApiSource[];
    subtitles?: VidkingApiSubtitle[];
    tmdbId?: string | number;
    mediaType?: string;
}

export interface VidkingResolvedSource {
    server: VidkingServerName;
    url: string;
    quality: string;
    type: string;
}

export interface VidkingResolveResult {
    sources: VidkingResolvedSource[];
    /** Subtitles returned inline by any successful server (often empty). */
    inlineSubtitles: VidkingApiSubtitle[];
    imdbId: string;
    diagnostics: string[];
}

export interface VidkingResolveOptions {
    /** Max concurrent per-server requests (default 3). */
    concurrency?: number;
    /**
     * Default abort budget for servers that do not set their own timeoutMs
     * (default 30000 — VPS / cold CDN paths are slower than local).
     */
    timeoutMs?: number;
    /** Only try these server names (default: all active). */
    servers?: VidkingServerName[];
}
