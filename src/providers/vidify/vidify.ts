import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class VidifyProvider extends BaseProvider {
    readonly id = 'vidify';
    readonly name = 'Vidify';
    readonly enabled = false;
    readonly BASE_URL = 'https://vidify.stream';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://vidify.stream/',
        Accept: 'application/json, text/plain, */*'
    };

    readonly VIDIFY_SERVERS = [
        { name: 'Mbox', sr: 17 },
        { name: 'Xprime', sr: 15 },
        { name: 'Hexo', sr: 8 },
        { name: 'Prime', sr: 9 },
        { name: 'Nitro', sr: 20 },
        { name: 'Meta', sr: 6 },
        { name: 'Veasy', sr: 16 },
        { name: 'Lux', sr: 26 },
        { name: 'Vfast', sr: 11 },
        { name: 'Zozo', sr: 7 },
        { name: 'Tamil', sr: 13 },
        { name: 'Telugu', sr: 14 },
        { name: 'Beta', sr: 5 },
        { name: 'Alpha', sr: 1 },
        { name: 'Vplus', sr: 18 },
        { name: 'Cobra', sr: 12 }
    ];

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
            const query: Record<string, string | number> = {
                type: media.type,
                tmdbId: media.tmdbId
            };

            if (media.type === 'tv' && media.s != null && media.e != null) {
                query.season = media.s;
                query.episode = media.e;
            }

            const sources: Source[] = this.VIDIFY_SERVERS.map((server) => ({
                url: this.createProxyUrl(
                    JSON.stringify({ ...query, sr: server.sr }),
                    this.HEADERS
                ),
                type: 'embed' as const,
                quality: server.name,
                audioTracks: [{ label: 'Original', language: 'en' }],
                provider: { id: this.id, name: this.name }
            }));

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
