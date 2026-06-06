import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class VidapiclickProvider extends BaseProvider {
    readonly id = 'vidapiclick';
    readonly name = 'vidapi.click';
    readonly enabled = false;
    readonly BASE_URL = 'https://vidapi.click';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://vidapi.click/',
        Accept: 'application/json, text/plain, */*'
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

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const apiUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/api/video/movie/${media.tmdbId}`
                    : `${this.BASE_URL}/api/video/tv/${media.tmdbId}/${media.s}/${media.e}`;

            this.console.log(`Fetching from API: ${apiUrl}`);

            const res = await fetch(apiUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as {
                sources?: Array<{ file?: string }>;
            };

            if (!data.sources?.[0]?.file) {
                return this.emptyResult('No video source found');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(data.sources[0].file, this.HEADERS),
                    type: 'hls',
                    quality: 'Unknown',
                    audioTracks: [{ label: 'Original', language: 'en' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
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
}
