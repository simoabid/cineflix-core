import * as cheerio from 'cheerio';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import { resolveDood } from '../../utils/embeds/dood.js';

const ORIGIN_HOST = 'https://www3.fsonline.app';
const MOVIE_PAGE_URL = 'https://www3.fsonline.app/film/';
const SHOW_PAGE_URL =
    'https://www3.fsonline.app/episoade/{{MOVIE}}-sezonul-{{SEASON}}-episodul-{{EPISODE}}/';
const EMBED_URL = 'https://www3.fsonline.app/wp-admin/admin-ajax.php';

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
    Origin: ORIGIN_HOST,
    Referer: ORIGIN_HOST
};

function normalizeName(name: string): string {
    return name
        .trim()
        .normalize('NFD')
        .toLowerCase()
        .replace(/[^a-zA-Z0-9. ]+/g, '')
        .replace('.', ' ')
        .split(' ')
        .join('-');
}

function buildPageUrl(media: ProviderMediaObject): string {
    const name =
        media.type === 'movie'
            ? `${media.title} ${media.releaseYear}`
            : media.title;
    const normalized = normalizeName(name);

    if (media.type === 'tv' && media.s && media.e) {
        return SHOW_PAGE_URL.replace('{{MOVIE}}', normalized)
            .replace('{{SEASON}}', String(media.s))
            .replace('{{EPISODE}}', String(media.e));
    }
    return `${MOVIE_PAGE_URL}${normalized}/`;
}

interface LazyPlayerSource {
    name: string;
    url: string;
}

export class FSOnlineProvider extends BaseProvider {
    readonly id = 'fsonline';
    readonly name = 'FSOnline';
    readonly enabled = true;
    readonly BASE_URL = ORIGIN_HOST;
    readonly HEADERS = HEADERS;

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
            const pageUrl = buildPageUrl(media);
            const movieId = await this.fetchMovieId(pageUrl);

            if (!movieId) {
                return this.emptyResult('Could not find movie ID on page');
            }

            const playerSources = await this.fetchLazyPlayer(movieId, pageUrl);
            if (playerSources.length === 0) {
                return this.emptyResult('No player sources found');
            }

            const sources: Source[] = [];

            for (const playerSource of playerSources) {
                const resolved = await this.resolveSource(playerSource);
                if (resolved) {
                    sources.push(resolved);
                }
            }

            if (sources.length === 0) {
                return this.emptyResult('Failed to resolve any stream sources');
            }

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async fetchMovieId(pageUrl: string): Promise<string | undefined> {
        try {
            const res = await fetch(pageUrl, {
                headers: HEADERS,
                signal: AbortSignal.timeout(15_000)
            });

            if (!res.ok) return undefined;

            const html = await res.text();
            const $ = cheerio.load(html);
            const movieId = $('#show_player_lazy').attr('movie-id');
            return movieId || undefined;
        } catch {
            return undefined;
        }
    }

    private async fetchLazyPlayer(
        movieId: string,
        referer: string
    ): Promise<LazyPlayerSource[]> {
        try {
            const res = await fetch(EMBED_URL, {
                method: 'POST',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type':
                        'application/x-www-form-urlencoded; charset=UTF-8',
                    Referer: referer,
                    Origin: ORIGIN_HOST
                },
                body: `action=lazy_player&movieID=${movieId}`,
                signal: AbortSignal.timeout(15_000)
            });

            if (!res.ok) return [];

            const html = await res.text();
            const $ = cheerio.load(html);
            const sources: LazyPlayerSource[] = [];

            $('li.dooplay_player_option').each((_, element) => {
                const name = $(element).find('span').text().trim();
                const url = $(element).attr('data-vs');
                if (url) {
                    sources.push({ name, url });
                }
            });

            return sources;
        } catch {
            return [];
        }
    }

    private async resolveSource(
        playerSource: LazyPlayerSource
    ): Promise<Source | null> {
        const nameLower = playerSource.name.toLowerCase();

        try {
            if (nameLower.includes('doodstream') || nameLower.includes('dood')) {
                const result = await resolveDood(playerSource.url);
                if (!result?.streams?.[0]) return null;

                const stream = result.streams[0];
                return {
                    url: this.createProxyUrl(stream.url, {
                        ...HEADERS,
                        ...(stream.headers ?? {})
                    }),
                    type: 'mp4',
                    quality: stream.quality ?? 'unknown',
                    audioTracks: [{ language: 'unknown', label: 'Default' }],
                    provider: { id: this.id, name: this.name }
                };
            }

            // Filemoon and other embed types - return as embed URL proxied
            if (nameLower.includes('filemoon')) {
                return {
                    url: this.createProxyUrl(playerSource.url, HEADERS),
                    type: 'embed',
                    quality: 'unknown',
                    audioTracks: [{ language: 'unknown', label: 'Default' }],
                    provider: { id: this.id, name: this.name }
                };
            }

            return null;
        } catch {
            return null;
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
