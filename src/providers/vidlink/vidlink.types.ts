export interface VidlinkEncryptResponse {
    result: string;
}

export interface VidlinkCaption {
    id?: string;
    url: string;
    language?: string;
    type?: string;
    hasCorsRestrictions?: boolean;
}

export interface VidlinkStream {
    id?: string;
    type?: string;
    qualities?: Record<string, { type: string; url: string }>;
    playlist?: string;
    captions?: VidlinkCaption[];
    headers?: Record<string, string>;
}

export interface VidlinkApiResponse {
    stream?: VidlinkStream;
    flags?: string[];
}
