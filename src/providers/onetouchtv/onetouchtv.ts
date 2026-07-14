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
    OnetouchtvDecrypted,
    OnetouchtvSearchHit,
    OnetouchtvStreamEntry,
    OnetouchtvTrack
} from './onetouchtv.types.js';

/**
 * OneTouchTV (api host api3.devcorp.me) - Asian VOD catalogue.
 *
 * This is the simplest enc-dec flow of the set: no proof-of-work, no token, no
 * key. The catalogue endpoint itself returns an encrypted blob that
 * enc-dec.app decrypts (mirrored from the enc-dec.app `onetouchtv` sample):
 *
 *   1. GET api3.devcorp.me/web/vod/<id>-<slug>/episode/<ep> -> encrypted text.
 *   2. POST enc-dec.app/api/dec-onetouchtv { text } -> decrypted stream json.
 *
 * Like KissKH, OneTouchTV is keyed by its own <id>-<slug>, not tmdb, so we
 * first resolve title -> { id, slug } via the catalogue search, then build the
 * episode url (tv -> media.e, movie -> episode 1).
 *
 * STATUS (2026-07-10): PARKED / DISABLED - enc-dec confirmed, but NOT
 * title-resolvable.
 *
 * Live tracing (onetouchtv_trace.py) proved:
 *   - The enc-dec + content route WORKS: the sample id 150294 returned HTTP
 *     200 with a real HLS playlist + subtitle tracks. Confirmed decrypted
 *     shape: { sources:[{type,contentId,id,name,quality,url}],
 *     track:[{file,kind,name,code,format,sourceFormat,default}] }.
 *   - BUT the leading id is OneTouchTV's OWN internal id, NOT tmdb: all 5 real
 *     tmdb ids tried (Fight Club 550, Dark Knight 155, Interstellar 157336,
 *     Parasite 496243, Squid Game 93405) decrypted to
 *     { success:false, status:'not_found', code:404 }.
 *   - There is NO search / browse route: ~35 endpoint probes all returned
 *     'NotFoundError: This route doesn't exist!'. The only working route is
 *     /web/vod/<internalId>-<slug>/episode/<ep>.
 * => The decryptor works, but with no tmdb->internal-id mapping and no search
 *    route, a title cannot be resolved. Kept DISABLED so it never pollutes
 *    results. Re-enable ONLY if a search route or id-mapping DB appears; the
 *    normalizer below already matches the confirmed payload shape (including
 *    the singular `track` subtitle array).
 */
export class OnetouchtvProvider extends BaseProvider {
    readonly id = 'onetouchtv';
    readonly name = 'OneTouchTV';
    // PARKED: enc-dec confirmed, but not title-resolvable (id != tmdb, no
    // search route). See STATUS above. Flip to true only if a search route or
    // an id-mapping DB is discovered.
    readonly enabled = false;
    readonly BASE_URL = 'https://api3.devcorp.me/web';
    readonly API_BASE = 'https://enc-dec.app/api';
    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*'
    };

    // candidate catalogue search endpoints, tried in order until one returns
    // usable json. The `%s` is the url-encoded query. Inferred from the VOD
    // path shape; onetouchtv_trace.py confirms which (if any) is correct.
    private readonly SEARCH_ENDPOINTS = [
        '/search?keyword=%s',
        '/vod/search?keyword=%s',
        '/search?q=%s',
        '/vod?keyword=%s'
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
                return this.emptyResult(
                    'missing title (required by onetouchtv)'
                );
            }

            const slugPath = await this.resolveContentPath(media);
            if (!slugPath) {
                return this.emptyResult(
                    `no onetouchtv match for "${media.title}"`
                );
            }

            const episode = media.type === 'tv' ? (media.e ?? 1) : 1;
            const contentUrl = `${this.BASE_URL}/vod/${slugPath}/episode/${episode}`;

            const encrypted = await this.fetchEncrypted(contentUrl);
            if (!encrypted) {
                return this.emptyResult(
                    `onetouchtv returned no data for ${slugPath} episode ${episode}`
                );
            }

            const decrypted = await this.decOnetouchtv(encrypted);
            if (!decrypted) {
                return this.emptyResult('dec-onetouchtv failed');
            }

            const { sources, subtitles } = this.normalizeStream(decrypted);
            const dedupedSources = this.dedupeSources(sources);
            const dedupedSubs = this.dedupeSubtitles(subtitles);

            if (dedupedSources.length === 0) {
                return this.emptyResult(
                    'onetouchtv returned no playable sources'
                );
            }

            this.console.log(
                `onetouchtv: ${slugPath} -> ${dedupedSources.length} source(s), ${dedupedSubs.length} subtitle(s)`
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

    // resolve title -> "<id>-<slug>" path segment for the VOD url.
    private async resolveContentPath(
        media: ProviderMediaObject
    ): Promise<string | null> {
        const hits = await this.searchContent(media.title);
        if (hits.length === 0) return null;

        const hit = this.pickHit(hits, media.title);
        if (!hit) return null;

        return this.buildSlugPath(hit);
    }

    // try each candidate endpoint until one yields a usable hit array.
    private async searchContent(title: string): Promise<OnetouchtvSearchHit[]> {
        const q = encodeURIComponent(title);
        for (const template of this.SEARCH_ENDPOINTS) {
            try {
                const url = `${this.BASE_URL}${template.replace('%s', q)}`;
                const res = await fetch(url, {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(this.TIMEOUT_MS)
                });
                if (!res.ok) continue;
                const json = (await res.json()) as unknown;
                const hits = this.extractHits(json);
                if (hits.length > 0) return hits;
            } catch {
                // try the next candidate
            }
        }
        return [];
    }

    // pull an array of hits out of the common envelope shapes.
    private extractHits(json: unknown): OnetouchtvSearchHit[] {
        if (Array.isArray(json)) return json as OnetouchtvSearchHit[];
        if (json && typeof json === 'object') {
            const obj = json as Record<string, unknown>;
            for (const key of ['data', 'results', 'items', 'vod', 'list']) {
                const val = obj[key];
                if (Array.isArray(val)) return val as OnetouchtvSearchHit[];
                // some apis nest as { data: { items: [...] } }
                if (val && typeof val === 'object') {
                    for (const inner of ['items', 'results', 'data']) {
                        const nested = (val as Record<string, unknown>)[inner];
                        if (Array.isArray(nested)) {
                            return nested as OnetouchtvSearchHit[];
                        }
                    }
                }
            }
        }
        return [];
    }

    // prefer an exact (case-insensitive) title match, else a prefix match;
    // never a blind first hit that merely shares a word.
    private pickHit(
        hits: OnetouchtvSearchHit[],
        title: string
    ): OnetouchtvSearchHit | null {
        const norm = (s?: string) => (s ?? '').trim().toLowerCase();
        const t = norm(title);
        const titleOf = (h: OnetouchtvSearchHit) => norm(h.title ?? h.name);

        return (
            hits.find((h) => titleOf(h) === t) ??
            hits.find(
                (h) =>
                    titleOf(h).startsWith(`${t} `) ||
                    titleOf(h).startsWith(`${t}:`) ||
                    titleOf(h) === t
            ) ??
            null
        );
    }

    // build the "<id>-<slug>" path segment from whatever fields a hit exposes.
    private buildSlugPath(hit: OnetouchtvSearchHit): string | null {
        // if a ready-made slug/permalink already carries the id, use it.
        const ready = hit.permalink ?? hit.seoUrl ?? hit.slug;
        if (ready) {
            const cleaned = ready
                .replace(/^https?:\/\/[^/]+/, '')
                .replace(/^\/?(web\/)?vod\//, '')
                .replace(/\/episode\/.*$/, '')
                .replace(/^\/+|\/+$/g, '');
            if (/^\d+-/.test(cleaned)) return cleaned;
            // slug without id: prepend the id if we have one.
            const id = hit.id ?? hit.vodId;
            if (id !== undefined && cleaned) return `${id}-${cleaned}`;
            if (cleaned) return cleaned;
        }

        // otherwise assemble from id + slugified title.
        const id = hit.id ?? hit.vodId;
        const name = hit.title ?? hit.name;
        if (id === undefined || !name) return null;
        const slug = name
            .toLowerCase()
            .replace(/['"]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return `${id}-${slug}`;
    }

    private async fetchEncrypted(url: string): Promise<string | null> {
        const res = await fetch(url, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;
        const text = await res.text();
        return text || null;
    }

    // POST enc-dec.app/api/dec-onetouchtv { text } and unwrap the envelope.
    private async decOnetouchtv(
        encrypted: string
    ): Promise<OnetouchtvDecrypted | null> {
        const res = await fetch(`${this.API_BASE}/dec-onetouchtv`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: encrypted }),
            signal: AbortSignal.timeout(this.TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const json = (await res.json()) as EncDecEnvelope<OnetouchtvDecrypted>;
        if (json.status !== 200) return null;
        return json.result ?? null;
    }

    // maps a decrypted payload into Source[] / Subtitle[]. Tolerates the
    // sources/streams array, single-url and qualities-map variants.
    private normalizeStream(stream: OnetouchtvDecrypted): {
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

        const pushSubtitles = (list?: OnetouchtvTrack[]) => {
            if (!Array.isArray(list)) return;
            for (const track of list) {
                const url = track.url ?? track.file ?? track.src;
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
                        track.name ??
                        track.language ??
                        track.lang ??
                        track.code ??
                        'Unknown',
                    format: this.detectSubtitleFormat(
                        url,
                        track.format ?? track.sourceFormat ?? track.type
                    )
                });
            }
        };

        const pushEntry = (entry: OnetouchtvStreamEntry) => {
            pushSource(
                entry.playlist ??
                    entry.url ??
                    entry.file ??
                    entry.link ??
                    entry.src,
                entry.type,
                entry.quality ??
                    entry.label ??
                    (entry.resolution !== undefined
                        ? String(entry.resolution)
                        : undefined)
            );
            pushSubtitles(entry.captions);
            pushSubtitles(entry.subtitles);
            pushSubtitles(entry.tracks);
            pushSubtitles(entry.track);
        };

        // sources / streams / stream arrays
        const lists = [stream.sources, stream.streams];
        for (const list of lists) {
            if (Array.isArray(list)) list.forEach(pushEntry);
        }
        if (Array.isArray(stream.stream)) {
            stream.stream.forEach(pushEntry);
        } else if (stream.stream && typeof stream.stream === 'object') {
            pushEntry(stream.stream);
        }

        // single playable url (fallback variant)
        pushSource(
            stream.url ?? stream.file ?? stream.playlist ?? stream.link,
            stream.type,
            stream.quality
        );

        // qualities map keyed by resolution (fallback variant)
        if (stream.qualities && typeof stream.qualities === 'object') {
            for (const [quality, entry] of Object.entries(stream.qualities)) {
                if (typeof entry === 'string') {
                    pushSource(entry, undefined, quality);
                } else {
                    pushSource(entry?.url ?? entry?.file, entry?.type, quality);
                }
            }
        }

        // top-level subtitle lists (incl. the singular `track` array that the
        // confirmed live payload actually uses)
        pushSubtitles(stream.tracks);
        pushSubtitles(stream.subtitles);
        pushSubtitles(stream.captions);
        pushSubtitles(stream.track);

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
            const res = await fetch(
                `${this.BASE_URL}/vod/150294-ghost-train-2024/episode/1`,
                {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(this.TIMEOUT_MS)
                }
            );
            return res.status < 500;
        } catch {
            return false;
        }
    }
}
