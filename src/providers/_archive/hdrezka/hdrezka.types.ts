export interface HdrezkaVideoLinks {
    success: boolean;
    message: string;
    premium_content: number;
    url: string;
    quality: string;
    subtitle: boolean | string;
    subtitle_lns: boolean;
    subtitle_def: boolean;
    thumbnails: string;
}

export interface HdrezkaMovieData {
    id: string | null;
    year: number;
    type: 'movie' | 'tv';
    url: string;
}

export interface HdrezkaSearchItem {
    id: string;
    year: number;
    type: 'movie' | 'tv';
    url: string;
}
