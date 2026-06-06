import { load } from 'cheerio';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { resolveFilemoon } from '../../utils/embeds/filemoon.js';
import { resolveStreamwish } from '../../utils/embeds/streamwish.js';
import { resolveVoe } from '../../utils/embeds/voe.js';

interface Video {
    result: string;
}

interface VideosByLanguage {
    latino?: Video[];
    spanish?: Video[];
    english?: Video[];
    [key: string]: Video[] | undefined;
}

interface MovieData {
    videos: VideosByLanguage;
}

interface EpisodeData {
    videos: VideosByLanguage;
}

export class Cuevana3Provider extends BaseProvider {
    readonly id = 'cuevana3';
    readonly name = 'Cuevana3';
    readonly enabled = true;
    readonly BASE_URL = 'https://www.cuevana3.eu';
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
            const embeds = await this.findEmbeds(media);

            if (embeds.length === 0) {
                return this.emptyResult('No valid streams found');
            }

            const sources: ProviderResult['sources'] = [];
            const subtitles: ProviderResult['subtitles'] = [];

            for (const embed of embeds) {
                const resolved = await this.resolveEmbed(embed.url);
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

                if (resolved.subtitles) {
                    for (const sub of resolved.subtitles) {
                        subtitles.push({
                            url: this.createProxyUrl(sub.url, this.HEADERS),
                            label: sub.label,
                            format: 'vtt'
                        });
                    }
                }
            }

            if (sources.length === 0) {
                return this.emptyResult('All embeds failed to resolve');
            }

            return { sources, subtitles, diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async findEmbeds(
        media: ProviderMediaObject
    ): Promise<Array<{ url: string; embedType: string; language: string }>> {
        // Try TMDB translated title first, then original title
        const titles = [media.title];

        try {
            const tmdbTitle = await this.fetchTmdbTitleSpanish(media.tmdbId);
            if (tmdbTitle && tmdbTitle !== media.title) {
                titles.unshift(tmdbTitle);
            }
        } catch {
            this.console.warn('Failed to fetch TMDB Spanish title, using original');
        }

        for (const title of titles) {
            const embeds = await this.scrapePage(media, title);
            if (embeds.length > 0) return embeds;
        }

        return [];
    }

    private async scrapePage(
        media: ProviderMediaObject,
        title: string
    ): Promise<Array<{ url: string; embedType: string; language: string }>> {
        const normalizedTitle = this.normalizeTitle(title);
        const pageUrl =
            media.type === 'movie'
                ? `${this.BASE_URL}/ver-pelicula/${normalizedTitle}`
                : `${this.BASE_URL}/episodio/${normalizedTitle}-temporada-${media.s}-episodio-${media.e}`;

        const response = await fetch(pageUrl, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15_000)
        });

        if (!response.ok) return [];

        const html = await response.text();
        const $ = load(html);

        const script = $('script')
            .toArray()
            .find((scriptEl) => {
                const content = (scriptEl.children[0] as { data?: string })?.data ?? '';
                return content.includes('{"props":{"pageProps":');
            });

        if (!script) return [];

        let jsonData: Record<string, unknown>;
        try {
            const jsonString = (script.children[0] as { data: string }).data;
            const start = jsonString.indexOf('{"props":{"pageProps":');
            if (start === -1) return [];
            const partialJson = jsonString.slice(start);
            jsonData = JSON.parse(partialJson);
        } catch {
            return [];
        }

        const pageProps = (jsonData as { props?: { pageProps?: Record<string, unknown> } })
            ?.props?.pageProps;
        if (!pageProps) return [];

        let videos: VideosByLanguage | undefined;
        if (media.type === 'movie') {
            const movieData = pageProps.thisMovie as MovieData | undefined;
            videos = movieData?.videos;
        } else {
            const episodeData = pageProps.episode as EpisodeData | undefined;
            videos = episodeData?.videos;
        }

        if (!videos) return [];

        return this.extractVideos(videos);
    }

    private async extractVideos(
        videos: VideosByLanguage
    ): Promise<Array<{ url: string; embedType: string; language: string }>> {
        const results: Array<{ url: string; embedType: string; language: string }> = [];

        for (const [lang, videoArray] of Object.entries(videos)) {
            if (!videoArray) continue;

            for (const video of videoArray) {
                if (!video.result) continue;

                const realUrl = await this.resolveEmbedUrl(video.result);
                if (!realUrl || !this.isValidStream(realUrl)) continue;

                let embedType = '';
                if (realUrl.includes('filemoon')) embedType = 'filemoon';
                else if (realUrl.includes('streamwish')) embedType = 'streamwish';
                else if (realUrl.includes('vidhide')) embedType = 'vidhide';
                else if (realUrl.includes('voe')) embedType = 'voe';
                else continue;

                results.push({
                    url: realUrl,
                    embedType,
                    language: this.normalizeLanguage(lang)
                });
            }
        }

        return results;
    }

    private async resolveEmbedUrl(embedUrl: string): Promise<string | null> {
        try {
            const response = await fetch(embedUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) return null;

            const html = await response.text();
            const match = html.match(/var url = '([^']+)'/);
            return match?.[1] ?? null;
        } catch {
            return null;
        }
    }

    private async resolveEmbed(
        url: string
    ): Promise<{ streams: Array<{ url: string; type: string; quality?: string; headers?: Record<string, string> }>; subtitles?: Array<{ url: string; label: string; format: string }> } | null> {
        try {
            if (url.includes('filemoon')) {
                return await resolveFilemoon(url, this.HEADERS);
            }
            if (url.includes('streamwish')) {
                return await resolveStreamwish(url, this.HEADERS);
            }
            if (url.includes('voe')) {
                return await resolveVoe(url, this.HEADERS);
            }
            // Vidhide: inline resolution (same pattern as streamwish)
            if (url.includes('vidhide')) {
                return await this.resolveVidhide(url);
            }
        } catch {
            // Ignore resolution errors
        }
        return null;
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

            // Vidhide uses packed JS similar to streamwish
            const packedMatch = html.match(
                /<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d.*?\)[\s\S]*?)<\/script>/
            );
            if (!packedMatch?.[1]) return null;

            // Try to extract m3u8 from unpacked or direct pattern
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

    private isValidStream(url: string): boolean {
        return (
            url.startsWith('https://') &&
            (url.includes('streamwish') ||
                url.includes('filemoon') ||
                url.includes('vidhide') ||
                url.includes('voe'))
        );
    }

    private normalizeLanguage(lang: string): string {
        const lower = lang.toLowerCase();
        if (lower === 'latino') return 'es';
        if (lower === 'spanish' || lower === 'castellano') return 'es';
        if (lower === 'english') return 'en';
        return 'es';
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

    private async fetchTmdbTitleSpanish(tmdbId: string): Promise<string | null> {
        const tmdbApiKey = process.env.TMDB_API_KEY ?? '';
        if (!tmdbApiKey) return null;

        const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbApiKey}&language=es-ES`;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(15_000)
        });
        if (!response.ok) return null;

        const data = (await response.json()) as { title?: string };
        return data.title ?? null;
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
