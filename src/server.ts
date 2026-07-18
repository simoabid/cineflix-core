import 'dotenv/config';
// Must load before any proxy requests: fixes host-without-scheme HLS URIs
// used by VidKing Oxygen (interkh.com child playlists) + Option B egress.
import './proxyResolvePatch.js';
import { OMSSServer } from '@omss/framework';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';
import { logScrapeProxyStatus } from './utils/scrapeFetch.js';
import {
    buildProgressiveMedia,
    listProvidersWithPriority,
    scrapeSingleProvider
} from './progressiveScrape.js';
import {
    searchWyzieSubtitles,
    wyzieKeyCount,
    wyzieKeyPoolSummary
} from './subtitles/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const server = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',

        // Network
        host: process.env.HOST ?? 'localhost',
        port: Number(process.env.PORT ?? 3000),
        publicUrl: process.env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (process.env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 60 * 60,
                subtitles: 60 * 60 * 24
            },
            redis: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
                password: process.env.REDIS_PASSWORD
            }
        },

        // TMDB
        tmdb: {
            apiKey: process.env.TMDB_API_KEY!,
            cacheTTL: 24 * 60 * 60 // 24h
        },

        // Third Party Proxy removal
        proxyConfig: {
            knownThirdPartyProxies: knownThirdPartyProxies,
            streamPatterns
        },

        cors: {
            origin: process.env.CORS_ORIGIN ?? '*',
            methods: ['GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        },

        stremio: {
            // exposes a stremio addon on /stremio/manifest.json
            enableNativeAddon: process.env.STREMIO_ADDON === 'true',
            // you can your own custom stremio addons as sources into cinepro.
            stremioAddons: []
            /*
            stremioAddons: [
                {
                    id: 'some-unique-id',
                    url: 'https://example.com/manifest.json',
                    enabled: true
                }
            ]
            */
        },

        // MCP for AI agents
        mcp: {
            enabled: process.env.MCP_ENABLED === 'true'
        }
    });

    // Register providers
    const registry = server.getRegistry();
    await registry.discoverProviders(path.join(__dirname, './providers/'));

    // Register custom routes: provider list + progressive single-provider scrape
    const fastifyApp = server.getInstance();
    fastifyApp.get('/v1/providers', async (_request, reply) => {
        return reply.code(200).send(listProvidersWithPriority(registry));
    });

    /**
     * Dedicated subtitle scrape (path B) — independent of stream providers.
     * Uses Wyzie with multi-key rotation (WYZIE_API_KEYS on server only).
     *
     * GET /v1/subtitles?tmdbId=155
     * GET /v1/subtitles?imdbId=tt0468569
     * GET /v1/subtitles?tmdbId=1396&season=1&episode=1
     */
    fastifyApp.get<{
        Querystring: {
            tmdbId?: string;
            imdbId?: string;
            id?: string;
            season?: string;
            episode?: string;
            s?: string;
            e?: string;
            language?: string;
        };
    }>('/v1/subtitles', async (request, reply) => {
        const q = request.query;
        const tmdbId = (q.tmdbId || '').trim();
        const imdbId = (q.imdbId || '').trim();
        const id = (q.id || '').trim();
        // id can be either IMDB (tt…) or TMDB numeric
        const resolvedImdb =
            imdbId || (id.startsWith('tt') ? id : undefined);
        const resolvedTmdb =
            tmdbId ||
            (!resolvedImdb && id && /^\d+$/.test(id) ? id : undefined);

        if (!resolvedImdb && !resolvedTmdb) {
            return reply.code(400).send({
                subtitles: [],
                error: 'Provide tmdbId, imdbId, or id query parameter'
            });
        }

        const seasonRaw = q.season ?? q.s;
        const episodeRaw = q.episode ?? q.e;
        const season =
            seasonRaw != null && seasonRaw !== ''
                ? Number(seasonRaw)
                : undefined;
        const episode =
            episodeRaw != null && episodeRaw !== ''
                ? Number(episodeRaw)
                : undefined;

        const result = await searchWyzieSubtitles({
            tmdbId: resolvedTmdb,
            imdbId: resolvedImdb,
            season:
                season != null && Number.isFinite(season) ? season : undefined,
            episode:
                episode != null && Number.isFinite(episode)
                    ? episode
                    : undefined,
            language: q.language
        });

        return reply.code(200).send({
            subtitles: result.subtitles,
            source: 'wyzie',
            keysTried: result.keysTried,
            keyPool: result.keyPool,
            ...(result.error ? { error: result.error } : {})
        });
    });

    /** Health/debug: whether subtitle keys are configured (never returns secrets). */
    fastifyApp.get('/v1/subtitles/status', async (_request, reply) => {
        return reply.code(200).send({
            configured: wyzieKeyCount() > 0,
            keyPool: wyzieKeyPoolSummary()
        });
    });

    // Progressive scrape: one provider only (SPA waterfall / on-demand switch)
    fastifyApp.get<{
        Params: { tmdbId: string; providerId: string };
    }>('/v1/movies/:tmdbId/providers/:providerId', async (request, reply) => {
        const { tmdbId, providerId } = request.params;
        try {
            const media = await buildProgressiveMedia('movie', tmdbId);
            const result = await scrapeSingleProvider(
                registry,
                providerId,
                media
            );
            return reply.code(200).send({
                sources: result.sources,
                subtitles: result.subtitles,
                diagnostics: result.diagnostics,
                providerId: result.providerId,
                providerName: result.providerName,
                durationMs: result.durationMs
            });
        } catch (err) {
            const status =
                (err as Error & { statusCode?: number }).statusCode ?? 500;
            const message =
                err instanceof Error ? err.message : 'Unknown error';
            return reply.code(status).send({
                sources: [],
                subtitles: [],
                diagnostics: [
                    {
                        code: 'PROVIDER_ERROR',
                        message,
                        field: '',
                        severity: 'error'
                    }
                ],
                error: message
            });
        }
    });

    fastifyApp.get<{
        Params: {
            tmdbId: string;
            season: string;
            episode: string;
            providerId: string;
        };
    }>(
        '/v1/tv/:tmdbId/seasons/:season/episodes/:episode/providers/:providerId',
        async (request, reply) => {
            const { tmdbId, season, episode, providerId } = request.params;
            const s = Number(season);
            const e = Number(episode);
            if (!Number.isFinite(s) || !Number.isFinite(e)) {
                return reply.code(400).send({
                    sources: [],
                    subtitles: [],
                    diagnostics: [],
                    error: 'Invalid season or episode'
                });
            }
            try {
                const media = await buildProgressiveMedia('tv', tmdbId, s, e);
                const result = await scrapeSingleProvider(
                    registry,
                    providerId,
                    media
                );
                return reply.code(200).send({
                    sources: result.sources,
                    subtitles: result.subtitles,
                    diagnostics: result.diagnostics,
                    providerId: result.providerId,
                    providerName: result.providerName,
                    durationMs: result.durationMs
                });
            } catch (err) {
                const status =
                    (err as Error & { statusCode?: number }).statusCode ?? 500;
                const message =
                    err instanceof Error ? err.message : 'Unknown error';
                return reply.code(status).send({
                    sources: [],
                    subtitles: [],
                    diagnostics: [
                        {
                            code: 'PROVIDER_ERROR',
                            message,
                            field: '',
                            severity: 'error'
                        }
                    ],
                    error: message
                });
            }
        }
    );

    await server.start();

    // Option B: residential scrape egress (PROXY_URL) for IP-blocked hosts.
    logScrapeProxyStatus();

    // Subtitle path B: Wyzie multi-key pool
    if (wyzieKeyCount() > 0) {
        console.log(`[subtitles] Wyzie path B ready — ${wyzieKeyPoolSummary()}`);
    } else {
        console.warn(
            '[subtitles] No WYZIE_API_KEYS set — GET /v1/subtitles will return empty. Add free keys from https://store.wyzie.io/redeem'
        );
    }

    const publicUrl =
        process.env.PUBLIC_URL ??
        `http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 3000}`;

    const uiUrl = `https://ui.cinepro.cc/?omssurl=${encodeURIComponent(publicUrl)}`;

    const title = '🚀 CinePro/ui is in public testing';
    const contrib =
        '🤝 We are looking for contributors to improve and develop!';
    const repo = 'Contribute: https://github.com/cinepro-org/ui';
    const tryIt = `🌐 Try it out: ${uiUrl} !`;
    const note =
        'You will need to give the website "access to local applications" that it works.';

    const lines = [title, '', repo, '', contrib, '', tryIt, '', note];

    // compute box width based on longest line
    const width = Math.max(...lines.map((l) => l.length)) + 2;

    const borderTop = '╭' + '─'.repeat(width) + '╮';
    const borderBottom = '╰' + '─'.repeat(width) + '╯';

    const pad = (line: string) => '│ ' + line.padEnd(width - 2, ' ') + ' │';

    console.log(`
================== CINEPRO BETA ANNOUNCEMENT ==================

${borderTop}
${lines.map(pad).join('\n')}
${borderBottom}
`);
}

main().catch(() => {
    process.exit(1);
});
