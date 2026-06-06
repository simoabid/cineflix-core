import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class CoitusProvider extends BaseProvider {
    readonly id = 'coitus';
    readonly name = 'Autoembed+';
    readonly enabled = false;
    readonly BASE_URL = 'https://api.coitus.ca';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://coitus.ca/',
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
            const apiUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/movie/${media.tmdbId}`
                    : `${this.BASE_URL}/tv/${media.tmdbId}/${media.s}/${media.e}`;

            this.console.log(`Fetching from API: ${apiUrl}`);

            const res = await fetch(apiUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as {
                videoSource?: string;
            };

            if (!data.videoSource) {
                return this.emptyResult('No video source found');
            }

            let processedUrl = data.videoSource;
            let streamHeaders: Record<string, string> = {};

            if (processedUrl.includes('orbitproxy')) {
                try {
                    const urlParts = processedUrl.split(/orbitproxy\.[^/]+\//);
                    if (urlParts.length >= 2) {
                        const encryptedPart = urlParts[1].split('.m3u8')[0];
                        const decodedData = Buffer.from(
                            encryptedPart,
                            'base64'
                        ).toString('utf-8');
                        const jsonData = JSON.parse(decodedData) as {
                            u?: string;
                            r?: string;
                        };

                        if (jsonData.u) {
                            processedUrl = jsonData.u;
                            if (jsonData.r) {
                                streamHeaders = { Referer: jsonData.r };
                            }
                        }
                    }
                } catch {
                    this.console.log('Failed to decode orbitproxy data, using original URL');
                }
            }

            this.console.log(`Resolved stream URL: ${processedUrl}`);

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(processedUrl, streamHeaders),
                    type: 'hls',
                    quality: 'Unknown',
                    audioTracks: [{ label: 'Original', language: 'en' }],
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
