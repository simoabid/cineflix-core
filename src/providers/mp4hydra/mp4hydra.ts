import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import { load } from 'cheerio';

export class Mp4hydraProvider extends BaseProvider {
    readonly id = 'mp4hydra';
    readonly name = 'Mp4Hydra';
    readonly enabled = false;
    readonly BASE_URL = 'https://mp4hydra.org';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://mp4hydra.org/',
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
            const searchUrl = `${this.BASE_URL}/search?q=${encodeURIComponent(media.title)}`;
            this.console.log(`Searching: ${searchUrl}`);

            const searchHtml = await this.fetchPage(searchUrl);
            const $search = load(searchHtml);
            const searchResults: Array<{
                title: string;
                year?: number;
                slug: string;
            }> = [];

            $search('.search-details').each((_, element) => {
                const text = $search(element).find('a').first().text().trim();
                const match = text.match(
                    /^(.*?)\s*(?:\(?\s*(\d{4})(?:\s*-\s*\d{0,4})?\s*\)?)?\s*$/
                );
                const title = match?.[1]?.trim();
                const year = match?.[2] ? parseInt(match[2], 10) : undefined;
                const slug = $search(element)
                    .find('a')
                    .attr('href')
                    ?.split('/')[4];

                if (!title || !slug) return;

                searchResults.push({ title, year, slug });
            });

            const matched = searchResults.find(
                (x) =>
                    x.title.toLowerCase().includes(media.title.toLowerCase()) ||
                    media.title.toLowerCase().includes(x.title.toLowerCase())
            );

            if (!matched) {
                return this.emptyResult('No watchable item found');
            }

            this.console.log(`Found match: ${matched.title} (${matched.year})`);

            const dataUrl = `${this.BASE_URL}/info2?v=8`;
            const dataRes = await fetch(dataUrl, {
                method: 'POST',
                headers: {
                    ...this.HEADERS,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    z: JSON.stringify([{ s: matched.slug, t: 'movie' }])
                }),
                signal: AbortSignal.timeout(15000)
            });

            if (!dataRes.ok) {
                return this.emptyResult(`HTTP ${dataRes.status}: ${dataRes.statusText}`);
            }

            const data = (await dataRes.json()) as {
                playlist?: Array<{ src?: string; label?: string }>;
                servers?: Record<string, string> & { auto?: string };
            };

            if (!data.playlist?.[0]?.src || !data.servers) {
                return this.emptyResult('No watchable item found');
            }

            const playlistSrc = data.playlist[0].src;
            const playlistLabel = data.playlist[0].label ?? '';

            const serverUrls: string[] = [];
            if (data.servers.auto && data.servers[data.servers.auto]) {
                serverUrls.push(data.servers[data.servers.auto]);
            }
            for (const [key, value] of Object.entries(data.servers)) {
                if (key !== 'auto' && value !== data.servers.auto && !serverUrls.includes(value)) {
                    serverUrls.push(value);
                }
            }

            const sources: Source[] = serverUrls
                .map((serverUrl, index) => {
                    const embedUrl = `${serverUrl}${playlistSrc}|${playlistLabel}`;
                    return {
                        url: this.createProxyUrl(embedUrl, this.HEADERS),
                        type: 'embed' as const,
                        quality: `Server ${index + 1}`,
                        audioTracks: [{ label: 'Original', language: 'en' }],
                        provider: { id: this.id, name: this.name }
                    };
                })
                .filter((s) => s.url);

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

    private async fetchPage(url: string): Promise<string> {
        const res = await fetch(url, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15000)
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
