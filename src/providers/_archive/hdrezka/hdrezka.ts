import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import type {
    HdrezkaMovieData,
    HdrezkaSearchItem,
    HdrezkaVideoLinks
} from './hdrezka.types.js';

export class HdrezkaProvider extends BaseProvider {
    readonly id = 'hdrezka';
    readonly name = 'HDRezka';
    readonly enabled = true;
    readonly BASE_URL = 'https://hdrezka.ag/';
    readonly HEADERS = {
        'X-Hdrezka-Android-App': '1',
        'X-Hdrezka-Android-App-Version': '2.2.0',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'CF-IPCountry': 'RU'
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
            const searchResult = await this.searchAndFindMediaId(media);
            if (!searchResult || !searchResult.id) {
                return this.emptyResult('No result found');
            }

            const translatorId = await this.getTranslatorId(
                searchResult.url,
                searchResult.id,
                media
            );
            if (!translatorId) {
                return this.emptyResult('No translator id found');
            }

            const streamData = await this.getStream(
                searchResult.id,
                translatorId,
                media
            );

            const sources = this.parseVideoLinks(streamData.url);
            const subtitles = this.parseSubtitleLinks(
                typeof streamData.subtitle === 'string'
                    ? streamData.subtitle
                    : undefined
            );

            return { sources, subtitles, diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async searchAndFindMediaId(
        media: ProviderMediaObject
    ): Promise<HdrezkaSearchItem | null> {
        const searchUrl = `${this.BASE_URL}engine/ajax/search.php?q=${encodeURIComponent(media.title)}`;

        const searchData = await fetch(searchUrl, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15000)
        }).then((r) => r.text());

        const items: HdrezkaSearchItem[] = [];
        const linkRegex =
            /<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<span class="enty">([^<]*)<\/span>[\s\S]*?<\/a>/g;

        let match: RegExpExecArray | null;
        while ((match = linkRegex.exec(searchData)) !== null) {
            const url = match[1];
            const titleText = match[2];

            const yearMatch =
                titleText.match(/\((\d{4})\)/) ||
                url.match(/-(\d{4})(?:-|\.html)/) ||
                titleText.match(/(\d{4})/);
            const itemYear = yearMatch
                ? parseInt(yearMatch[1], 10)
                : typeof media.releaseYear === 'string'
                    ? parseInt(media.releaseYear, 10)
                    : media.releaseYear;
            const idMatch = url.match(/\/(\d+)-[^/]+\.html$/);

            if (idMatch) {
                items.push({
                    id: idMatch[1],
                    year: itemYear,
                    type: media.type,
                    url
                });
            }
        }

        const releaseYear =
            typeof media.releaseYear === 'string'
                ? parseInt(media.releaseYear, 10)
                : media.releaseYear;

        items.sort((a, b) => {
            const diffA = Math.abs(a.year - releaseYear);
            const diffB = Math.abs(b.year - releaseYear);
            return diffA - diffB;
        });

        return items[0] || null;
    }

    private async getTranslatorId(
        url: string,
        id: string,
        media: ProviderMediaObject
    ): Promise<string | null> {
        const response = await fetch(url, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15000)
        }).then((r) => r.text());

        if (response.includes('data-translator_id="238"')) {
            return '238';
        }

        const functionName =
            media.type === 'movie'
                ? 'initCDNMoviesEvents'
                : 'initCDNSeriesEvents';
        const regexPattern = new RegExp(
            `sof\\.tv\\.${functionName}\\(${id}, ([^,]+)`,
            'i'
        );
        const match = response.match(regexPattern);
        return match ? match[1] : null;
    }

    private async getStream(
        id: string,
        translatorId: string,
        media: ProviderMediaObject
    ): Promise<HdrezkaVideoLinks> {
        const params = new URLSearchParams();
        params.append('id', id);
        params.append('translator_id', translatorId);

        if (media.type === 'tv' && media.s !== undefined && media.e !== undefined) {
            params.append('season', media.s.toString());
            params.append('episode', media.e.toString());
        }

        params.append('favs', this.generateRandomFavs());
        params.append(
            'action',
            media.type === 'tv' ? 'get_stream' : 'get_movie'
        );
        params.append('t', Date.now().toString());

        const response = await fetch(`${this.BASE_URL}ajax/get_cdn_series/`, {
            method: 'POST',
            headers: {
                ...this.HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
                Referer: `${this.BASE_URL}films/action/${id}-latest.html`
            },
            body: params,
            signal: AbortSignal.timeout(15000)
        }).then((r) => r.json());

        const data = response as HdrezkaVideoLinks;

        if (!data.url) {
            throw new Error('No stream URL found in response');
        }

        return data;
    }

    private generateRandomFavs(): string {
        const randomHex = () =>
            Math.floor(Math.random() * 16).toString(16);
        const generateSegment = (length: number) =>
            Array.from({ length }, randomHex).join('');

        return `${generateSegment(8)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(12)}`;
    }

    private parseVideoLinks(inputString?: string): Source[] {
        if (!inputString) return [];

        const sources: Source[] = [];
        const links = inputString.split(',');

        for (const link of links) {
            const match = link.match(/\[([^\]]+)\](https?:\/\/[^\s,]+)/);
            if (match) {
                const quality = match[1]
                    .replace(/<[^>]+>/g, '')
                    .toLowerCase()
                    .replace('p', '')
                    .trim();
                const url = match[2].trim();

                if (url === 'null') continue;

                sources.push({
                    url: this.createProxyUrl(url, this.HEADERS),
                    type: 'mp4',
                    quality,
                    audioTracks: [],
                    provider: { id: this.id, name: this.name }
                });
            }
        }

        return sources;
    }

    private parseSubtitleLinks(inputString?: string): Subtitle[] {
        if (!inputString) return [];

        const subtitles: Subtitle[] = [];
        const links = inputString.split(',');

        for (const link of links) {
            const match = link.match(
                /\[([^\]]+)\](https?:\/\/\S+?)(?=,\[|$)/
            );
            if (match) {
                const label = match[1];
                const url = match[2];

                subtitles.push({
                    url: this.createProxyUrl(url, this.HEADERS),
                    label,
                    format: 'vtt'
                });
            }
        }

        return subtitles;
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
