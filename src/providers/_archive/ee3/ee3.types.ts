export interface Ee3AuthResponse {
    token?: string;
}

export interface Ee3MovieResponse {
    items?: Array<{
        video?: string;
    }>;
}

export interface Ee3KeyResponse {
    key?: string;
}
