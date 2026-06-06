export interface EightStreamPlayData {
    file: string;
    key: string;
}

export interface EightStreamInfoResult {
    success: boolean;
    data: {
        playlist: string;
        key: string;
    };
}

export interface EightStreamResult {
    success: boolean;
    data: {
        link: string;
    };
}
