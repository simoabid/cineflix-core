import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import type { FullhdfilmizleSearchResult } from './fullhdfilmizle.types.js';
import {
    decodeAtom,
    decodeDeanEdwards,
    decodeHex,
    extractPackerParams,
    rtt,
    unescapeString
} from './decrypt.js';

export class FullhdfilmizleProvider extends BaseProvider {
    readonly id = 'fullhdfilmizle';
    readonly name = 'FullHDFilmizle (Turkish)';
    readonly enabled = true;
    readonly BASE_URL = 'https://www.fullhdfilmizlesene.tv';
    readonly HEADERS = {
        Referer: 'https://www.fullhdfilmizlesene.tv',
        Accept: 'application/json, text/plain, */*',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            if (!media.imdbId) {
                return this.emptyResult('IMDb id not provided');
            }

            this.console.log(`Searching for IMDb ID: ${media.imdbId}`);

            const searchUrl = `${this.BASE_URL}/autocomplete/q.php?q=${media.imdbId}`;
            const searchJson = (await fetch(searchUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            }).then((r) => r.json())) as FullhdfilmizleSearchResult[];

            if (!searchJson.length) {
                return this.emptyResult('Media not found');
            }

            const searchResult = searchJson[0];
            const mediaUrl = `${this.BASE_URL}/${searchResult.prefix}/${searchResult.dizilink}`;

            this.console.log(`Fetching media page: ${mediaUrl}`);

            const mediaPage = await fetch(mediaUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            }).then((r) => r.text());

            const playerMatch = mediaPage.match(
                /var scx = {.+"t":\["(.+)"\]},/
            );
            if (!playerMatch) {
                return this.emptyResult('No source found');
            }

            const playerUrl = atob(rtt(playerMatch[1]));
            const isVidmoxy = playerUrl.startsWith('https://vidmoxy.com');

            this.console.log(`Player URL: ${playerUrl}`);

            const playerHeaders = {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                Referer: this.BASE_URL,
                'Sec-Fetch-Dest': 'iframe',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-User': '?1',
                'Sec-GPC': '1',
                'Upgrade-Insecure-Requests': '1',
                'User-Agent': this.HEADERS['User-Agent']
            };

            const playerResponse = await fetch(
                playerUrl + (isVidmoxy ? '?vst=1' : ''),
                {
                    headers: playerHeaders,
                    signal: AbortSignal.timeout(15000)
                }
            ).then((r) => r.text());

            if (!playerResponse || playerResponse === '404') {
                return this.emptyResult('Player 404: Source is inaccessible');
            }

            const playlistUrl = isVidmoxy
                ? this.extractVidmoxy(playerResponse)
                : this.extractAtom(playerResponse);

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(playlistUrl, this.HEADERS),
                    type: 'hls',
                    quality: 'Auto',
                    audioTracks: [],
                    provider: { id: this.id, name: this.name }
                }
            ];

            this.console.log(`Found 1 HLS source`);

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    async getTVSources(_media: ProviderMediaObject): Promise<ProviderResult> {
        return this.emptyResult('TV shows not supported');
    }

    // NOTE: This function matches `eval(...)` patterns in scraped HTML via regex
    // to extract Dean Edwards packed payloads. It does NOT call eval() -- decoding
    // is done safely via string replacement in decodeDeanEdwards().
    private extractVidmoxy(body: string): string {
        const regex =
            /eval\(function\(p,a,c,k,e,d\){.+}}return p}\((\\?'.+.split\(\\?'\|\\?'\)).+$/m;

        let decoded = body;
        let i = 0;

        while (decoded.includes('eval(')) {
            const decodedMatch = decoded.match(regex);
            if (!decodedMatch) {
                throw new Error('Decryption unsuccessful');
            }

            const parameters = extractPackerParams(
                i > 0 ? unescapeString(decodedMatch[1]) : decodedMatch[1]
            );
            if (!parameters) {
                throw new Error('Decryption unsuccessful');
            }

            decoded = decodeDeanEdwards(parameters);
            i++;
        }

        const fileMatch = decoded.match(/"file":"(.+?)"/);
        if (!fileMatch) {
            throw new Error('No playlist found');
        }

        return unescapeString(decodeHex(fileMatch[1]));
    }

    private extractAtom(body: string): string {
        const fileMatch = body.match(/"file": av\('(.+)'\),$/m);

        if (!fileMatch) {
            throw new Error('No playlist found');
        }

        return decodeAtom(fileMatch[1]);
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
