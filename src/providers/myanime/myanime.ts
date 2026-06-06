import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

export class MyanimeProvider extends BaseProvider {
    readonly id = 'myanime';
    readonly name = 'MyAnime';
    readonly enabled = false;
    readonly BASE_URL = 'https://anime.aether.mom';
    readonly AI_URL = 'https://gemini.aether.mom/v1beta/models/gemini-2.5-flash-lite:generateContent';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://anime.aether.mom/',
        Accept: 'application/json, text/plain, */*'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getMovie(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getTV(media);
    }

    private async getMovie(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const searchUrl = `${this.BASE_URL}/api/search?keyword=${encodeURIComponent(media.title)}`;
            this.console.log(`Searching: ${searchUrl}`);

            const res = await fetch(searchUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as {
                results?: {
                    data?: Array<{
                        id?: string;
                        tvInfo?: { showType?: string };
                    }>;
                };
            };

            const movie = data.results?.data?.find(
                (v) => v.tvInfo?.showType === 'Movie'
            );

            if (!movie?.id) {
                return this.emptyResult('No watchable sources found');
            }

            const episodeRes = await fetch(
                `${this.BASE_URL}/api/episodes/${movie.id}`,
                {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(15000)
                }
            );

            if (!episodeRes.ok) {
                return this.emptyResult('Failed to fetch episodes');
            }

            const episodeData = (await episodeRes.json()) as {
                results?: {
                    episodes?: Array<{ id?: string; episode_no?: number }>;
                };
            };

            const episode = episodeData.results?.episodes?.find(
                (e) => e.episode_no === 1
            );

            if (!episode?.id) {
                return this.emptyResult('No watchable sources found');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(
                        `myanimesub:${episode.id}`,
                        this.HEADERS
                    ),
                    type: 'embed',
                    quality: 'Sub',
                    audioTracks: [{ label: 'Sub', language: 'ja' }],
                    provider: { id: this.id, name: this.name }
                },
                {
                    url: this.createProxyUrl(
                        `myanimedub:${episode.id}`,
                        this.HEADERS
                    ),
                    type: 'embed',
                    quality: 'Dub',
                    audioTracks: [{ label: 'Dub', language: 'en' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async getTV(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const searchUrl = `${this.BASE_URL}/api/search?keyword=${encodeURIComponent(media.title)}`;
            this.console.log(`Searching: ${searchUrl}`);

            const res = await fetch(searchUrl, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) {
                return this.emptyResult(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as {
                results?: {
                    data?: Array<{
                        id?: string;
                        title?: string;
                        alt_title?: string;
                        tvInfo?: {
                            showType?: string;
                            totalEpisodes?: number;
                            sub?: number;
                            dub?: number;
                        };
                    }>;
                };
            };

            const tvAnimes =
                data.results?.data?.filter(
                    (v) => v.tvInfo?.showType === 'TV'
                ) ?? [];

            if (tvAnimes.length === 0) {
                return this.emptyResult('Anime not found');
            }

            const aiResult = await this.getAiMatching(media, tvAnimes);

            let seasons: Array<{
                id?: string;
                title?: string;
                seasonNum: number;
                tvInfo?: { sub?: number };
            }> = [];

            if (aiResult?.results?.length) {
                seasons = aiResult.results
                    .map((v) => {
                        const anime = tvAnimes.find((a) => a.id === v.id);
                        if (!anime) return null;
                        return {
                            ...anime,
                            seasonNum: v.season ?? 1
                        };
                    })
                    .filter((v): v is NonNullable<typeof v> => v !== null)
                    .sort((a, b) => a.seasonNum - b.seasonNum);
            }

            if (seasons.length === 0) {
                return this.emptyResult('Anime not found');
            }

            let episodeId: string | undefined;

            let season = seasons.find(
                (v) => v.seasonNum === media.s
            );

            const seasonEntries = seasons.filter(
                (v) => v.seasonNum === media.s
            );

            if (seasonEntries.length > 1) {
                season = seasonEntries[0];
            }

            if (season?.id) {
                const episodeRes = await fetch(
                    `${this.BASE_URL}/api/episodes/${season.id}`,
                    {
                        headers: this.HEADERS,
                        signal: AbortSignal.timeout(15000)
                    }
                );

                if (episodeRes.ok) {
                    const episodeData = (await episodeRes.json()) as {
                        results?: {
                            episodes?: Array<{
                                id?: string;
                                episode_no?: number;
                            }>;
                        };
                    };

                    const episode = episodeData.results?.episodes?.find(
                        (ep) => ep.episode_no === media.e
                    );

                    if (episode?.id) {
                        episodeId = episode.id;
                    }
                }
            }

            if (!episodeId) {
                let episodeNumber = media.e ?? 1;
                for (const s of seasons) {
                    const epCount = s.tvInfo?.sub ?? 0;
                    if (episodeNumber <= epCount && s.id) {
                        const episodeRes = await fetch(
                            `${this.BASE_URL}/api/episodes/${s.id}`,
                            {
                                headers: this.HEADERS,
                                signal: AbortSignal.timeout(15000)
                            }
                        );

                        if (episodeRes.ok) {
                            const episodeData = (await episodeRes.json()) as {
                                results?: {
                                    episodes?: Array<{
                                        id?: string;
                                        episode_no?: number;
                                    }>;
                                };
                            };

                            const episode =
                                episodeData.results?.episodes?.find(
                                    (ep) => ep.episode_no === episodeNumber
                                );

                            if (episode?.id) {
                                episodeId = episode.id;
                                break;
                            }
                        }
                    }
                    episodeNumber -= epCount;
                }
            }

            if (!episodeId) {
                return this.emptyResult('Episode not found');
            }

            const sources: Source[] = [
                {
                    url: this.createProxyUrl(
                        `myanimesub:${episodeId}`,
                        this.HEADERS
                    ),
                    type: 'embed',
                    quality: 'Sub',
                    audioTracks: [{ label: 'Sub', language: 'ja' }],
                    provider: { id: this.id, name: this.name }
                },
                {
                    url: this.createProxyUrl(
                        `myanimedub:${episodeId}`,
                        this.HEADERS
                    ),
                    type: 'embed',
                    quality: 'Dub',
                    audioTracks: [{ label: 'Dub', language: 'en' }],
                    provider: { id: this.id, name: this.name }
                }
            ];

            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    private async getAiMatching(
        media: ProviderMediaObject,
        searchResults: Array<{
            id?: string;
            title?: string;
            alt_title?: string;
            tvInfo?: {
                showType?: string;
                totalEpisodes?: number;
                sub?: number;
                dub?: number;
                eps?: number;
                year?: number;
            };
        }>
    ): Promise<{ results: Array<{ id?: string; season?: number }> } | null> {
        try {
            const seasons =
                media.s && media.s > 1
                    ? ` and has ${media.s} seasons`
                    : '';

            const prompt = `
You are an AI that matches TMDB movie and show data to myanime search results.
The user is searching for "${media.title}" which was released in ${media.releaseYear}${seasons}.
The user is looking for season ${media.s ?? 1}, episode ${media.e ?? 1}.

Here are the search results from myanime:
${JSON.stringify(searchResults, null, 2)}

IMPORTANT: Some shows on TMDB have continuous episode numbering across seasons (e.g., episode 25 is the first episode of season 2), but myanime lists seasons as separate entries with their own episode counts. The myanime entry may also have a different title (e.g., "Mugen Train Arc").
To solve this, please return a JSON object with a "results" array that contains ALL entries from the search results that match the requested show, including all of its seasons, even if the user is only asking for one.
Each object in the "results" array should have the "id" of the matching anime from the myanime search results, and the "season" number. You must determine the season number for each entry based on its title.
The results MUST be sorted by season number in ascending order so the calling code can correctly map the episode number.
Pay close attention to the season title and episode counts from both TMDB and the myanime results to find the best match. If TMDB combines seasons into one, you must split them based on the episode counts in the search results.
Use the TMDB season title as the primary key for matching, and do not assign the same season number to different arcs.
Your response must only be the raw JSON object, without any markdown formatting, comments, or other text.
            `.trim();

            const res = await fetch(this.AI_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                }),
                signal: AbortSignal.timeout(15000)
            });

            if (!res.ok) return null;

            const data = (await res.json()) as {
                candidates?: Array<{
                    content?: {
                        parts?: Array<{ text?: string }>;
                    };
                }>;
            };

            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) return null;

            const firstBracket = text.indexOf('{');
            const lastBracket = text.lastIndexOf('}');
            if (firstBracket === -1 || lastBracket === -1) return null;

            const jsonString = text.substring(firstBracket, lastBracket + 1);
            return JSON.parse(jsonString) as {
                results: Array<{ id?: string; season?: number }>;
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
