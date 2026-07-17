import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import type { VideasyServer } from './videasy.types.js';
import { decryptResponse } from './decryptor.js';
import { scrapeFetch } from '../../utils/scrapeFetch.js';

/**
 * videasy migrated its backend to api.wingsdatabase.com and now requires a
 * per-media `seed` (fetched from /seed?mediaId=<tmdbId>) plus `enc=2` on every
 * sources-with-title request. the seed must also be forwarded to enc-dec.app
 * when decrypting the returned blob.
 *
 * server names below use videasy's public codenames. the "Original" servers
 * carry the primary (usually english) audio. hdmovie ("Vyse") returns sources
 * whose "quality" field is actually a language label, so it is filtered down to
 * english via `qualityFilter`. the non-english servers (german/hindi/spanish/
 * portuguese) are kept commented out to preserve the english-first behavior.
 */

const VIDEASY_SERVERS: readonly VideasyServer[] = [
    {
        name: 'jett',
        url: 'https://api.wingsdatabase.com/jett/sources-with-title'
    },
    {
        name: 'yoru',
        url: 'https://api.wingsdatabase.com/cdn/sources-with-title'
    },
    {
        name: 'tejo',
        url: 'https://api.wingsdatabase.com/tejo/sources-with-title'
    },
    {
        name: 'neon',
        url: 'https://api.wingsdatabase.com/neon2/sources-with-title'
    },
    {
        name: 'sage',
        url: 'https://api.wingsdatabase.com/ym/sources-with-title'
    },
    {
        name: 'cypher',
        url: 'https://api.wingsdatabase.com/downloader2/sources-with-title'
    },
    {
        name: 'breach',
        url: 'https://api.wingsdatabase.com/m4uhd/sources-with-title'
    },
    {
        name: 'vyse',
        url: 'https://api.wingsdatabase.com/hdmovie/sources-with-title',
        qualityFilter: 'English'
    }

    // non-english servers (enable if you want multi-language output):
    // { name: 'killjoy', url: 'https://api.wingsdatabase.com/meine/sources-with-title', language: 'german' },
    // { name: 'fade',    url: 'https://api.wingsdatabase.com/hdmovie/sources-with-title', qualityFilter: 'Hindi' },
    // { name: 'omen',    url: 'https://api.wingsdatabase.com/lamovie/sources-with-title', language: 'spanish' },
    // { name: 'raze',    url: 'https://api.wingsdatabase.com/superflix/sources-with-title', language: 'portuguese' }
] as const;

export class VideasyProvider extends BaseProvider {
    readonly id = 'Videasy';
    readonly name = 'Videasy';
    readonly enabled = true;
    readonly BASE_URL = 'https://api.wingsdatabase.com';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Accept: '*/*',
        Referer: 'https://player.videasy.to/',
        Origin: 'https://player.videasy.to'
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

    // fans out to all servers in parallel, merges results
    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        // videasy now gates every request behind a per-media seed. fetch it once
        // and reuse it across all servers + the enc-dec.app decrypt call.
        const seedResult = await this.fetchSeed(String(media.tmdbId));

        if (!seedResult.ok) {
            return this.emptyResult(
                `could not obtain videasy seed (api.wingsdatabase.com/seed): ${seedResult.error}`,
                media
            );
        }
        const seed = seedResult.seed;

        const results = await Promise.allSettled(
            VIDEASY_SERVERS.map((server) =>
                this.fetchFromServer(server, media, seed)
            )
        );

        const sources: ProviderResult['sources'] = [];
        const subtitles: ProviderResult['subtitles'] = [];
        const diagnostics: ProviderResult['diagnostics'] = [];
        let failCount = 0;

        for (const result of results) {
            if (result.status === 'rejected' || !result.value) {
                failCount++;
                continue;
            }
            sources.push(...result.value.sources);
            subtitles.push(...result.value.subtitles);
        }

        if (failCount > 0 && sources.length > 0) {
            diagnostics.push({
                code: 'PARTIAL_SCRAPE',
                message: `${failCount} of ${VIDEASY_SERVERS.length} videasy servers did not return results`,
                field: '',
                severity: 'warning'
            });
        }

        if (sources.length === 0) {
            return this.emptyResult(
                'all videasy servers returned no sources',
                media
            );
        }

        return { sources, subtitles, diagnostics };
    }

    // I have added a small identification of error in case in future we have some problem
    // if the error has all capital then it proly mean that they shifted their encryption and all
    // if it's small and has same then we might have to change a bit let's say api url ?.
    // suppose the small invalid response indicates that they might have changed their setup
    // while the capital indicates that the response might be short not enough, hope it helps.

    // fetches videasy's per-media seed from api.wingsdatabase.com.
    private async fetchSeed(
        tmdbId: string
    ): Promise<{ ok: true; seed: string } | { ok: false; error: string }> {
        try {
            // Option B: wingsdatabase seed fails direct from AWS (~20–30ms empty).
            const res = await scrapeFetch(
                `${this.BASE_URL}/seed?mediaId=${encodeURIComponent(tmdbId)}`,
                {
                    headers: this.HEADERS,
                    timeoutMs: 15_000,
                    viaProxy: true
                }
            );
            if (!res.ok) {
                return { ok: false, error: `HTTP ${res.status}` };
            }
            const json = (await res.json()) as { seed?: string | number };
            if (json?.seed == null) {
                return { ok: false, error: 'missing seed field' };
            }
            return { ok: true, seed: String(json.seed) };
        } catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : 'fetch failed'
            };
        }
    }

    // fetches one server, reads plain text blob, decrypts via enc-dec.app
    private async fetchFromServer(
        server: VideasyServer,
        media: ProviderMediaObject,
        seed: string
    ): Promise<ProviderResult | null> {
        const params = this.buildParams(server, media, seed);
        const url = `${server.url}?${new URLSearchParams(params as Record<string, string>)}`;
        const response = await scrapeFetch(url, {
            headers: this.HEADERS,
            timeoutMs: 25_000,
            viaProxy: true
        });

        if (!response.ok) {
            return this.emptyResult('invalid response', media);
        }

        // api returns plain text hex blob, not json
        const blob = await response.text();

        if (!blob || blob.length < 10) {
            return this.emptyResult('INVALID RESPONSE', media);
        }

        const decrypted = await decryptResponse(
            blob,
            String(media.tmdbId),
            seed
        );

        if (!decrypted || decrypted.sources.length === 0) {
            return this.emptyResult('Unable to Decode', media);
        }

        // some servers (e.g. vyse/hdmovie) put a language label in "quality";
        // qualityFilter narrows those down to the language we actually want.
        const rawSources = server.qualityFilter
            ? decrypted.sources.filter(
                  (s) =>
                      (s.quality ?? '').toLowerCase() ===
                      server.qualityFilter!.toLowerCase()
              )
            : decrypted.sources;

        const sources: ProviderResult['sources'] = rawSources
            .filter((s) => !!s?.url)
            .map((s) => ({
                url: this.createProxyUrl(s.url, this.HEADERS),
                type: this.detectType(s.url, s.type),
                quality: this.normalizeQuality(s.quality),
                audioTracks: [
                    {
                        language: this.resolveLanguage(server),
                        label: this.resolveLanguageLabel(server)
                    }
                ],
                provider: { id: this.id, name: this.name }
            }));

        const subtitles: ProviderResult['subtitles'] = decrypted.subtitles
            .filter((s) => !!s?.url)
            .map((s) => ({
                url: this.createProxyUrl(s.url, {}),
                label: s.lang ?? s.language ?? 'Unknown',
                format: 'vtt' as const
            }));

        return { sources, subtitles, diagnostics: [] };
    }

    // builds query params for the wingsdatabase sources-with-title endpoint.
    // videasy double-url-encodes the title (encodeURIComponent here + a second
    // pass by URLSearchParams at the call site), and requires enc=2 + seed.
    private buildParams(
        server: VideasyServer,
        media: ProviderMediaObject,
        seed: string
    ): Record<string, string> {
        const base: Record<string, string> = {
            // pre-encode once; URLSearchParams applies the second pass
            title: encodeURIComponent(media.title ?? ''),
            mediaType: media.type === 'movie' ? 'movie' : 'tv',
            tmdbId: String(media.tmdbId),
            imdbId: media.imdbId ?? '',
            episodeId: String(media.type === 'tv' ? (media.e ?? 1) : 1),
            seasonId: String(media.type === 'tv' ? (media.s ?? 1) : 1),
            enc: '2', // algorithm version expected by enc-dec.app/dec-videasy
            seed
        };

        if (media.type === 'movie') {
            base.year = String(media.releaseYear ?? '');
        }

        if (server.language) {
            base.language = server.language;
        }

        return base;
    }

    // detects stream type from url extension and api hint
    private detectType(url: string, hint?: string): 'hls' | 'mp4' {
        const lower = (hint ?? '').toLowerCase();
        if (
            lower.includes('hls') ||
            lower.includes('m3u8') ||
            url.toLowerCase().includes('.m3u8')
        ) {
            return 'hls';
        }
        return 'mp4';
    }

    // guards against language labels being passed as quality (e.g. "Hindi")
    private normalizeQuality(raw?: string): string {
        if (!raw) return 'unknown';
        return /^\d{3,4}p$|^4K$|^8K$|^HD$|^SD$/i.test(raw.trim())
            ? raw.trim()
            : 'unknown';
    }

    private resolveLanguage(server: VideasyServer): string {
        if (!server.language) return 'en';
        const map: Record<string, string> = {
            german: 'de',
            italian: 'it',
            french: 'fr',
            spanish: 'es',
            portuguese: 'pt'
        };
        return map[server.language] ?? 'en';
    }

    private resolveLanguageLabel(server: VideasyServer): string {
        if (!server.language) return 'English';
        const map: Record<string, string> = {
            german: 'German',
            italian: 'Italian',
            french: 'French',
            spanish: 'Spanish',
            portuguese: 'Portuguese'
        };
        return map[server.language] ?? 'English';
    }

    private emptyResult(
        message: string,
        _media: ProviderMediaObject
    ): ProviderResult {
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
            const res = await scrapeFetch(`${this.BASE_URL}/seed?mediaId=155`, {
                headers: this.HEADERS,
                timeoutMs: 10_000,
                viaProxy: true
            });
            return res.status < 500;
        } catch {
            return false;
        }
    }
}
