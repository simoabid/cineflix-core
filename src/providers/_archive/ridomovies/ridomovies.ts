import { load } from 'cheerio';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { resolveRidoo } from '../../utils/embeds/ridoo.js';
import type { SearchResult, IframeSourceResult } from './ridomovies.types.js';

export class RidomoviesProvider extends BaseProvider {
    readonly id = 'ridomovies';
    readonly name = 'RidoMovies';
    readonly enabled = true;
    readonly BASE_URL = 'https://ridomovies.tv';
    readonly API_URL = 'https://ridomovies.tv/core/api';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'application/json, text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
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
            // Search for the media
            const searchUrl = `${this.API_URL}/search?q=${encodeURIComponent(media.title)}`;
            const searchResponse = await fetch(searchUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15_000)
            });

            if (!searchResponse.ok) {
                return this.emptyResult('Search request failed');
            }

            const searchResult = (await searchResponse.json()) as SearchResult;

            if (!searchResult.data?.items || searchResult.data.items.length === 0) {
                return this.emptyResult('No search results found');
            }

            const mediaData = searchResult.data.items.map((item) => ({
                name: item.title,
                year: item.contentable.releaseYear,
                fullSlug: item.fullSlug
            }));

            const normalizedSearchTitle = this.normalizeTitle(media.title);
            const searchYear = media.releaseYear;

            // Find matching media
            let targetMedia = mediaData.find(
                (m) =>
                    this.normalizeTitle(m.name) === normalizedSearchTitle &&
                    m.year === searchYear
            );

            if (!targetMedia) {
                targetMedia = mediaData.find((m) => {
                    const normalizedName = this.normalizeTitle(m.name);
                    return (
                        m.year === searchYear &&
                        (normalizedName.includes(normalizedSearchTitle) ||
                            normalizedSearchTitle.includes(normalizedName))
                    );
                });
            }

            if (!targetMedia?.fullSlug) {
                return this.emptyResult('No matching media found');
            }

            // Get iframe source URL
            let iframeSourceUrl = `/${targetMedia.fullSlug}/videos`;

            if (media.type === 'tv') {
                const showPageUrl = `${this.BASE_URL}/${targetMedia.fullSlug}`;
                const showResponse = await fetch(showPageUrl, {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(15_000)
                });

                if (!showResponse.ok) {
                    return this.emptyResult('Failed to fetch show page');
                }

                const showPage = await showResponse.text();
                const fullEpisodeSlug = `season-${media.s}/episode-${media.e}`;
                const regexPattern = new RegExp(
                    `\\\\"id\\\\":\\\\"(\\d+)\\\\"(?=.*?\\\\"fullSlug\\\\":\\\\"[^"]*${fullEpisodeSlug}[^"]*\\\\")`,
                    'g'
                );

                const matches = [...showPage.matchAll(regexPattern)];
                const episodeIds = matches.map((m) => m[1]);

                if (episodeIds.length === 0) {
                    return this.emptyResult('Episode not found');
                }

                const episodeId = episodeIds[episodeIds.length - 1];
                iframeSourceUrl = `/episodes/${episodeId}/videos`;
            }

            const iframeResponse = await fetch(
                `${this.API_URL}${iframeSourceUrl}`,
                {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(15_000)
                }
            );

            if (!iframeResponse.ok) {
                return this.emptyResult('Failed to fetch iframe source');
            }

            const iframeSource =
                (await iframeResponse.json()) as IframeSourceResult;

            if (!iframeSource.data || iframeSource.data.length === 0) {
                return this.emptyResult('No video sources found');
            }

            // Parse iframe URL from HTML
            const iframeHtml = iframeSource.data[0].url;
            const $ = load(iframeHtml);
            const iframeUrl = $('iframe').attr('data-src');

            if (!iframeUrl) {
                return this.emptyResult('No iframe URL found');
            }

            // Determine embed type and resolve
            const embedType = iframeUrl.includes('ridoo') ? 'ridoo' : 'closeload';
            const resolved = await this.resolveEmbed(iframeUrl, embedType);

            if (!resolved) {
                return this.emptyResult('Failed to resolve embed');
            }

            const sources: ProviderResult['sources'] = [];

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
                            language: 'en',
                            label: 'English'
                        }
                    ],
                    provider: { id: this.id, name: this.name }
                });
            }

            if (sources.length === 0) {
                return this.emptyResult('No valid streams extracted');
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
            if (embedType === 'ridoo') {
                return await resolveRidoo(url, this.HEADERS);
            }

            // Closeload: inline resolution (similar to filemoon)
            if (embedType === 'closeload') {
                return await this.resolveCloseload(url);
            }
        } catch {
            // Ignore resolution errors
        }
        return null;
    }

    private async resolveCloseload(
        url: string
    ): Promise<{
        streams: Array<{
            url: string;
            type: string;
            quality?: string;
            headers?: Record<string, string>;
        }>;
    } | null> {
        try {
            const response = await fetch(url, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) return null;

            const html = await response.text();

            // Closeload uses packed JS similar to filemoon
            const packedMatch = html.match(
                /<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d.*?\)[\s\S]*?)<\/script>/
            );
            if (packedMatch?.[1]) {
                // Try to extract m3u8 from the packed script
                const fileMatch = packedMatch[1].match(
                    /file:\s*"([^"]+\.m3u8[^"]*)"/i
                );
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
            }

            // Fallback: look for direct file patterns in HTML
            const directMatch = html.match(
                /file:\s*"([^"]+\.m3u8[^"]*)"/i
            );
            if (directMatch?.[1]) {
                return {
                    streams: [
                        {
                            url: directMatch[1],
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

    private normalizeTitle(title: string): string {
        return title
            .toLowerCase()
            .trim()
            .replace(/[^\w\s]/g, '')
            .replace(/\s+/g, ' ');
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
