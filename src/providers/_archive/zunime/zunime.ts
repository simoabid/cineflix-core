import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

const ZUNIME_SERVERS = ['zunime-hd-2', 'zunime-miko', 'zunime-shiro', 'zunime-zaza'] as const;

const BACKEND_URL = 'https://backend.xaiby.sbs';
const DEFAULT_HEADERS = {
    referer: 'https://vidnest.fun/',
    origin: 'https://vidnest.fun',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

interface ZunimeResponse {
    success?: boolean;
    sources?: {
        url?: string;
        headers?: Record<string, string>;
    };
}

export class ZunimeProvider extends BaseProvider {
    readonly id = 'zunime';
    readonly name = 'Zunime';
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
                ZUNIME_SERVERS.map((serverId) =>
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
                return this.emptyResult('No streams found from any zunime server');
            }

            const diagnostics: ProviderResult['diagnostics'] = [];
            if (failCount > 0) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    message: `${failCount} of ${ZUNIME_SERVERS.length} zunime servers failed`,
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
                id: String(tmdbId),
                ep: String(episode),
                host: serverId,
                type: 'dub'
            });

            const res = await fetch(`${BACKEND_URL}/sources?${params.toString()}`, {
                headers: DEFAULT_HEADERS,
                signal: AbortSignal.timeout(15_000)
            });

            if (!res.ok) return null;

            const data = (await res.json()) as ZunimeResponse;
            if (!data?.success || !data?.sources?.url) return null;

            const streamUrl = data.sources.url;
            const upstreamHeaders =
                data.sources.headers && Object.keys(data.sources.headers).length > 0
                    ? data.sources.headers
                    : DEFAULT_HEADERS;

            return {
                url: this.createProxyUrl(streamUrl, upstreamHeaders),
                type: 'hls',
                quality: 'unknown',
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
