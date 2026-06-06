export interface FshareApiResponse {
    data: {
        file: {
            sources: FshareSource[];
        };
    };
    status: string;
}

export interface FshareSource {
    src: string;
    quality: string | number;
    type: string;
    label: string;
}
