import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import { randomBytes } from 'crypto';
import type {
    EncDecEnvelope,
    HexaCapToken,
    HexaDecryptedStream,
    HexaTrack
} from './hexa.types.js';

/**
 * Hexa (hexa.su, also serves flixer.su; api host theemoviedb.hexa.su)
 *
 * Unlike cinesrc/lordflix there is no proof-of-work: hexa gates on a random
 * per-request api key plus a capability token that enc-dec.app mints for us.
 * Flow (mirrored from the enc-dec.app `hexa` sample):
 *
 *   1. Generate a random 32-byte hex string; send it as the X-Api-Key header
 *      AND reuse it as the dec-hexa `key` (both must match).
 *   2. GET enc-dec.app/api/enc-hexa -> { token }; send it as X-Cap-Token.
 *   3. GET theemoviedb.hexa.su/api/tmdb/{movie|tv}/{tmdb}[/season/{s}/episode/
 *      {e}]/images  (with the fixed X-Fingerprint-Lite + the two headers
 *      above) -> encrypted text.
 *   4. POST enc-dec.app/api/dec-hexa { text, key } -> decrypted stream.
 *
 * A single request resolves a title (no per-server fan-out), so we fail fast on
 * a missing token / non-200 / empty body and return a clear diagnostic.
 *
 * STATUS (2026-07-09): built against the enc-dec.app `hexa` sample and
 * exercised via hexa_trace.py. This provider's code path is correct, but
 * enc-dec.app has DISABLED the token endpoint: GET /api/enc-hexa returns
 *     { status: 500, error: "Generation failure: disabled" }
 * for every request (both movie and tv), so no X-Cap-Token can be minted and
 * the flow stops before the image fetch/dec. That is a deliberate server-side
 * shutoff on enc-dec.app's side - NOT a bug in this provider or in hexa.su.
 * Because we fail cleanly at the token step (no token -> empty result, never a
 * broken stream), this provider is left ENABLED so it recovers automatically
 * if enc-dec.app re-enables enc-hexa. Re-run hexa_trace.py to check: a 200 with
 * a token means it is working again. (The decrypted shape is still unconfirmed;
 * the normalizer reads the tolerant union of the sibling providers' shapes.)
 */
export class HexaProvider extends BaseProvider {
    readonly id = 'hexa';
    readonly name = 'Hexa';
    readonly enabled = true;
    readonly BASE_URL = 'https://theemoviedb.hexa.su';
    readonly SITE_URL = 'https://hexa.su';
    readonly API_BASE = 'https://enc-dec.app/api';
    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Referer: 'https://hexa.su/',
        Accept: 'text/plain',
        'X-Fingerprint-Lite': 'e9136c41504646444'
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
            // 1. random 32-byte hex, used as BOTH the X-Api-Key header and the
            // dec-hexa key (they must be identical).
            const key = randomBytes(32).toString('hex');

            // 2. capability token minted by enc-dec.app.
            const token = await this.getCapToken();
            if (!token) {
                return this.emptyResult(
                    'enc-dec.app could not mint a hexa cap token ' +
                        '(enc-hexa unavailable)'
                );
            }

            // 3. fetch the encrypted blob.
            const url = this.buildUrl(media);
            const res = await fetch(url, {
                headers: {
                    ...this.HEADERS,
                    'X-Api-Key': key,
                    'X-Cap-Token': token
                },
                signal: AbortSignal.timeout(this.TIMEOUT_MS)
            });
            if (!res.ok) {
                return this.emptyResult(
                    `hexa image endpoint returned ${res.status}`
                );
            }

            const encrypted = await res.text();
            if (!encrypted) {
                return this.emptyResult('hexa returned an empty body');
            }

            // 4. decrypt.
            const decrypted = await this.decHexa(encrypted, key);
            if (!decrypted) {
                return this.emptyResult('dec-hexa failed to decrypt the blob');
            }

            // 5. normalize.
            const { sources, subtitles } = this.normalizeStream(decrypted);
            const dedupedSources = this.dedupeSources(sources);
            const dedupedSubs = this.dedupeSubtitles(subtitles);

            if (dedupedSources.length === 0) {
                return this.emptyResult('hexa returned no playable sources');
            }

            this.console.log(
                `hexa: ${dedupedSources.length} source(s), ${dedupedSubs.length} subtitle(s)`
            );

            return {
                sources: dedupedSources,
                subtitles: dedupedSubs,
                diagnostics: []
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'unknown error'
            );
        }
    }

    // GET enc-dec.app/api/enc-hexa -> capability token.
    private async getCapToken(): Promise<string | null> {
        const res = await fetch(`${this.API_BASE}/enc-hexa`, {
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const json = (await res.json()) as EncDecEnvelope<HexaCapToken>;
        if (json.status !== 200 || !json.result?.token) return null;
        return json.result.token;
    }

    // theemoviedb.hexa.su image endpoint (obfuscated stream source).
    private buildUrl(media: ProviderMediaObject): string {
        if (media.type === 'tv') {
            return (
                `${this.BASE_URL}/api/tmdb/tv/${media.tmdbId}` +
                `/season/${media.s ?? 1}/episode/${media.e ?? 1}/images`
            );
        }
        return `${this.BASE_URL}/api/tmdb/movie/${media.tmdbId}/images`;
    }

    // POST enc-dec.app/api/dec-hexa { text, key } and unwrap the envelope.
    private async decHexa(
        encrypted: string,
        key: string
    ): Promise<HexaDecryptedStream | null> {
        const res = await fetch(`${this.API_BASE}/dec-hexa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: encrypted, key }),
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const json = (await res.json()) as EncDecEnvelope<HexaDecryptedStream>;
        if (json.status !== 200) return null;
        return json.result ?? null;
    }

    // maps a decrypted stream payload into Source[] / Subtitle[]. Tolerates the
    // stream-array, sources-array, qualities-map and single-url variants.
    private normalizeStream(stream: HexaDecryptedStream): {
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

        const pushSubtitles = (list?: HexaTrack[]) => {
            if (!Array.isArray(list)) return;
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
        };

        // stream / sources arrays: [{ type, playlist|url|file, captions }]
        const entryLists = [stream.stream, stream.sources];
        for (const list of entryLists) {
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
                pushSource(
                    entry.playlist ?? entry.url ?? entry.file,
                    entry.type,
                    entry.quality ?? entry.label
                );
                pushSubtitles(entry.captions);
                pushSubtitles(entry.subtitles);
                pushSubtitles(entry.tracks);
            }
        }

        // single playable url (fallback variant)
        pushSource(
            stream.url ?? stream.file ?? stream.playlist,
            stream.type,
            stream.quality
        );

        // qualities map keyed by resolution (fallback variant)
        if (stream.qualities && typeof stream.qualities === 'object') {
            for (const [quality, entry] of Object.entries(stream.qualities)) {
                pushSource(entry?.url ?? entry?.file, entry?.type, quality);
            }
        }

        // top-level subtitle lists
        pushSubtitles(stream.tracks);
        pushSubtitles(stream.subtitles);
        pushSubtitles(stream.captions);

        return { sources, subtitles };
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
            const res = await fetch(this.SITE_URL, {
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
