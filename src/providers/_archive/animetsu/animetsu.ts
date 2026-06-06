import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

const ANIMETSU_SERVERS = [
    'animetsu-pahe',
    'animetsu-zoro',
    'animetsu-zaza',
    'animetsu-meg',
    'animetsu-bato'
] as const;

const BACKEND_URL = 'https://backend.animetsu.net';
const DEFAULT_HEADERS = {
    referer: 'https://animetsu.net/',
    origin: 'https://backend.animetsu.net',
    accept: 'application/json, text/plain, */*',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

interface AnimetsuSource {
    url?: string;
    type?: string;
    quality?: string;
}

interface AnimetsuResponse {
    sources?: AnimetsuSource[];
}

export class AnimetsuProvider extends BaseProvider {
    readonly id = 'animetsu';
    readonly name = 'Animetsu';
    readonly enabled = true;
    readonly BASE_URL = BACKEND_URL;
    readonly HEADERS = DEFAULT_HEADERS;

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const episode = media.type === 'tv' ? media.e ?? 1 : 1;

            const results = await Promise.allSettled(
                ANIMETSU_SERVERS.map((serverId) =>
                    this.fetchServerSource(serverId, media.tmdbId, episode)
                )
            );

            const sources: Source[] = [];
            let failCount = 0;

            for (const result of results) {
                if (result.status === 'rejected' || !result.value) {
                    failCount++;
                    continue;
                }
                sources.push(result.value);
            }

            if (sources.length === 0) {
                return this.emptyResult('No streams found from any animetsu server');
            }

            const diagnostics: ProviderResult['diagnostics'] = [];
            if (failCount > 0) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    message: `${failCount} of ${ANIMETSU_SERVERS.length} animetsu servers failed`,
                    field: '',
                    severity: 'warning'
                });
            }

            return { sources, subtitles: [], diagnostics };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async fetchServerSource(
        serverId: string,
        tmdbId: string,
        episode: number
    ): Promise<Source | null> {
        try {
            const params = new URLSearchParams({
                server: serverId,
                id: String(tmdbId),
                num: String(episode),
                subType: 'dub'
            });

            const res = await fetch(
                `${BACKEND_URL}/api/anime/tiddies?${params.toString()}`,
                {
                    headers: DEFAULT_HEADERS,
                    signal: AbortSignal.timeout(15_000)
                }
            );

            if (!res.ok) return null;

            const data = (await res.json()) as AnimetsuResponse;
            const source = data?.sources?.[0];
            if (!source?.url) return null;

            const streamType = source.type === 'mp4' ? 'mp4' : 'hls';
            let quality = 'unknown';
            if (source.quality) {
                const qualityMatch = source.quality.match(/(\d+)p?/);
                if (qualityMatch) {
                    quality = qualityMatch[1];
                }
            }

            return {
                url: this.createProxyUrl(source.url, DEFAULT_HEADERS),
                type: streamType,
                quality,
                audioTracks: [{ language: 'dub', label: 'Dub' }],
                provider: { id: this.id, name: this.name }
            };
        } catch {
            return null;
        }
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
