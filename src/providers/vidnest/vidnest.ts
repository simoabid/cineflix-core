import { BaseProvider } from '@omss/framework';
import type {
    Diagnostic,
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    SourceType,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';

import decrypt from './decrypt.js';
import type {
    ServerMap,
    SupportedServer,
    klikxxiResponse,
    allmoviesResponse,
    onehdResponse,
    hollymoviehdResponse,
    vidlinkResponse,
    purstreamResponse,
    deltaResponse,
    movieboxSource
} from './vidnest.types.js';
import { scrapeFetch } from '../../utils/scrapeFetch.js';
import { filterPlayableSources } from '../../utils/streamProbe.js';
import {
    hasMalformedMediaToken,
    normalizeUpstreamMediaUrl
} from '../../utils/streamUrl.js';

type RawSource = {
    url: string;
    headers?: Record<string, string>;
    type: SourceType;
    quality: string;
    audioTracks: Source['audioTracks'];
    serverPath: string;
};

type RawSubtitle = {
    url: string;
    headers?: Record<string, string>;
    label: string;
    format: SubtitleFormat;
};

export class VidNestProvider extends BaseProvider {
    readonly id = 'vidnest';
    readonly name = 'VidNest';
    readonly enabled = true;

    readonly BASE_URL = 'https://vidnest.fun';
    readonly API_BASE_URL = 'https://new.vidnest.fun';

    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `${this.BASE_URL}/`,
        Origin: this.BASE_URL
    };

    /**
     * ALL servers (some unsupported)
     */
    private readonly SERVERS: { path: string; query: string }[] = [
        { path: 'moviebox', query: '' },
        { path: 'allmovies', query: '' },
        { path: 'catflix', query: '' },
        { path: 'purstream', query: '' },
        { path: 'hollymoviehd', query: '' },
        { path: 'lamda', query: '' },
        { path: 'flixhq', query: '' },
        { path: 'vidlink', query: '' },
        { path: 'onehd', query: '?server=upcloud' },
        { path: 'klikxxi', query: '' }
    ];

    private readonly handlers: {
        [K in SupportedServer]: {
            parse: (data: string) => ServerMap[K];
            mapSources: (root: ServerMap[K], serverPath: string) => RawSource[];
            mapSubtitles: (root: ServerMap[K]) => RawSubtitle[];
        };
    } = {
        klikxxi: {
            parse: (d) => decrypt<klikxxiResponse>(d),
            mapSources: (root, serverPath) =>
                (root?.sources ?? []).map((s) =>
                    this.rawSource(
                        s.url,
                        this.HEADERS,
                        s.type,
                        s.quality,
                        [{ language: 'English', label: 'eng' }],
                        serverPath
                    )
                ),
            mapSubtitles: () => []
        },

        allmovies: {
            parse: (d) => decrypt<allmoviesResponse>(d),
            mapSources: (root, serverPath) =>
                (root?.streams ?? []).map((s) =>
                    this.rawSource(
                        s.url,
                        this.HEADERS,
                        s.type,
                        'Auto',
                        [{ language: s.language, label: s.language }],
                        serverPath
                    )
                ),
            mapSubtitles: () => []
        },

        onehd: {
            parse: (d) => decrypt<onehdResponse>(d),
            mapSources: (root, serverPath) => [
                this.rawSource(
                    root.url,
                    { ...this.HEADERS, ...(root.headers ?? {}) },
                    '',
                    'Auto',
                    [{ language: 'English', label: 'eng' }],
                    serverPath
                )
            ],
            mapSubtitles: (root) =>
                (root?.subtitles ?? []).map((s) => ({
                    url: s.url,
                    headers: { ...this.HEADERS, ...(root.headers ?? {}) },
                    label: s.lang,
                    format: this.inferSubtitleFormat(s.url)
                }))
        },

        hollymoviehd: {
            parse: (d) => decrypt<hollymoviehdResponse>(d),
            mapSources: (root, serverPath) =>
                (root?.sources ?? []).map((s) =>
                    this.rawSource(
                        s.file,
                        this.HEADERS,
                        s.type,
                        s.label,
                        [{ language: 'English', label: 'eng' }],
                        serverPath
                    )
                ),
            mapSubtitles: () => []
        },

        vidlink: {
            parse: (d) => decrypt<vidlinkResponse>(d),
            mapSources: (root, serverPath) => [
                this.rawSource(
                    root.data.stream.playlist,
                    { ...this.HEADERS, ...(root.headers ?? {}) },
                    root.data.stream.type,
                    'Auto',
                    [{ language: 'English', label: 'eng' }],
                    serverPath
                )
            ],
            mapSubtitles: (root) =>
                (root?.data?.stream?.captions ?? []).map((c) => ({
                    url: c.url,
                    headers: { ...this.HEADERS, ...(root.headers ?? {}) },
                    label: c.language,
                    format: this.inferSubtitleFormat(c.url)
                }))
        },

        delta: {
            parse: (d) => decrypt<deltaResponse>(d),
            mapSources: (root, serverPath) =>
                (root?.streams ?? []).map((s) =>
                    this.rawSource(
                        s.url,
                        this.HEADERS,
                        s.type,
                        'Auto',
                        [
                            {
                                language: s.language.slice(0, 3),
                                label: s.language
                            }
                        ],
                        serverPath
                    )
                ),
            mapSubtitles: () => []
        },

        purstream: {
            parse: (d) => decrypt<purstreamResponse>(d),
            mapSources: (root, serverPath) =>
                (root?.sources ?? []).map((s) =>
                    this.rawSource(
                        s.url,
                        this.HEADERS,
                        s.format,
                        this.qualityFromName(s.name),
                        [{ language: 'French', label: 'fr' }],
                        serverPath
                    )
                ),
            mapSubtitles: () => []
        },

        moviebox: {
            parse: (d) => decrypt<movieboxSource>(d),
            mapSources: (root, serverPath) =>
                (root?.url ?? []).map((u) =>
                    this.rawSource(
                        u.link,
                        this.HEADERS,
                        u.type,
                        'Auto',
                        [{ language: u.lang.slice(0, 3), label: u.lang }],
                        serverPath
                    )
                ),
            mapSubtitles: () => []
        }
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private rawSource(
        url: string | undefined,
        headers: Record<string, string> | undefined,
        typeHint: string,
        quality: string,
        audioTracks: Source['audioTracks'],
        serverPath: string
    ): RawSource {
        const clean = normalizeUpstreamMediaUrl(url ?? '');
        return {
            url: clean,
            headers: { ...this.HEADERS, ...(headers ?? {}) },
            type: this.inferSourceType(typeHint, clean),
            quality,
            audioTracks,
            serverPath
        };
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        const rawSources: RawSource[] = [];
        const rawSubtitles: RawSubtitle[] = [];
        const diagnostics: Diagnostic[] = [];

        const promises = this.SERVERS.map((server) => {
            const url =
                media.type === 'movie'
                    ? this.buildMovieUrl(media, server.path) + server.query
                    : this.buildTvUrl(media, server.path) + server.query;

            return this.fetchVidnest(url);
        });

        const results = await Promise.allSettled(promises);

        const rejected = results.filter((r) => r.status === 'rejected').length;
        if (rejected === results.length) {
            diagnostics.push({
                code: 'PARTIAL_SCRAPE',
                field: '',
                message: `${this.name}: 0/${results.length} servers returned data`,
                severity: 'error'
            });
        }

        results.forEach((result, i) => {
            if (result.status !== 'fulfilled') return;

            const server = this.SERVERS[i]!;
            const key = server.path as SupportedServer;
            const handler = this.handlers[key];

            if (!handler) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    field: '',
                    message: `${this.name}: ${server.path} returned sources, but we don't have a handler for it yet (check for updates: https://github.com/cinepro-org/core).`,
                    severity: 'warning'
                });
                return;
            }

            try {
                const { sources: s, subtitles: sub } = this.handleServer(
                    key,
                    result.value.data,
                    server.path
                );
                rawSources.push(...s.filter((x) => x.url && !hasMalformedMediaToken(x.url)));
                rawSubtitles.push(...sub);
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'parse failed';
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    field: '',
                    message: `${this.name}/${server.path}: ${msg}`,
                    severity: 'warning'
                });
            }
        });

        const probeDiagnostics: string[] = [];
        const playable = await filterPlayableSources(
            rawSources.map((s) => ({
                url: s.url,
                headers: s.headers,
                label: `${s.serverPath}/${s.quality}`,
                type: s.type
            })),
            {
                timeoutMs: 8_000,
                maxSources: 12,
                viaProxy: 'auto',
                diagnostics: probeDiagnostics
            }
        );

        for (const msg of probeDiagnostics) {
            diagnostics.push({
                code: 'PARTIAL_SCRAPE',
                field: '',
                message: `${this.name}: ${msg}`,
                severity: 'warning'
            });
        }

        const playableUrls = new Set(playable.map((p) => p.url));
        const sources: Source[] = rawSources
            .filter((s) => playableUrls.has(s.url))
            .map((s) => ({
                url: this.createProxyUrl(s.url, s.headers ?? this.HEADERS),
                type: s.type,
                quality: s.quality,
                audioTracks: s.audioTracks,
                provider: {
                    id: this.id,
                    name: `${this.name} (${s.serverPath})`
                }
            }));

        const subtitles: Subtitle[] = rawSubtitles
            .filter((s) => s.url && /^https?:\/\//i.test(s.url))
            .map((s) => ({
                url: this.createProxyUrl(s.url, s.headers ?? this.HEADERS),
                label: s.label,
                format: s.format
            }));

        return {
            sources,
            subtitles,
            diagnostics
        };
    }

    private handleServer<K extends SupportedServer>(
        key: K,
        data: string,
        serverPath: string
    ): { sources: RawSource[]; subtitles: RawSubtitle[] } {
        const handler = this.handlers[key];
        const root = handler.parse(data);

        return {
            sources: handler
                .mapSources(root, serverPath)
                .filter((s) => s.url && /^https?:\/\//i.test(s.url)),
            subtitles: handler.mapSubtitles(root)
        };
    }

    private buildMovieUrl(media: ProviderMediaObject, server: string) {
        return `${this.API_BASE_URL}/${server}/movie/${media.tmdbId}`;
    }

    private buildTvUrl(media: ProviderMediaObject, server: string) {
        return `${this.API_BASE_URL}/${server}/tv/${media.tmdbId}/${media.s}/${media.e}`;
    }

    private async fetchVidnest(url: string) {
        // scrapeFetch: API may behave differently on EC2 vs residential laptop.
        const res = await scrapeFetch(url, {
            headers: this.HEADERS,
            timeoutMs: 20_000,
            viaProxy: 'auto'
        });

        if (!res.ok) {
            throw new Error(`VidNest: ${res.status}`);
        }

        return res.json() as Promise<{ encrypted: boolean; data: string }>;
    }

    private inferSourceType(type: string, url: string): SourceType {
        const t = (type ?? '').toLowerCase();
        const u = (url ?? '').toLowerCase();
        if (t === 'hls' || u.includes('.m3u8')) return 'hls';
        if (t === 'dash' || u.includes('.mpd')) return 'dash';
        if (t === 'mp4' || u.includes('.mp4')) return 'mp4';
        if (t === 'mkv' || u.includes('.mkv')) return 'mkv';
        if (t === 'webm' || u.includes('.webm')) return 'webm';
        if (t === 'embed') return 'embed';
        return 'hls';
    }

    private inferSubtitleFormat(url: string): SubtitleFormat {
        const u = (url ?? '').toLowerCase();
        if (u.includes('.vtt')) return 'vtt';
        if (u.includes('.srt')) return 'srt';
        if (u.includes('.ass')) return 'ass';
        if (u.includes('.ssa')) return 'ssa';
        if (u.includes('.ttml')) return 'ttml';
        return 'vtt';
    }

    private qualityFromName(name?: string): string {
        if (!name) return 'Auto';
        const m = name.match(/(\d{3,4}p|4K|8K|HD|SD)/i);
        return m?.[1] ?? name;
    }
}
