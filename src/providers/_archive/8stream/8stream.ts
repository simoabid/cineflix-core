import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import type {
    EightStreamInfoResult,
    EightStreamResult
} from './8stream.types.js';

export class EightStreamProvider extends BaseProvider {
    readonly id = '8stream';
    readonly name = '8Stream';
    readonly enabled = true;
    readonly BASE_URL = 'https://ftmoh345xme.com';
    readonly HEADERS = {
        Origin: 'https://friness-cherlormur-i-275.site',
        Referer: 'https://google.com/',
        Dnt: '1',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
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

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        try {
            if (!media.imdbId) {
                return this.emptyResult('IMDb ID not provided');
            }

            this.console.log(`Getting info for IMDb ID: ${media.imdbId}`);

            const info = await this.getInfo(media.imdbId);
            if (!info.success) {
                return this.emptyResult('Failed to get media info');
            }

            this.console.log('Getting stream link...');

            const stream = await this.getStream(
                info.data.playlist,
                info.data.key
            );
            if (!stream.success) {
                return this.emptyResult('Failed to get stream');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(stream.data.link, this.HEADERS),
                    type: 'hls',
                    quality: 'Auto',
                    audioTracks: [],
                    provider: { id: this.id, name: this.name }
                }
            ];

            this.console.log('Found 1 HLS source');

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async getInfo(imdbId: string): Promise<EightStreamInfoResult> {
        try {
            const url = `${this.BASE_URL}/play/${imdbId}`;
            const result = await fetch(url, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            }).then((r) => r.text());

            const scriptMatch = result.match(
                /<script[^>]*>([\s\S]*?)<\/script>/gi
            );
            if (!scriptMatch || scriptMatch.length === 0) {
                return { success: false, data: { playlist: '', key: '' } };
            }

            const lastScript = scriptMatch[scriptMatch.length - 1];
            const scriptContent = lastScript.replace(
                /<\/?script[^>]*>/gi,
                ''
            );

            const contentMatch =
                scriptContent.match(/(\{[^;]+});/)?.[1] ||
                scriptContent.match(/\((\{.*\})\)/)?.[1];

            if (!contentMatch) {
                return { success: false, data: { playlist: '', key: '' } };
            }

            const data = JSON.parse(contentMatch);
            let file = data.file;

            if (!file) {
                return { success: false, data: { playlist: '', key: '' } };
            }

            if (file.startsWith('/')) {
                file = this.BASE_URL + file;
            }

            const key = data.key;

            const headersWithKey = {
                ...this.HEADERS,
                'X-Csrf-Token': key
            };

            const playlist = await fetch(file, {
                headers: headersWithKey,
                signal: AbortSignal.timeout(15000)
            }).then((r) => r.text());

            return {
                success: true,
                data: { playlist, key }
            };
        } catch {
            return { success: false, data: { playlist: '', key: '' } };
        }
    }

    private async getStream(
        file: string,
        key: string
    ): Promise<EightStreamResult> {
        try {
            const path = `${file.slice(1)}.txt`;
            const url = `${this.BASE_URL}/playlist/${path}`;

            const headersWithKey = {
                ...this.HEADERS,
                'X-Csrf-Token': key
            };

            const result = await fetch(url, {
                headers: headersWithKey,
                signal: AbortSignal.timeout(15000)
            }).then((r) => r.text());

            return {
                success: true,
                data: { link: result }
            };
        } catch {
            return { success: false, data: { link: '' } };
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
