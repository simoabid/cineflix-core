/**
 * vidup.types.ts
 *
 * Type definitions for the vidup.to provider.
 */

/** Decoded RSC payload from the embed page. */
export interface VidupEmbedPayload {
    en: string;
    host: string;
    id: string;
    title: string;
    year?: string;
    ad?: boolean;
    theme?: string;
    server?: string;
    season?: string;
    episode?: string;
}

/** A single resolved server from the vidup API. */
export interface VidupServer {
    name: string;
    data: string;
    image?: string;
    selected?: boolean;
    failed?: boolean;
}

/** A stream URL returned by the vidup API. */
export interface VidupStream {
    url: string;
    type: 'hls' | 'mp4' | 'mkv' | 'embed';
    quality?: string;
    headers?: Record<string, string>;
    server?: string;
}

/** A subtitle track from the wyzie API. */
export interface VidupSubtitle {
    url: string;
    label: string;
    format: 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml';
    language?: string;
    isHearingImpaired?: boolean;
}

/** Result of resolving streams for a media item. */
export interface VidupResolveResult {
    sources: VidupStream[];
    subtitles: VidupSubtitle[];
    servers: VidupServer[];
}

/** Wyzie API subtitle response shape. */
export interface WyzieSubtitle {
    url: string;
    format?: string;
    display?: string;
    language?: string;
    isHearingImpaired?: boolean;
}
