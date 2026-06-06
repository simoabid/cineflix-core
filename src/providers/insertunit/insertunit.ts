import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';

export class InsertunitProvider extends BaseProvider {
    readonly id = 'insertunit';
    readonly name = 'Insertunit';
    readonly enabled = false;
    readonly BASE_URL = 'https://isut.streamflix.one';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://isut.streamflix.one/',
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
                    ? `${this.BASE_URL}/api/source/${media.tmdbId}`
                    : `${this.BASE_URL}/api/source/${media.tmdbId}/${media.s}/${media.e}`;

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

            if (!data.sources?.length) {
                return this.emptyResult('No sources found');
            }

            const file = data.sources[0].file;
            if (!file) {
                return this.emptyResult('No file URL found');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(file, this.HEADERS),
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
