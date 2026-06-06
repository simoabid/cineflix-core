import 'dotenv/config';
import { BaseProvider } from '@omss/framework';

// ANSI color codes
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const movieMedia = {
    type: 'movie' as const,
    tmdbId: '155',
    imdbId: 'tt0468569',
    title: 'The Dark Knight',
    releaseYear: '2008'
};

const tvMedia = {
    type: 'tv' as const,
    tmdbId: '1399',
    imdbId: 'tt0944947',
    title: 'Game of Thrones',
    releaseYear: '2011',
    s: 1,
    e: 1
};

type TestResult = {
    id: string;
    name: string;
    enabled: boolean;
    movieSources: number;
    movieSubtitles: number;
    movieError: string | null;
    tvSources: number;
    tvSubtitles: number;
    tvError: string | null;
    duration: number;
};

async function discoverProviders(): Promise<BaseProvider[]> {
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const fs = await import('node:fs');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const providersDir = path.join(__dirname, 'providers');

    const providers: BaseProvider[] = [];
    const entries = fs.readdirSync(providersDir, { withFileTypes: true });

    // Support both .ts (tsx) and .js (compiled) execution
    const ext = __filename.endsWith('.ts') ? '.ts' : '.js';

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(providersDir, entry.name);
        const files = fs.readdirSync(dirPath).filter((f) => {
            if (!f.endsWith(ext)) return false;
            if (f.includes('.test.')) return false;
            if (f.includes('.types.')) return false;
            if (f === `test${ext}`) return false;
            if (f.includes('decrypt') || f.includes('encrypt') || f.includes('decryptor')) return false;
            if (f.includes('mapper')) return false;
            return true;
        });

        for (const file of files) {
            try {
                const filePath = path.join(dirPath, file);
                const module = await import(filePath);
                for (const exported of Object.values(module)) {
                    if (typeof exported !== 'function') continue;
                    // Check if it's a BaseProvider subclass
                    const isProvider =
                        exported.prototype instanceof BaseProvider ||
                        (exported.prototype &&
                            typeof exported.prototype.getMovieSources === 'function' &&
                            typeof exported.prototype.getTVSources === 'function');
                    if (isProvider) {
                        try {
                            providers.push(new (exported as any)());
                        } catch {}
                    }
                }
            } catch {}
        }
    }

    return providers;
}

async function testProvider(provider: BaseProvider): Promise<TestResult> {
    const start = Date.now();
    const result: TestResult = {
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled,
        movieSources: 0,
        movieSubtitles: 0,
        movieError: null,
        tvSources: 0,
        tvSubtitles: 0,
        tvError: null,
        duration: 0
    };

    // Test movie
    if (provider.capabilities.supportedContentTypes.includes('movies')) {
        try {
            const r = await Promise.race([
                provider.getMovieSources(movieMedia),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout (60s)')), 60000)
                )
            ]);
            result.movieSources = r.sources.length;
            result.movieSubtitles = r.subtitles.length;
        } catch (err) {
            result.movieError = err instanceof Error ? err.message : 'Unknown error';
        }
    }

    // Test TV
    if (provider.capabilities.supportedContentTypes.includes('tv')) {
        try {
            const r = await Promise.race([
                provider.getTVSources(tvMedia),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout (60s)')), 60000)
                )
            ]);
            result.tvSources = r.sources.length;
            result.tvSubtitles = r.subtitles.length;
        } catch (err) {
            result.tvError = err instanceof Error ? err.message : 'Unknown error';
        }
    }

    result.duration = Date.now() - start;
    return result;
}

function printResult(result: TestResult) {
    const movieOk = result.movieError === null && result.movieSources > 0;
    const tvOk = result.tvError === null && result.tvSources > 0;
    const hasMovie = result.movieError !== null || result.movieSources > 0 || result.movieSubtitles > 0;
    const hasTv = result.tvError !== null || result.tvSources > 0 || result.tvSubtitles > 0;

    const anyWorking = movieOk || tvOk;
    const statusColor = !result.enabled ? YELLOW : anyWorking ? GREEN : RED;
    const statusText = !result.enabled ? 'DISABLED' : anyWorking ? 'WORKING' : 'FAILED';

    const icon = !result.enabled ? '○' : anyWorking ? '✓' : '✗';

    console.log(
        `${statusColor}${icon} ${statusText.padEnd(10)}${RESET} ` +
        `${BOLD}${result.name.padEnd(25)}${RESET} ` +
        `${DIM}(${result.id})${RESET} ` +
        `${DIM}${result.duration}ms${RESET}`
    );

    // Movie details
    if (hasMovie) {
        const mColor = movieOk ? GREEN : result.movieError ? RED : DIM;
        const mText = movieOk
            ? `${result.movieSources} sources, ${result.movieSubtitles} subtitles`
            : result.movieError || 'no sources';
        console.log(`  ${DIM}├─ Movie:${RESET} ${mColor}${mText}${RESET}`);
    }

    // TV details
    if (hasTv) {
        const tColor = tvOk ? GREEN : result.tvError ? RED : DIM;
        const tText = tvOk
            ? `${result.tvSources} sources, ${result.tvSubtitles} subtitles`
            : result.tvError || 'no sources';
        console.log(`  ${DIM}└─ TV:   ${RESET} ${tColor}${tText}${RESET}`);
    }
}

async function main() {
    console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${BOLD}${CYAN}║        CinePro Core — Provider Test Runner          ║${RESET}`);
    console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}\n`);

    console.log(`${DIM}Discovering providers...${RESET}`);
    const providers = await discoverProviders();
    console.log(`${DIM}Found ${providers.length} providers. Testing...\n${RESET}`);

    const results: TestResult[] = [];
    const enabled = providers.filter((p) => p.enabled);
    const disabled = providers.filter((p) => !p.enabled);

    // Test enabled providers in parallel (batches of 5)
    console.log(`${BOLD}━━━ Testing ${enabled.length} Enabled Providers ━━━${RESET}\n`);
    for (let i = 0; i < enabled.length; i += 5) {
        const batch = enabled.slice(i, i + 5);
        const batchResults = await Promise.all(batch.map(testProvider));
        for (const r of batchResults) {
            printResult(r);
            results.push(r);
        }
    }

    // Test disabled providers (just instantiation, no network calls)
    if (disabled.length > 0) {
        console.log(`\n${BOLD}━━━ ${disabled.length} Disabled Providers ━━━${RESET}\n`);
        for (const p of disabled) {
            const r: TestResult = {
                id: p.id,
                name: p.name,
                enabled: false,
                movieSources: 0,
                movieSubtitles: 0,
                movieError: null,
                tvSources: 0,
                tvSubtitles: 0,
                tvError: null,
                duration: 0
            };
            printResult(r);
            results.push(r);
        }
    }

    // Summary
    const working = results.filter(
        (r) => r.enabled && (r.movieSources > 0 || r.tvSources > 0)
    );
    const failed = results.filter(
        (r) => r.enabled && r.movieSources === 0 && r.tvSources === 0
    );

    console.log(`\n${BOLD}${CYAN}══════════════════════ Summary ══════════════════════${RESET}\n`);
    console.log(`  ${GREEN}${BOLD}✓ Working:${RESET}  ${GREEN}${working.length}${RESET} providers`);
    console.log(`  ${RED}${BOLD}✗ Failed:${RESET}   ${RED}${failed.length}${RESET} providers`);
    console.log(`  ${YELLOW}${BOLD}○ Disabled:${RESET} ${YELLOW}${disabled.length}${RESET} providers`);
    console.log(`  ${DIM}Total:${RESET}      ${results.length} providers\n`);

    if (working.length > 0) {
        console.log(`${GREEN}${BOLD}Working providers:${RESET}`);
        for (const r of working) {
            const sources = Math.max(r.movieSources, r.tvSources);
            console.log(`  ${GREEN}✓${RESET} ${r.name} ${DIM}(${r.id})${RESET} — ${sources} sources`);
        }
    }

    if (failed.length > 0) {
        console.log(`\n${RED}${BOLD}Failed providers:${RESET}`);
        for (const r of failed) {
            const err = r.movieError || r.tvError || 'no sources returned';
            console.log(`  ${RED}✗${RESET} ${r.name} ${DIM}(${r.id})${RESET} — ${err}`);
        }
    }

    console.log('');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
