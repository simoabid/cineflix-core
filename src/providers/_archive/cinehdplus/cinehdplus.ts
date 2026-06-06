import { load } from 'cheerio';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { resolveSupervideo } from '../../utils/embeds/supervideo.js';
import { resolveDropload } from '../../utils/embeds/dropload.js';

export class CinehdplusProvider extends BaseProvider {
    readonly id = 'cinehdplus';
    readonly name = 'CineHDPlus (Latino)';
    readonly enabled = true;
    readonly BASE_URL = 'https://cinehdplus.gratis';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        Referer: 'https://cinehdplus.gratis'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['tv']
    };

    async getMovieSources(_media: ProviderMediaObject): Promise<ProviderResult> {
        return this.emptyResult('CineHDPlus only supports TV shows');
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            // Search for the series by TMDB ID
            const searchUrl = `${this.BASE_URL}/series/?story=${media.tmdbId}&do=search&subaction=search`;

            const searchResponse = await fetch(searchUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15_000)
            });

            if (!searchResponse.ok) {
                return this.emptyResult('Search request failed');
            }

            const searchHtml = await searchResponse.text();
            const $search = load(searchHtml);

            const seriesUrl = $search('.card__title a[href]:first').attr('href');

            if (!seriesUrl) {
                return this.emptyResult('Series not found in search results');
            }

            // Fetch the series page
            const seriesPageUrl = new URL(seriesUrl, this.BASE_URL);
            const seriesResponse = await fetch(seriesPageUrl.href, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15_000)
            });

            if (!seriesResponse.ok) {
                return this.emptyResult('Failed to fetch series page');
            }

            const seriesHtml = await seriesResponse.text();
            const $ = load(seriesHtml);

            // Build episode selector
            const episodeSelector = `[data-num="${media.s}x${media.e}"]`;

            // Find mirror links for the specific episode
            const mirrorUrls = $(episodeSelector)
                .siblings('.mirrors')
                .children('[data-link]')
                .toArray()
                .map((el) => $(el).attr('data-link'))
                .filter((link): link is string => !!link)
                .filter((link) => !link.match(/cinehdplus/))
                .map((link) => {
                    const url = link.startsWith('http')
                        ? link
                        : `https://${link}`;
                    try {
                        return new URL(url);
                    } catch {
                        return null;
                    }
                })
                .filter(
                    (url): url is URL =>
                        url !== null && url.hostname !== 'cinehdplus.gratis'
                );

            if (!mirrorUrls.length) {
                return this.emptyResult('No streaming links found for this episode');
            }

            // Map URLs to embed types and resolve
            const sources: ProviderResult['sources'] = [];

            for (const url of mirrorUrls) {
                let embedType: string | null = null;

                if (url.hostname.includes('supervideo')) {
                    embedType = 'supervideo';
                } else if (url.hostname.includes('dropload')) {
                    embedType = 'dropload';
                }

                if (!embedType) continue;

                const resolved = await this.resolveEmbed(
                    url.href,
                    embedType
                );
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
                                language: 'es',
                                label: 'Spanish'
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

    private async resolveEmbed(
        url: string,
        embedType: string
    ): Promise<{
        streams: Array<{
            url: string;
            type: string;
            quality?: string;
            headers?: Record<string, string>;
        }>;
    } | null> {
        try {
            if (embedType === 'supervideo') {
                return await resolveSupervideo(url, this.HEADERS);
            }
            if (embedType === 'dropload') {
                return await resolveDropload(url, this.HEADERS);
            }
        } catch {
            // Ignore resolution errors
        }
        return null;
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
