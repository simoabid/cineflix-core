import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import type { NunflixApiResponse } from './nunflix.types.js';

export class NunflixProvider extends BaseProvider {
    readonly id = 'nunflix';
    readonly name = 'NFlix';
    readonly enabled = true;
    readonly BASE_URL = 'https://mama.up.railway.app/api/showbox';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
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
            const userToken = this.getUserToken();

            const apiUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/movie/${media.tmdbId}?token=${userToken}`
                    : `${this.BASE_URL}/tv/${media.tmdbId}?season=${media.s}&episode=${media.e}&token=${userToken}`;

            this.console.log(`Fetching from API: ${apiUrl}`);

            const response = await fetch(apiUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!response.ok) {
                return this.emptyResult(
                    `API returned ${response.status}`
                );
            }

            const data = (await response.json()) as NunflixApiResponse;

            if (!data.success) {
                return this.emptyResult('No streams found');
            }

            const streamItems = Array.isArray(data.streams)
                ? data.streams
                : [data.streams];

            if (
                streamItems.length === 0 ||
                !streamItems[0].player_streams
            ) {
                return this.emptyResult('No valid streams found');
            }

            let bestStreamItem = streamItems[0];
            for (const item of streamItems) {
                if (
                    item.quality.includes('4K') ||
                    item.quality.includes('2160p')
                ) {
                    bestStreamItem = item;
                    break;
                }
            }

            const streams: Record<number, string> = {};
            for (const stream of bestStreamItem.player_streams) {
                let qualityKey: number;
                if (
                    stream.quality === '4K' ||
                    stream.quality.includes('4K')
                ) {
                    qualityKey = 2160;
                } else if (
                    stream.quality === 'ORG' ||
                    stream.quality.includes('ORG')
                ) {
                    continue;
                } else {
                    qualityKey = parseInt(
                        stream.quality.replace('P', ''),
                        10
                    );
                }

                if (Number.isNaN(qualityKey) || streams[qualityKey]) continue;
                streams[qualityKey] = stream.file;
            }

            const sources: Source[] = [];
            const qualityMap: Record<string, number> = {
                '4k': 2160,
                '1080': 1080,
                '720': 720,
                '480': 480,
                '360': 360
            };

            for (const [label, key] of Object.entries(qualityMap)) {
                if (streams[key]) {
                    sources.push({
                        url: this.createProxyUrl(
                            streams[key],
                            this.HEADERS
                        ),
                        type: 'mp4',
                        quality: label,
                        audioTracks: [],
                        provider: { id: this.id, name: this.name }
                    });
                }
            }

            this.console.log(`Found ${sources.length} sources`);

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private getUserToken(): string {
        return '';
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
}
