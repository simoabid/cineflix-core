import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import { load } from 'cheerio';

export class SoapertvProvider extends BaseProvider {
    readonly id = 'soapertv';
    readonly name = 'SoaperTV';
    readonly enabled = false;
    readonly BASE_URL = 'https://soaper.cc';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        Referer: 'https://soaper.cc/',
        'Viewport-Width': '375',
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
            const searchResult = await this.fetchPage(
                `${this.BASE_URL}/search.html?keyword=${encodeURIComponent(media.title)}`
            );

            const $search = load(searchResult);
            const searchResults: Array<{
                title: string;
                year?: number;
                url: string;
            }> = [];

            $search('.thumbnail').each((_, element) => {
                const title = $search(element).find('h5 a').first().text().trim();
                const yearText = $search(element).find('.img-tip').first().text().trim();
                const url = $search(element).find('h5 a').first().attr('href');

                if (!title || !url) return;

                searchResults.push({
                    title,
                    year: yearText ? parseInt(yearText, 10) : undefined,
                    url
                });
            });

            const showLink = searchResults.find(
                (x) =>
                    x.title.toLowerCase().includes(media.title.toLowerCase()) ||
                    media.title.toLowerCase().includes(x.title.toLowerCase())
            )?.url;

            if (!showLink) {
                return this.emptyResult('Content not found');
            }

            let contentUrl = showLink;

            if (media.type === 'tv') {
                const showPage = await this.fetchPage(`${this.BASE_URL}${showLink}`);
                const $show = load(showPage);

                const seasonBlock = $show('h4')
                    .filter((_, el) =>
                        $show(el).text().trim().startsWith(`Season${media.s}`)
                    )
                    .parent();

                const episodeLink = seasonBlock
                    .find('a')
                    .toArray()
                    .find(
                        (el) =>
                            parseInt($show(el).text().split('.')[0], 10) === media.e
                    );

                if (!episodeLink) {
                    return this.emptyResult('Episode not found');
                }

                contentUrl = $show(episodeLink).attr('href') ?? contentUrl;
            }

            const contentPage = await this.fetchPage(`${this.BASE_URL}${contentUrl}`);
            const $content = load(contentPage);
            const pass = $content('#hId').attr('value');

            if (!pass) {
                return this.emptyResult('Content not found');
            }

            const formData = new URLSearchParams();
            formData.append('pass', pass);
            formData.append('e2', '0');
            formData.append('server', '0');

            const infoEndpoint =
                media.type === 'tv'
                    ? '/home/index/getEInfoAjax'
                    : '/home/index/getMInfoAjax';

            const streamRes = await this.fetchPage(
                `${this.BASE_URL}${infoEndpoint}`,
                {
                    method: 'POST',
                    body: formData,
                    headers: {
                        ...this.HEADERS,
                        Referer: `${this.BASE_URL}${contentUrl}`,
                        Origin: this.BASE_URL
                    }
                }
            );

            const streamData = JSON.parse(streamRes) as {
                val?: string;
                val_bak?: string;
                subs?: Array<{ path?: string; name?: string }>;
            };

            if (!streamData.val) {
                return this.emptyResult('No stream found');
            }

            const streamHeaders = {
                ...this.HEADERS,
                Referer: `${this.BASE_URL}${contentUrl}`,
                Origin: this.BASE_URL
            };

            const subtitles: Subtitle[] = (streamData.subs ?? [])
                .filter((sub) => sub.path && sub.name)
                .map((sub) => {
                    let label = sub.name ?? 'Unknown';
                    if (label.includes('.srt')) {
                        label = label.split('.srt')[0].trim();
                    } else if (label.includes(':')) {
                        label = label.split(':')[0].trim();
                    }

                    return {
                        url: this.createProxyUrl(
                            `${this.BASE_URL}${sub.path}`,
                            streamHeaders
                        ),
                        label,
                        format: 'srt' as const
                    };
                });

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(
                        `${this.BASE_URL}/${streamData.val}`,
                        streamHeaders
                    ),
                    type: 'hls',
                    quality: 'Unknown',
                    audioTracks: [{ label: 'Original', language: 'en' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            if (streamData.val_bak) {
                sources.push({
                    url: this.createProxyUrl(
                        `${this.BASE_URL}/${streamData.val_bak}`,
                        streamHeaders
                    ),
                    type: 'hls',
                    quality: 'Unknown',
                    audioTracks: [{ label: 'Original', language: 'en' }],
                    provider: { id: this.id, name: this.name }
                });
            }

            return { sources, subtitles, diagnostics: [] };
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
