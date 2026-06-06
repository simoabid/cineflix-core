import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class WarezcdnProvider extends BaseProvider {
    readonly id = 'warezcdn';
    readonly name = 'WarezCDN';
    readonly enabled = false;
    readonly BASE_URL = 'https://embed.warezcdn.link';
    readonly API_BASE = 'https://warezcdn.link/embed';
    readonly PLAYER_BASE = 'https://warezcdn.link/player';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://warezcdn.link/',
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
            if (!media.imdbId) {
                return this.emptyResult('This source requires IMDB id');
            }

            const pageUrl =
                media.type === 'movie'
                    ? `${this.BASE_URL}/filme/${media.imdbId}`
                    : `${this.BASE_URL}/serie/${media.imdbId}/${media.s}/${media.e}`;

            this.console.log(`Fetching page: ${pageUrl}`);

            const res = await fetch(pageUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const html = await res.text();

            const dataMatch = html.match(
                /let\s+data\s*=\s*'\[\s*\{\s*"id":"([^"]+)".*?"servers":"([^"]+)"/
            );

            if (!dataMatch?.[1] || !dataMatch?.[2]) {
                return this.emptyResult('Failed to find episode data');
            }

            const id = dataMatch[1];
            const servers = dataMatch[2];

            this.console.log(`Found ID: ${id}, Servers: ${servers}`);

            const sources: Source[] = [];

            for (const server of servers.split(',')) {
                try {
                    await this.fetchPage(
                        `${this.API_BASE}/getEmbed.php?id=${id}&sv=${server}`,
                        {
                            method: 'HEAD',
                            headers: {
                                ...this.HEADERS,
                                Referer: `${this.API_BASE}/getEmbed.php?id=${id}&sv=${server}`
                            }
                        }
                    );

                    const playHtml = await this.fetchPage(
                        `${this.API_BASE}/getPlay.php?id=${id}&sv=${server}`,
                        {
                            headers: {
                                ...this.HEADERS,
                                Referer: `${this.API_BASE}/getEmbed.php?id=${id}&sv=${server}`
                            }
                        }
                    );

                    const embedUrl = playHtml.match(
                        /window.location.href\s*=\s*"([^"]+)"/
                    )?.[1];

                    if (!embedUrl) continue;

                    if (server === 'warezcdn') {
                        sources.push(
                            {
                                url: this.createProxyUrl(embedUrl, this.HEADERS),
                                type: 'embed',
                                quality: 'WarezCDN HLS',
                                audioTracks: [
                                    { label: 'Original', language: 'en' }
                                ],
                                provider: { id: this.id, name: this.name }
                            },
                            {
                                url: this.createProxyUrl(embedUrl, this.HEADERS),
                                type: 'embed',
                                quality: 'WarezCDN MP4',
                                audioTracks: [
                                    { label: 'Original', language: 'en' }
                                ],
                                provider: { id: this.id, name: this.name }
                            }
                        );
                    } else if (server === 'mixdrop') {
                        sources.push({
                            url: this.createProxyUrl(embedUrl, this.HEADERS),
                            type: 'embed',
                            quality: 'MixDrop',
                            audioTracks: [
                                { label: 'Original', language: 'en' }
                            ],
                            provider: { id: this.id, name: this.name }
                        });
                    }
                } catch {
                    this.console.log(`Failed to resolve server: ${server}`);
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
