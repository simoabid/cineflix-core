export interface LookmovieSearchResult {
    items: LookmovieSearchItem[];
}

export interface LookmovieSearchItem {
    title: string;
    slug: string;
    year: string;
    id_movie?: string;
    id_show?: string;
}

export interface LookmovieShowData {
    episodes?: LookmovieEpisode[];
}

export interface LookmovieEpisode {
    season: string;
    episode: string;
    id: string;
}

export interface LookmovieStreamsResult {
    streams: Record<string, string>;
    subtitles: LookmovieSubtitle[];
}

export interface LookmovieSubtitle {
    url: string;
    language: string;
}
