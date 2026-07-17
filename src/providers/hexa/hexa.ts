import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';
import { resolveHexaAll } from './hexaClient.js';

interface WyzieSubtitle {
    url: string;
    format?: string;
    display?: string;
    language?: string;
    isHearingImpaired?: boolean;
}

/**
 * Hexa (hexa.su / theemoviedb.hexa.su)
 *
 * Same WASM crypto pipeline as vidsrc (HMAC-signed image API + AES decrypt),
 * plus Cap.js Standalone (cap.hexa.su) for x-cap-token:
 *   challenge → PoW solutions + instrumentation math → redeem → token.
 *
 * Cap instrumentation is re-executed in Node (DOM-tree mock + string-table
 * rewrite); no browser / enc-dec.app dependency.
 *
 * ---------------------------------------------------------------------------
 * CAVEATS (read before declaring "production healthy"):
 *
 * 1) Resolve ≠ playback
 *    Returning proxied m3u8/mp4 URLs only proves the API handshake worked.
 *    CDN edges can still 403/410 once the player hits segments through our
 *    proxy (same class of failure as VidKing Oxygen). Always verify real
 *    playback on the deployment that will serve users.
 *
 * 2) Local ≠ EC2 / production network
 *    Cap, theemoviedb.hexa.su, and CDNs may treat residential IPs, datacenter
 *    IPs, and Cloudflare-fronted hosts differently. A green local smoke test
 *    is necessary but not sufficient for EC2/core.cineflix.dev.
 *
 * Full field notes: docs/HEXA-SCRAPING.md
 * ---------------------------------------------------------------------------
 */
export class HexaProvider extends BaseProvider {
    readonly id = 'hexa';
    readonly name = 'Hexa';
    readonly enabled = true;

    readonly BASE_URL = 'https://hexa.su';
    readonly SUBTITLE_API = 'https://sub.wyzie.ru/search';

    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        Referer: 'https://hexa.su/',
        Origin: 'https://hexa.su'
    };

    readonly STREAM_HEADERS: Record<string, string> = {
        'User-Agent': this.HEADERS['User-Agent'] as string,
        Referer: 'https://hexa.su/',
        Origin: 'https://hexa.su'
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
        if (media.type === 'tv' && (media.s == null || media.e == null)) {
            return this.emptyResult('Missing season/episode for TV request');
        }
        if (!media.tmdbId) {
            return this.emptyResult('tmdbId is required');
        }

        try {
            const { sources: resolved } = await resolveHexaAll({
                type: media.type,
                tmdbId: media.tmdbId,
                seasonId: media.type === 'tv' ? media.s : undefined,
                episodeId: media.type === 'tv' ? media.e : undefined
            });

            this.console.log(`hexa: ${resolved.length} server source(s)`);

            const sources: Source[] = resolved.map((s) => ({
                url: this.createProxyUrl(s.url, this.STREAM_HEADERS),
                type: s.url.includes('.mp4') ? 'mp4' : 'hls',
                quality: 'Auto',
                audioTracks: [{ language: 'eng', label: 'English' }],
                provider: {
                    id: this.id,
                    name: `${this.name} (${this.titleCase(s.server)})`
                }
            }));

            const subtitles = await this.fetchSubtitles(media);

            return { sources, subtitles, diagnostics: [] };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Unknown error';
            this.console.log(`hexa failed: ${message}`);
            return this.emptyResult(message);
        }
    }

    private async fetchSubtitles(
        media: ProviderMediaObject
    ): Promise<Subtitle[]> {
        try {
            let url = `${this.SUBTITLE_API}?id=${media.tmdbId}`;
            if (media.type === 'tv' && media.s != null && media.e != null) {
                url += `&season=${media.s}&episode=${media.e}`;
            }
            const res = await fetch(url, {
                signal: AbortSignal.timeout(15_000)
            });
            if (!res.ok) return [];
            const data = (await res.json()) as WyzieSubtitle[];
            if (!Array.isArray(data)) return [];
            return data
                .filter((s) => s.url)
                .map((s) => ({
                    url: this.createProxyUrl(s.url, this.HEADERS),
                    label: s.display || s.language || 'Unknown',
                    format: this.detectSubtitleFormat(s.url, s.format)
                }));
        } catch {
            return [];
        }
    }

    private detectSubtitleFormat(url: string, hint?: string): SubtitleFormat {
        const haystack = `${hint ?? ''} ${url}`.toLowerCase();
        if (haystack.includes('srt')) return 'srt';
        if (haystack.includes('ssa')) return 'ssa';
        if (haystack.includes('ass')) return 'ass';
        if (haystack.includes('ttml')) return 'ttml';
        return 'vtt';
    }

    private titleCase(s: string): string {
        if (!s) return s;
        return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
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
            return res.status < 500;
        } catch {
            return false;
        }
    }
}
