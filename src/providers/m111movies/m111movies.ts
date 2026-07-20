/**
 * m111movies.ts — 111Movies / Vidlove provider for CinePro Core.
 *
 * Entry: 111movies.net → 302 → player.vidlove.cc SPA.
 * Resolve path (pure HTTP, no browser):
 *   POST momlover…/auth/generate-token
 *   GET  momlover…/{moviebox|cline|self|zebra|fabric}/movie|tv/…
 *        + x-request-token + x-response-encryption: aes-gcm
 *   Decrypt AES-GCM payload → stream URLs
 *
 * Field notes: SPA bundle sec-gcm + sec-constants (RESPONSE_BASE_KEY).
 * Methodology: docs/SCRAPING-MASTERCLASS.md §2.
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
import { scrapeFetch } from '../../utils/scrapeFetch.js';
import {
    BROWSER_HEADERS,
    PLAYER_ORIGIN,
    resolveM111Streams
} from './m111moviesClient.js';

export class M111MoviesProvider extends BaseProvider {
    readonly id = 'm111movies';
    readonly name = '111Movies';
    readonly enabled = true;

    readonly BASE_URL = PLAYER_ORIGIN;

    readonly HEADERS: Record<string, string> = { ...BROWSER_HEADERS };

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
                `Resolved ${result.sources.length} playable source(s) and ` +
                    `${result.subtitles.length} subtitle(s)` +
                    (result.servers.length
                        ? ` from ${result.servers.length} server(s)`
                        : '')
            );

            for (const msg of result.probeDiagnostics ?? []) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    message: `${this.name}: ${msg}`,
                    field: '',
                    severity: 'warning'
                });
            }

            const sources: Source[] = result.sources.map((s) => ({
                url: this.createProxyUrl(s.url, {
                    ...this.HEADERS,
                    ...(s.headers ?? {}),
                    Referer: s.noReferrer
                        ? 'no-referrer'
                        : `${PLAYER_ORIGIN}/`
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
                return this.emptyResult(
                    result.probeDiagnostics?.length
                        ? `No playable sources after probe (${result.probeDiagnostics.slice(0, 3).join('; ')})`
                        : 'No playable sources found'
                );
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
            const res = await scrapeFetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS,
                timeoutMs: 10_000,
                viaProxy: true
            });
            return res.ok || res.status === 302 || res.status === 301;
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
