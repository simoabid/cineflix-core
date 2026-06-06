import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class RgshowsProvider extends BaseProvider {
    readonly id = 'rgshows';
    readonly name = 'RGShows';
    readonly enabled = true;
    readonly BASE_URL = 'https://api.rgshows.ru';

    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: 'https://rgshows.ru/',
        Origin: 'https://rgshows.ru',
        Host: 'api.rgshows.ru'
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
            let url: string;
            if (media.type === 'movie') {
                url = `${this.BASE_URL}/main/movie/${media.tmdbId}`;
            } else {
                url = `${this.BASE_URL}/main/tv/${media.tmdbId}/${media.s}/${media.e}`;
            }

            const res = await fetch(url, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`API returned HTTP ${res.status}`);
            }

            const data = (await res.json()) as { stream?: { url?: string } };

            if (!data?.stream?.url) {
                return this.emptyResult('No stream URL in API response');
            }

            const streamUrl = data.stream.url;

            // Filter out known bad streams
            if (streamUrl === 'https://vidzee.wtf/playlist/69/master.m3u8') {
                return this.emptyResult('Filtered out known bad stream');
            }

            const streamHost = new URL(streamUrl).host;
            const streamHeaders = {
                ...this.HEADERS,
                Host: streamHost,
                Origin: 'https://www.rgshows.ru',
                Referer: 'https://www.rgshows.ru/'
            };

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(streamUrl, streamHeaders),
                    type: 'hls',
                    quality: 'Auto',
                    audioTracks: [{ language: 'org', label: 'Original' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            this.console.log(`Found stream for "${media.title}"`, media);

            return { sources, subtitles: [], diagnostics: [] };
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
