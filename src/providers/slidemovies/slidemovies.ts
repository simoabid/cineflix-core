import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import { load } from 'cheerio';

export class SlidemoviesProvider extends BaseProvider {
    readonly id = 'slidemovies';
    readonly name = 'SlideMovies';
    readonly enabled = false;
    readonly BASE_URL = 'https://pupp.slidemovies-dev.workers.dev';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://pupp.slidemovies-dev.workers.dev/',
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
            const watchPageUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/movie/${media.tmdbId}`
                    : `${this.BASE_URL}/tv/${media.tmdbId}/${media.s}/-${media.e}`;

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

            const proxiedStreamUrl = $('media-player').attr('src');
            if (!proxiedStreamUrl) {
                return this.emptyResult('Stream URL not found');
            }

            const proxyUrl = new URL(proxiedStreamUrl);
            const encodedUrl = proxyUrl.searchParams.get('url') || '';
            const playlist = decodeURIComponent(encodedUrl);

            if (!playlist) {
                return this.emptyResult('No playlist URL found');
            }

            const subtitles: Subtitle[] = $('media-provider track')
                .map((_, el) => {
                    const url = $(el).attr('src') || '';
                    const rawLang = $(el).attr('lang') || 'unknown';
                    const format = url.endsWith('.vtt') ? 'vtt' : 'srt';

                    return {
                        url: this.createProxyUrl(url, this.HEADERS),
                        label: rawLang,
                        format: format as 'vtt' | 'srt'
                    };
                })
                .get();

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(playlist, this.HEADERS),
                    type: 'hls',
                    quality: 'Unknown',
                    audioTracks: [{ label: 'Original', language: 'en' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            return { sources, subtitles, diagnostics: [] };
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
