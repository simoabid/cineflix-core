/**
 * m111movies.types.ts
 * Type definitions for the 111movies provider.
 */

export interface M111Server {
    name: string;
    description?: string;
    image?: string;
    data: string;
}

export interface M111StreamResponse {
    url: string;
    tracks?: Array<{ file?: string; label?: string; kind?: string }>;
    noReferrer?: boolean;
}

export interface M111Subtitle {
    display: string;
    language: string;
    url: string;
    encoding?: string;
}

export interface M111EmbedPayload {
    data: string;
    backdrop: string;
    ad: boolean;
}
