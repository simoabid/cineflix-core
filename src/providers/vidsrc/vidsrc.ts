import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';
import { resolveVidsrcAll } from './vidsrcClient.js';

interface WyzieSubtitle {
    url: string;
    format?: string;
    display?: string;
    language?: string;
    isHearingImpaired?: boolean;
}

/**
 * VidSrc provider.
 *
 * VidSrc (vidsrc.ru / vidsrc.su) is a client-side SPA whose stream URLs are
 * produced by a wasm-bindgen module: it derives a per-session key, signs the
 * request (HMAC), and AES-decrypts the backend response into a signed `.m3u8`.
 * `vidsrcClient.ts` reproduces that flow in Node (running the site's own wasm
 * for key derivation + decryption). This provider wraps the resolved stream
 * through `createProxyUrl()` and attaches subtitles from the wyzie API that the
 * site itself uses.
 */
export class VidSrcProvider extends BaseProvider {
    readonly id = 'vidsrc';
    readonly name = 'VidSrc';
    readonly enabled = true;

    readonly BASE_URL = 'https://vidsrc.ru';
    readonly SUBTITLE_API = 'https://sub.wyzie.ru/search';

    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Referer: 'https://vidsrc.ru/'
    };

    // Headers the stream CDN (mto/lva.nexlunar99.site) expects on playback.
    readonly STREAM_HEADERS: Record<string, string> = {
        'User-Agent': this.HEADERS['User-Agent'],
        Referer: 'https://vidsrc.ru/',
        Origin: 'https://vidsrc.ru'
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
            const { sources: resolved } = await resolveVidsrcAll({
                type: media.type,
                tmdbId: media.tmdbId,
                seasonId: media.type === 'tv' ? media.s : undefined,
                episodeId: media.type === 'tv' ? media.e : undefined
            });

            this.console.log(`Resolved ${resolved.length} server source(s)`);

            // One OMSS source per working server, labelled "VidSrc (Alpha)".
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
            this.console.log(`Failed: ${message}`);
            return this.emptyResult(message);
        }
    }

    /**
     * Fetch subtitles from the wyzie API (keyed by TMDB id, optional s/e).
     */
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

            const seen = new Set<string>();
            const subtitles: Subtitle[] = [];
            for (const sub of data) {
                if (!sub?.url || seen.has(sub.url)) continue;
                seen.add(sub.url);
                const label =
                    (sub.display || sub.language || 'Unknown') +
                    (sub.isHearingImpaired ? ' (SDH)' : '');
                subtitles.push({
                    url: this.createProxyUrl(sub.url, this.HEADERS),
                    label,
                    format: this.subtitleFormat(sub.format, sub.url)
                });
            }
            return subtitles;
        } catch {
            return [];
        }
    }

    private titleCase(s: string): string {
        return s.charAt(0).toUpperCase() + s.slice(1);
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
