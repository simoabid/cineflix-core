export interface NunflixPlayerStream {
    file: string;
    quality: string;
    type: string;
}

export interface NunflixStreamItem {
    filename: string;
    quality: string;
    type: string;
    size: string;
    player_streams: NunflixPlayerStream[];
    direct_download: string;
}

export interface NunflixApiResponse {
    success: boolean;
    tmdb_id: string;
    type: 'movie' | 'tv';
    title: string;
    year: number;
    showbox_id: string;
    febbox_url?: string;
    season?: number;
    episode?: number;
    streams: NunflixStreamItem | NunflixStreamItem[];
    seasons?: Record<string, unknown>;
    source: string;
}
