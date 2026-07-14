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
    VidfastDecryptedStream,
    VidfastHandshake,
    VidfastServer,
    VidfastTrack
} from './vidfast.types.js';

/**
 * VidFast (vidfast.vc)
 *
 * VidFast never ships plaintext stream urls in the page. The public flow,
 * mirrored from the enc-dec.app `vidfast` sample, is a multi-step handshake:
 *
 *   1. GET the player page (/movie/<tmdb> or /tv/<tmdb>/<s>/<e>) and scrape the
 *      escaped `\"en\":\"<token>\"` blob out of the HTML.
 *   2. GET enc-dec.app/api/enc-vidfast?text=<token> -> { servers, stream, token }.
 *   3. Send `token` as the X-CSRF-Token header, POST the `servers` url to get an
 *      encrypted server list, then POST enc-dec.app/api/dec-vidfast to decrypt
 *      it into [{ data, ... }].
 *   4. For each server, POST `${stream}/${data}` (still with X-CSRF-Token) to get
 *      the encrypted stream blob, then dec-vidfast it into the playable payload.
 *
 * enc-dec.app performs the closed-source crypto server-side; we only orchestrate
 * the handshake and normalize the final payload.
 */
export class VidfastProvider extends BaseProvider {
    readonly id = 'vidfast';
    readonly name = 'VidFast';

    /*
     * STATUS (2026-07-09): TEMPORARILY DISABLED.
     * Live tracing showed the enc-dec.app `enc-vidfast` handshake is currently
     * stale: it returns an empty `token` ("") plus `servers`/`stream` URLs that
     * 404 on vidfast.vc ("Route not found"), while reporting `info: "no update"`.
     * vidfast.vc changed its route scheme (it is now a Next.js/RSC app) and
     * enc-dec.app has not caught up, so there is no client-side fix here.
     *
     * The handshake below is correct per the documented flow and already fails
     * gracefully today (returns a PROVIDER_ERROR diagnostic, never throws).
     * Re-enable by flipping this to `true` once vidfast_trace.py / vidfast_diag.py
     * shows the `servers` request returning ciphertext instead of a 404.
     */
    readonly enabled = false;
    readonly BASE_URL = 'https://vidfast.vc';
    readonly API_BASE = 'https://enc-dec.app/api';
    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Referer: 'https://vidfast.vc/',
        Origin: 'https://vidfast.vc',
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
                return this.emptyResult('enc-vidfast handshake incomplete');
            }

            // 3. decrypt the server list
            const servers = await this.getServers(handshake);
            if (servers.length === 0) {
                return this.emptyResult('no vidfast servers returned');
            }

            this.console.log(`vidfast: resolving ${servers.length} server(s)`);

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
                    'all vidfast servers returned no sources'
                );
            }

            const diagnostics: ProviderResult['diagnostics'] = [];
            if (failCount > 0) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    message: `${failCount} of ${servers.length} vidfast servers failed`,
                    field: '',
                    severity: 'warning'
                });
            }

            this.console.log(
                `vidfast: ${dedupedSources.length} source(s), ${dedupedSubs.length} subtitle(s)`
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

    // 2. GET enc-vidfast -> { servers, stream, token }.
    private async getHandshake(
        pageToken: string
    ): Promise<VidfastHandshake | null> {
        const url = `${this.API_BASE}/enc-vidfast?text=${encodeURIComponent(pageToken)}`;
        const res = await fetch(url, {
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const json = (await res.json()) as EncDecEnvelope<VidfastHandshake>;
        if (json.status !== 200 || !json.result) return null;
        return json.result;
    }

    // 3. POST the servers url (csrf-protected) then dec-vidfast the response.
    private async getServers(
        handshake: VidfastHandshake
    ): Promise<VidfastServer[]> {
        const encrypted = await this.csrfPostText(
            handshake.servers,
            handshake.token
        );
        if (!encrypted) return [];

        const decrypted = await this.decVidfast<unknown>(encrypted);

        // the servers payload is normally an array; be defensive about wrappers.
        const list = Array.isArray(decrypted)
            ? decrypted
            : Array.isArray((decrypted as { servers?: unknown })?.servers)
              ? (decrypted as { servers: unknown[] }).servers
              : [];

        return list.filter(
            (s): s is VidfastServer =>
                !!s &&
                typeof s === 'object' &&
                typeof (s as VidfastServer).data === 'string'
        );
    }

    // 4. POST `${stream}/${data}` (csrf-protected) then dec-vidfast -> normalize.
    private async fetchServerStream(
        handshake: VidfastHandshake,
        server: VidfastServer
    ): Promise<{ sources: Source[]; subtitles: Subtitle[] } | null> {
        const streamUrl = `${handshake.stream}/${server.data}`;
        const encrypted = await this.csrfPostText(streamUrl, handshake.token);
        if (!encrypted) return null;

        const decrypted =
            await this.decVidfast<VidfastDecryptedStream>(encrypted);
        if (!decrypted) return null;

        return this.normalizeStream(decrypted);
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

    // POST enc-dec.app/api/dec-vidfast and unwrap the result envelope.
    private async decVidfast<T>(encrypted: string): Promise<T | null> {
        const res = await fetch(`${this.API_BASE}/dec-vidfast`, {
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
    // several shapes documented in vidfast.types.ts.
    private normalizeStream(stream: VidfastDecryptedStream): {
        sources: Source[];
        subtitles: Subtitle[];
    } {
        const sources: Source[] = [];
        const subtitles: Subtitle[] = [];

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
        pushSource(stream.url ?? stream.file, stream.type, stream.quality);

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
        const trackLists: Array<VidfastTrack[] | undefined> = [
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

    private detectType(url: string, hint?: string): 'hls' | 'mp4' {
        const haystack = `${hint ?? ''} ${url}`.toLowerCase();
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
