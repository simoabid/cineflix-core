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
    KisskhDramaDetail,
    KisskhEpisode,
    KisskhSearchHit,
    KisskhSubtitle,
    KisskhVideo
} from './kisskh.types.js';

/**
 * KissKH (kisskh.do) - Asian dramas, movies and some anime.
 *
 * Unlike the tmdb-keyed providers, KissKH is keyed by its own numeric episode
 * ids, so we first resolve title -> drama -> episode id, then run the
 * enc-dec.app flow (mirrored from the enc-dec.app `kisskh` sample):
 *
 *   1. GET kisskh.do/api/DramaList/Search?q=<title> -> [{ id, title }].
 *   2. Pick the best drama and GET kisskh.do/api/DramaList/Drama/{id} ->
 *      { episodes: [{ id, number }] }; select the episode id (movie -> the
 *      single/first episode, tv -> the episode whose number == media.e).
 *   3. GET enc-dec.app/api/enc-kisskh?text=<episodeId>&type=vid -> vid kkey;
 *      GET kisskh.do/api/DramaList/Episode/<episodeId>.png?err=false&ts=&time=
 *      &kkey=<vid> -> { Video, ThirdParty }.
 *   4. GET enc-dec.app/api/enc-kisskh?text=<episodeId>&type=sub -> sub kkey;
 *      GET kisskh.do/api/Sub/<episodeId>?kkey=<sub> -> [{ src, label }].
 *   5. Each subtitle `src` is an ENCRYPTED file, so the player subtitle url is
 *      pointed at enc-dec.app/api/dec-kisskh?url=<src>, which returns the
 *      decrypted subtitle text on GET.
 *
 * STATUS (2026-07-10): CONFIRMED WORKING live via kisskh_trace.py - the full
 * enc-dec flow (steps 3-5) returns a real hls url and dec-kisskh yields
 * readable subtitle text. The trace also exposed two resolver issues, now
 * fixed: (a) KissKH splits seasons into separate "<Title> Season <N>" entries,
 * so pickDrama is season-aware (media.s) and never blindly takes the first hit
 * (which had matched "Train to Busan" -> a "...Mugen Train Arc" anime); no
 * confident match now returns null (clean empty result) rather than a wrong
 * stream. (b) Subs are "<name>.<ext>.txt1" and decrypt to their real <ext>
 * (observed SRT), so detectSubtitleFormat reads the inner extension, not the
 * .txt1 encryption suffix. Only Asian content resolves (most western tmdb
 * titles won't be found -> clean empty result). ENABLED; every failure path
 * returns an empty result, never a broken stream. NOTE: KissKH rotates
 * domains; if it moves off kisskh.do, update BASE_URL.
 */
export class KisskhProvider extends BaseProvider {
    readonly id = 'kisskh';
    readonly name = 'KissKH';
    readonly enabled = true;
    readonly BASE_URL = 'https://kisskh.do';
    readonly API_BASE = 'https://enc-dec.app/api';
    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://kisskh.do/',
        Origin: 'https://kisskh.do'
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
            if (!media.title) {
                return this.emptyResult('missing title (required by kisskh)');
            }

            const episodeId = await this.resolveEpisodeId(media);
            if (episodeId === null) {
                return this.emptyResult(
                    `no kisskh match for "${media.title}"` +
                        (media.type === 'tv'
                            ? ` S${media.s ?? 1}E${media.e ?? 1}`
                            : '')
                );
            }

            const [sources, subtitles] = await Promise.all([
                this.getVideoSources(episodeId),
                this.getSubtitles(episodeId)
            ]);

            const dedupedSources = this.dedupeSources(sources);
            const dedupedSubs = this.dedupeSubtitles(subtitles);

            if (dedupedSources.length === 0) {
                return this.emptyResult(
                    `kisskh episode ${episodeId} returned no playable video`
                );
            }

            this.console.log(
                `kisskh: episode ${episodeId} -> ${dedupedSources.length} source(s), ${dedupedSubs.length} subtitle(s)`
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

    // steps 1-2: title -> drama -> episode id.
    private async resolveEpisodeId(
        media: ProviderMediaObject
    ): Promise<number | null> {
        const hits = await this.searchDrama(media.title);
        if (hits.length === 0) return null;

        const drama = this.pickDrama(hits, media);
        if (!drama) return null;

        const detail = await this.getDramaDetail(drama.id);
        const episodes = detail?.episodes ?? [];
        if (episodes.length === 0) return null;

        if (media.type === 'movie') {
            // movies are a single episode; prefer number 1, else the only one.
            const first =
                episodes.find((e) => Number(e.number) === 1) ?? episodes[0];
            return first?.id ?? null;
        }

        // tv: match the requested episode number.
        const target = media.e ?? 1;
        const ep = episodes.find((e) => Number(e.number) === target);
        return ep?.id ?? null;
    }

    private async searchDrama(title: string): Promise<KisskhSearchHit[]> {
        try {
            const res = await fetch(
                `${this.BASE_URL}/api/DramaList/Search?q=${encodeURIComponent(title)}&type=0`,
                {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(this.TIMEOUT_MS)
                }
            );
            if (!res.ok) return [];
            const json = (await res.json()) as unknown;
            if (!Array.isArray(json)) return [];
            return json.filter(
                (h): h is KisskhSearchHit =>
                    !!h &&
                    typeof h.id === 'number' &&
                    typeof h.title === 'string'
            );
        } catch {
            return [];
        }
    }

    // choose the drama entry. KissKH splits seasons into separate entries
    // titled "<Title> Season <N>", so match season-aware and NEVER fall back to
    // a blind first hit (that once matched "Train to Busan" -> a "...Mugen
    // Train Arc" anime). No confident match -> null -> clean empty result.
    private pickDrama(
        hits: KisskhSearchHit[],
        media: ProviderMediaObject
    ): KisskhSearchHit | null {
        const norm = (s: string) => s.trim().toLowerCase();
        const base = norm(media.title);
        const season = media.type === 'tv' ? (media.s ?? 1) : null;

        // acceptable exact title forms, most specific first.
        const forms: string[] = [];
        if (season !== null) {
            forms.push(`${base} season ${season}`);
            // season 1 is frequently listed without a "Season 1" suffix.
            if (season === 1) forms.push(base);
        } else {
            forms.push(base);
        }

        // 1. exact match against a preferred title form.
        for (const form of forms) {
            const hit = hits.find((h) => norm(h.title) === form);
            if (hit) return hit;
        }

        // 2. tv season > 1: a hit that starts with the base title AND names the
        // requested season (guards against grabbing another season).
        if (season !== null && season > 1) {
            const hit = hits.find(
                (h) =>
                    norm(h.title).startsWith(base) &&
                    norm(h.title).includes(`season ${season}`)
            );
            return hit ?? null;
        }

        // 3. movie / season 1: prefix match on the base title, shortest title
        // first so "<Title>" wins over "<Title>: <spinoff>". Never matches an
        // unrelated hit that merely shares a word.
        const prefix = hits
            .filter(
                (h) =>
                    norm(h.title) === base ||
                    norm(h.title).startsWith(`${base} `) ||
                    norm(h.title).startsWith(`${base}:`)
            )
            .sort((a, b) => a.title.length - b.title.length);
        return prefix[0] ?? null;
    }

    private async getDramaDetail(
        id: number
    ): Promise<KisskhDramaDetail | null> {
        try {
            const res = await fetch(
                `${this.BASE_URL}/api/DramaList/Drama/${id}?isq=false`,
                {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(this.TIMEOUT_MS)
                }
            );
            if (!res.ok) return null;
            const json = (await res.json()) as KisskhDramaDetail;
            // KissKH lists episodes newest-first; sort ascending by number so
            // "episode N" and "first episode" selection is deterministic.
            if (Array.isArray(json.episodes)) {
                json.episodes = [...json.episodes].sort(
                    (a: KisskhEpisode, b: KisskhEpisode) =>
                        Number(a.number) - Number(b.number)
                );
            }
            return json;
        } catch {
            return null;
        }
    }

    // step 3: vid kkey -> episode video json -> Source[].
    private async getVideoSources(episodeId: number): Promise<Source[]> {
        const vidKey = await this.getKey(episodeId, 'vid');
        if (!vidKey) return [];

        const res = await fetch(
            `${this.BASE_URL}/api/DramaList/Episode/${episodeId}.png` +
                `?err=false&ts=&time=&kkey=${encodeURIComponent(vidKey)}`,
            {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(this.TIMEOUT_MS)
            }
        );
        if (!res.ok) return [];

        const video = (await res.json()) as KisskhVideo;
        const sources: Source[] = [];

        if (video.Video) {
            sources.push({
                url: this.createProxyUrl(video.Video, this.HEADERS),
                type: this.detectType(video.Video),
                quality: 'Auto',
                audioTracks: [],
                provider: { id: this.id, name: this.name }
            });
        }

        // ThirdParty is an embed fallback (can coexist with Video); hand it to
        // the player/resolver when present.
        if (video.ThirdParty) {
            sources.push({
                url: video.ThirdParty,
                type: 'embed',
                quality: 'Auto',
                audioTracks: [],
                provider: { id: this.id, name: this.name }
            });
        }

        return sources;
    }

    // step 4-5: sub kkey -> subtitle list -> Subtitle[] pointing at dec-kisskh.
    private async getSubtitles(episodeId: number): Promise<Subtitle[]> {
        const subKey = await this.getKey(episodeId, 'sub');
        if (!subKey) return [];

        const res = await fetch(
            `${this.BASE_URL}/api/Sub/${episodeId}?kkey=${encodeURIComponent(subKey)}`,
            {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(this.TIMEOUT_MS)
            }
        );
        if (!res.ok) return [];

        const json = (await res.json()) as unknown;
        if (!Array.isArray(json)) return [];

        const subtitles: Subtitle[] = [];
        for (const entry of json as KisskhSubtitle[]) {
            if (!entry?.src) continue;
            subtitles.push({
                // dec-kisskh returns the DECRYPTED subtitle text on GET, so the
                // player fetches the readable track straight from this url.
                url: `${this.API_BASE}/dec-kisskh?url=${encodeURIComponent(entry.src)}`,
                label: entry.label ?? entry.land ?? 'Unknown',
                format: this.detectSubtitleFormat(entry.src)
            });
        }
        return subtitles;
    }

    // GET enc-dec.app/api/enc-kisskh?text=<id>&type=vid|sub -> bare kkey string.
    private async getKey(
        episodeId: number,
        type: 'vid' | 'sub'
    ): Promise<string | null> {
        try {
            const res = await fetch(
                `${this.API_BASE}/enc-kisskh?text=${episodeId}&type=${type}`,
                { signal: AbortSignal.timeout(this.TIMEOUT_MS) }
            );
            if (!res.ok) return null;
            const json = (await res.json()) as EncDecEnvelope<string>;
            if (json.status !== 200 || typeof json.result !== 'string') {
                return null;
            }
            return json.result;
        } catch {
            return null;
        }
    }

    private detectType(url: string, hint?: string): 'hls' | 'mp4' | 'dash' {
        const haystack = `${hint ?? ''} ${url}`.toLowerCase();
        if (haystack.includes('.mpd') || haystack.includes('dash'))
            return 'dash';
        if (haystack.includes('m3u8') || haystack.includes('hls')) return 'hls';
        return 'mp4';
    }

    // KissKH serves subs as "<name>.<ext>.txt1" (encrypted); dec-kisskh returns
    // the decrypted <ext> text (observed: real SRT). Detect the real extension
    // embedded in the name, NOT the .txt1 encryption suffix.
    private detectSubtitleFormat(
        src: string
    ): 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' {
        const s = src.toLowerCase();
        if (s.includes('.srt')) return 'srt';
        if (s.includes('.vtt')) return 'vtt';
        if (s.includes('.ssa')) return 'ssa';
        if (s.includes('.ass')) return 'ass';
        if (s.includes('.ttml')) return 'ttml';
        // KissKH's default encrypted track decrypts to SRT.
        return 'srt';
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
                `${this.BASE_URL}/api/DramaList/Search?q=test&type=0`,
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
