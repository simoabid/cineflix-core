import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';

const API_URL = 'https://api.1anime.app';

interface StreamSource {
    url: string;
    isM3U8: boolean;
}

interface StreamHeaders {
    Referer?: string;
    Origin?: string;
}

interface SubtitleEntry {
    url: string;
    lang?: string;
    kind?: string;
}

interface WatchResponse {
    headers?: StreamHeaders;
    sources?: StreamSource[];
    subtitles?: SubtitleEntry[];
}

export class AnimekaiProvider extends BaseProvider {
    readonly id = 'animekai';
    readonly name = 'AnimeKai';
    readonly enabled = true;
    readonly BASE_URL = API_URL;
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['tv']
    };

    async getMovieSources(_media: ProviderMediaObject): Promise<ProviderResult> {
        return this.emptyResult('AnimeKai only supports TV content');
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const res = await fetch(
                `${API_URL}/anime/animekai/watch/${encodeURIComponent(media.tmdbId)}`,
                {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(15_000)
                }
            );

            if (!res.ok) {
                return this.emptyResult(`API returned status ${res.status}`);
            }

            const data = (await res.json()) as WatchResponse;
            if (!data?.sources?.length) {
                return this.emptyResult('No sources found');
            }

            const hlsSource = data.sources.find((s) => s.isM3U8);
            if (!hlsSource) {
                return this.emptyResult('No HLS source found');
            }

            const streamHeaders: Record<string, string> = {};
            if (data.headers?.Referer) {
                streamHeaders.Referer = data.headers.Referer;
                try {
                    streamHeaders.Origin = new URL(data.headers.Referer).origin;
                } catch {
                    // ignore invalid URL
                }
            }
            if (data.headers?.Origin) {
                streamHeaders.Origin = data.headers.Origin;
            }

            const hasHeaders = Object.keys(streamHeaders).length > 0;

            const source: Source = {
                url: this.createProxyUrl(
                    hlsSource.url,
                    hasHeaders ? streamHeaders : this.HEADERS
                ),
                type: 'hls',
                quality: 'unknown',
                audioTracks: [{ language: 'jpn', label: 'Sub' }],
                provider: { id: this.id, name: this.name }
            };

            const subtitles: Subtitle[] = (data.subtitles ?? [])
                .filter((sub) => sub.lang && sub.kind !== 'thumbnails')
                .map((sub) => ({
                    url: this.createProxyUrl(sub.url, this.HEADERS),
                    label: sub.lang?.replace(/_\[.*?\]$/, '').trim() || 'Unknown',
                    format: 'vtt' as const
                }));

            return {
                sources: [source],
                subtitles,
                diagnostics: []
            };
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
