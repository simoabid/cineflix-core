import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

type DebridService = 'torbox' | 'real-debrid';

interface StremioStream {
    name?: string;
    description?: string;
    title?: string;
    url: string;
    infoHash?: string;
    fileIdx?: number;
    behaviorHints?: {
        bingeGroup: string;
        filename: string;
        videoSize?: number;
    };
}

interface StremioAddonResponse {
    streams: StremioStream[];
}

interface ParsedStream {
    resolution?: string;
    container?: string;
    codec?: string;
    audio?: string;
    complete?: boolean;
    title: string;
    url: string;
}

const COMET_BASE_URL = 'https://comet.elfhosted.com';
const TORRENT_PARSE_URL = 'https://torrent-parse.pstream.mov';

function normalizeQuality(
    resolution?: string
): '4k' | '1080' | '720' | '480' | '360' | 'unknown' {
    if (!resolution) return 'unknown';
    const res = resolution.toLowerCase();
    if (res === '4k' || res === '2160p') return '4k';
    if (res === '1080p') return '1080';
    if (res === '720p') return '720';
    if (res === '480p') return '480';
    if (res === '360p') return '360';
    return 'unknown';
}

function scoreStream(stream: ParsedStream): number {
    let score = 0;
    if (stream.container === 'mp4') score += 10;
    if (stream.audio === 'aac') score += 5;
    if (stream.codec === 'h265') score += 2;
    if (stream.container === 'mkv') score -= 2;
    if (stream.complete) score += 1;
    return score;
}

export class DebridProvider extends BaseProvider {
    readonly id = 'debrid';
    readonly name = 'Debrid';
    readonly enabled = false; // Requires user configuration (debrid token)
    readonly BASE_URL = 'https://torrentio.strem.fun';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    private debridToken: string | null = null;
    private debridService: DebridService = 'real-debrid';

    /**
     * Configure the debrid provider with user credentials.
     * Must be called before getMovieSources/getTVSources.
     */
    configure(token: string, service: DebridService = 'real-debrid'): void {
        this.debridToken = token;
        this.debridService = service;
    }

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        if (!this.debridToken) {
            return this.emptyResult(
                'Debrid API token is required. Call configure() first.'
            );
        }

        try {
            const [torrentioStreams, cometStreams] = await Promise.all([
                this.fetchTorrentioStreams(media).catch(() => [] as ParsedStream[]),
                this.fetchCometStreams(media).catch(() => [] as ParsedStream[])
            ]);

            const allStreams = [...torrentioStreams, ...cometStreams];

            if (allStreams.length === 0) {
                return this.emptyResult('No streams found from torrentio or comet');
            }

            this.console.log(
                `Total streams: ${allStreams.length} (${torrentioStreams.length} from Torrentio, ${cometStreams.length} from Comet)`,
                media
            );

            const sources = this.buildSourcesFromStreams(allStreams);

            if (sources.length === 0) {
                return this.emptyResult('No playable streams after quality selection');
            }

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async fetchTorrentioStreams(
        media: ProviderMediaObject
    ): Promise<ParsedStream[]> {
        const addonUrl = `https://torrentio.strem.fun/${this.debridService}=${this.debridToken}`;
        const stremioStreams = await this.fetchAddonStreams(addonUrl, media);

        if (stremioStreams.length === 0) return [];

        const toParse = stremioStreams.map((s) => ({
            title: s.title ?? s.description ?? s.name ?? '',
            url: s.url
        }));

        return this.parseStreamData(toParse);
    }

    private async fetchCometStreams(
        media: ProviderMediaObject
    ): Promise<ParsedStream[]> {
        const cometConfig = btoa(
            JSON.stringify({
                maxResultsPerResolution: 0,
                maxSize: 0,
                cachedOnly: false,
                removeTrash: true,
                resultFormat: ['all'],
                debridService: this.debridService,
                debridApiKey: this.debridToken,
                debridStreamProxyPassword: '',
                languages: { exclude: [], preferred: ['en'] },
                resolutions: {},
                options: {
                    remove_ranks_under: -10000000000,
                    allow_english_in_languages: false,
                    remove_unknown_languages: false
                }
            })
        );

        const addonUrl = `${COMET_BASE_URL}/${cometConfig}`;
        const stremioStreams = await this.fetchAddonStreams(addonUrl, media);

        if (stremioStreams.length === 0) return [];

        const toParse = stremioStreams
            .filter((s) => s.description)
            .map((s) => ({
                title: (s.description as string).replace(/\n/g, ''),
                url: s.url
            }));

        return this.parseStreamData(toParse);
    }

    private async fetchAddonStreams(
        addonUrl: string,
        media: ProviderMediaObject
    ): Promise<StremioStream[]> {
        if (!media.imdbId) {
            throw new Error('IMDB ID is required for debrid streams');
        }

        let streamPath: string;
        if (media.type === 'tv' && media.s && media.e) {
            streamPath = `/stream/series/${media.imdbId}:${media.s}:${media.e}.json`;
        } else {
            streamPath = `/stream/movie/${media.imdbId}.json`;
        }

        const res = await fetch(`${addonUrl}${streamPath}`, {
            signal: AbortSignal.timeout(15_000)
        });

        if (!res.ok) return [];

        const data = (await res.json()) as StremioAddonResponse;
        return data?.streams ?? [];
    }

    private async parseStreamData(
        streams: Array<{ title: string; url: string }>
    ): Promise<ParsedStream[]> {
        try {
            const res = await fetch(TORRENT_PARSE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(streams),
                signal: AbortSignal.timeout(15_000)
            });

            if (!res.ok) return [];
            return (await res.json()) as ParsedStream[];
        } catch {
            return [];
        }
    }

    private buildSourcesFromStreams(allStreams: ParsedStream[]): Source[] {
        const byQuality: Record<string, ParsedStream[]> = {};

        for (const stream of allStreams) {
            const quality = normalizeQuality(stream.resolution);
            if (!byQuality[quality]) byQuality[quality] = [];
            byQuality[quality].push(stream);
        }

        const sources: Source[] = [];

        for (const [quality, streams] of Object.entries(byQuality)) {
            const best = this.selectBestStream(streams);
            if (!best) continue;

            sources.push({
                url: this.createProxyUrl(best.url, this.HEADERS),
                type: 'mp4',
                quality,
                audioTracks: [{ language: 'eng', label: 'English' }],
                provider: { id: this.id, name: this.name }
            });
        }

        return sources;
    }

    private selectBestStream(streams: ParsedStream[]): ParsedStream | null {
        // Prefer mp4 + aac
        const mp4Aac = streams.find(
            (s) => s.container === 'mp4' && s.audio === 'aac'
        );
        if (mp4Aac) return mp4Aac;

        // Then prefer mp4
        const mp4 = streams.find((s) => s.container === 'mp4');
        if (mp4) return mp4;

        // Score and pick best
        const sorted = [...streams].sort(
            (a, b) => scoreStream(b) - scoreStream(a)
        );
        return sorted[0] ?? null;
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
}
