import { load } from 'cheerio';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { resolveStreamwish } from '../../utils/embeds/streamwish.js';
import { resolveStreamtape } from '../../utils/embeds/streamtape.js';

export class AnimeflvProvider extends BaseProvider {
    readonly id = 'animeflv';
    readonly name = 'AnimeFLV';
    readonly enabled = true;
    readonly BASE_URL = 'https://www3.animeflv.net';
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
            this.console.log(`Searching for: ${media.title}`);

            const animeUrl = await this.searchAnime(media.title);

            let episodeUrl: string;

            if (media.type === 'tv') {
                if (!media.e) {
                    return this.emptyResult('Episode number is required');
                }

                const episodes = await this.getEpisodes(animeUrl);
                const ep = episodes.find((e) => e.number === media.e);

                if (!ep) {
                    return this.emptyResult(`Episode ${media.e} not found`);
                }

                episodeUrl = ep.url;
            } else {
                // Movie: get the animeUri and construct episode 1 URL
                const animeUri = await this.getAnimeUri(animeUrl);
                if (!animeUri) {
                    return this.emptyResult('Could not extract anime URI');
                }
                episodeUrl = `${this.BASE_URL}/ver/${animeUri}-1`;
            }

            const embeds = await this.getEmbeds(episodeUrl);

            if (embeds.length === 0) {
                return this.emptyResult('No valid streams found');
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
                                language: embed.language,
                                label: this.languageLabel(embed.language)
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

    private async searchAnime(title: string): Promise<string> {
        const searchUrl = `${this.BASE_URL}/browse?q=${encodeURIComponent(title)}`;

        const response = await fetch(searchUrl, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15_000)
        });

        if (!response.ok) {
            throw new Error('Search request failed');
        }

        const html = await response.text();
        const $ = load(html);

        const results = $('div.Container ul.ListAnimes li article');

        if (!results.length) {
            throw new Error('No anime found');
        }

        let animeUrl = '';

        results.each((_, el) => {
            const resultTitle = $(el).find('a h3').text().trim().toLowerCase();
            if (resultTitle === title.trim().toLowerCase()) {
                animeUrl =
                    $(el).find('div.Description a.Button').attr('href') ?? '';
                return false;
            }
        });

        if (!animeUrl) {
            animeUrl =
                results
                    .first()
                    .find('div.Description a.Button')
                    .attr('href') ?? '';
        }

        if (!animeUrl) {
            throw new Error('No anime URL found');
        }

        return animeUrl.startsWith('http')
            ? animeUrl
            : `${this.BASE_URL}${animeUrl}`;
    }

    private async getEpisodes(
        animeUrl: string
    ): Promise<Array<{ number: number; url: string }>> {
        const response = await fetch(animeUrl, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15_000)
        });

        if (!response.ok) return [];

        const html = await response.text();
        const $ = load(html);
        let episodes: Array<{ number: number; url: string }> = [];

        $('script').each((_, script) => {
            const data = $(script).html() ?? '';
            if (data.includes('var anime_info =')) {
                const animeInfo = data.split('var anime_info = [')?.[1]?.split('];')?.[0];
                const animeUri = animeInfo
                    ?.split(',')?.[2]
                    ?.replace(/"/g, '')
                    .trim();

                const episodesRaw = data.split('var episodes = [')?.[1]?.split('];')?.[0];

                if (animeUri && episodesRaw) {
                    const arrEpisodes = episodesRaw.split('],[');
                    episodes = arrEpisodes.map((arrEp) => {
                        const noEpisode = arrEp
                            .replace('[', '')
                            .replace(']', '')
                            .split(',')[0];
                        return {
                            number: parseInt(noEpisode, 10),
                            url: `${this.BASE_URL}/ver/${animeUri}-${noEpisode}`
                        };
                    });
                }
            }
        });

        return episodes;
    }

    private async getAnimeUri(animeUrl: string): Promise<string | null> {
        const response = await fetch(animeUrl, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15_000)
        });

        if (!response.ok) return null;

        const html = await response.text();
        const $ = load(html);
        let animeUri: string | null = null;

        $('script').each((_, script) => {
            const data = $(script).html() ?? '';
            if (data.includes('var anime_info =')) {
                const animeInfo = data.split('var anime_info = [')?.[1]?.split('];')?.[0];
                animeUri =
                    animeInfo?.split(',')?.[2]?.replace(/"/g, '').trim() ?? null;
            }
        });

        return animeUri;
    }

    private async getEmbeds(
        episodeUrl: string
    ): Promise<Array<{ url: string; embedType: string; language: string }>> {
        const response = await fetch(episodeUrl, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15_000)
        });

        if (!response.ok) return [];

        const html = await response.text();
        const $ = load(html);
        const results: Array<{ url: string; embedType: string; language: string }> = [];

        // Find the script containing videos variable
        const script = $('script:contains("var videos =")').html();
        if (!script) return [];

        const match = script.match(/var videos = (\{[\s\S]*?\});/);
        if (!match) return [];

        let videos: Record<string, Array<{ title?: string; url?: string; code?: string }>>;
        try {
            videos = JSON.parse(match[1]);
        } catch {
            return [];
        }

        // StreamWish in SUB (Japanese audio)
        if (videos.SUB) {
            const sw = videos.SUB.find(
                (s) => s.title?.toLowerCase() === 'sw'
            );
            if (sw && (sw.url || sw.code)) {
                let url = sw.url ?? sw.code ?? '';
                if (url.startsWith('/e/')) {
                    url = `https://streamwish.to${url}`;
                }
                if (url) {
                    results.push({
                        url,
                        embedType: 'streamwish',
                        language: 'ja'
                    });
                }
            }
        }

        // Streamtape in LAT (Latino audio)
        if (videos.LAT) {
            const stape = videos.LAT.find(
                (s) =>
                    s.title?.toLowerCase() === 'stape' ||
                    s.title?.toLowerCase() === 'streamtape'
            );
            if (stape && (stape.url || stape.code)) {
                let url = stape.url ?? stape.code ?? '';
                if (url.startsWith('/e/')) {
                    url = `https://streamtape.com${url}`;
                }
                if (url) {
                    results.push({
                        url,
                        embedType: 'streamtape',
                        language: 'es'
                    });
                }
            }
        }

        return results;
    }

    private async resolveEmbed(
        url: string,
        embedType: string
    ): Promise<{ streams: Array<{ url: string; type: string; quality?: string; headers?: Record<string, string> }> } | null> {
        try {
            if (embedType === 'streamwish') {
                return await resolveStreamwish(url, this.HEADERS);
            }
            if (embedType === 'streamtape') {
                return await resolveStreamtape(url, this.HEADERS);
            }
        } catch {
            // Ignore resolution errors
        }
        return null;
    }

    private languageLabel(lang: string): string {
        if (lang === 'ja') return 'Japanese';
        if (lang === 'es') return 'Spanish';
        if (lang === 'en') return 'English';
        return lang;
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
