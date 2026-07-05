/**
 * m111movies.ts — 111movies.net provider for CinePro Core.
 *
 * 111movies is a Next.js SPA with an obfuscated player. The API flow is:
 *   1. Embed page server-renders a `data` blob in __NEXT_DATA__
 *   2. The player's JS decodes the blob into an API path
 *   3. GET /{api_path} → returns JSON array of servers (plain JSON!)
 *   4. GET /{api_path}/{server.data} → returns JSON {url, tracks, noReferrer}
 *   5. The `url` field is the direct m3u8/mp4 stream URL
 *   6. Subtitles from /wyzie?id={tmdbId} (same wyzie API as vidup)
 *
 * The `data` blob decode requires running the player's obfuscated JS.
 * This provider uses a headless browser (Playwright) ONLY for the _data
 * decode (~5 seconds), then makes all API calls in pure HTTP. The API
 * responses are plain JSON (not encrypted like vidup), so stream resolution
 * is fast once the API URL is known.
 *
 * Multiple servers are supported (Alpha, Charlie, etc.).
 */
import { BaseProvider } from '@omss/framework';
import type {
    Diagnostic,
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';
import { resolveM111Streams } from './m111moviesClient.js';

export class M111MoviesProvider extends BaseProvider {
    readonly id = 'm111movies';
    readonly name = '111Movies';
    readonly enabled = true;

    readonly BASE_URL = 'https://111movies.net';

    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://111movies.net/',
        Origin: 'https://111movies.net'
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

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        if (!media.tmdbId) {
            return this.emptyResult('tmdbId is required');
        }
        if (media.type === 'tv' && (media.s == null || media.e == null)) {
            return this.emptyResult('Missing season or episode for TV request');
        }

        const diagnostics: Diagnostic[] = [];

        try {
            const result = await resolveM111Streams({
                type: media.type,
                tmdbId: media.tmdbId,
                season: media.type === 'tv' ? media.s : undefined,
                episode: media.type === 'tv' ? media.e : undefined
            });

            this.console.log(
                `Resolved ${result.sources.length} source(s) and ` +
                    `${result.subtitles.length} subtitle(s)` +
                    (result.servers.length
                        ? ` from ${result.servers.length} server(s)`
                        : '')
            );

            const sources: Source[] = result.sources.map((s) => ({
                url: this.createProxyUrl(s.url, {
                    ...this.HEADERS,
                    Referer: s.noReferrer
                        ? 'no-referrer'
                        : 'https://111movies.net/'
                }),
                type: s.type,
                quality: s.quality,
                audioTracks: [{ language: 'eng', label: 'English' }],
                provider: {
                    id: this.id,
                    name: `${this.name} (${s.serverName})`
                }
            }));

            const subtitles: Subtitle[] = result.subtitles.map((sub) => ({
                url: this.createProxyUrl(sub.url, this.HEADERS),
                label: sub.display,
                format: this.detectFormat(sub.url)
            }));

            if (sources.length === 0) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    message: `${this.name}: No playable sources found`,
                    field: 'sources',
                    severity: 'warning'
                });
            }

            return { sources, subtitles, diagnostics };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Unknown error';
            this.console.log(`Failed: ${message}`);
            return this.emptyResult(message);
        }
    }

    private detectFormat(url: string): SubtitleFormat {
        const u = url.toLowerCase();
        if (u.includes('.vtt')) return 'vtt';
        if (u.includes('.srt')) return 'srt';
        if (u.includes('.ass')) return 'ass';
        if (u.includes('.ssa')) return 'ssa';
        if (u.includes('.ttml') || u.includes('.xml')) return 'ttml';
        return 'vtt';
    }

    async healthCheck(): Promise<boolean> {
        try {
            const res = await fetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS,
                signal: AbortSignal.timeout(10_000)
            });
            return res.ok;
        } catch {
            return false;
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
