import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    SourceType,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';
import { fetchVidkingSubtitles, resolveVidking } from './vidkingClient.js';
import type { VidkingApiSubtitle } from './vidking.types.js';

/**
 * VidKing provider (https://www.vidking.net).
 *
 * Public "embed player" docs only expose iframe URLs that inject ads. The
 * underlying player is a Vite SPA that resolves streams against
 * api.speedracelight.com with seed-based enc=2 encryption and five named
 * backends (Hydrogen, Titanium, Oxygen, Lithium, Helium). This provider
 * reproduces that client flow in Node — no iframe, no ads — and wraps every
 * stream through `createProxyUrl()`.
 *
 * Methodology: docs/SCRAPING-MASTERCLASS.md §2 (SPA recon → reproduce →
 * decode → integrate).
 */
export class VidkingProvider extends BaseProvider {
    readonly id = 'vidking';
    readonly name = 'VidKing';
    readonly enabled = true;

    readonly BASE_URL = 'https://www.vidking.net';

    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Referer: 'https://www.vidking.net/',
        Origin: 'https://www.vidking.net'
    };

    /**
     * Playback headers for CDN fetches via the OMSS proxy.
     *
     * Important: Hydrogen's CDN (ironbubble.site) returns 403 when a Referer
     * is present. Oxygen/others accept either. Use a minimal header set so
     * all servers play through the proxy.
     */
    readonly STREAM_HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Accept: '*/*'
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
            return this.emptyResult('Missing season/episode for TV request');
        }

        try {
            const resolved = await resolveVidking({
                type: media.type,
                tmdbId: media.tmdbId,
                title: media.title,
                year: media.releaseYear,
                imdbId: media.imdbId,
                seasonId: media.type === 'tv' ? media.s : undefined,
                episodeId: media.type === 'tv' ? media.e : undefined
            });

            if (resolved.diagnostics.length > 0) {
                this.console.log(
                    `Server diagnostics: ${resolved.diagnostics.join('; ')}`
                );
            }

            this.console.log(
                `Resolved ${resolved.sources.length} stream(s) across servers`
            );

            // Prefer HLS over DASH when both exist for the same server+quality
            // (player's `sl()` does the opposite — we optimize for OMSS clients).
            const ranked = this.rankSources(resolved.sources);

            const sources: Source[] = ranked.map((s) => ({
                url: this.createProxyUrl(s.url, this.streamHeadersFor(s.url)),
                type: this.toSourceType(s.type, s.url),
                quality: s.quality,
                audioTracks: [{ language: 'eng', label: 'English' }],
                provider: {
                    id: this.id,
                    name: `${this.name} (${s.server})`
                }
            }));

            const subtitles = await this.collectSubtitles(
                media,
                resolved.imdbId,
                resolved.inlineSubtitles
            );

            if (sources.length === 0) {
                const detail =
                    resolved.diagnostics.length > 0
                        ? resolved.diagnostics.join('; ')
                        : 'No streams from any server';
                return this.emptyResult(detail);
            }

            return { sources, subtitles, diagnostics: [] };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Unknown error';
            this.console.log(`Failed: ${message}`);
            return this.emptyResult(message);
        }
    }

    /**
     * Hydrogen CDN forbids Referer; others are fine with bare UA.
     */
    private streamHeadersFor(url: string): Record<string, string> {
        if (/ironbubble\.site/i.test(url)) {
            return this.STREAM_HEADERS;
        }
        // Ironwall / other hosts accept vidking referer; still prefer minimal
        // headers for maximum compatibility through the proxy.
        return this.STREAM_HEADERS;
    }

    private rankSources<
        T extends { type: string; url: string; quality: string; server: string }
    >(sources: T[]): T[] {
        const score = (s: T): number => {
            const t = s.type.toLowerCase();
            if (t === 'hls' || s.url.includes('.m3u8')) return 0;
            if (t === 'mp4' || s.url.includes('.mp4')) return 1;
            if (t === 'dash' || s.url.includes('.mpd')) return 2;
            return 3;
        };
        return [...sources].sort((a, b) => score(a) - score(b));
    }

    private toSourceType(type: string, url: string): SourceType {
        const t = type.toLowerCase();
        if (t === 'dash' || url.includes('.mpd')) return 'dash';
        if (t === 'mp4' || (url.includes('.mp4') && !url.includes('m3u8'))) {
            return 'mp4';
        }
        if (t === 'hls' || url.includes('.m3u8')) return 'hls';
        return 'hls';
    }

    private async collectSubtitles(
        media: ProviderMediaObject,
        imdbId: string,
        inline: VidkingApiSubtitle[]
    ): Promise<Subtitle[]> {
        const fromInline = this.mapSubtitles(inline);
        const fromApi = this.mapSubtitles(
            await fetchVidkingSubtitles(
                imdbId || media.imdbId,
                media.type === 'tv' ? media.s : undefined,
                media.type === 'tv' ? media.e : undefined
            )
        );

        const seen = new Set<string>();
        const out: Subtitle[] = [];
        for (const sub of [...fromInline, ...fromApi]) {
            if (seen.has(sub.url)) continue;
            seen.add(sub.url);
            out.push(sub);
        }
        return out;
    }

    private mapSubtitles(raw: VidkingApiSubtitle[]): Subtitle[] {
        const out: Subtitle[] = [];
        for (const sub of raw) {
            if (!sub?.url) continue;
            const label =
                (sub.display || sub.language || 'Unknown') +
                (sub.isHearingImpaired ? ' (SDH)' : '');
            out.push({
                url: this.createProxyUrl(sub.url, this.HEADERS),
                label,
                format: this.subtitleFormat(sub.format, sub.url)
            });
        }
        return out;
    }

    private subtitleFormat(
        fmt: string | undefined,
        url: string
    ): SubtitleFormat {
        const f = (fmt ?? '').toLowerCase();
        if (f === 'srt' || f === 'vtt' || f === 'ass' || f === 'ssa') return f;
        if (f === 'ttml') return 'ttml';
        const u = url.toLowerCase();
        if (u.includes('.srt')) return 'srt';
        if (u.includes('.ass')) return 'ass';
        if (u.includes('.ssa')) return 'ssa';
        if (u.includes('.ttml') || u.includes('.xml')) return 'ttml';
        return 'vtt';
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
}
