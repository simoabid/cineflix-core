import { load } from 'cheerio';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { resolveStreamtape } from '../../utils/embeds/streamtape.js';
import { resolveDood } from '../../utils/embeds/dood.js';

interface SearchResult {
    title: string;
    year?: number;
    url: string;
}

export class TugaflixProvider extends BaseProvider {
    readonly id = 'tugaflix';
    readonly name = 'Tugaflix';
    readonly enabled = true;
    readonly BASE_URL = 'https://tugaflix.love';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media, 'movie');
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media, 'tv');
    }

    private async getSources(
        media: ProviderMediaObject,
        type: 'movie' | 'tv'
    ): Promise<ProviderResult> {
        try {
            const searchPath = type === 'movie' ? '/filmes/' : '/series/';
            const searchUrl = `${this.BASE_URL}${searchPath}?s=${encodeURIComponent(media.title)}`;

            const searchResponse = await fetch(searchUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15_000)
            });

            if (!searchResponse.ok) {
                return this.emptyResult('Search request failed');
            }

            const searchHtml = await searchResponse.text();
            const searchResults = this.parseSearch(searchHtml);

            if (searchResults.length === 0) {
                return this.emptyResult('No search results found');
            }

            const matched = searchResults.find((x) =>
                this.compareMedia(media, x.title, x.year)
            );

            if (!matched) {
                return this.emptyResult('No matching media found');
            }

            let embeds: Array<{ url: string; embedType: string }> = [];

            if (type === 'movie') {
                embeds = await this.scrapeMovie(matched.url);
            } else {
                embeds = await this.scrapeShow(matched.url, media);
            }

            if (embeds.length === 0) {
                return this.emptyResult('No embeds found');
            }

            const sources: ProviderResult['sources'] = [];

            for (const embed of embeds) {
                const resolved = await this.resolveEmbed(embed.url, embed.embedType);
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
                                language: 'pt',
                                label: 'Portuguese'
                            }
                        ],
                        provider: { id: this.id, name: this.name }
                    });
                }
            }

            if (sources.length === 0) {
                return this.emptyResult('All embeds failed to resolve');
            }

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async scrapeMovie(
        pageUrl: string
    ): Promise<Array<{ url: string; embedType: string }>> {
        const videoResponse = await fetch(pageUrl, {
            method: 'POST',
            headers: this.HEADERS,
            body: new URLSearchParams({ play: '' }),
            signal: AbortSignal.timeout(15_000)
        });

        if (!videoResponse.ok) return [];

        const videoPage = await videoResponse.text();
        const $ = load(videoPage);
        const results: Array<{ url: string; embedType: string }> = [];

        for (const element of $('.play a').toArray()) {
            const embedUrl = $(element).attr('href');
            if (!embedUrl) continue;

            const fullUrl = embedUrl.startsWith('https://')
                ? embedUrl
                : `https://${embedUrl}`;

            try {
                const embedResponse = await fetch(fullUrl, {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(15_000),
                    redirect: 'follow'
                });

                if (!embedResponse.ok) continue;

                const embedHtml = await embedResponse.text();
                const $embed = load(embedHtml);
                const finalUrl = $embed('a:contains("Download Filme")').attr('href');

                if (!finalUrl) continue;

                if (finalUrl.includes('streamtape')) {
                    results.push({ url: finalUrl, embedType: 'streamtape' });
                } else if (finalUrl.includes('dood')) {
                    results.push({ url: finalUrl, embedType: 'dood' });
                }
            } catch {
                // Skip failed embeds
            }
        }

        return results;
    }

    private async scrapeShow(
        pageUrl: string,
        media: ProviderMediaObject
    ): Promise<Array<{ url: string; embedType: string }>> {
        const s = (media.s ?? 0) < 10 ? `0${media.s}` : String(media.s);
        const e = (media.e ?? 0) < 10 ? `0${media.e}` : String(media.e);

        const videoResponse = await fetch(pageUrl, {
            method: 'POST',
            headers: this.HEADERS,
            body: new URLSearchParams({ [`S${s}E${e}`]: '' }),
            signal: AbortSignal.timeout(15_000)
        });

        if (!videoResponse.ok) return [];

        const videoPage = await videoResponse.text();
        const $ = load(videoPage);

        const embedUrl = $('iframe[name="player"]').attr('src');
        if (!embedUrl) return [];

        const fullEmbedUrl = embedUrl.startsWith('https:')
            ? embedUrl
            : `https:${embedUrl}`;

        const playerResponse = await fetch(fullEmbedUrl, {
            method: 'POST',
            headers: this.HEADERS,
            body: new URLSearchParams({ submit: '' }),
            signal: AbortSignal.timeout(15_000)
        });

        if (!playerResponse.ok) return [];

        const playerPage = await playerResponse.text();
        const $player = load(playerPage);
        const finalUrl = $player('a:contains("Download Episodio")').attr('href');

        if (!finalUrl) return [];

        if (finalUrl.includes('streamtape')) {
            return [{ url: finalUrl, embedType: 'streamtape' }];
        }
        if (finalUrl.includes('dood')) {
            return [{ url: finalUrl, embedType: 'dood' }];
        }

        return [];
    }

    private async resolveEmbed(
        url: string,
        embedType: string
    ): Promise<{ streams: Array<{ url: string; type: string; quality?: string; headers?: Record<string, string> }> } | null> {
        try {
            if (embedType === 'streamtape') {
                return await resolveStreamtape(url, this.HEADERS);
            }
            if (embedType === 'dood') {
                return await resolveDood(url, this.HEADERS);
            }
        } catch {
            // Ignore resolution errors
        }
        return null;
    }

    private parseSearch(html: string): SearchResult[] {
        const results: SearchResult[] = [];
        const $ = load(html);

        $('.items .poster').each((_, element) => {
            const $link = $(element).find('a');
            const url = $link.attr('href');
            const titleAttr = $link.attr('title') ?? '';
            const match = titleAttr.match(/^(.*?)\s*(?:\((\d{4})\))?\s*$/);

            if (!match || !url) return;

            const title = match[1];
            const year = match[2] ? parseInt(match[2], 10) : undefined;
            results.push({ title, year, url });
        });

        return results;
    }

    private compareMedia(
        media: ProviderMediaObject,
        title: string,
        year?: number
    ): boolean {
        const normalize = (s: string) =>
            s.toLowerCase()
                .normalize('NFD')
                .replace(/[̀-ͯ]/g, '')
                .replace(/[^a-z0-9\s]/g, '')
                .trim();

        const normalizedSearch = normalize(media.title);
        const normalizedTitle = normalize(title);

        const titleMatch =
            normalizedTitle.includes(normalizedSearch) ||
            normalizedSearch.includes(normalizedTitle);

        if (!titleMatch) return false;

        if (year && media.releaseYear) {
            return year === parseInt(media.releaseYear, 10);
        }

        return true;
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
