import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class PrimewireProvider extends BaseProvider {
    readonly id = 'primewire';
    readonly name = 'PrimeWire';
    readonly enabled = false;
    readonly BASE_URL = 'https://primewire.pstream.mov';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        Referer: 'https://primewire.pstream.mov/',
        Accept: 'application/json, text/plain, */*'
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
            if (!media.imdbId) {
                return this.emptyResult('IMDB ID required');
            }

            const apiUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/movie/${media.imdbId}`
                    : `${this.BASE_URL}/tv/${media.imdbId}/${media.s}/${media.e}`;

            this.console.log(`Fetching from API: ${apiUrl}`);

            const res = await fetch(apiUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as {
                streams?: Array<{
                    headers?: Record<string, string>;
                    link?: string;
                    quality?: string;
                    server?: string;
                    type?: string;
                }>;
            };

            if (!data.streams?.length) {
                return this.emptyResult('No streams found');
            }

            const sources: Source[] = [];

            for (const stream of data.streams) {
                if (!stream.link || !stream.quality) continue;

                const streamHeaders = stream.headers ?? {};

                if (stream.type === 'm3u8') {
                    sources.push({
                        url: this.createProxyUrl(stream.link, streamHeaders),
                        type: 'hls',
                        quality: stream.quality,
                        audioTracks: [{ label: 'Original', language: 'en' }],
                        provider: { id: this.id, name: this.name }
                    });
                } else {
                    const urlPath = stream.link.split('?')[0];
                    if (
                        urlPath.toLowerCase().endsWith('.mp4') ||
                        stream.quality !== 'ORG'
                    ) {
                        sources.push({
                            url: this.createProxyUrl(stream.link, streamHeaders),
                            type: 'mp4',
                            quality: stream.quality,
                            audioTracks: [{ label: 'Original', language: 'en' }],
                            provider: { id: this.id, name: this.name }
                        });
                    }
                }
            }

            if (sources.length === 0) {
                return this.emptyResult('No valid streams found');
            }

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
