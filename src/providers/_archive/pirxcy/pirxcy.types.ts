export interface PirxcyStreamItem {
    path: string;
    quality: string;
    real_quality: string;
    format: string;
}

export interface PirxcyStreamData {
    list: PirxcyStreamItem[];
}

export interface PirxcySearchResult {
    id: string;
    title?: string;
}

export interface PirxcySearchResponse {
    data: PirxcySearchResult[];
}

export interface PirxcyDetailResponse {
    data: {
        tmdb_id: number;
        title?: string;
    };
}

export interface PirxcyStreamResponse {
    data: PirxcyStreamData;
}
