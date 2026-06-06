import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import type { Ee3AuthResponse, Ee3MovieResponse, Ee3KeyResponse } from './ee3.types.js';

const API_BASE_URL = 'https://borg.rips.cc';
const USERNAME = '_ps_';
const PASSWORD = 'defonotscraping';

export class Ee3Provider extends BaseProvider {
    readonly id = 'ee3';
    readonly name = 'EE3';
    readonly enabled = true;
    readonly BASE_URL = API_BASE_URL;

    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Origin: 'https://ee3.me'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            // Step 1: Authenticate
            const authRes = await fetch(
                `${API_BASE_URL}/api/collections/users/auth-with-password?expand=lists_liked`,
                {
                    method: 'POST',
                    headers: {
                        ...this.HEADERS,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        identity: USERNAME,
                        password: PASSWORD
                    }),
                    signal: AbortSignal.timeout(15000)
                }
            );

            if (!authRes.ok) {
                return this.emptyResult(`Auth failed with HTTP ${authRes.status}`);
            }

            const authData = (await authRes.json()) as Ee3AuthResponse;
            if (!authData?.token) {
                return this.emptyResult('No token in auth response');
            }

            const token = authData.token;

            // Step 2: Find movie by TMDB ID
            const movieUrl = `${API_BASE_URL}/api/collections/movies/records?page=1&perPage=48&filter=tmdb_data.id%20~%20${media.tmdbId}`;
            const movieRes = await fetch(movieUrl, {
                headers: {
                    ...this.HEADERS,
                    Authorization: `Bearer ${token}`
                },
                signal: AbortSignal.timeout(15000)
            });

            if (!movieRes.ok) {
                return this.emptyResult(`Movie lookup failed with HTTP ${movieRes.status}`);
            }

            const movieData = (await movieRes.json()) as Ee3MovieResponse;
            if (!movieData?.items?.length) {
                return this.emptyResult(`No items found for TMDB ID ${media.tmdbId}`);
            }

            const videoId = movieData.items[0]?.video;
            if (!videoId) {
                return this.emptyResult('No video field in first item');
            }

            // Step 3: Get video key
            const keyRes = await fetch(`${API_BASE_URL}/video/${videoId}/key`, {
                headers: {
                    ...this.HEADERS,
                    Authorization: `Bearer ${token}`
                },
                signal: AbortSignal.timeout(15000)
            });

            if (!keyRes.ok) {
                return this.emptyResult(`Key fetch failed with HTTP ${keyRes.status}`);
            }

            const keyData = (await keyRes.json()) as Ee3KeyResponse;
            if (!keyData?.key) {
                return this.emptyResult('No key in response');
            }

            const videoUrl = `${API_BASE_URL}/video/${videoId}?k=${keyData.key}`;

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(videoUrl, {
                        ...this.HEADERS,
                        Authorization: `Bearer ${token}`
                    }),
                    type: 'mp4',
                    quality: 'Auto',
                    audioTracks: [{ language: 'org', label: 'Original' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            this.console.log(`Found video for "${media.title}"`, media);

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    async getTVSources(_media: ProviderMediaObject): Promise<ProviderResult> {
        return this.emptyResult('TV shows not supported');
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
