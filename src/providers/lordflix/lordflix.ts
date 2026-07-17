import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import { createHash } from 'crypto';
import type {
    EncDecEnvelope,
    LordflixChallenge,
    LordflixDecryptedStream,
    LordflixEncResult,
    LordflixServer,
    LordflixTrack
} from './lordflix.types.js';

/**
 * LordFlix (lordflix.org, api host snowhouse.lordflix.club)
 *
 * Every request is gated behind an ALTCHA-style hashcash proof-of-work, and
 * the stream url itself is signed by enc-dec.app. Flow (mirrored from the
 * enc-dec.app `lordflix` sample):
 *
 *   1. GET snowhouse.lordflix.club/servers -> { servers: [{ name }] }.
 *   2. For each server, build the media url
 *      snowhouse.lordflix.club/?title=&type=movie|series&year=&imdb=&tmdb=
 *      &server=[&season=&episode=] and GET
 *      enc-dec.app/api/enc-lordflix?url=<encoded> -> { url } (a signed url).
 *   3. Solve the hashcash challenge: GET snowhouse.lordflix.club/challenge ->
 *      { algorithm, challenge, salt, signature, maxnumber }; find the integer
 *      n in [0, maxnumber] with sha256(salt + n) hex == challenge; base64 the
 *      echoed payload and send it as the x-attest header.
 *   4. GET the signed url with x-attest -> encrypted text.
 *   5. POST enc-dec.app/api/dec-lordflix { text } -> decrypted stream.
 *
 * The attestation is treated as single-use (like the sibling vidsync Turnstile
 * token), so we mint a fresh one per server and fan out across the server list.
 *
 * STATUS (2026-07-09): built against the enc-dec.app `lordflix` sample and
 * CONFIRMED WORKING end to end via lordflix_trace.py - both movie and tv
 * resolved with a 200 through every stage (servers -> enc-lordflix -> hashcash
 * -> fetch -> dec-lordflix). The decrypted payload shape is
 *     { stream: [{ id, type: "hls", playlist: "<manifest url>", captions: [] }] }
 * with playlists served from ok.horseapples.cc; the normalizer reads that
 * shape (plus tolerant fallbacks for other variants). Servers observed:
 * Solstice, Vienna, Lion, Phoenix, Sakura, Luna, Flower, Rio, Moscow. Enabled.
 */
export class LordflixProvider extends BaseProvider {
    readonly id = 'lordflix';
    readonly name = 'LordFlix';
    // Disabled 2026-07: snowhouse.lordflix.club + lordflix.org both NXDOMAIN;
    // enc-dec.app enc-lordflix returns 500 ("Missing required values"). Host is gone.
    readonly enabled = false;
    readonly BASE_URL = 'https://snowhouse.lordflix.club';
    readonly SITE_URL = 'https://lordflix.org';
    readonly API_BASE = 'https://enc-dec.app/api';
    readonly HEADERS: Record<string, string> = {
        Accept: '*/*',
        Origin: 'https://lordflix.org',
        Referer: 'https://lordflix.org/',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
    };

    private readonly TIMEOUT_MS = 15000;
    // safety cap for the hashcash search; real challenges expose maxnumber
    // (observed 100000), this only guards against a malformed/huge value.
    private readonly MAX_POW_ITERATIONS = 5_000_000;

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
                return this.emptyResult('missing title (required by lordflix)');
            }

            const servers = await this.getServerList();
            if (servers.length === 0) {
                return this.emptyResult(
                    'no lordflix servers available ' +
                        '(snowhouse.lordflix.club unreachable)'
                );
            }

            // Fast-fail probe: every request needs a solved x-attest hashcash
            // token minted from snowhouse.lordflix.club/challenge. If that
            // endpoint is down we cannot attest anything, so probe once and
            // return a single clear diagnostic instead of failing per server.
            const probeAttest = await this.solveAttestation();
            if (!probeAttest) {
                return this.emptyResult(
                    'could not obtain/solve the lordflix attestation ' +
                        'challenge (snowhouse.lordflix.club unavailable)'
                );
            }

            this.console.log(
                `lordflix: querying ${servers.length} server(s) for "${media.title}"`
            );

            // fan out across servers; reuse the probe attestation for the first
            // server (so it isn't wasted) and mint a fresh single-use one for
            // each remaining server.
            const settled = await Promise.allSettled(
                servers.map((server, i) =>
                    this.fetchServer(
                        media,
                        server,
                        i === 0 ? probeAttest : undefined
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
                    'all lordflix servers returned no sources'
                );
            }

            const diagnostics: ProviderResult['diagnostics'] = [];
            if (failCount > 0) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    message: `${failCount} of ${servers.length} lordflix servers failed`,
                    field: '',
                    severity: 'warning'
                });
            }

            this.console.log(
                `lordflix: ${dedupedSources.length} source(s), ${dedupedSubs.length} subtitle(s)`
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

    // GET snowhouse.lordflix.club/servers -> list of server names.
    private async getServerList(): Promise<string[]> {
        try {
            const res = await fetch(`${this.BASE_URL}/servers`, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(this.TIMEOUT_MS)
            });
            if (!res.ok) return [];

            const json = (await res.json()) as
                { servers?: LordflixServer[] } | LordflixServer[];
            const list = Array.isArray(json)
                ? json
                : Array.isArray(json?.servers)
                  ? json.servers
                  : [];
            return list
                .map((s) => s?.name)
                .filter(
                    (n): n is string => typeof n === 'string' && n.length > 0
                );
        } catch {
            return [];
        }
    }

    // 2-5: sign the media url -> attest -> fetch encrypted -> dec -> normalize.
    private async fetchServer(
        media: ProviderMediaObject,
        server: string,
        presetAttest?: string
    ): Promise<{ sources: Source[]; subtitles: Subtitle[] } | null> {
        const signedUrl = await this.getSignedUrl(media, server);
        if (!signedUrl) return null;

        // reuse the probe attestation for the first server so it isn't wasted;
        // every other server mints its own fresh single-use attestation.
        const attest = presetAttest ?? (await this.solveAttestation());
        if (!attest) return null;

        const res = await fetch(signedUrl, {
            headers: { ...this.HEADERS, 'x-attest': attest },
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const encrypted = await res.text();
        if (!encrypted) return null;

        const decrypted = await this.decLordflix(encrypted);
        if (!decrypted) return null;

        return this.normalizeStream(decrypted, server);
    }

    // GET enc-dec.app/api/enc-lordflix?url=<media url> -> signed snowhouse url.
    private async getSignedUrl(
        media: ProviderMediaObject,
        server: string
    ): Promise<string | null> {
        const mediaUrl = this.buildMediaUrl(media, server);
        const res = await fetch(
            `${this.API_BASE}/enc-lordflix?url=${encodeURIComponent(mediaUrl)}`,
            { signal: AbortSignal.timeout(this.TIMEOUT_MS) }
        );
        if (!res.ok) return null;

        const json = (await res.json()) as EncDecEnvelope<LordflixEncResult>;
        if (json.status !== 200 || !json.result?.url) return null;
        return json.result.url;
    }

    // builds the snowhouse media url. Spaces are encoded as %20 (encodeURI-
    // Component), matching the sample's urllib.parse.quote.
    private buildMediaUrl(media: ProviderMediaObject, server: string): string {
        const parts = [
            `title=${encodeURIComponent(media.title)}`,
            `type=${media.type === 'tv' ? 'series' : 'movie'}`
        ];
        if (media.releaseYear) {
            parts.push(`year=${encodeURIComponent(String(media.releaseYear))}`);
        }
        parts.push(`imdb=${encodeURIComponent(media.imdbId ?? '')}`);
        parts.push(`tmdb=${encodeURIComponent(String(media.tmdbId))}`);
        parts.push(`server=${encodeURIComponent(server)}`);
        if (media.type === 'tv') {
            parts.push(`season=${encodeURIComponent(String(media.s ?? 1))}`);
            parts.push(`episode=${encodeURIComponent(String(media.e ?? 1))}`);
        }
        return `${this.BASE_URL}/?${parts.join('&')}`;
    }

    // GET /challenge, solve the hashcash, and return the base64 x-attest value.
    private async solveAttestation(): Promise<string | null> {
        try {
            const res = await fetch(`${this.BASE_URL}/challenge`, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(this.TIMEOUT_MS)
            });
            if (!res.ok) return null;

            const challenge = (await res.json()) as LordflixChallenge;
            const number = this.solvePow(challenge);
            if (number === null) return null;

            // echo the challenge fields back with the solved number, matching
            // the sample's payload order.
            const payload = {
                algorithm: challenge.algorithm,
                challenge: challenge.challenge,
                number,
                salt: challenge.salt,
                signature: challenge.signature
            };
            return Buffer.from(JSON.stringify(payload), 'utf8').toString(
                'base64'
            );
        } catch {
            return null;
        }
    }

    // hashcash: find n in [0, maxnumber] with sha256(salt + n) hex == challenge.
    private solvePow(challenge: LordflixChallenge): number | null {
        const max =
            typeof challenge.maxnumber === 'number' && challenge.maxnumber >= 0
                ? challenge.maxnumber
                : this.MAX_POW_ITERATIONS;
        const limit = Math.min(max, this.MAX_POW_ITERATIONS);
        for (let n = 0; n <= limit; n++) {
            const digest = createHash('sha256')
                .update(`${challenge.salt}${n}`)
                .digest('hex');
            if (digest === challenge.challenge) return n;
        }
        return null;
    }

    // POST enc-dec.app/api/dec-lordflix { text } and unwrap the envelope.
    private async decLordflix(
        encrypted: string
    ): Promise<LordflixDecryptedStream | null> {
        const res = await fetch(`${this.API_BASE}/dec-lordflix`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: encrypted }),
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const json =
            (await res.json()) as EncDecEnvelope<LordflixDecryptedStream>;
        if (json.status !== 200) return null;
        return json.result ?? null;
    }

    // maps a decrypted stream payload into Source[] / Subtitle[]. The confirmed
    // shape is { stream: [{ type, playlist, captions }] }; the sources-array /
    // qualities-map / single-url variants are tolerated as fallbacks.
    private normalizeStream(
        stream: LordflixDecryptedStream,
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

        const pushSubtitles = (list?: LordflixTrack[]) => {
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

        // confirmed shape: { stream: [{ id, type, playlist, captions }] }.
        if (Array.isArray(stream.stream)) {
            for (const entry of stream.stream) {
                pushSource(
                    entry.playlist ?? entry.url ?? entry.file,
                    entry.type,
                    entry.quality
                );
                pushSubtitles(entry.captions);
                pushSubtitles(entry.subtitles);
                pushSubtitles(entry.tracks);
            }
        }

        // single playable url (fallback variant)
        pushSource(
            stream.url ?? stream.file,
            stream.type,
            stream.quality ?? serverQuality
        );

        // explicit sources array (fallback variant)
        if (Array.isArray(stream.sources)) {
            for (const s of stream.sources) {
                pushSource(s.url ?? s.file, s.type, s.quality ?? s.label);
            }
        }

        // qualities map keyed by resolution (fallback variant)
        if (stream.qualities && typeof stream.qualities === 'object') {
            for (const [quality, entry] of Object.entries(stream.qualities)) {
                pushSource(entry?.url ?? entry?.file, entry?.type, quality);
            }
        }

        // top-level subtitle lists (fallback variants)
        pushSubtitles(stream.tracks);
        pushSubtitles(stream.subtitles);
        pushSubtitles(stream.captions);

        return { sources, subtitles };
    }

    // server names may hint at quality; fall back to the raw name so multiple
    // servers stay distinguishable instead of collapsing to "Auto".
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
            const res = await fetch(`${this.BASE_URL}/servers`, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(this.TIMEOUT_MS)
            });
            return res.status < 500;
        } catch {
            return false;
        }
    }
}
