import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import { load } from 'cheerio';
import JsUnpacker from '../../utils/jsunpack.js';

export class ZoechipProvider extends BaseProvider {
    readonly id = 'zoechip';
    readonly name = 'ZoeChip';
    readonly enabled = false;
    readonly BASE_URL = 'https://zoechip.org';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Referer: 'https://zoechip.org/',
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
            const url = this.buildWatchUrl(media);
            this.console.log(`Fetching watch page: ${url}`);

            const html = await this.fetchPage(url);
            const $ = load(html);

            const movieId =
                $('div#show_player_ajax').attr('movie-id') ||
                $('[data-movie-id]').attr('data-movie-id') ||
                $('[movie-id]').attr('movie-id') ||
                $('.player-wrapper').attr('data-id');

            if (!movieId) {
                return this.emptyResult('No content ID found on page');
            }

            this.console.log(`Found movie ID: ${movieId}`);

            const ajaxUrl = `${this.BASE_URL}/wp-admin/admin-ajax.php`;
            const ajaxBody = new URLSearchParams({
                action: 'lazy_player',
                movieID: movieId
            });

            const ajaxHtml = await this.fetchPage(ajaxUrl, {
                method: 'POST',
                headers: {
                    ...this.HEADERS,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    Referer: url
                },
                body: ajaxBody.toString()
            });

            const $ajax = load(ajaxHtml);
            const filemoonUrl = $ajax('ul.nav a:contains(Filemoon)').attr('data-server');

            if (!filemoonUrl) {
                return this.emptyResult('No Filemoon server found');
            }

            this.console.log(`Found Filemoon URL: ${filemoonUrl}`);

            const streamUrl = await this.resolveFilemoon(filemoonUrl);
            if (!streamUrl) {
                return this.emptyResult('Failed to resolve Filemoon stream');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(streamUrl, {
                        Referer: 'https://filemoon.to/',
                        'User-Agent': this.HEADERS['User-Agent']
                    }),
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

    private buildWatchUrl(media: ProviderMediaObject): string {
        const slug = this.createSlug(media.title);
        if (media.type === 'movie') {
            return `${this.BASE_URL}/film/${slug}-${media.releaseYear}`;
        }
        return `${this.BASE_URL}/episode/${slug}-season-${media.s}-episode-${media.e}`;
    }

    private createSlug(title: string): string {
        return title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .trim();
    }

    private async resolveFilemoon(filemoonUrl: string): Promise<string | null> {
        try {
            const redirectRes = await fetch(filemoonUrl, {
                method: 'HEAD',
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000),
                redirect: 'follow'
            });

            const redirectUrl = redirectRes.url;
            if (!redirectUrl) return null;

            const redirectHtml = await this.fetchPage(redirectUrl);
            const $redirect = load(redirectHtml);
            const iframeUrl = $redirect('iframe').attr('src');

            if (!iframeUrl) return null;

            const iframeHtml = await this.fetchPage(iframeUrl);

            const evalMatch = iframeHtml.match(
                /eval\(function\(p,a,c,k,e,.*\)\)/i
            );
            if (!evalMatch) return null;

            const unpacker = new JsUnpacker(evalMatch[0]);
            const unpacked = unpacker.unpack();
            if (!unpacked) return null;

            const fileMatch = unpacked.match(/file\s*:\s*"([^"]+)"/i);
            return fileMatch?.[1] ?? null;
        } catch {
            return null;
        }
    }

    private async fetchPage(
        url: string,
        options?: RequestInit
    ): Promise<string> {
        const res = await fetch(url, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15000),
            ...options
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.text();
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
