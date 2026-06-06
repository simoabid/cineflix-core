import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import type { VidlinkApiResponse, VidlinkEncryptResponse } from './vidlink.types.js';

export class VidlinkProvider extends BaseProvider {
    readonly id = 'vidlink';
    readonly name = 'VidLink';
    readonly enabled = true;
    readonly BASE_URL = 'https://vidlink.pro';
    readonly API_BASE = 'https://enc-dec.app/api';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Connection: 'keep-alive',
        Referer: 'https://vidlink.pro/',
        Origin: 'https://vidlink.pro'
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
            this.console.log(`Encrypting TMDB ID: ${media.tmdbId}`);

            const encryptedId = await this.encryptTmdbId(media.tmdbId);
            this.console.log(`Encrypted ID obtained`);

            const apiUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/api/b/movie/${encryptedId}`
                    : `${this.BASE_URL}/api/b/tv/${encryptedId}/${media.s}/${media.e}`;

            const response = await fetch(apiUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!response.ok) {
                return this.emptyResult(
                    `Vidlink API returned ${response.status}`
                );
            }

            const vidlinkData = (await response.json()) as VidlinkApiResponse;

            if (!vidlinkData.stream) {
                return this.emptyResult('No stream data found in vidlink response');
            }

            const { stream } = vidlinkData;

            const sources: Source[] = [];

            if (stream.qualities) {
                for (const [quality, data] of Object.entries(stream.qualities)) {
                    sources.push({
                        url: this.createProxyUrl(data.url, this.HEADERS),
                        type: data.type === 'hls' ? 'hls' : 'mp4',
                        quality,
                        audioTracks: [],
                        provider: { id: this.id, name: this.name }
                    });
                }
            }

            if (stream.playlist) {
                sources.push({
                    url: this.createProxyUrl(stream.playlist, this.HEADERS),
                    type: 'hls',
                    quality: 'Auto',
                    audioTracks: [],
                    provider: { id: this.id, name: this.name }
                });
            }

            const subtitles: Subtitle[] = [];
            if (stream.captions && Array.isArray(stream.captions)) {
                for (const caption of stream.captions) {
                    const format = caption.type === 'srt' ? 'srt' : 'vtt';
                    subtitles.push({
                        url: this.createProxyUrl(caption.url, this.HEADERS),
                        label: caption.language || 'Unknown',
                        format
                    });
                }
            }

            this.console.log(
                `Found ${sources.length} sources and ${subtitles.length} subtitles`
            );

            return { sources, subtitles, diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async encryptTmdbId(tmdbId: string): Promise<string> {
        const url = `${this.API_BASE}/enc-vidlink?text=${encodeURIComponent(tmdbId)}`;

        const response = await fetch(url, {
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            throw new Error(`Encryption API returned ${response.status}`);
        }

        const data = (await response.json()) as VidlinkEncryptResponse;

        if (!data.result) {
            throw new Error('Failed to encrypt TMDB ID');
        }

        return data.result;
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
