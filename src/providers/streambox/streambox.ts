import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';

export class StreamboxProvider extends BaseProvider {
    readonly id = 'streambox';
    readonly name = 'StreamBox';
    readonly enabled = false;
    readonly BASE_URL = 'https://vidjoy.pro';
    readonly API_URL = 'https://vidjoy.pro/embed/api/fastfetch';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://vidjoy.pro/',
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
                    ? `${this.API_URL}/${media.tmdbId}?sr=0`
                    : `${this.API_URL}/${media.tmdbId}/${media.s}/${media.e}?sr=0`;

            this.console.log(`Fetching from API: ${apiUrl}`);

            const res = await fetch(apiUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as {
                url?: Array<{ resulation?: string; link?: string; type?: string }>;
                tracks?: Array<{ lang?: string; url?: string; code?: string }>;
                provider?: string;
                headers?: { Referer?: string };
            };

            if (!data.url?.length) {
                return this.emptyResult('No streams found');
            }

            const streams: Record<string, string> = {};
            for (const stream of data.url) {
                if (stream.resulation && stream.link) {
                    streams[stream.resulation] = stream.link;
                }
            }

            const subtitles: Subtitle[] = (data.tracks ?? []).map((track) => ({
                url: this.createProxyUrl(track.url ?? '', this.HEADERS),
                label: track.lang ?? track.code ?? 'Unknown',
                format: 'srt' as const
            }));

            const streamHeaders: Record<string, string> = {};
            if (data.headers?.Referer) {
                streamHeaders.Referer = data.headers.Referer;
            }

            let sources: Source[];

            if (data.provider === 'MovieBox') {
                sources = Object.entries(streams)
                    .filter(([_, url]) => url)
                    .map(([quality, url]) => ({
                        url: this.createProxyUrl(url, streamHeaders),
                        type: 'mp4' as const,
                        quality: quality.includes('p') ? quality : `${quality}p`,
                        audioTracks: [{ label: 'Original', language: 'en' }],
                        provider: { id: this.id, name: this.name }
                    }));
            } else {
                const hlsStream =
                    data.url.find((s) => s.type === 'hls') ?? data.url[0];
                if (!hlsStream?.link) {
                    return this.emptyResult('No HLS stream found');
                }
                sources = [
                    {
                        url: this.createProxyUrl(hlsStream.link, streamHeaders),
                        type: 'hls',
                        quality: 'Unknown',
                        audioTracks: [{ label: 'Original', language: 'en' }],
                        provider: { id: this.id, name: this.name }
                    }
                ];
            }

            if (sources.length === 0) {
                return this.emptyResult('No valid sources found');
            }

            return { sources, subtitles, diagnostics: [] };
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
