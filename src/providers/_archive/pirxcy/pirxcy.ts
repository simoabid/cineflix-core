import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import type {
    PirxcySearchResponse,
    PirxcyDetailResponse,
    PirxcyStreamResponse
} from './pirxcy.types.js';

export class PirxcyProvider extends BaseProvider {
    readonly id = 'pirxcy';
    readonly name = 'Pirxcy';
    readonly enabled = true;
    readonly BASE_URL = 'https://mbp.pirxcy.dev';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media, 'movie');
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media, 'tv');
    }

    private async getSources(
        media: ProviderMediaObject,
        type: 'movie' | 'tv'
    ): Promise<ProviderResult> {
        try {
            if (!media.tmdbId || !media.title) {
                return this.emptyResult('Missing required media information');
            }

            this.console.log(`Searching for: ${media.title} (${type})`);

            const mediaId = await this.findMediaByTMDBId(
                media.tmdbId,
                media.title,
                type,
                media.releaseYear
            );

            const streamUrl =
                type === 'movie'
                    ? `${this.BASE_URL}/movie/${mediaId}`
                    : `${this.BASE_URL}/tv/${mediaId}/${media.s}/${media.e}`;

            this.console.log(`Fetching streams from: ${streamUrl}`);

            const streamData = (await fetch(streamUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            }).then((r) => r.json())) as PirxcyStreamResponse;

            if (!streamData.data || !streamData.data.list) {
                return this.emptyResult('No streams found');
            }

            const sources = this.buildQualitiesFromStreams(streamData.data);

            this.console.log(`Found ${sources.length} sources`);

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async findMediaByTMDBId(
        tmdbId: string,
        title: string,
        type: 'movie' | 'tv',
        year?: string
    ): Promise<string> {
        const searchUrl = `${this.BASE_URL}/search?q=${encodeURIComponent(title)}&type=${type}${year ? `&year=${year}` : ''}`;

        const searchRes = (await fetch(searchUrl, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(15000)
        }).then((r) => r.json())) as PirxcySearchResponse;

        if (!searchRes.data || searchRes.data.length === 0) {
            throw new Error('No results found in search');
        }

        for (const result of searchRes.data) {
            const detailUrl = `${this.BASE_URL}/details/${type}/${result.id}`;
            const detailRes = (await fetch(detailUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            }).then((r) => r.json())) as PirxcyDetailResponse;

            if (
                detailRes.data &&
                detailRes.data.tmdb_id.toString() === tmdbId
            ) {
                return result.id;
            }
        }

        throw new Error(
            'Could not find matching media item for TMDB ID'
        );
    }

    private buildQualitiesFromStreams(data: {
        list: Array<{
            path: string;
            quality: string;
            real_quality: string;
            format: string;
        }>;
    }): Source[] {
        const streams: Record<string, string> = {};

        for (const stream of data.list) {
            if (stream.format !== 'mp4') continue;

            let qualityKey: number;
            if (
                stream.quality === '4K' ||
                stream.real_quality === '4K'
            ) {
                qualityKey = 2160;
            } else {
                const qualityStr = stream.quality.replace('p', '');
                qualityKey = parseInt(qualityStr, 10);
            }

            if (Number.isNaN(qualityKey) || streams[qualityKey]) continue;
            streams[qualityKey] = stream.path;
        }

        const sources: Source[] = [];
        const qualityMap: Record<string, string> = {
            '2160': '4k',
            '1080': '1080',
            '720': '720',
            '480': '480',
            '360': '360'
        };

        for (const [key, label] of Object.entries(qualityMap)) {
            if (streams[key]) {
                sources.push({
                    url: this.createProxyUrl(streams[key], this.HEADERS),
                    type: 'mp4',
                    quality: label,
                    audioTracks: [],
                    provider: { id: this.id, name: this.name }
                });
            }
        }

        return sources;
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
