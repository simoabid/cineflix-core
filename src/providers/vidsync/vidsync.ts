import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import { createBroWasm, type BroWasm } from './broWasm.js';
import type { VidsyncDecryptedStream, VidsyncTrack } from './vidsync.types.js';

/**
 * VidSync (vidsync.live — vidsync.xyz 301s here)
 *
 * Native browser flow (embed chunk 96fa5e81961f95b0.js, 2026-07):
 *
 *   1. Cloudflare Turnstile (sitekey 0x4AAAAAAB_8pfVJvAg9lSQ4,
 *      action stream_fetch) → X-CF-Turnstile
 *   2. GET /api/stream/fetch?...&serverName=…
 *   3. bro.wasm: SHA-512(PREFIX+X12) → verify → decrypt(text, mediaId)
 *
 * PROVED (mitmweb capture + Node, 2026-07-15):
 *   • bro.wasm decrypt is pure Node and returns mp4_qualities JSON
 *   • Live 200 ciphertext for Godfather/cinebox decrypts to workers.dev URLs
 *
 * BLOCKED for shipping:
 *   • Pure-Node Turnstile mint (Cloudflare closed; not Cap.js)
 *   • We refuse Playwright / 1–2h token paste injectors (ops-hostile)
 *
 * enc-dec.app enc-vidsync is dead (InitTabs2). See docs/VIDSYNC-SCRAPING.md.
 *
 * CAVEATS: resolve ≠ playback; local ≠ EC2.
 *
 * STATUS: enabled = false until a pure Turnstile (or equivalent) mint exists.
 * broWasm remains for offline decrypt / future wire-up.
 */
export class VidsyncProvider extends BaseProvider {
    readonly id = 'vidsync';
    readonly name = 'VidSync';
    /** Disabled: Turnstile has no pure-Node mint; browser injectors rejected. */
    readonly enabled = false;
    readonly BASE_URL = 'https://vidsync.live';
    readonly HEADERS: Record<string, string> = {
        Accept: '*/*',
        Origin: 'https://vidsync.live',
        Referer: 'https://vidsync.live/',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest'
    };

    private readonly DEFAULT_SERVERS = [
        'cinebox',
        'cinebox-1',
        'cinefast',
        'cinenet',
        'cineready',
        'cinedub-2',
        'cinevip',
        'cineviet'
    ];

    private readonly TIMEOUT_MS = 15000;

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
        // Hard gate: do not attempt Playwright / env-token mint paths.
        return this.emptyResult(
            'disabled — bro.wasm decrypt is pure Node, but Cloudflare ' +
                'Turnstile has no pure-Node mint (enc-vidsync dead; browser ' +
                'token injectors rejected). See docs/VIDSYNC-SCRAPING.md'
        );
    }

    /**
     * Research / future path: stream/fetch + bro decrypt once a pure
     * Turnstile mint exists. Not used while enabled === false.
     */
    async resolveWithTurnstileToken(
        media: ProviderMediaObject,
        token: string
    ): Promise<ProviderResult> {
        try {
            if (!media.title) {
                return this.emptyResult('missing title (required by vidsync)');
            }
            if (!token) {
                return this.emptyResult('missing X-CF-Turnstile token');
            }

            const servers = await this.getServerList();
            if (servers.length === 0) {
                return this.emptyResult('no vidsync servers available');
            }

            this.console.log(
                `vidsync: research resolve ${servers.length} server(s) for "${media.title}"`
            );

            const settled = await Promise.allSettled(
                servers.map((server) => this.fetchServer(media, server, token))
            );

            const sources: Source[] = [];
            const subtitles: Subtitle[] = [];
            let failCount = 0;

            for (const outcome of settled) {
                if (outcome.status === 'rejected' || !outcome.value) {
                    failCount++;
                    continue;
                }
                sources.push(...outcome.value.sources);
                subtitles.push(...outcome.value.subtitles);
            }

            const dedupedSources = this.dedupeSources(sources);
            const dedupedSubs = this.dedupeSubtitles(subtitles);

            if (dedupedSources.length === 0) {
                return this.emptyResult(
                    'all vidsync servers returned no sources'
                );
            }

            const diagnostics: ProviderResult['diagnostics'] = [];
            if (failCount > 0) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    message: `${failCount} of ${servers.length} vidsync servers failed`,
                    field: '',
                    severity: 'warning'
                });
            }

            return {
                sources: dedupedSources,
                subtitles: dedupedSubs,
                diagnostics
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'unknown error'
            );
        }
    }

    private async getServerList(): Promise<string[]> {
        try {
            const res = await fetch(`${this.BASE_URL}/api/stream/serverList`, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(this.TIMEOUT_MS)
            });
            if (res.ok) {
                const json = (await res.json()) as unknown;
                const list = Array.isArray(json)
                    ? json
                    : Array.isArray((json as { servers?: unknown })?.servers)
                      ? (json as { servers: unknown[] }).servers
                      : [];
                const names = list.filter(
                    (s): s is string => typeof s === 'string'
                );
                if (names.length > 0) return names;
            }
        } catch {
            // fall through
        }
        return this.DEFAULT_SERVERS;
    }

    private async fetchServer(
        media: ProviderMediaObject,
        server: string,
        token: string
    ): Promise<{ sources: Source[]; subtitles: Subtitle[] } | null> {
        const url = this.buildFetchUrl(media, server);
        const res = await fetch(url, {
            headers: { ...this.HEADERS, 'X-CF-Turnstile': token },
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const encrypted = await res.text();
        if (!encrypted) return null;

        if (encrypted.trimStart().startsWith('{')) {
            try {
                const err = JSON.parse(encrypted) as { error?: string };
                if (err.error) return null;
            } catch {
                // try decrypt
            }
        }

        const mediaId = Number(media.tmdbId);
        if (!Number.isFinite(mediaId)) return null;

        let plain: string;
        try {
            const bro: BroWasm = await createBroWasm();
            plain = bro.decrypt(encrypted, mediaId);
        } catch {
            return null;
        }

        let decrypted: VidsyncDecryptedStream;
        try {
            decrypted = JSON.parse(plain) as VidsyncDecryptedStream;
        } catch {
            return null;
        }

        return this.normalizeStream(decrypted, server);
    }

    private buildFetchUrl(media: ProviderMediaObject, server: string): string {
        const params = new URLSearchParams({
            type: media.type,
            title: media.title,
            mediaId: String(media.tmdbId),
            serverName: server
        });
        if (media.releaseYear) {
            params.set('releaseYear', String(media.releaseYear));
        }
        if (media.type === 'tv') {
            params.set('season', String(media.s ?? 1));
            params.set('episode', String(media.e ?? 1));
        }
        return `${this.BASE_URL}/api/stream/fetch?${params.toString()}`;
    }

    private normalizeStream(
        stream: VidsyncDecryptedStream,
        server: string
    ): {
        sources: Source[];
        subtitles: Subtitle[];
    } {
        const sources: Source[] = [];
        const subtitles: Subtitle[] = [];
        const serverQuality = this.serverQuality(server);

        const pushSource = (
            rawUrl?: string,
            typeHint?: string,
            quality?: string
        ) => {
            if (!rawUrl) return;
            sources.push({
                url: this.createProxyUrl(rawUrl, this.HEADERS),
                type: this.detectType(rawUrl, typeHint),
                quality: quality || serverQuality,
                audioTracks: [],
                provider: { id: this.id, name: this.name }
            });
        };

        pushSource(
            stream.url ?? stream.file,
            stream.type ?? stream.streamType,
            stream.quality ?? serverQuality
        );

        if (Array.isArray(stream.sources)) {
            for (const s of stream.sources) {
                pushSource(
                    s.url ?? s.file,
                    s.type ?? s.streamType,
                    s.quality ?? s.label
                );
            }
        }

        if (stream.qualities && typeof stream.qualities === 'object') {
            for (const [quality, entry] of Object.entries(stream.qualities)) {
                pushSource(entry?.url ?? entry?.file, entry?.type, quality);
            }
        }

        for (const list of [
            stream.tracks,
            stream.subtitles,
            stream.captions
        ] as Array<VidsyncTrack[] | undefined>) {
            if (!Array.isArray(list)) continue;
            for (const track of list) {
                const url = track.url ?? track.file;
                if (!url) continue;
                const kind = (track.kind ?? track.type ?? '').toLowerCase();
                if (
                    kind.includes('thumb') ||
                    kind === 'video' ||
                    kind === 'audio'
                ) {
                    continue;
                }
                subtitles.push({
                    url: this.createProxyUrl(url, this.HEADERS),
                    label:
                        track.label ??
                        track.language ??
                        track.lang ??
                        'Unknown',
                    format: this.detectSubtitleFormat(url, track.type)
                });
            }
        }

        return { sources, subtitles };
    }

    private serverQuality(server: string): string {
        const s = server.toLowerCase();
        if (s.includes('4k') || s.includes('2160')) return '4K';
        if (s.includes('1080')) return '1080p';
        if (s.includes('720')) return '720p';
        return server;
    }

    private detectType(url: string, hint?: string): 'hls' | 'mp4' | 'dash' {
        const haystack = `${hint ?? ''} ${url}`.toLowerCase();
        if (haystack.includes('.mpd') || haystack.includes('dash'))
            return 'dash';
        if (haystack.includes('m3u8') || haystack.includes('hls')) return 'hls';
        return 'mp4';
    }

    private detectSubtitleFormat(
        url: string,
        hint?: string
    ): 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' {
        const haystack = `${hint ?? ''} ${url}`.toLowerCase();
        if (haystack.includes('srt')) return 'srt';
        if (haystack.includes('ssa')) return 'ssa';
        if (haystack.includes('ass')) return 'ass';
        if (haystack.includes('ttml')) return 'ttml';
        return 'vtt';
    }

    private dedupeSources(sources: Source[]): Source[] {
        const seen = new Set<string>();
        const out: Source[] = [];
        for (const s of sources) {
            if (seen.has(s.url)) continue;
            seen.add(s.url);
            out.push(s);
        }
        return out;
    }

    private dedupeSubtitles(subtitles: Subtitle[]): Subtitle[] {
        const seen = new Set<string>();
        const out: Subtitle[] = [];
        for (const sub of subtitles) {
            const key = `${sub.label}:${sub.url}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(sub);
        }
        return out;
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
            const res = await fetch(`${this.BASE_URL}/api/stream/serverList`, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(this.TIMEOUT_MS)
            });
            return res.ok;
        } catch {
            return false;
        }
    }
}
