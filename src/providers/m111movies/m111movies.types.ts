export type M111Server = {
    name: string;
    path: string;
};

export type M111Subtitle = {
    url: string;
    display: string;
    language?: string;
};

export type M111StreamSource = {
    url: string;
    type: 'hls' | 'mp4';
    quality: string;
    serverName: string;
    noReferrer: boolean;
    headers?: Record<string, string>;
};

export type M111ResolveResult = {
    sources: M111StreamSource[];
    subtitles: M111Subtitle[];
    servers: M111Server[];
};

/** Decrypted momlover envelope (loose). */
export type MomloverDecrypted = {
    success?: boolean;
    sources?: Array<{
        url?: string;
        file?: string;
        proxiedUrl?: string;
        streamUrl?: string;
        quality?: string | number;
        type?: string;
        headers?: Record<string, string>;
    }>;
    streams?: Array<{
        url?: string;
        file?: string;
        quality?: string | number;
        headers?: Record<string, string>;
    }>;
    languages?: Array<{
        original?: boolean;
        sources?: Array<{
            url?: string;
            file?: string;
            quality?: string | number;
            headers?: Record<string, string>;
        }>;
    }>;
    url?: string;
    stream?: string;
    m3u8?: string;
    playlist?: string;
    subtitles?: Array<{
        url?: string;
        file?: string;
        label?: string;
        language?: string;
        lang?: string;
    }>;
    tracks?: Array<{
        file?: string;
        url?: string;
        label?: string;
        kind?: string;
    }>;
};
