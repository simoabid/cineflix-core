/**
 * Provider health audit — resolve movies/TV per provider, no server required.
 *
 *   npx tsx scripts/audit-providers.mts
 *   npx tsx scripts/audit-providers.mts --enabled-only
 *   npx tsx scripts/audit-providers.mts --provider vidsrc,icefy
 *
 * Exit 0 always (report is the product). Writes scripts/audit-providers-report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PROVIDERS_DIR = path.join(ROOT, 'src/providers');

const MOVIES = [
    {
        type: 'movie' as const,
        tmdbId: '155',
        imdbId: 'tt0468569',
        title: 'The Dark Knight',
        releaseYear: '2008'
    },
    {
        type: 'movie' as const,
        tmdbId: '238',
        imdbId: 'tt0068646',
        title: 'The Godfather',
        releaseYear: '1972'
    },
    {
        type: 'movie' as const,
        tmdbId: '27205',
        imdbId: 'tt1375666',
        title: 'Inception',
        releaseYear: '2010'
    }
];

const TV = [
    {
        type: 'tv' as const,
        tmdbId: '1399',
        imdbId: 'tt0944947',
        title: 'Game of Thrones',
        releaseYear: '2011',
        s: 1,
        e: 1
    },
    {
        type: 'tv' as const,
        tmdbId: '1396',
        imdbId: 'tt0903747',
        title: 'Breaking Bad',
        releaseYear: '2008',
        s: 1,
        e: 1
    }
];

const DEFAULT_TIMEOUT_MS = 28_000;
const LONG_TIMEOUT_MS = 45_000;
const LONG_IDS = new Set([
    'vidsrc',
    'vidking',
    'vidup',
    'm111movies',
    'vidnest',
    'vidrock',
    'vidsync',
    'vidcore',
    'vidfast'
]);

type Outcome =
    | 'ok'
    | 'empty'
    | 'error'
    | 'timeout'
    | 'skip_capability'
    | 'disabled'
    | 'load_error';

interface CallResult {
    title: string;
    tmdbId: string;
    kind: 'movie' | 'tv';
    outcome: Outcome;
    sources: number;
    subtitles: number;
    ms: number;
    error?: string;
    sampleUrl?: string;
}

interface ProviderReport {
    dir: string;
    id: string;
    name: string;
    enabled: boolean;
    className: string;
    modulePath: string;
    capabilities: string[];
    calls: CallResult[];
    score: {
        ok: number;
        empty: number;
        error: number;
        timeout: number;
        totalAttempts: number;
    };
    verdict: 'works' | 'partial' | 'broken' | 'disabled' | 'load_error';
}

function parseArgs() {
    const args = process.argv.slice(2);
    const enabledOnly = args.includes('--enabled-only');
    const pIdx = args.findIndex((a) => a === '--provider' || a === '-p');
    const filter =
        pIdx >= 0 && args[pIdx + 1]
            ? new Set(
                  args[pIdx + 1]
                      .split(',')
                      .map((s) => s.trim().toLowerCase())
                      .filter(Boolean)
              )
            : null;
    return { enabledOnly, filter };
}

function discoverProviders(): {
    dir: string;
    modulePath: string;
    className: string;
    id: string;
    name: string;
    enabled: boolean;
    caps: string[];
}[] {
    const out: ReturnType<typeof discoverProviders> = [];
    for (const dir of fs.readdirSync(PROVIDERS_DIR).sort()) {
        if (dir.startsWith('_') || dir === 'utils') continue;
        const main = path.join(PROVIDERS_DIR, dir, `${dir}.ts`);
        if (!fs.existsSync(main)) continue;
        const text = fs.readFileSync(main, 'utf8');
        const className = text.match(/export class (\w+)/)?.[1];
        if (!className) continue;
        const id =
            text.match(/readonly id\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? dir;
        const name =
            text.match(/readonly name\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? dir;
        const enabled =
            (text.match(/readonly enabled\s*=\s*(true|false)/)?.[1] ??
                'true') === 'true';
        const capsRaw =
            text.match(/supportedContentTypes:\s*\[([^\]]+)\]/)?.[1] ?? '';
        const caps = [...capsRaw.matchAll(/['"]([^'"]+)['"]/g)].map(
            (m) => m[1]
        );
        out.push({
            dir,
            modulePath: main,
            className,
            id,
            name,
            enabled,
            caps
        });
    }
    return out;
}

async function withTimeout<T>(
    p: Promise<T>,
    ms: number
): Promise<{ ok: true; value: T } | { ok: false; timeout: true }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const value = await Promise.race([
            p,
            new Promise<never>((_, rej) => {
                timer = setTimeout(() => rej(new Error('__TIMEOUT__')), ms);
            })
        ]);
        return { ok: true, value };
    } catch (e) {
        if (e instanceof Error && e.message === '__TIMEOUT__') {
            return { ok: false, timeout: true };
        }
        throw e;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function runCall(
    provider: any,
    media: (typeof MOVIES)[0] | (typeof TV)[0],
    timeoutMs: number
): Promise<CallResult> {
    const kind = media.type;
    const title = media.title;
    const tmdbId = media.tmdbId;
    const start = Date.now();
    try {
        const method =
            kind === 'movie'
                ? provider.getMovieSources.bind(provider)
                : provider.getTVSources.bind(provider);
        const raced = await withTimeout(method(media), timeoutMs);
        const ms = Date.now() - start;
        if (!raced.ok) {
            return {
                title,
                tmdbId,
                kind,
                outcome: 'timeout',
                sources: 0,
                subtitles: 0,
                ms,
                error: `timeout ${timeoutMs}ms`
            };
        }
        const result = raced.value as {
            sources?: unknown[];
            subtitles?: unknown[];
            diagnostics?: { message?: string }[];
        };
        const sources = Array.isArray(result.sources)
            ? result.sources.length
            : 0;
        const subtitles = Array.isArray(result.subtitles)
            ? result.subtitles.length
            : 0;
        const sampleUrl =
            sources > 0 &&
            result.sources &&
            typeof (result.sources[0] as { url?: string })?.url === 'string'
                ? String((result.sources[0] as { url: string }).url).slice(
                      0,
                      100
                  )
                : undefined;
        if (sources === 0) {
            const diag =
                result.diagnostics
                    ?.map((d) => d.message)
                    .filter(Boolean)
                    .slice(0, 2)
                    .join('; ') || undefined;
            return {
                title,
                tmdbId,
                kind,
                outcome: 'empty',
                sources: 0,
                subtitles,
                ms,
                error: diag
            };
        }
        return {
            title,
            tmdbId,
            kind,
            outcome: 'ok',
            sources,
            subtitles,
            ms,
            sampleUrl
        };
    } catch (e) {
        const ms = Date.now() - start;
        return {
            title,
            tmdbId,
            kind,
            outcome: 'error',
            sources: 0,
            subtitles: 0,
            ms,
            error: e instanceof Error ? e.message : String(e)
        };
    }
}

function verdictOf(r: ProviderReport): ProviderReport['verdict'] {
    if (!r.enabled) return 'disabled';
    if (r.calls.some((c) => c.outcome === 'load_error')) return 'load_error';
    const attempts = r.score.totalAttempts;
    if (attempts === 0) return 'broken';
    if (r.score.ok === attempts) return 'works';
    if (r.score.ok > 0) return 'partial';
    return 'broken';
}

async function auditOne(
    meta: ReturnType<typeof discoverProviders>[0]
): Promise<ProviderReport> {
    const report: ProviderReport = {
        dir: meta.dir,
        id: meta.id,
        name: meta.name,
        enabled: meta.enabled,
        className: meta.className,
        modulePath: meta.modulePath,
        capabilities: meta.caps,
        calls: [],
        score: { ok: 0, empty: 0, error: 0, timeout: 0, totalAttempts: 0 },
        verdict: 'broken'
    };

    if (!meta.enabled) {
        report.verdict = 'disabled';
        return report;
    }

    let ProviderClass: new () => any;
    try {
        const mod = await import(pathToFileURL(meta.modulePath).href);
        ProviderClass = mod[meta.className];
        if (typeof ProviderClass !== 'function') {
            throw new Error(`export ${meta.className} not found`);
        }
    } catch (e) {
        report.calls.push({
            title: '(load)',
            tmdbId: '-',
            kind: 'movie',
            outcome: 'load_error',
            sources: 0,
            subtitles: 0,
            ms: 0,
            error: e instanceof Error ? e.message : String(e)
        });
        report.verdict = 'load_error';
        return report;
    }

    const provider = new ProviderClass();
    // Silence noisy console during audit
    if (provider.console) {
        try {
            provider.console.log = () => {};
        } catch {
            /* ignore */
        }
    }

    const timeoutMs = LONG_IDS.has(meta.id.toLowerCase())
        ? LONG_TIMEOUT_MS
        : DEFAULT_TIMEOUT_MS;

    const supportsMovies =
        meta.caps.length === 0 || meta.caps.includes('movies');
    const supportsTv = meta.caps.length === 0 || meta.caps.includes('tv');

    const movieJobs = supportsMovies
        ? MOVIES
        : MOVIES.map((m) => ({ ...m, _skip: true as const }));
    const tvJobs = supportsTv
        ? TV
        : TV.map((m) => ({ ...m, _skip: true as const }));

    for (const m of MOVIES) {
        if (!supportsMovies) {
            report.calls.push({
                title: m.title,
                tmdbId: m.tmdbId,
                kind: 'movie',
                outcome: 'skip_capability',
                sources: 0,
                subtitles: 0,
                ms: 0
            });
            continue;
        }
        process.stdout.write(
            `  · movie ${m.tmdbId} ${m.title.slice(0, 20)}… `
        );
        const r = await runCall(provider, m, timeoutMs);
        report.calls.push(r);
        report.score.totalAttempts++;
        if (r.outcome === 'ok') report.score.ok++;
        else if (r.outcome === 'empty') report.score.empty++;
        else if (r.outcome === 'timeout') report.score.timeout++;
        else report.score.error++;
        console.log(
            `${r.outcome} src=${r.sources} ${r.ms}ms${r.error ? ' ' + r.error.slice(0, 60) : ''}`
        );
    }

    for (const m of TV) {
        if (!supportsTv) {
            report.calls.push({
                title: m.title,
                tmdbId: m.tmdbId,
                kind: 'tv',
                outcome: 'skip_capability',
                sources: 0,
                subtitles: 0,
                ms: 0
            });
            continue;
        }
        process.stdout.write(
            `  · tv ${m.tmdbId} S${m.s}E${m.e} ${m.title.slice(0, 18)}… `
        );
        const r = await runCall(provider, m, timeoutMs);
        report.calls.push(r);
        report.score.totalAttempts++;
        if (r.outcome === 'ok') report.score.ok++;
        else if (r.outcome === 'empty') report.score.empty++;
        else if (r.outcome === 'timeout') report.score.timeout++;
        else report.score.error++;
        console.log(
            `${r.outcome} src=${r.sources} ${r.ms}ms${r.error ? ' ' + r.error.slice(0, 60) : ''}`
        );
    }

    void movieJobs;
    void tvJobs;
    report.verdict = verdictOf(report);
    return report;
}

async function main() {
    const { enabledOnly, filter } = parseArgs();
    let list = discoverProviders();
    if (enabledOnly) list = list.filter((p) => p.enabled);
    if (filter) {
        list = list.filter(
            (p) =>
                filter.has(p.dir.toLowerCase()) ||
                filter.has(p.id.toLowerCase())
        );
    }

    console.log(
        `Auditing ${list.length} providers × ${MOVIES.length} movies × ${TV.length} TV…\n`
    );

    const reports: ProviderReport[] = [];
    for (const meta of list) {
        console.log(
            `\n== ${meta.name} (${meta.id}) enabled=${meta.enabled} [${meta.dir}] ==`
        );
        const r = await auditOne(meta);
        reports.push(r);
        console.log(`   verdict: ${r.verdict}  ok=${r.score.ok}/${r.score.totalAttempts}`);
    }

    // Summary tables
    const works = reports.filter((r) => r.verdict === 'works');
    const partial = reports.filter((r) => r.verdict === 'partial');
    const broken = reports.filter((r) => r.verdict === 'broken');
    const disabled = reports.filter((r) => r.verdict === 'disabled');
    const loadErr = reports.filter((r) => r.verdict === 'load_error');

    console.log('\n\n========== SUMMARY ==========\n');
    console.log(`WORKS (${works.length}):`);
    for (const r of works) {
        console.log(
            `  ✓ ${r.id.padEnd(16)} ${r.name.padEnd(22)} ${r.score.ok}/${r.score.totalAttempts} ok`
        );
    }
    console.log(`\nPARTIAL (${partial.length}):`);
    for (const r of partial) {
        const fails = r.calls
            .filter((c) => c.outcome !== 'ok' && c.outcome !== 'skip_capability')
            .map((c) => `${c.kind}:${c.tmdbId}=${c.outcome}`)
            .join(', ');
        console.log(
            `  ~ ${r.id.padEnd(16)} ${r.name.padEnd(22)} ${r.score.ok}/${r.score.totalAttempts}  fail: ${fails}`
        );
    }
    console.log(`\nBROKEN (${broken.length}):`);
    for (const r of broken) {
        const sample =
            r.calls.find((c) => c.error)?.error?.slice(0, 70) ||
            r.calls.map((c) => c.outcome).join(',');
        console.log(
            `  ✗ ${r.id.padEnd(16)} ${r.name.padEnd(22)} ${r.score.ok}/${r.score.totalAttempts}  ${sample}`
        );
    }
    if (loadErr.length) {
        console.log(`\nLOAD ERROR (${loadErr.length}):`);
        for (const r of loadErr) {
            console.log(
                `  ! ${r.id.padEnd(16)} ${r.calls[0]?.error?.slice(0, 80)}`
            );
        }
    }
    console.log(`\nDISABLED (skipped resolve) (${disabled.length}):`);
    for (const r of disabled) {
        console.log(`  · ${r.id.padEnd(16)} ${r.name}`);
    }

    const outPath = path.join(ROOT, 'scripts/audit-providers-report.json');
    fs.writeFileSync(
        outPath,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                movies: MOVIES.map((m) => ({
                    tmdbId: m.tmdbId,
                    title: m.title
                })),
                tv: TV.map((m) => ({
                    tmdbId: m.tmdbId,
                    title: m.title,
                    s: m.s,
                    e: m.e
                })),
                reports
            },
            null,
            2
        )
    );
    console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
