import { load } from 'cheerio';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class WecimaProvider extends BaseProvider {
    readonly id = 'wecima';
    readonly name = 'Wecima (Arabic)';
    readonly enabled = true;
    readonly BASE_URL = 'https://wecima.tube';

    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: 'https://wecima.tube/'
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
            // Step 1: Search
            const searchHtml = await this.fetchText(
                `${this.BASE_URL}/search/${encodeURIComponent(media.title)}/`
            );
            const search$ = load(searchHtml);
            const firstResult = search$('.Grid--WecimaPosts .GridItem a').first();
            if (!firstResult.length) {
                return this.emptyResult('No search results found');
            }

            const contentUrl = firstResult.attr('href');
            if (!contentUrl) {
                return this.emptyResult('No content URL in search result');
            }

            // Step 2: Get content page
            const contentHtml = await this.fetchText(contentUrl);
            const content$ = load(contentHtml);

            let embedUrl: string | undefined;

            if (media.type === 'movie') {
                embedUrl = content$('meta[itemprop="embedURL"]').attr('content');
            } else {
                // TV: navigate seasons → episodes → find embed
                const seasonLinks = content$('.List--Seasons--Episodes a');
                let seasonUrl: string | undefined;

                for (const element of seasonLinks.get()) {
                    const text = content$(element).text().trim();
                    if (text.includes(`موسم ${media.s}`)) {
                        seasonUrl = content$(element).attr('href');
                        break;
                    }
                }

                if (!seasonUrl) {
                    return this.emptyResult(`Season ${media.s} not found`);
                }

                const seasonHtml = await this.fetchText(seasonUrl);
                const season$ = load(seasonHtml);

                const episodeLinks = season$('.Episodes--Seasons--Episodes a');
                for (const element of episodeLinks.get()) {
                    const epTitle = season$(element).find('episodetitle').text().trim();
                    if (epTitle === `الحلقة ${media.e}`) {
                        const episodeUrl = season$(element).attr('href');
                        if (episodeUrl) {
                            const episodeHtml = await this.fetchText(episodeUrl);
                            const episode$ = load(episodeHtml);
                            embedUrl = episode$('meta[itemprop="embedURL"]').attr('content');
                        }
                        break;
                    }
                }
            }

            if (!embedUrl) {
                return this.emptyResult('No embed URL found');
            }

            // Step 3: Get video source from embed page
            const embedHtml = await this.fetchText(embedUrl);
            const embed$ = load(embedHtml);
            const videoSource = embed$('source[type="video/mp4"]').attr('src');

            if (!videoSource) {
                return this.emptyResult('No video source found on embed page');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(videoSource, { Referer: this.BASE_URL }),
                    type: 'mp4',
                    quality: 'Auto',
                    audioTracks: [{ language: 'ar', label: 'Arabic' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            this.console.log(`Found video for "${media.title}"`, media);

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async fetchText(url: string): Promise<string> {
        const res = await fetch(url, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.text();
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
