/**
 * Hexa resolved shapes (post WASM decrypt). Compatible with vidsrc-style payloads.
 */

export interface HexaTrack {
    url?: string;
    file?: string;
    lang?: string;
    language?: string;
    label?: string;
    kind?: string;
    type?: string;
}

export interface HexaStreamEntry {
    id?: string;
    server?: string;
    type?: string;
    playlist?: string;
    url?: string;
    file?: string;
    quality?: string;
    label?: string;
    captions?: HexaTrack[];
    subtitles?: HexaTrack[];
    tracks?: HexaTrack[];
}

export interface HexaDecryptedStream {
    stream?: HexaStreamEntry[];
    sources?: HexaStreamEntry[] | { file?: string; url?: string };
    servers?: Record<string, unknown>;
    url?: string;
    file?: string;
    playlist?: string;
    type?: string;
    quality?: string;
    tracks?: HexaTrack[];
    subtitles?: HexaTrack[];
    captions?: HexaTrack[];
}
