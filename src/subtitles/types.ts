/** Normalized subtitle row returned by core subtitle endpoints / providers. */
export type CineProSubtitle = {
    url: string;
    label: string;
    format: 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml';
    language?: string;
    isHearingImpaired?: boolean;
    encoding?: string;
    source?: string;
    flagUrl?: string;
    release?: string | null;
};

export type WyzieSearchParams = {
    tmdbId?: string;
    imdbId?: string;
    season?: number;
    episode?: number;
    language?: string;
    format?: string;
};
