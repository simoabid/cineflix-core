/**
 * Laptop playability probe (resolve ≠ playback).
 *
 * Usage (from cineflix-core, proxy OFF):
 *   env -u PROXY_URL -u SCRAPE_PROXY_URL SCRAPE_PROXY_MODE=off npx tsx scripts/probe-playable.mts
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseProvider } from '@omss/framework';
import type { ProviderResult } from '@omss/framework';
import {
    filterPlayableSources,
    probeSource,
    type ProbeableSource
} from '../src/utils/streamProbe.js';

process.env.SCRAPE_PROXY_MODE = 'off';
delete process.env.PROXY_URL;
delete process.env.SCRAPE_PROXY_URL;

const movieMedia = {
    type: 'movie' as const,
    tmdbId: '155',
    imdbId: 'tt0468569',
    title: 'The Dark Knight',
    releaseYear: '2008'
};

const PRIORITY_IDS = [
    'vidsrc',
    'hexa',
    'vidlink',
    'fsharetv',
    'lookmovie',
    'm111movies',
    'vidcore',
    'vidnest',
    'vidrock',
    'vixsrc',
    'Peachify',
    'Videasy',
    'vidup',
    'vidking',
    'Icefy'
];

function unwrapProxyUrl(url: string): {
    raw: string;
    headers?: Record<string, string>;
} {
    try {
        const u = new URL(url);
        const dataParam = u.searchParams.get('data');
        if (dataParam) {
            try {
                const parsed = JSON.parse(decodeURIComponent(dataParam)) as {
                    url?: string;
                    headers?: Record<string, string>;
                };
                if (parsed?.url) {
                    return { raw: parsed.url, headers: parsed.headers };
                }
            } catch {
                if (dataParam.startsWith('http')) return { raw: dataParam };
            }
        }
        const b64 = u.searchParams.get('url');
        if (b64) {
            try {
                const decoded = Buffer.from(b64, 'base64').toString('utf8');
                if (decoded.startsWith('http')) return { raw: decoded };
                const parsed = JSON.parse(decoded) as {
                    url?: string;
                    headers?: Record<string, string>;
                };
                if (parsed?.url) {
                    return { raw: parsed.url, headers: parsed.headers };
                }
            } catch {
                if (b64.startsWith('http')) return { raw: b64 };
            }
        }
    } catch {
        /* keep original */
    }
    return { raw: url };
}

async function discoverProviders(): Promise<BaseProvider[]> {
    const __filename = fileURLToPath(import.meta.url);
    const providersDir = path.resolve(
        path.dirname(__filename),
        '../src/providers'
    );
    const providers: BaseProvider[] = [];
    const entries = fs.readdirSync(providersDir, { withFileTypes: true });
    const ext = '.ts';

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const dirPath = path.join(providersDir, entry.name);
        const files = fs.readdirSync(dirPath).filter((f) => {
            if (!f.endsWith(ext)) return false;
            if (f.includes('.test.') || f.includes('.types.')) return false;
            if (f === `test${ext}`) return false;
            if (
                /decrypt|encrypt|decryptor|mapper|Crypto|crypto|Client|VM|Wasm|capSolver/i.test(
                    f
                ) &&
                f !== `${entry.name}${ext}`
            ) {
                return false;
            }
            return true;
        });

        for (const file of files) {
            try {
                const module = await import(path.join(dirPath, file));
                for (const exported of Object.values(module)) {
                    if (typeof exported !== 'function') continue;
                    const proto = (exported as Function).prototype;
                    const isProvider =
                        proto instanceof BaseProvider ||
                        (proto && typeof proto.getMovieSources === 'function');
                    if (!isProvider) continue;
                    try {
                        providers.push(
                            new (exported as new () => BaseProvider)()
                        );
                    } catch {
                        /* ctor */
                    }
                }
            } catch {
                /* import */
            }
        }
    }
    return providers;
}

type Row = {
    id: string;
    scraped: number;
    probed: number;
    playable: number;
    scrapeMs: number;
    samples: Array<{
        label: string;
        ok: boolean;
        reason?: string;
        detail?: string;
        urlPreview: string;
    }>;
    error?: string;
};

async function main() {
    const all = await discoverProviders();
    const byId = new Map(all.map((p) => [p.id, p]));
    const rows: Row[] = [];

    console.log(
        `Discovered ${all.length} providers; probing ${PRIORITY_IDS.length} priority ids (proxy OFF)\n`
    );

    for (const id of PRIORITY_IDS) {
        const provider =
            byId.get(id) ||
            all.find((p) => p.id.toLowerCase() === id.toLowerCase());
        if (!provider) {
            console.log(`? ${id}: not discovered`);
            rows.push({
                id,
                scraped: 0,
                probed: 0,
                playable: 0,
                scrapeMs: 0,
                samples: [],
                error: 'not discovered'
            });
            continue;
        }
        if (!provider.enabled) {
            console.log(`o ${provider.id}: disabled`);
            continue;
        }

        const t0 = Date.now();
        let result: ProviderResult;
        try {
            result = await Promise.race([
                provider.getMovieSources(movieMedia as never),
                new Promise<never>((_, rej) =>
                    setTimeout(
                        () => rej(new Error('scrape timeout 45s')),
                        45_000
                    )
                )
            ]);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`x ${provider.id}: scrape error — ${msg}`);
            rows.push({
                id: provider.id,
                scraped: 0,
                probed: 0,
                playable: 0,
                scrapeMs: Date.now() - t0,
                samples: [],
                error: msg
            });
            continue;
        }

        const scraped = result.sources?.length ?? 0;
        const probeables: ProbeableSource[] = (result.sources ?? [])
            .slice(0, 4)
            .map((s, i) => {
                const unwrapped = unwrapProxyUrl(s.url);
                const headers = {
                    ...(unwrapped.headers ?? {}),
                    ...((s as { headers?: Record<string, string> }).headers ??
                        {})
                };
                return {
                    url: unwrapped.raw,
                    headers: Object.keys(headers).length ? headers : undefined,
                    label:
                        (s as { quality?: string; server?: string }).quality ||
                        (s as { server?: string }).server ||
                        s.type ||
                        `src-${i + 1}`,
                    type: s.type
                };
            });

        console.log(
            `\n=== ${provider.id}: scraped ${scraped}, probing ${probeables.length} ===`
        );
        if (probeables.length === 0) {
            const diags = (result.diagnostics ?? [])
                .map((d) => d.message)
                .filter(Boolean)
                .slice(0, 2);
            console.log(`  empty scrape ${diags.join(' | ')}`);
            rows.push({
                id: provider.id,
                scraped: 0,
                probed: 0,
                playable: 0,
                scrapeMs: Date.now() - t0,
                samples: [],
                error: diags.join(' | ') || 'empty'
            });
            continue;
        }

        const detailed = await Promise.all(
            probeables.map((s) =>
                probeSource(s, {
                    timeoutMs: 8_000,
                    viaProxy: false,
                    mode: 'quick'
                })
            )
        );
        const kept = await filterPlayableSources(probeables, {
            timeoutMs: 8_000,
            maxSources: 4,
            viaProxy: false,
            mode: 'quick'
        });

        const samples = detailed.map((r) => ({
            label: r.source.label || 'src',
            ok: r.ok,
            reason: r.ok ? undefined : r.reason,
            detail: r.ok ? undefined : r.detail.slice(0, 180),
            urlPreview: r.source.url.slice(0, 100)
        }));

        for (const s of samples) {
            if (s.ok) {
                console.log(`  + OK  ${s.label}: ${s.urlPreview}`);
            } else {
                console.log(
                    `  - FAIL ${s.label}: ${s.reason} — ${s.detail ?? ''}`
                );
            }
        }
        console.log(
            `  => playable ${kept.length}/${probeables.length} (filterPlayableSources)`
        );

        rows.push({
            id: provider.id,
            scraped,
            probed: probeables.length,
            playable: kept.length,
            scrapeMs: Date.now() - t0,
            samples
        });
    }

    console.log('\n\n======== PLAYABILITY SUMMARY (laptop, proxy OFF) ========');
    for (const r of rows) {
        if (r.error && r.scraped === 0) {
            console.log(
                `${r.id.padEnd(14)} scrape-fail  ${r.error.slice(0, 80)}`
            );
        } else {
            const flag =
                r.playable > 0
                    ? 'PLAYABLE'
                    : r.scraped > 0
                      ? 'SCRAPE-ONLY'
                      : 'EMPTY';
            console.log(
                `${r.id.padEnd(14)} ${flag.padEnd(12)} scrape=${r.scraped} playable=${r.playable}/${r.probed} (${r.scrapeMs}ms)`
            );
        }
    }

    const out = path.resolve('scripts/playability-report.json');
    fs.writeFileSync(
        out,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                egress: 'laptop-residential-proxy-off',
                media: movieMedia,
                rows
            },
            null,
            2
        )
    );
    console.log(`\nWrote ${out}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
