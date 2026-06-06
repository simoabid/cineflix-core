import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class VidsrcvipProvider extends BaseProvider {
    readonly id = 'vidsrcvip';
    readonly name = 'VidSrc.vip';
    readonly enabled = false;
    readonly BASE_URL = 'https://api2.vidsrc.vip';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://vidsrc.vip/',
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
            const apiType = media.type === 'movie' ? 'movie' : 'tv';
            const encodedId = this.encodeTmdbId(
                media.tmdbId,
                media.type,
                media.type === 'tv' ? media.s : undefined,
                media.type === 'tv' ? media.e : undefined
            );

            const url = `${this.BASE_URL}/${apiType}/${encodedId}`;
            this.console.log(`Fetching from API: ${url}`);

            const res = await fetch(url, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as Record<
                string,
                { url?: string } | undefined
            >;

            if (!data?.source1) {
                return this.emptyResult('No sources found');
            }

            const embedIds = [
                'vidsrc-comet',
                'vidsrc-pulsar',
                'vidsrc-nova'
            ];

            const sources: Source[] = [];
            let sourceIndex = 0;

            for (let i = 1; data[`source${i}`]; i++) {
                const source = data[`source${i}`];
                if (source?.url) {
                    sources.push({
                        url: this.createProxyUrl(source.url, this.HEADERS),
                        type: 'embed',
                        quality: embedIds[sourceIndex % embedIds.length],
                        audioTracks: [{ label: 'Original', language: 'en' }],
                        provider: { id: this.id, name: this.name }
                    });
                    sourceIndex++;
                }
            }

            if (sources.length === 0) {
                return this.emptyResult('No valid sources found');
            }

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private encodeTmdbId(
        tmdb: string,
        type: 'movie' | 'tv',
        season?: number,
        episode?: number
    ): string {
        const digitToLetterMap = (digit: string): string => {
            const map = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
            return map[parseInt(digit, 10)];
        };

        let raw: string;
        if (type === 'tv' && season && episode) {
            raw = `${tmdb}-${season}-${episode}`;
        } else {
            raw = tmdb.split('').map(digitToLetterMap).join('');
        }

        const reversed = raw.split('').reverse().join('');
        return btoa(btoa(reversed));
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
