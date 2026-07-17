/**
 * Progressive single-provider scrape helpers for CinePro Core.
 *
 * Used by custom routes so the SPA can waterfall providers (best → worst)
 * and start playback without waiting for bulk Promise.allSettled.
 */
import type { ProviderRegistry } from '@omss/framework';
import {
    getProviderTimeoutMs,
    orderedEnabledProviderIds,
    getProviderTier
} from './providerPriority.js';

export type ProgressiveMedia =
    | {
          type: 'movie';
          tmdbId: string;
          title: string;
          releaseYear?: string;
          imdbId?: string;
      }
    | {
          type: 'tv';
          tmdbId: string;
          title: string;
          releaseYear?: string;
          imdbId?: string;
          s: number;
          e: number;
      };

type TmdbMovie = {
    title?: string;
    release_date?: string;
    external_ids?: { imdb_id?: string | null };
};

type TmdbTv = {
    name?: string;
    first_air_date?: string;
    external_ids?: { imdb_id?: string | null };
};

async function tmdbFetch<T>(path: string): Promise<T> {
    const key = process.env.TMDB_API_KEY;
    if (!key) {
        throw new Error('TMDB_API_KEY not configured');
    }
    const url = `https://api.themoviedb.org/3${path}${
        path.includes('?') ? '&' : '?'
    }api_key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000)
    });
    if (!res.ok) {
        throw new Error(`TMDB HTTP ${res.status} for ${path}`);
    }
    return (await res.json()) as T;
}

export async function buildProgressiveMedia(
    type: 'movie' | 'tv',
    tmdbId: string,
    season?: number,
    episode?: number
): Promise<ProgressiveMedia> {
    if (type === 'movie') {
        const d = await tmdbFetch<TmdbMovie>(
            `/movie/${encodeURIComponent(tmdbId)}?append_to_response=external_ids`
        );
        return {
            type: 'movie',
            tmdbId: String(tmdbId),
            title: d.title ?? 'Unknown',
            releaseYear: d.release_date?.slice(0, 4),
            imdbId: d.external_ids?.imdb_id ?? undefined
        };
    }

    const s = season ?? 1;
    const e = episode ?? 1;
    const d = await tmdbFetch<TmdbTv>(
        `/tv/${encodeURIComponent(tmdbId)}?append_to_response=external_ids`
    );
    return {
        type: 'tv',
        tmdbId: String(tmdbId),
        title: d.name ?? 'Unknown',
        releaseYear: d.first_air_date?.slice(0, 4),
        imdbId: d.external_ids?.imdb_id ?? undefined,
        s,
        e
    };
}

function toProviderMedia(media: ProgressiveMedia): Record<string, unknown> {
    if (media.type === 'movie') {
        return {
            type: 'movie',
            tmdbId: media.tmdbId,
            title: media.title,
            releaseYear: media.releaseYear,
            imdbId: media.imdbId ?? ''
        };
    }
    return {
        type: 'tv',
        tmdbId: media.tmdbId,
        title: media.title,
        releaseYear: media.releaseYear,
        imdbId: media.imdbId ?? '',
        s: media.s,
        e: media.e
    };
}

async function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} timed out after ${ms}ms`)),
                    ms
                );
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export type SingleProviderResult = {
    sources: unknown[];
    subtitles: unknown[];
    diagnostics: unknown[];
    providerId: string;
    providerName: string;
    durationMs: number;
};

/**
 * Scrape a single registered provider. Returns empty sources on soft failure.
 */
export async function scrapeSingleProvider(
    registry: ProviderRegistry,
    providerId: string,
    media: ProgressiveMedia
): Promise<SingleProviderResult> {
    const providers = registry.getProviders() as Array<{
        id: string;
        name: string;
        enabled: boolean;
        getMovieSources: (m: unknown) => Promise<{
            sources: unknown[];
            subtitles: unknown[];
            diagnostics: unknown[];
        }>;
        getTVSources: (m: unknown) => Promise<{
            sources: unknown[];
            subtitles: unknown[];
            diagnostics: unknown[];
        }>;
    }>;

    const provider = providers.find((p) => p.id === providerId);
    if (!provider) {
        const err = new Error(`Provider not found: ${providerId}`);
        (err as Error & { statusCode?: number }).statusCode = 404;
        throw err;
    }
    if (!provider.enabled) {
        const err = new Error(`Provider disabled: ${providerId}`);
        (err as Error & { statusCode?: number }).statusCode = 404;
        throw err;
    }

    const timeoutMs = getProviderTimeoutMs(providerId);
    const payload = toProviderMedia(media);
    const start = Date.now();

    try {
        const result = await withTimeout(
            media.type === 'movie'
                ? provider.getMovieSources(payload)
                : provider.getTVSources(payload),
            timeoutMs,
            provider.name
        );

        return {
            sources: Array.isArray(result.sources) ? result.sources : [],
            subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
            diagnostics: Array.isArray(result.diagnostics)
                ? result.diagnostics
                : [],
            providerId: provider.id,
            providerName: provider.name,
            durationMs: Date.now() - start
        };
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Unknown provider error';
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${provider.name}: ${message}`,
                    field: '',
                    severity: 'error'
                }
            ],
            providerId: provider.id,
            providerName: provider.name,
            durationMs: Date.now() - start
        };
    }
}

export function listProvidersWithPriority(registry: ProviderRegistry): Array<{
    id: string;
    name: string;
    enabled: boolean;
    priority: number;
    tier: string | null;
}> {
    const providers = registry.getProviders() as Array<{
        id: string;
        name: string;
        enabled: boolean;
    }>;
    const orderedIds = orderedEnabledProviderIds(providers);
    const orderIndex = new Map(orderedIds.map((id, i) => [id, i]));

    return providers
        .map((p) => ({
            id: p.id,
            name: p.name,
            enabled: p.enabled,
            priority: orderIndex.get(p.id) ?? 10_000,
            tier: getProviderTier(p.id)
        }))
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
