import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class EmbedsuProvider extends BaseProvider {
    readonly id = 'embedsu';
    readonly name = 'embed.su';
    readonly enabled = false;
    readonly BASE_URL = 'https://embed.su';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: 'https://embed.su/',
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
            const embedUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/embed/movie/${media.tmdbId}`
                    : `${this.BASE_URL}/embed/tv/${media.tmdbId}/${media.s}/${media.e}`;

            this.console.log(`Fetching embed page: ${embedUrl}`);

            const res = await fetch(embedUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const html = await res.text();

            const vConfigMatch = html.match(
                /window\.vConfig\s*=\s*JSON\.parse\(atob\(`([^`]+)/i
            );
            const encodedConfig = vConfigMatch?.[1];

            if (!encodedConfig) {
                return this.emptyResult('No encoded config found');
            }

            const decodedConfig = JSON.parse(
                await this.stringAtob(encodedConfig)
            ) as { hash?: string };

            if (!decodedConfig?.hash) {
                return this.emptyResult('No stream hash found');
            }

            const firstDecode = (await this.stringAtob(decodedConfig.hash))
                .split('.')
                .map((item) => item.split('').reverse().join(''));

            const secondDecode = JSON.parse(
                await this.stringAtob(
                    firstDecode.join('').split('').reverse().join('')
                )
            ) as Array<{ name?: string; hash?: string }>;

            if (!secondDecode?.length) {
                return this.emptyResult('No servers found');
            }

            const sources: Source[] = secondDecode
                .filter((server) => server.hash)
                .map((server, index) => ({
                    url: this.createProxyUrl(
                        `https://embed.su/api/e/${server.hash}`,
                        this.HEADERS
                    ),
                    type: 'embed' as const,
                    quality: server.name ?? `Server ${index + 1}`,
                    audioTracks: [{ label: 'Original', language: 'en' }],
                    provider: { id: this.id, name: this.name }
                }));

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

    private async stringAtob(input: string): Promise<string> {
        const chars =
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
        const str = input.replace(/=+$/, '');
        let output = '';

        if (str.length % 4 === 1) {
            throw new Error('The string to be decoded is not correctly encoded.');
        }

        for (let bc = 0, bs = 0, i = 0; i < str.length; i++) {
            const buffer = str.charAt(i);
            const charIndex = chars.indexOf(buffer);
            if (charIndex === -1) continue;
            bs = bc % 4 ? bs * 64 + charIndex : charIndex;
            if (bc++ % 4) {
                output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
            }
        }

        return output;
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
