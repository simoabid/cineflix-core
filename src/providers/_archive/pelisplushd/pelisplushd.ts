import { load } from 'cheerio';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';

export class PelisplushdProvider extends BaseProvider {
    readonly id = 'pelisplushd';
    readonly name = 'PelisPlusHD';
    readonly enabled = true;
    readonly BASE_URL = 'https://ww3.pelisplus.to';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
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
            // Try TMDB translated title first
            let translatedTitle: string | null = null;
            try {
                translatedTitle = await this.fetchTmdbTitleSpanish(media);
            } catch {
                this.console.warn('Failed to fetch TMDB Spanish title');
            }

            const titles = translatedTitle
                ? [translatedTitle, media.title]
                : [media.title];

            let embeds: Array<{ url: string; language: string }> = [];

            for (const title of titles) {
                embeds = await this.scrapePage(media, title);
                if (embeds.length > 0) break;
            }

            // Fallback: try GitHub-hosted JSON
            if (embeds.length === 0) {
                embeds = await this.fallbackSearchByGithub(media);
            }

            if (embeds.length === 0) {
                return this.emptyResult('No vidhide embed found');
            }

            const sources: ProviderResult['sources'] = [];

            for (const embed of embeds) {
                const resolved = await this.resolveVidhide(embed.url);
                if (!resolved) continue;

                for (const stream of resolved.streams) {
                    sources.push({
                        url: this.createProxyUrl(
                            stream.url,
                            stream.headers ?? this.HEADERS
                        ),
                        type: stream.type === 'mp4' ? 'mp4' : 'hls',
                        quality: stream.quality ?? 'unknown',
                        audioTracks: [
                            {
                                language: embed.language,
                                label: this.languageLabel(embed.language)
                            }
                        ],
                        provider: { id: this.id, name: this.name }
                    });
                }
            }

            if (sources.length === 0) {
                return this.emptyResult('All vidhide embeds failed to resolve');
            }

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async scrapePage(
        media: ProviderMediaObject,
        title: string
    ): Promise<Array<{ url: string; language: string }>> {
        const normalizedTitle = this.normalizeTitle(title);
        const pageUrl =
            media.type === 'movie'
                ? `${this.BASE_URL}/pelicula/${normalizedTitle}`
                : `${this.BASE_URL}/serie/${normalizedTitle}/season/${media.s}/episode/${media.e}`;

        const response = await fetch(pageUrl, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15_000)
        });

        if (!response.ok) return [];

        const html = await response.text();
        const $ = load(html);
        return this.extractVidhideEmbeds($, html);
    }

    private async extractVidhideEmbeds(
        $: ReturnType<typeof load>,
        _html: string
    ): Promise<Array<{ url: string; language: string }>> {
        const regIsUrl = /^https?:\/\/([\w.-]+\.[a-z]{2,})(\/.*)?$/i;
        const results: Array<{ url: string; language: string }> = [];

        const listItems = $('.bg-tabs ul li').toArray();

        for (let idx = 0; idx < listItems.length; idx++) {
            const li = $(listItems[idx]);
            const langBtn = li
                .parent()
                ?.parent()
                ?.find('button')
                .first()
                .text()
                .trim()
                .toLowerCase() ?? '';

            const dataServer = li.attr('data-server') ?? '';
            const decoded = this.decodeBase64(dataServer);
            const url = regIsUrl.test(decoded)
                ? decoded
                : `${this.BASE_URL}/player/${btoa(dataServer)}`;

            let realUrl = url;
            if (realUrl.includes('/player/')) {
                realUrl = await this.resolvePlayerUrl(realUrl);
            }

            if (/vidhide/i.test(realUrl)) {
                let language = 'es';
                if (langBtn.includes('latino')) language = 'es';
                else if (
                    langBtn.includes('castellano') ||
                    langBtn.includes('español')
                )
                    language = 'es';
                else if (
                    langBtn.includes('ingles') ||
                    langBtn.includes('english')
                )
                    language = 'en';

                results.push({ url: realUrl, language });
            }
        }

        return results;
    }

    private async resolvePlayerUrl(url: string): Promise<string> {
        try {
            const response = await fetch(url, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) return '';

            const html = await response.text();
            const $ = load(html);
            const script = $('script:contains("window.onload")').html() ?? '';
            const urls = this.fetchUrls(script);
            return urls[0] ?? '';
        } catch {
            return '';
        }
    }

    private async fallbackSearchByGithub(
        media: ProviderMediaObject
    ): Promise<Array<{ url: string; language: string }>> {
        const jsonFile =
            media.type === 'movie'
                ? 'pelisplushd_movies.json'
                : 'pelisplushd_series.json';

        let fallbacks: Record<string, string> = {};
        try {
            const url = `https://raw.githubusercontent.com/moonpic/fixed-titles/main/${jsonFile}`;
            const response = await fetch(url, {
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) return [];
            fallbacks = (await response.json()) as Record<string, string>;
        } catch {
            return [];
        }

        const fallbackTitle = fallbacks[media.tmdbId];
        if (!fallbackTitle) return [];

        return this.scrapePage(media, fallbackTitle);
    }

    private async resolveVidhide(
        url: string
    ): Promise<{ streams: Array<{ url: string; type: string; quality?: string; headers?: Record<string, string> }> } | null> {
        try {
            const response = await fetch(url, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) return null;

            const html = await response.text();

            // Vidhide uses packed JS with hls2 key
            const hls2Match = html.match(/"hls2"\s*:\s*"([^"]+)"/);
            if (hls2Match?.[1]) {
                let videoUrl = hls2Match[1];
                if (!/^https?:\/\//.test(videoUrl)) {
                    videoUrl = `https://swiftplayers.com/${videoUrl.replace(/^\/+/, '')}`;
                }
                return {
                    streams: [
                        {
                            url: videoUrl,
                            type: 'hls',
                            quality: 'unknown',
                            headers: {
                                Referer: new URL(url).origin + '/'
                            }
                        }
                    ]
                };
            }

            // Fallback: look for direct file patterns
            const fileMatch = html.match(/file:\s*"([^"]+\.m3u8[^"]*)"/i);
            if (fileMatch?.[1]) {
                return {
                    streams: [
                        {
                            url: fileMatch[1],
                            type: 'hls',
                            quality: 'unknown',
                            headers: {
                                Referer: new URL(url).origin + '/'
                            }
                        }
                    ]
                };
            }

            return null;
        } catch {
            return null;
        }
    }

    private decodeBase64(str: string): string {
        try {
            return atob(str);
        } catch {
            return '';
        }
    }

    private fetchUrls(text: string): string[] {
        if (!text) return [];
        const linkRegex =
            /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:/~+#-]*[\w@?^=%&/~+#-])/g;
        return Array.from(text.matchAll(linkRegex)).map((m) =>
            m[0].replace(/^"+|"+$/g, '')
        );
    }

    private languageLabel(lang: string): string {
        if (lang === 'es') return 'Spanish';
        if (lang === 'en') return 'English';
        return lang;
    }

    private normalizeTitle(title: string): string {
        return title
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/gi, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');
    }

    private async fetchTmdbTitleSpanish(
        media: ProviderMediaObject
    ): Promise<string | null> {
        const tmdbApiKey = process.env.TMDB_API_KEY ?? '';
        if (!tmdbApiKey) return null;

        const endpoint =
            media.type === 'movie'
                ? `https://api.themoviedb.org/3/movie/${media.tmdbId}?api_key=${tmdbApiKey}&language=es-ES`
                : `https://api.themoviedb.org/3/tv/${media.tmdbId}?api_key=${tmdbApiKey}&language=es-ES`;

        const response = await fetch(endpoint, {
            signal: AbortSignal.timeout(15_000)
        });
        if (!response.ok) return null;

        const data = (await response.json()) as { title?: string; name?: string };
        return media.type === 'movie' ? data.title ?? null : data.name ?? null;
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
            const res = await fetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS
            });
            return res.status === 200;
        } catch {
            return false;
        }
    }
}
