import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import { load } from 'cheerio';

export class CatflixProvider extends BaseProvider {
    readonly id = 'catflix';
    readonly name = 'Catflix';
    readonly enabled = false;
    readonly BASE_URL = 'https://catflix.su';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://catflix.su/',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
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
            const mediaTitle = media.title
                .replace(/ /g, '-')
                .replace(/[():]/g, '')
                .toLowerCase();

            const watchPageUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/movie/${mediaTitle}-${media.tmdbId}`
                    : `${this.BASE_URL}/episode/${mediaTitle}-season-${media.s}-episode-${media.e}/eid-${media.tmdbId}`;

            this.console.log(`Fetching watch page: ${watchPageUrl}`);

            const res = await fetch(watchPageUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const html = await res.text();
            const $ = load(html);

            const scriptContent = $('script')
                .toArray()
                .find((script) => {
                    const child = script.children[0];
                    return (
                        child &&
                        'type' in child &&
                        child.type === 'text' &&
                        'data' in child &&
                        (child as { data: string }).data.includes(
                            'main_origin ='
                        )
                    );
                });

            if (!scriptContent) {
                return this.emptyResult('No embed data found');
            }

            const scriptData = scriptContent.children[0] as { data: string };
            const mainOriginMatch = scriptData.data.match(
                /main_origin = "(.*?)";/
            );

            if (!mainOriginMatch) {
                return this.emptyResult('Failed to extract embed URL');
            }

            const decodedUrl = atob(mainOriginMatch[1]);

            this.console.log(`Decoded embed URL: ${decodedUrl}`);

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(decodedUrl, this.HEADERS),
                    type: 'embed',
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
