import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import type {
    LookmovieSearchResult,
    LookmovieStreamsResult,
    LookmovieShowData,
    LookmovieEpisode
} from './lookmovie.types.js';

const API_BASE_URL = 'https://lmscript.xyz';

export class LookmovieProvider extends BaseProvider {
    readonly id = 'lookmovie';
    readonly name = 'LookMovie';
    readonly enabled = true;
    readonly BASE_URL = API_BASE_URL;

    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: 'https://lookmovie2.to/'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const searchRes = await this.fetchJson<LookmovieSearchResult>(
                `${API_BASE_URL}/v1/movies?filters[q]=${encodeURIComponent(media.title)}`
            );

            const match = searchRes?.items?.find(
                (item) =>
                    item.title?.toLowerCase().includes(media.title.toLowerCase()) &&
                    (!media.releaseYear || String(item.year) === media.releaseYear)
            );

            if (!match?.id_movie) {
                return this.emptyResult('Movie not found in search results');
            }

            const video = await this.getVideo(match.id_movie, media);
            if (!video.playlist) {
                return this.emptyResult('No video stream found');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(video.playlist, this.HEADERS),
                    type: 'hls',
                    quality: 'Auto',
                    audioTracks: [{ language: 'en', label: 'English' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            this.console.log(`Found movie stream for "${media.title}"`, media);

            return { sources, subtitles: video.subtitles, diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const searchRes = await this.fetchJson<LookmovieSearchResult>(
                `${API_BASE_URL}/v1/shows?filters[q]=${encodeURIComponent(media.title)}`
            );

            const match = searchRes?.items?.find(
                (item) =>
                    item.title?.toLowerCase().includes(media.title.toLowerCase()) &&
                    (!media.releaseYear || String(item.year) === media.releaseYear)
            );

            if (!match?.id_show) {
                return this.emptyResult('Show not found in search results');
            }

            // Get show details with episodes
            const showData = await this.fetchJson<LookmovieShowData>(
                `${API_BASE_URL}/v1/shows?expand=episodes&id=${match.id_show}`
            );

            const episode = showData?.episodes?.find(
                (ep: LookmovieEpisode) =>
                    Number(ep.season) === Number(media.s) &&
                    Number(ep.episode) === Number(media.e)
            );

            if (!episode?.id) {
                return this.emptyResult(
                    `Episode S${media.s}E${media.e} not found`
                );
            }

            const video = await this.getVideo(episode.id, media);
            if (!video.playlist) {
                return this.emptyResult('No video stream found');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(video.playlist, this.HEADERS),
                    type: 'hls',
                    quality: 'Auto',
                    audioTracks: [{ language: 'en', label: 'English' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            this.console.log(
                `Found TV stream for "${media.title}" S${media.s}E${media.e}`,
                media
            );

            return { sources, subtitles: video.subtitles, diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async getVideo(
        id: string,
        media: ProviderMediaObject
    ): Promise<{ playlist: string | null; subtitles: Subtitle[] }> {
        // Movies are public; episode view requires Bearer auth
        // (WWW-Authenticate: Bearer realm="api") and guest tokens are not
        // issued. Download APIs also require a logged-in user.
        const path = media.type === 'tv' ? '/v1/episodes/view' : '/v1/movies/view';
        const data = await this.fetchJson<LookmovieStreamsResult>(
            `${API_BASE_URL}${path}?expand=streams,subtitles&id=${id}`
        );

        // Find best quality stream
        const qualityPriority = [
            'auto',
            '1080p',
            '1080',
            '720p',
            '720',
            '480p',
            '480'
        ];
        let playlist: string | null = null;
        for (const q of qualityPriority) {
            if (data?.streams?.[q]) {
                playlist = data.streams[q];
                break;
            }
        }

        // Parse subtitles
        const subtitles: Subtitle[] = [];
        if (data?.subtitles) {
            for (const sub of data.subtitles) {
                if (!sub?.url || !sub?.language) continue;
                subtitles.push({
                    url: `${API_BASE_URL}${sub.url}`,
                    label: sub.language,
                    format: 'vtt'
                });
            }
        }

        return { playlist, subtitles };
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const res = await fetch(url, {
            headers: {
                ...this.HEADERS,
                Accept: 'application/json, text/plain, */*',
                Origin: 'https://www.lookmovie2.to'
            },
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) {
            if (res.status === 401 && url.includes('/episodes/')) {
                throw new Error(
                    `HTTP 401 for episode streams (Bearer auth required; TV needs a logged-in LookMovie account). ${url}`
                );
            }
            throw new Error(`HTTP ${res.status} for ${url}`);
        }
        return res.json() as Promise<T>;
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
