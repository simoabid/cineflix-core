export interface VidrockStreamInfo {
    url: string | null;
    language: string | null;
    flag: string | null;
    /** Server-reported container: "hls" | "mp4" | null */
    type?: string | null;
}

export type VidrockStreams = Record<string, VidrockStreamInfo>;

/** @deprecated Secondary CDN quality ladder no longer used after AES-GCM rewrite */
export interface VidrockCDN {
    resolution: string;
    url: string;
}
