import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import type {
    EncDecEnvelope,
    VidsyncDecryptedStream,
    VidsyncTrack,
    VidsyncTurnstile
} from './vidsync.types.js';

/**
 * VidSync (vidsync.xyz)
 *
 * Unlike vidfast/vidcore, vidsync does not hand back site urls to POST to.
 * enc-dec.app instead solves the Cloudflare Turnstile challenge for us and the
 * player queries vidsync directly. Flow (mirrored from the enc-dec.app
 * `vidsync` sample):
 *
 *   1. GET enc-dec.app/api/enc-vidsync -> { token } (a Cloudflare Turnstile
 *      token, valid briefly and effectively single-use).
 *   2. Send it as the X-Cf-Turnstile header and GET
 *      vidsync.xyz/api/stream/fetch?type=&title=&releaseYear=&mediaId=<tmdb>
 *      &serverName=<server>[&season=&episode=] -> encrypted text.
 *   3. POST enc-dec.app/api/dec-vidsync { text, id:<tmdb> } -> decrypted stream.
 *
 * vidsync exposes several servers (see /api/stream/serverList). We fetch that
 * list (falling back to a known set) and fan out across them, requesting a
 * fresh Turnstile token per server because the token is single-use.
 *
 * STATUS (2026-07-09): built against the enc-dec.app `vidsync` sample and
 * exercised end to end with vidsync_trace.py. vidsync.xyz itself is live (the
 * serverList endpoint returns 200 with the current servers), but enc-dec.app's
 * token endpoint currently 500s on every request:
 *     GET /api/enc-vidsync ->
 *     { status: 500, error: "Generation failure: InitTabs2 must be called
 *       before generating a token" }
 * That is a server-side fault in enc-dec.app's Turnstile solver (its solver
 * tabs are not initialised) - NOT a bug in this provider or in vidsync.xyz.
 * Because we fail cleanly at the token step (no token -> no requests -> empty
 * result, never a broken stream), this provider is left ENABLED so it recovers
 * automatically the moment enc-dec.app fixes its token service. Re-run
 * vidsync_trace.py to check: a 200 with a token means it is working again.
 */
export class VidsyncProvider extends BaseProvider {
    readonly id = 'vidsync';
    readonly name = 'VidSync';
    readonly enabled = true;
    readonly BASE_URL = 'https://vidsync.xyz';
    readonly API_BASE = 'https://enc-dec.app/api';
    readonly HEADERS: Record<string, string> = {
        Accept: '*/*',
        Origin: 'https://vidsync.xyz',
        Referer: 'https://vidsync.xyz/',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest'
    };

    // fallback if /api/stream/serverList is unreachable.
    private readonly DEFAULT_SERVERS = [
        'cinevault',
        'cinedub',
        'cinebox',
        'cineflix',
        'cinevip',
        'cinecloud',
        'cine4k'
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
        try {
            if (!media.title) {
                return this.emptyResult('missing title (required by vidsync)');
            }

            const servers = await this.getServerList();
            if (servers.length === 0) {
                return this.emptyResult('no vidsync servers available');
            }

            // Fast-fail probe: enc-dec.app mints the Cloudflare Turnstile token
            // for us, and when that service is unhealthy every request 500s
            // (see the STATUS note above). Probe once so we return a single
            // clear diagnostic instead of hammering enc-vidsync per server.
            const probeToken = await this.getTurnstileToken();
            if (!probeToken) {
                return this.emptyResult(
                    'enc-dec.app could not mint a Turnstile token ' +
                        '(enc-vidsync unavailable)'
                );
            }

            this.console.log(
                `vidsync: querying ${servers.length} server(s) for "${media.title}"`
            );

            // fan out across servers; the probe token is reused for the first
            // server (so it isn't wasted) and the rest mint their own fresh
            // single-use token.
            const settled = await Promise.allSettled(
                servers.map((server, i) =>
                    this.fetchServer(
                        media,
                        server,
                        i === 0 ? probeToken : undefined
                    )
                )
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

            this.console.log(
                `vidsync: ${dedupedSources.length} source(s), ${dedupedSubs.length} subtitle(s)`
            );

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

    // fetches the live server list, falling back to the known defaults.
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
            // ignore and fall back
        }
        return this.DEFAULT_SERVERS;
    }

    // 1-3: turnstile token -> vidsync fetch -> dec-vidsync -> normalize.
    private async fetchServer(
        media: ProviderMediaObject,
        server: string,
        presetToken?: string
    ): Promise<{ sources: Source[]; subtitles: Subtitle[] } | null> {
        // reuse the probe token for the first server so it isn't wasted; every
        // other server mints its own fresh single-use token.
        const token = presetToken ?? (await this.getTurnstileToken());
        if (!token) return null;

        const url = this.buildFetchUrl(media, server);
        const res = await fetch(url, {
            headers: { ...this.HEADERS, 'X-Cf-Turnstile': token },
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const encrypted = await res.text();
        if (!encrypted) return null;

        const decrypted = await this.decVidsync(encrypted, media.tmdbId);
        if (!decrypted) return null;

        return this.normalizeStream(decrypted, server);
    }

    // GET enc-vidsync -> a fresh (single-use) Cloudflare Turnstile token.
    private async getTurnstileToken(): Promise<string | null> {
        const res = await fetch(`${this.API_BASE}/enc-vidsync`, {
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const json = (await res.json()) as EncDecEnvelope<VidsyncTurnstile>;
        if (json.status !== 200 || !json.result?.token) return null;
        return json.result.token;
    }

    // builds vidsync.xyz/api/stream/fetch with the sample's query contract.
    // URLSearchParams encodes spaces as '+', matching the sample's quote_plus.
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

    // POST enc-dec.app/api/dec-vidsync { text, id } and unwrap the envelope.
    private async decVidsync(
        encrypted: string,
        tmdbId: number | string
    ): Promise<VidsyncDecryptedStream | null> {
        const res = await fetch(`${this.API_BASE}/dec-vidsync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: encrypted, id: String(tmdbId) }),
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const json =
            (await res.json()) as EncDecEnvelope<VidsyncDecryptedStream>;
        if (json.status !== 200) return null;
        return json.result ?? null;
    }

    // maps a decrypted stream payload into Source[] / Subtitle[]. Handles the
    // single-url, sources-array and qualities-map variants.
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

        // single playable url
        pushSource(
            stream.url ?? stream.file,
            stream.type,
            stream.quality ?? serverQuality
        );

        // explicit sources array
        if (Array.isArray(stream.sources)) {
            for (const s of stream.sources) {
                pushSource(s.url ?? s.file, s.type, s.quality ?? s.label);
            }
        }

        // qualities map keyed by resolution
        if (stream.qualities && typeof stream.qualities === 'object') {
            for (const [quality, entry] of Object.entries(stream.qualities)) {
                pushSource(entry?.url ?? entry?.file, entry?.type, quality);
            }
        }

        // subtitles can live under any of these keys
        const trackLists: Array<VidsyncTrack[] | undefined> = [
            stream.tracks,
            stream.subtitles,
            stream.captions
        ];
        for (const list of trackLists) {
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

    // vidsync server names hint at quality (e.g. "cine4k"); use them so the
    // multiple servers stay distinguishable instead of collapsing to "Auto".
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
            const res = await fetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS,
                signal: AbortSignal.timeout(this.TIMEOUT_MS)
            });
            return res.status < 500;
        } catch {
            return false;
        }
    }
}
