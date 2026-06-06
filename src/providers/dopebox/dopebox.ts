import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import { load } from 'cheerio';

export class DopeboxProvider extends BaseProvider {
    readonly id = 'dopebox';
    readonly name = 'Dopebox';
    readonly enabled = false;
    readonly BASE_URL = 'https://dopebox.to';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://dopebox.to/',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    readonly SEARCH_URL = `${this.BASE_URL}/search/`;
    readonly SEASONS_URL = `${this.BASE_URL}/ajax/season/list/`;
    readonly EPISODES_URL = `${this.BASE_URL}/ajax/season/episodes/`;
    readonly SHOW_SERVERS_URL = `${this.BASE_URL}/ajax/episode/servers/`;
    readonly MOVIE_SERVERS_URL = `${this.BASE_URL}/ajax/episode/list/`;
    readonly FETCH_EMBEDS_URL = `${this.BASE_URL}/ajax/episode/sources/`;
    readonly FETCH_SOURCES_URL =
        'https://streameeeeee.site/embed-1/v3/e-1/getSources';

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
            const searchQuery = media.title
                .trim()
                .split(' ')
                .join('-')
                .toLowerCase();

            const searchHtml = await this.fetchPage(
                `${this.SEARCH_URL}${searchQuery}`
            );
            const $search = load(searchHtml);
            const searchResults: Array<{
                title: string;
                id: string;
                url: string;
            }> = [];

            $search('.flw-item').each((_, film) => {
                const detail = $search(film).find('.film-detail').first();
                const nameLink = detail?.find('.film-name a').first();
                if (!detail || !nameLink) return;

                const pathname = nameLink.attr('href')?.trim();
                const title = nameLink.attr('title')?.trim();
                if (!pathname || !title) return;

                const url = new URL(pathname, this.BASE_URL);
                const id = url.pathname.split('-').pop();
                if (!id) return;

                searchResults.push({ title, id, url: url.href });
            });

            const mediaType = media.type === 'movie' ? 'Movie' : 'TV';
            const matched = searchResults.find(
                (r) =>
                    r.title.toLowerCase().includes(media.title.toLowerCase()) &&
                    r.title.includes(mediaType)
            );

            if (!matched) {
                return this.emptyResult('Content not found');
            }

            let playerId: string;
            let playerUrl: string;

            if (media.type === 'tv') {
                const seasonsHtml = await this.fetchAjax(
                    `${this.SEASONS_URL}${matched.id}`
                );
                const $seasons = load(seasonsHtml);
                const season = $seasons('.ss-item')
                    .toArray()
                    .find(
                        (el) =>
                            parseInt(
                                ($seasons(el).text().match(/(\d+)/)?.[1] ?? '0'),
                                10
                            ) === media.s
                    );

                if (!season) {
                    return this.emptyResult('Season not found');
                }

                const seasonId = $seasons(season).attr('data-id')?.trim();
                if (!seasonId) {
                    return this.emptyResult('Season ID not found');
                }

                const episodesHtml = await this.fetchAjax(
                    `${this.EPISODES_URL}${seasonId}`
                );
                const $episodes = load(episodesHtml);
                const episode = $episodes('.eps-item')
                    .toArray()
                    .find(
                        (el) =>
                            parseInt(
                                ($episodes(el)
                                    .find('.episode-number')
                                    .first()
                                    .text()
                                    .match(/(\d+)/)?.[1] ?? '0'),
                                10
                            ) === media.e
                    );

                if (!episode) {
                    return this.emptyResult('Episode not found');
                }

                playerId = $episodes(episode).attr('data-id')?.trim() ?? '';
                playerUrl = `${this.SHOW_SERVERS_URL}${playerId}`;
            } else {
                playerId = matched.id;
                playerUrl = `${this.MOVIE_SERVERS_URL}${playerId}`;
            }

            const serversHtml = await this.fetchAjax(playerUrl);
            const $servers = load(serversHtml);
            const upcloudLink = $servers('.link-item')
                .toArray()
                .find(
                    (el) =>
                        $servers(el).find('span').first().text().trim().toLowerCase() ===
                        'upcloud'
                );

            if (!upcloudLink) {
                return this.emptyResult('UpCloud server not found');
            }

            const upcloudId = $servers(upcloudLink).attr('data-id')?.trim();
            if (!upcloudId) {
                return this.emptyResult('UpCloud ID not found');
            }

            const watchUrl = `${matched.url
                .replace(/\/tv\//, '/watch-tv/')
                .replace(/\/movie\//, '/watch-movie/')}.${upcloudId}`;

            const embedsHtml = await this.fetchAjax(
                `${this.FETCH_EMBEDS_URL}${upcloudId}`
            );
            const embedsData = JSON.parse(embedsHtml) as { link?: string };

            if (!embedsData.link) {
                return this.emptyResult('No embed link found');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(embedsData.link, this.HEADERS),
                    type: 'embed',
                    quality: 'UpCloud',
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

    private async fetchAjax(url: string): Promise<string> {
        const res = await fetch(url, {
            headers: {
                ...this.HEADERS,
                'X-Requested-With': 'XMLHttpRequest',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            },
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
