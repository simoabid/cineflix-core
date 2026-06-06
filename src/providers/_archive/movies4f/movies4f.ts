import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import type { Movies4fTokenResponse } from './movies4f.types.js';

const BASE_URL = 'https://movies4f.com';
const TOKEN_ENDPOINT = 'https://moviking.childish2x2.fun/geturl';
const BOUNDARY = '----geckoformboundaryc5f480bcac13a77346dab33881da6bfb';

export class Movies4fProvider extends BaseProvider {
    readonly id = 'movies4f';
    readonly name = 'M4F';
    readonly enabled = true;
    readonly BASE_URL = BASE_URL;

    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL
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
            // Step 1: Search for the film
            const filmUrl = await this.searchFilm(media);
            if (!filmUrl) {
                return this.emptyResult('No matching film found in search results');
            }

            // Step 2: Load film page and extract embed iframe
            const filmHtml = await this.fetchText(filmUrl);
            const iframeMatch = filmHtml.match(/<iframe[^>]*id="iframeStream"[^>]*src="([^"]+)"/);
            if (!iframeMatch) {
                return this.emptyResult('No embed iframe found on film page');
            }

            const iframeSrc = iframeMatch[1];
            const embedUrl = new URL(iframeSrc);
            const videoId = embedUrl.searchParams.get('id');
            if (!videoId) {
                return this.emptyResult('No video ID in embed URL');
            }

            // Step 3: POST multipart form to get tokens
            const tokenBody = this.buildMultipartBody(videoId, BASE_URL);
            const tokenRes = await fetch(TOKEN_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
                    'User-Agent': this.HEADERS['User-Agent'],
                    Referer: iframeSrc
                },
                body: tokenBody,
                signal: AbortSignal.timeout(15000)
            });

            if (!tokenRes.ok) {
                return this.emptyResult(`Token request failed with HTTP ${tokenRes.status}`);
            }

            const tokenText = await tokenRes.text();
            const tokenMatch = tokenText.match(
                /token1=(\w+)&token2=(\w+)&token3=(\w+)/
            );
            if (!tokenMatch) {
                return this.emptyResult('Failed to extract tokens from response');
            }

            const [, token1, token2, token3] = tokenMatch;

            // Step 4: Fetch streaming page with tokens
            const streamingUrl = `https://cdn4.zenty.store/streaming?id=${videoId}&web=movies4f.com&token1=${token1}&token2=${token2}&token3=${token3}&cdn=https%3A%2F%2Fcdn4.zenty.store&lang=en`;

            const streamingHtml = await fetch(streamingUrl, {
                headers: {
                    'User-Agent': this.HEADERS['User-Agent'],
                    Referer: 'https://moviking.childish2x2.fun/'
                },
                signal: AbortSignal.timeout(15000)
            }).then((r) => {
                if (!r.ok) throw new Error(`Streaming page HTTP ${r.status}`);
                return r.text();
            });

            // Step 5: Extract M3U8 URL from streaming page
            const urlRegex = /url = '([^']+)'/;
            const urlMatch = streamingHtml.match(urlRegex);
            if (!urlMatch) {
                return this.emptyResult('Failed to extract stream URL from streaming page');
            }

            const streamBaseUrl = urlMatch[1];
            const streamUrl = `${streamBaseUrl}${videoId}/?token1=${token1}&token3=${token3}`;

            const streamHeaders = {
                'User-Agent': this.HEADERS['User-Agent'],
                Referer: 'https://moviking.childish2x2.fun/',
                Origin: 'https://cdn4.zenty.store'
            };

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(streamUrl, streamHeaders),
                    type: 'hls',
                    quality: 'Auto',
                    audioTracks: [{ language: 'en', label: 'English' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            this.console.log(`Found stream for "${media.title}"`, media);

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async searchFilm(
        media: ProviderMediaObject
    ): Promise<string | null> {
        // Try without year first
        let html = await this.fetchText(
            `${BASE_URL}/search?q=${encodeURIComponent(media.title)}`
        );

        let result = this.parseSearchResult(html, media);

        // If no results, try with year
        if (!result && media.releaseYear) {
            html = await this.fetchText(
                `${BASE_URL}/search?q=${encodeURIComponent(`${media.title} ${media.releaseYear}`)}`
            );
            result = this.parseSearchResult(html, media);
        }

        return result;
    }

    private parseSearchResult(
        html: string,
        media: ProviderMediaObject
    ): string | null {
        const filmCardRegex =
            /<a[^>]*href="([^"]*\/film\/\d+\/[^"]*)"[^>]*class="[^"]*poster[^"]*"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*>/g;

        let match: RegExpExecArray | null;
        for (;;) {
            match = filmCardRegex.exec(html);
            if (match === null) break;

            const link = match[1];
            const title = match[2];

            const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
            const normalizedSearch = media.title.toLowerCase().replace(/[^a-z0-9]/g, '');

            if (normalizedTitle.includes(normalizedSearch)) {
                if (media.type === 'tv') {
                    return `${BASE_URL}${link}/episode-${media.e}`;
                }
                return `${BASE_URL}${link}`;
            }
        }

        return null;
    }

    private buildMultipartBody(videoId: string, domain: string): string {
        const fields = [
            { name: 'renderer', value: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar' },
            { name: 'id', value: '6164426f797cf4b2fe93e4b20c0a4338' },
            { name: 'videoId', value: videoId },
            { name: 'domain', value: `${domain}/` }
        ];

        const parts = fields.map(
            (f) =>
                `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}`
        );

        return parts.join('\r\n') + `\r\n--${BOUNDARY}--`;
    }

    private async fetchText(url: string): Promise<string> {
        const res = await fetch(url, {
            headers: {
                'User-Agent': this.HEADERS['User-Agent']
            },
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
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
