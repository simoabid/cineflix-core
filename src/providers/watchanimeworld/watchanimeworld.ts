import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import { load } from 'cheerio';

export class WatchanimeworldProvider extends BaseProvider {
    readonly id = 'watchanimeworld';
    readonly name = 'WatchAnimeWorld';
    readonly enabled = false;
    readonly BASE_URL = 'https://watchanimeworld.in';
    readonly ZEPHYR_URL = 'https://play.zephyrflick.top';
    readonly TMDB_API_KEY = '5b9790d9305dca8713b9a0afad42ea8d';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Referer: 'https://watchanimeworld.in/',
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
            const title = await this.fetchTMDBTitle(media);
            const normalizedTitle = this.normalizeTitle(title);

            const watchUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/movies/${normalizedTitle}/`
                    : `${this.BASE_URL}/episode/${normalizedTitle}-${media.s}x${media.e}/`;

            this.console.log(`Fetching watch page: ${watchUrl}`);

            const res = await fetch(watchUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const html = await res.text();
            const $ = load(html);

            const iframeSrc =
                $('iframe[data-src]').attr('data-src') ||
                $('iframe[src]').attr('src');

            if (!iframeSrc) {
                return this.emptyResult('No iframe found on watch page');
            }

            const hashMatch = iframeSrc.match(/\/video\/([a-f0-9]+)/);
            if (!hashMatch) {
                return this.emptyResult(
                    'Could not extract video hash from iframe'
                );
            }

            const videoHash = hashMatch[1];
            this.console.log(`Found video hash: ${videoHash}`);

            const apiUrl = `${this.ZEPHYR_URL}/player/index.php?data=${videoHash}&do=getVideo`;

            const streamRes = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    ...this.HEADERS,
                    Referer: `${this.ZEPHYR_URL}/`,
                    Origin: this.ZEPHYR_URL,
                    Accept: 'application/json, text/plain, */*',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: `data=${videoHash}&do=getVideo`,
                signal: AbortSignal.timeout(15000)
            });

            if (!streamRes.ok) {
                return this.emptyResult(
                    `Stream API returned HTTP ${streamRes.status}`
                );
            }

            const streamData = (await streamRes.json()) as {
                hls?: boolean;
                videoSource?: string;
                securedLink?: string;
            };

            if (!streamData.hls || !streamData.videoSource) {
                return this.emptyResult('No HLS stream found');
            }

            const streamHeaders = {
                Referer: `${this.ZEPHYR_URL}/`,
                Origin: this.ZEPHYR_URL,
                'User-Agent': this.HEADERS['User-Agent']
            };

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(
                        streamData.videoSource,
                        streamHeaders
                    ),
                    type: 'hls',
                    quality: 'Unknown',
                    audioTracks: [{ label: 'Original', language: 'ja' }],
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

    private async fetchTMDBTitle(media: ProviderMediaObject): Promise<string> {
        const endpoint = media.type === 'movie' ? 'movie' : 'tv';
        const res = await fetch(
            `https://api.themoviedb.org/3/${endpoint}/${media.tmdbId}?api_key=${this.TMDB_API_KEY}`,
            { signal: AbortSignal.timeout(15000) }
        );

        if (!res.ok) {
            throw new Error('Failed to fetch TMDB data');
        }

        const data = (await res.json()) as {
            title?: string;
            original_title?: string;
            name?: string;
            original_name?: string;
        };

        return (
            data.title ||
            data.original_title ||
            data.name ||
            data.original_name ||
            media.title
        );
    }

    private normalizeTitle(title: string): string {
        return title
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .trim();
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
