import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    SourceType,
    Subtitle
} from '@omss/framework';
import { decryptStreamUrl } from './encrypt.js';
import type { VidrockStreams } from './vidrock.types.js';

/**
 * VidRock (vidrock.ru — domain migrated from vidrock.net).
 *
 * Flow (from SPA bundle index-sQtBxu0M.js, 2026-07):
 *   GET /api/movie/{tmdbId} or /api/tv/{tmdbId}/{s}/{e}
 *   → JSON map of servers { name: { url: <b64url AES-GCM>, type, language } }
 *   Decrypt each url with fixed AES-GCM key → playable m3u8/mp4.
 */
export class VidRockProvider extends BaseProvider {
    readonly id = 'vidrock';
    readonly name = 'VidRock';
    readonly enabled = true;
    readonly BASE_URL = 'https://vidrock.ru/';
    readonly API_BASE = 'https://vidrock.ru/api';
    readonly SUB_BASE_URL = 'https://sub.vdrk.site';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: this.BASE_URL,
        Origin: 'https://vidrock.ru'
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

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        try {
            if (!media.tmdbId) {
                return this.emptyResult('tmdbId is required');
            }
            if (media.type === 'tv' && (media.s == null || media.e == null)) {
                return this.emptyResult('Missing season/episode for TV request');
            }

            const apiUrl = this.buildApiUrl(media);
            const data = await this.fetchJson(apiUrl);
            if (!data) {
                return this.emptyResult('Failed to fetch stream list');
            }

            const resp = data as VidrockStreams;
            const sources: Source[] = [];

            for (const [serverName, stream] of Object.entries(resp)) {
                if (!stream?.url) continue;

                let plainUrl: string;
                try {
                    plainUrl = await decryptStreamUrl(stream.url);
                } catch (err) {
                    this.console.log(
                        `VidRock: decrypt failed for ${serverName}: ${
                            err instanceof Error ? err.message : String(err)
                        }`
                    );
                    continue;
                }

                if (!plainUrl || !/^https?:\/\//i.test(plainUrl)) continue;

                const streamType = stream.type;
                const resolvedType: SourceType =
                    streamType === 'mp4' ||
                    (streamType !== 'hls' && plainUrl.includes('.mp4'))
                        ? 'mp4'
                        : 'hls';

                sources.push({
                    url: this.createProxyUrl(plainUrl, {
                        ...this.HEADERS,
                        Referer: this.BASE_URL,
                        Origin: 'https://vidrock.ru'
                    }),
                    type: resolvedType,
                    quality: 'Auto',
                    audioTracks: [
                        {
                            language:
                                stream.language === 'English'
                                    ? 'eng'
                                    : 'unknown',
                            label: stream.language ?? serverName
                        }
                    ],
                    provider: {
                        id: this.id,
                        name: `${this.name} (${serverName})`
                    }
                });
            }

            if (sources.length === 0) {
                return this.emptyResult('No decryptable sources returned');
            }

            const subtitles = await this.fetchSubtitles(media);

            return {
                sources,
                subtitles,
                diagnostics: []
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error
                    ? error.message
                    : 'Unknown provider error'
            );
        }
    }

    private buildApiUrl(media: ProviderMediaObject): string {
        if (media.type === 'tv') {
            return `${this.API_BASE}/tv/${media.tmdbId}/${media.s}/${media.e}`;
        }
        return `${this.API_BASE}/movie/${media.tmdbId}`;
    }

    private async fetchSubtitles(
        media: ProviderMediaObject
    ): Promise<Subtitle[]> {
        try {
            const subUrl =
                media.type === 'tv'
                    ? `${this.SUB_BASE_URL}/v2/tv/${media.tmdbId}/${media.s}/${media.e}`
                    : `${this.SUB_BASE_URL}/v2/movie/${media.tmdbId}`;

            const response = await fetch(subUrl, {
                headers: {
                    ...this.HEADERS,
                    Referer: this.BASE_URL
                },
                signal: AbortSignal.timeout(15000)
            });

            if (response.status !== 200) {
                return [];
            }

            const subsData = (await response.json()) as Array<{
                label: string;
                file: string;
            }>;

            if (!Array.isArray(subsData)) return [];

            return subsData
                .filter((sub) => sub?.file)
                .map((sub) => ({
                    url: this.createProxyUrl(sub.file, {
                        ...this.HEADERS,
                        Referer: subUrl
                    }),
                    format: 'vtt' as const,
                    label: sub.label
                }));
        } catch {
            return [];
        }
    }

    private async fetchJson(url: string): Promise<unknown | null> {
        try {
            const response = await fetch(url, {
                headers: { ...this.HEADERS, Referer: this.BASE_URL },
                signal: AbortSignal.timeout(20000)
            });

            if (response.status !== 200) return null;

            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.includes('application/json')) {
                return await response.json();
            }

            // Some edges return JSON without content-type
            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch {
                return null;
            }
        } catch {
            return null;
        }
    }

    private emptyResult(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error'
                }
            ]
        };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS,
                signal: AbortSignal.timeout(10000)
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }
}
