import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class AutoembedProvider extends BaseProvider {
    readonly id = 'autoembed';
    readonly name = 'Autoembed';
    readonly enabled = false;
    readonly BASE_URL = 'https://tom.autoembed.cc';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://tom.autoembed.cc/',
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
            const mediaType = media.type === 'movie' ? 'movie' : 'tv';
            let id = media.tmdbId;

            if (media.type === 'tv') {
                id = `${id}/${media.s}/${media.e}`;
            }

            const apiUrl = `${this.BASE_URL}/api/getVideoSource?type=${mediaType}&id=${id}`;
            this.console.log(`Fetching from API: ${apiUrl}`);

            const res = await fetch(apiUrl, {
                headers: {
                    ...this.HEADERS,
                    Referer: this.BASE_URL,
                    Origin: this.BASE_URL
                },
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as {
                videoSource?: string;
            };

            if (!data.videoSource) {
                return this.emptyResult('No video source found');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(data.videoSource, this.HEADERS),
                    type: 'embed',
                    quality: 'English',
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
