import { load } from 'cheerio';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    SourceType
} from '@omss/framework';
import type { FshareApiResponse, FshareSource } from './fshare.types.js';

export class FsharetvProvider extends BaseProvider {
    readonly id = 'fsharetv';
    readonly name = 'FshareTV';
    readonly enabled = true;
    readonly BASE_URL = 'https://fsharetv.co';

    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: 'https://fsharetv.co/'
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
            const searchPage = await this.fetchText(
                `${this.BASE_URL}/search?q=${encodeURIComponent(media.title)}`
            );

            const $ = load(searchPage);
            const searchResults: { title: string; year?: number; url: string }[] = [];

            $('.movie-item').each((_, element) => {
                const [, title, year] =
                    $(element)
                        .find('b')
                        .text()
                        ?.match(/^(.*?)\s*(?:\(?\s*(\d{4})(?:\s*-\s*\d{0,4})?\s*\)?)?\s*$/) || [];
                const url = $(element).find('a').attr('href');
                if (!title || !url) return;
                searchResults.push({ title, year: year ? Number(year) : undefined, url });
            });

            const match = searchResults.find(
                (x) =>
                    x.title.toLowerCase().includes(media.title.toLowerCase()) &&
                    (!x.year || !media.releaseYear || x.year === Number(media.releaseYear))
            );

            if (!match?.url) {
                return this.emptyResult('No matching result found in search');
            }

            const watchPageUrl = match.url.replace('/movie', '/w');
            const watchPage = await this.fetchText(`${this.BASE_URL}${watchPageUrl}`);

            const fileId = watchPage.match(/Movie\.setSource\('([^']*)'/)?.[1];
            if (!fileId) {
                return this.emptyResult('File ID not found on watch page');
            }

            const apiUrl = `${this.BASE_URL}/api/file/${fileId}/source?type=watch`;
            const apiRes: FshareApiResponse = await this.fetchJson(apiUrl);

            if (!apiRes?.data?.file?.sources?.length) {
                return this.emptyResult('API returned no sources');
            }

            // Resolve the final media base URL from the first source redirect
            const firstSrcUrl = apiRes.data.file.sources[0].src;
            const fullFirstUrl = firstSrcUrl.startsWith('http')
                ? firstSrcUrl
                : `${this.BASE_URL}${firstSrcUrl}`;

            let mediaBase: string;
            try {
                const headRes = await fetch(fullFirstUrl, {
                    method: 'HEAD',
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(15000),
                    redirect: 'follow'
                });
                mediaBase = new URL(headRes.url).origin;
            } catch {
                mediaBase = this.BASE_URL;
            }

            const sources: Source[] = [];
            for (const source of apiRes.data.file.sources) {
                const quality =
                    typeof source.quality === 'number'
                        ? `${source.quality}p`
                        : this.normalizeQuality(source.quality);
                const filePath = source.src.replace('/api', '');
                const rawUrl = `${mediaBase}${filePath}`;

                sources.push({
                    url: this.createProxyUrl(rawUrl, { Referer: this.BASE_URL }),
                    type: 'mp4' as SourceType,
                    quality,
                    audioTracks: [{ language: 'org', label: 'Original' }],
                    provider: { id: this.id, name: this.name }
                });
            }

            this.console.log(`Found ${sources.length} sources for "${media.title}"`, media);

            return { sources, subtitles: [] , diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async fetchText(url: string): Promise<string> {
        const res = await fetch(url, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.text();
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const res = await fetch(url, {
            headers: { ...this.HEADERS, Accept: 'application/json' },
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.json() as Promise<T>;
    }

    private normalizeQuality(raw: string): string {
        const lower = raw.toLowerCase().trim();
        if (lower.includes('4k') || lower.includes('2160')) return '2160p';
        if (lower.includes('1080') || lower === 'fhd') return '1080p';
        if (lower.includes('720') || lower === 'hd') return '720p';
        if (lower.includes('480')) return '480p';
        if (lower.includes('360')) return '360p';
        return 'Auto';
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
