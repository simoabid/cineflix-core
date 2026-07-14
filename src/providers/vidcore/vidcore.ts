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
    VidcoreDecryptedStream,
    VidcoreHandshake,
    VidcoreServer,
    VidcoreTrack
} from './vidcore.types.js';

/**
 * VidCore (vidcore.net)
 *
 * VidCore uses the exact same enc-dec.app handshake as VidFast, only with the
 * `vidcore` host and `enc-vidcore` / `dec-vidcore` endpoints. The flow, mirrored
 * from the enc-dec.app `vidcore` sample, is:
 *
 *   1. GET the player page (/movie/<tmdb> or /tv/<tmdb>/<s>/<e>) and scrape the
 *      escaped `\"en\":\"<token>\"` blob out of the HTML.
 *   2. GET enc-dec.app/api/enc-vidcore?text=<token> -> { servers, stream, token }.
 *   3. Send `token` as the X-CSRF-Token header, POST the `servers` url to get an
 *      encrypted server list, then POST enc-dec.app/api/dec-vidcore to decrypt
 *      it into [{ data, ... }].
 *   4. For each server, POST `${stream}/${data}` (still with X-CSRF-Token) to get
 *      the encrypted stream blob, then dec-vidcore it into the playable payload.
 *
 * enc-dec.app performs the closed-source crypto server-side; we only orchestrate
 * the handshake and normalize the final payload.
 *
 * NOTE: this provider shares the mechanism that is currently stale for VidFast
 * (enc-dec.app handing back 404-ing site urls). It is shipped enabled so it can
 * be verified live; if vidcore_trace.py shows the `servers` request 404-ing with
 * an empty token, disable it the same way VidFast was disabled.
 */
export class VidcoreProvider extends BaseProvider {
    readonly id = 'vidcore';
    readonly name = 'VidCore';
    readonly enabled = true;
    readonly BASE_URL = 'https://vidcore.net';
    readonly API_BASE = 'https://enc-dec.app/api';
    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Referer: 'https://vidcore.net/',
        Origin: 'https://vidcore.net',
        'X-Requested-With': 'XMLHttpRequest'
    };

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
            // 1. scrape the page token
            const pageToken = await this.fetchPageToken(media);
            if (!pageToken) {
                return this.emptyResult('could not extract page token');
            }

            // 2. exchange it for the servers/stream urls + csrf token
            const handshake = await this.getHandshake(pageToken);
            if (
                !handshake?.servers ||
                !handshake?.stream ||
                !handshake?.token
            ) {
                return this.emptyResult('enc-vidcore handshake incomplete');
            }

            // 3. decrypt the server list
            const servers = await this.getServers(handshake);
            if (servers.length === 0) {
                return this.emptyResult('no vidcore servers returned');
            }

            this.console.log(`vidcore: resolving ${servers.length} server(s)`);

            // 4. fan out across servers, decrypt each stream, merge
            const settled = await Promise.allSettled(
                servers.map((server) =>
                    this.fetchServerStream(handshake, server)
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
                    'all vidcore servers returned no sources'
                );
            }

            const diagnostics: ProviderResult['diagnostics'] = [];
            if (failCount > 0) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    message: `${failCount} of ${servers.length} vidcore servers failed`,
                    field: '',
                    severity: 'warning'
                });
            }

            this.console.log(
                `vidcore: ${dedupedSources.length} source(s), ${dedupedSubs.length} subtitle(s)`
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

    // 1. loads the player page and scrapes the escaped `\"en\":\"...\"` token.
    private async fetchPageToken(
        media: ProviderMediaObject
    ): Promise<string | null> {
        const pageUrl =
            media.type === 'movie'
                ? `${this.BASE_URL}/movie/${media.tmdbId}`
                : `${this.BASE_URL}/tv/${media.tmdbId}/${media.s ?? 1}/${media.e ?? 1}/`;

        const res = await fetch(pageUrl, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const html = await res.text();

        // the token is embedded as escaped json in the html: \"en\":\"<token>\"
        const match = html.match(/\\"en\\":\\"(.*?)\\"/);
        return match?.[1] ?? null;
    }

    // 2. GET enc-vidcore -> { servers, stream, token }.
    private async getHandshake(
        pageToken: string
    ): Promise<VidcoreHandshake | null> {
        const url = `${this.API_BASE}/enc-vidcore?text=${encodeURIComponent(pageToken)}`;
        const res = await fetch(url, {
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const json = (await res.json()) as EncDecEnvelope<VidcoreHandshake>;
        if (json.status !== 200 || !json.result) return null;
        return json.result;
    }

    // 3. POST the servers url (csrf-protected) then dec-vidcore the response.
    private async getServers(
        handshake: VidcoreHandshake
    ): Promise<VidcoreServer[]> {
        const encrypted = await this.csrfPostText(
            handshake.servers,
            handshake.token
        );
        if (!encrypted) return [];

        const decrypted = await this.decVidcore<unknown>(encrypted);

        // the servers payload is normally an array; be defensive about wrappers.
        const list = Array.isArray(decrypted)
            ? decrypted
            : Array.isArray((decrypted as { servers?: unknown })?.servers)
              ? (decrypted as { servers: unknown[] }).servers
              : [];

        return list.filter(
            (s): s is VidcoreServer =>
                !!s &&
                typeof s === 'object' &&
                typeof (s as VidcoreServer).data === 'string'
        );
    }

    // 4. POST `${stream}/${data}` (csrf-protected) then dec-vidcore -> normalize.
    private async fetchServerStream(
        handshake: VidcoreHandshake,
        server: VidcoreServer
    ): Promise<{ sources: Source[]; subtitles: Subtitle[] } | null> {
        const streamUrl = `${handshake.stream}/${server.data}`;
        const encrypted = await this.csrfPostText(streamUrl, handshake.token);
        if (!encrypted) return null;

        const decrypted =
            await this.decVidcore<VidcoreDecryptedStream>(encrypted);
        if (!decrypted) return null;

        return this.normalizeStream(decrypted, server);
    }

    // POST helper that attaches the X-CSRF-Token header and returns the raw
    // (still-encrypted) text body.
    private async csrfPostText(
        url: string,
        token: string
    ): Promise<string | null> {
        const res = await fetch(url, {
            method: 'POST',
            headers: { ...this.HEADERS, 'X-CSRF-Token': token },
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;
        const text = await res.text();
        return text && text.length > 0 ? text : null;
    }

    // POST enc-dec.app/api/dec-vidcore and unwrap the result envelope.
    private async decVidcore<T>(encrypted: string): Promise<T | null> {
        const res = await fetch(`${this.API_BASE}/dec-vidcore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: encrypted }),
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const json = (await res.json()) as EncDecEnvelope<T>;
        if (json.status !== 200) return null;
        return json.result ?? null;
    }

    // maps a decrypted stream payload into Source[] / Subtitle[]. Handles the
    // several shapes documented in vidcore.types.ts.
    private normalizeStream(
        stream: VidcoreDecryptedStream,
        server: VidcoreServer
    ): {
        sources: Source[];
        subtitles: Subtitle[];
    } {
        const sources: Source[] = [];
        const subtitles: Subtitle[] = [];

        // vidcore returns one adaptive manifest (hls .m3u8 or dash .mpd) per
        // server with no explicit resolution, so we label the source using the
        // server's own name/description (e.g. "Premiere 4K") to keep the
        // servers distinguishable in the results.
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
                quality: quality || 'Auto',
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
        const trackLists: Array<VidcoreTrack[] | undefined> = [
            stream.tracks,
            stream.subtitles,
            stream.captions
        ];
        for (const list of trackLists) {
            if (!Array.isArray(list)) continue;
            for (const track of list) {
                const url = track.url ?? track.file;
                if (!url) continue;
                // skip non-caption tracks (thumbnails, video, audio)
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

    // vidcore servers carry a display name + description (e.g. "Premiere 4K",
    // "Original audio, 4K"). Derive a quality label from them, falling back to
    // the server name so distinct servers don't collapse into one "Auto" entry.
    private serverQuality(server: VidcoreServer): string {
        const haystack =
            `${server.name ?? ''} ${server.description ?? ''}`.toLowerCase();
        if (haystack.includes('4k') || haystack.includes('2160')) return '4K';
        if (haystack.includes('1080')) return '1080p';
        if (haystack.includes('720')) return '720p';
        return server.name ?? 'Auto';
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
