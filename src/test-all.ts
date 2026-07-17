/**
 * CinePro Core — Provider Test Runner
 *
 * Prints per-media outcomes + failure class hints so EC2 vs laptop diffs can
 * be split into IP/egress blocks vs catalog/auth/crypto/timeouts.
 *
 *   npx tsx src/test-all.ts
 *   npx tsx src/test-all.ts --json   # also writes scripts/test-all-report.json
 *
 * Exit 0 always (report is the product). CAVEAT: resolve ≠ playback; local ≠ EC2.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseProvider } from '@omss/framework';
import type { ProviderResult } from '@omss/framework';

// ANSI color codes
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const TIMEOUT_MS = 60_000;
/** Sub-second empty/error responses are usually hard network/IP rejects. */
const FAST_FAIL_MS = 800;

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

/** Heuristic buckets for triage (not perfect — always read the raw message). */
type FailureClass =
    | 'ok'
    | 'skip'
    | 'timeout'
    | 'rate_limit'
    | 'ip_or_bot_block'
    | 'network_dns_tls'
    | 'auth_or_token'
    | 'timestamp_clock'
    | 'crypto_or_decrypt'
    | 'empty_catalog'
    | 'empty_unknown'
    | 'error_other';

type MediaCall = {
    kind: 'movie' | 'tv';
    sources: number;
    subtitles: number;
    ms: number;
    error: string | null;
    diagnostics: string[];
    failureClass: FailureClass;
};

type TestResult = {
    id: string;
    name: string;
    enabled: boolean;
    duration: number;
    calls: MediaCall[];
    /** Aggregate: any media produced sources */
    working: boolean;
    /** Dominant failure class across failed media (for summary buckets) */
    primaryFailure: FailureClass | null;
};

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        writeJson:
            args.includes('--json') ||
            args.includes('-j') ||
            process.env.TEST_ALL_JSON === '1'
    };
}

function diagMessages(result: ProviderResult): string[] {
    const list = result.diagnostics ?? [];
    return list
        .map((d) => (typeof d?.message === 'string' ? d.message.trim() : ''))
        .filter(Boolean);
}

function summarizeEmpty(result: ProviderResult): string {
    const msgs = diagMessages(result);
    if (msgs.length === 0) return 'no sources returned (no diagnostics)';
    // Prefer error-severity lines first
    const errors = (result.diagnostics ?? []).filter(
        (d) => d.severity === 'error' && d.message
    );
    const pick = errors.length
        ? errors.map((d) => d.message!)
        : msgs;
    return pick.slice(0, 3).join(' | ');
}

/**
 * Classify a failed media call from message + duration.
 * Order matters: more specific patterns first.
 */
function classifyFailure(
    error: string | null,
    sources: number,
    ms: number
): FailureClass {
    if (sources > 0) return 'ok';
    const e = (error || '').toLowerCase();

    if (!error && sources === 0) {
        // Should not happen if we always set error on empty — keep fallback
        return ms < FAST_FAIL_MS ? 'ip_or_bot_block' : 'empty_unknown';
    }

    if (/timeout\s*\(/i.test(error || '') || e.includes('aborted') && e.includes('timeout')) {
        return 'timeout';
    }
    if (
        e.includes('etimedout') ||
        e.includes('timeout') && (e.includes('fetch') || e.includes('network'))
    ) {
        return 'timeout';
    }

    if (
        e.includes('429') ||
        e.includes('too many requests') ||
        e.includes('rate limit') ||
        e.includes('ratelimit')
    ) {
        return 'rate_limit';
    }

    if (
        e.includes('invalid_timestamp') ||
        e.includes('expired timestamp') ||
        e.includes('invalid or expired timestamp') ||
        e.includes('clock')
    ) {
        return 'timestamp_clock';
    }

    if (
        e.includes('enotfound') ||
        e.includes('eai_again') ||
        e.includes('getaddrinfo') ||
        e.includes('econnrefused') ||
        e.includes('econnreset') ||
        e.includes('epipe') ||
        e.includes('socket hang up') ||
        e.includes('certificate') ||
        e.includes('ssl') ||
        e.includes('tls') ||
        e.includes('cert ') ||
        e.includes('unable to verify') ||
        e.includes('network error') ||
        e.includes('fetch failed')
    ) {
        return 'network_dns_tls';
    }

    if (
        e.includes('401') ||
        e.includes('unauthorized') ||
        e.includes('bearer') ||
        e.includes('invalid credentials') ||
        e.includes('missing request token') ||
        e.includes('x-request-token') ||
        e.includes('csrf') ||
        e.includes('handshake incomplete') ||
        e.includes('could not extract page token') ||
        e.includes('generate-token')
    ) {
        return 'auth_or_token';
    }

    if (
        e.includes('decrypt') ||
        e.includes('cipher') ||
        e.includes('aes-gcm') ||
        e.includes('cap instr') ||
        e.includes('wasm') ||
        e.includes('invalid gcm') ||
        e.includes('module ') && e.includes('not found')
    ) {
        return 'crypto_or_decrypt';
    }

    // Explicit bot / IP / edge blocks (require stronger signal than bare 5xx)
    if (
        e.includes('403') ||
        e.includes('451') ||
        e.includes('521') ||
        e.includes('522') ||
        e.includes('523') ||
        e.includes('524') ||
        e.includes('525') ||
        e.includes('captcha') ||
        e.includes('cloudflare') ||
        e.includes('cf-ray') ||
        e.includes('access denied') ||
        e.includes('forbidden') ||
        e.includes('bot detected') ||
        e.includes('not available in your region') ||
        e.includes('unavailable for legal reasons') ||
        e.includes('just a moment') ||
        e.includes('attention required') ||
        // "blocked by" / "ip blocked" — not every "no sources" message
        e.includes('blocked by') ||
        e.includes('ip block') ||
        e.includes('datacenter') ||
        e.includes('vpn detected')
    ) {
        return 'ip_or_bot_block';
    }

    // Soft empty / catalog
    if (
        e.includes('not found') ||
        e.includes('no matching') ||
        e.includes('no kisskh match') ||
        e.includes('media not found') ||
        e.includes('no servers') ||
        e.includes('no playable') ||
        e.includes('no sources') ||
        e.includes('no stream') ||
        e.includes('no decryptable')
    ) {
        return 'empty_catalog';
    }

    // Bare upstream 5xx without body detail — keep as OTHER (may be rate-limit
    // wrapped as 500, or origin outage). Do NOT auto-label as IP block.
    if (/\bstatus\s*5\d\d\b/.test(e) || /\bhttp\s*5\d\d\b/.test(e)) {
        return 'error_other';
    }

    // Fast fail with almost no message → likely hard egress reject
    if (
        ms < FAST_FAIL_MS &&
        (e.length < 40 ||
            e === 'no sources returned (no diagnostics)' ||
            e.includes('fetch failed'))
    ) {
        return 'ip_or_bot_block';
    }

    return 'error_other';
}

function pickPrimaryFailure(calls: MediaCall[]): FailureClass | null {
    const failed = calls.filter((c) => c.failureClass !== 'ok' && c.failureClass !== 'skip');
    if (failed.length === 0) return null;
    // Prefer non-empty_unknown classes that explain "why"
    const priority: FailureClass[] = [
        'ip_or_bot_block',
        'network_dns_tls',
        'rate_limit',
        'auth_or_token',
        'timestamp_clock',
        'crypto_or_decrypt',
        'timeout',
        'empty_catalog',
        'error_other',
        'empty_unknown'
    ];
    for (const p of priority) {
        if (failed.some((c) => c.failureClass === p)) return p;
    }
    return failed[0]!.failureClass;
}

const CLASS_LABEL: Record<FailureClass, string> = {
    ok: 'OK',
    skip: 'skipped',
    timeout: 'TIMEOUT',
    rate_limit: 'RATE_LIMIT',
    ip_or_bot_block: 'IP/BOT_BLOCK (likely egress)',
    network_dns_tls: 'NETWORK/DNS/TLS',
    auth_or_token: 'AUTH/TOKEN',
    timestamp_clock: 'TIMESTAMP/CLOCK',
    crypto_or_decrypt: 'CRYPTO/DECRYPT',
    empty_catalog: 'EMPTY_CATALOG',
    empty_unknown: 'EMPTY_UNKNOWN',
    error_other: 'OTHER'
};

const CLASS_COLOR: Record<FailureClass, string> = {
    ok: GREEN,
    skip: DIM,
    timeout: YELLOW,
    rate_limit: MAGENTA,
    ip_or_bot_block: RED,
    network_dns_tls: RED,
    auth_or_token: YELLOW,
    timestamp_clock: YELLOW,
    crypto_or_decrypt: YELLOW,
    empty_catalog: CYAN,
    empty_unknown: DIM,
    error_other: YELLOW
};

async function discoverProviders(): Promise<BaseProvider[]> {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const providersDir = path.join(__dirname, 'providers');

    const providers: BaseProvider[] = [];
    const entries = fs.readdirSync(providersDir, { withFileTypes: true });
    const ext = __filename.endsWith('.ts') ? '.ts' : '.js';

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_')) continue;
        const dirPath = path.join(providersDir, entry.name);
        const files = fs.readdirSync(dirPath).filter((f) => {
            if (!f.endsWith(ext)) return false;
            if (f.includes('.test.')) return false;
            if (f.includes('.types.')) return false;
            if (f === `test${ext}`) return false;
            if (
                f.includes('decrypt') ||
                f.includes('encrypt') ||
                f.includes('decryptor')
            ) {
                return false;
            }
            if (f.includes('mapper')) return false;
            if (f.includes('Crypto') || f.includes('crypto')) return false;
            if (f.includes('Client') || f.includes('VM') || f.includes('Wasm')) {
                // Keep main provider file only (e.g. m111movies.ts not *Client*)
                if (f !== `${entry.name}${ext}`) return false;
            }
            return true;
        });

        for (const file of files) {
            try {
                const filePath = path.join(dirPath, file);
                const module = await import(filePath);
                for (const exported of Object.values(module)) {
                    if (typeof exported !== 'function') continue;
                    const isProvider =
                        exported.prototype instanceof BaseProvider ||
                        (exported.prototype &&
                            typeof exported.prototype.getMovieSources ===
                                'function' &&
                            typeof exported.prototype.getTVSources ===
                                'function');
                    if (isProvider) {
                        try {
                            providers.push(
                                new (exported as new () => BaseProvider)()
                            );
                        } catch {
                            /* ignore ctor failures */
                        }
                    }
                }
            } catch {
                /* ignore import failures */
            }
        }
    }

    return providers;
}

async function runMediaCall(
    provider: BaseProvider,
    kind: 'movie' | 'tv'
): Promise<MediaCall> {
    const caps = provider.capabilities.supportedContentTypes;
    if (kind === 'movie' && !caps.includes('movies')) {
        return {
            kind,
            sources: 0,
            subtitles: 0,
            ms: 0,
            error: null,
            diagnostics: [],
            failureClass: 'skip'
        };
    }
    if (kind === 'tv' && !caps.includes('tv')) {
        return {
            kind,
            sources: 0,
            subtitles: 0,
            ms: 0,
            error: null,
            diagnostics: [],
            failureClass: 'skip'
        };
    }

    const media = kind === 'movie' ? movieMedia : tvMedia;
    const method =
        kind === 'movie'
            ? provider.getMovieSources.bind(provider)
            : provider.getTVSources.bind(provider);

    const start = Date.now();
    try {
        const r = (await Promise.race([
            method(media),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error(`Timeout (${TIMEOUT_MS / 1000}s)`)),
                    TIMEOUT_MS
                )
            )
        ])) as ProviderResult;

        const ms = Date.now() - start;
        const sources = Array.isArray(r.sources) ? r.sources.length : 0;
        const subtitles = Array.isArray(r.subtitles) ? r.subtitles.length : 0;
        const diagnostics = diagMessages(r);

        if (sources > 0) {
            return {
                kind,
                sources,
                subtitles,
                ms,
                error: null,
                diagnostics,
                failureClass: 'ok'
            };
        }

        const error = summarizeEmpty(r);
        return {
            kind,
            sources: 0,
            subtitles,
            ms,
            error,
            diagnostics,
            failureClass: classifyFailure(error, 0, ms)
        };
    } catch (err) {
        const ms = Date.now() - start;
        const error =
            err instanceof Error ? err.message : String(err ?? 'Unknown error');
        return {
            kind,
            sources: 0,
            subtitles: 0,
            ms,
            error,
            diagnostics: [],
            failureClass: classifyFailure(error, 0, ms)
        };
    }
}

async function testProvider(provider: BaseProvider): Promise<TestResult> {
    const start = Date.now();
    // Silence provider console noise so diagnostics stay readable
    const cons = (provider as unknown as { console?: { log?: (...a: unknown[]) => void } })
        .console;
    if (cons && typeof cons.log === 'function') {
        cons.log = () => {};
    }

    const movie = await runMediaCall(provider, 'movie');
    const tv = await runMediaCall(provider, 'tv');
    const calls = [movie, tv];
    const working = calls.some((c) => c.sources > 0);

    return {
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled,
        duration: Date.now() - start,
        calls,
        working,
        primaryFailure: working ? null : pickPrimaryFailure(calls)
    };
}

function truncate(s: string, n: number): string {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function printResult(result: TestResult) {
    const statusColor = !result.enabled
        ? YELLOW
        : result.working
          ? GREEN
          : RED;
    const statusText = !result.enabled
        ? 'DISABLED'
        : result.working
          ? 'WORKING'
          : 'FAILED';
    const icon = !result.enabled ? '○' : result.working ? '✓' : '✗';

    console.log(
        `${statusColor}${icon} ${statusText.padEnd(10)}${RESET} ` +
            `${BOLD}${result.name.padEnd(25)}${RESET} ` +
            `${DIM}(${result.id})${RESET} ` +
            `${DIM}${result.duration}ms${RESET}` +
            (result.primaryFailure
                ? `  ${CLASS_COLOR[result.primaryFailure]}[${CLASS_LABEL[result.primaryFailure]}]${RESET}`
                : '')
    );

    for (const call of result.calls) {
        if (call.failureClass === 'skip') continue;
        const isLast =
            call ===
            result.calls.filter((c) => c.failureClass !== 'skip').at(-1);
        const branch = isLast ? '└─' : '├─';
        const label = call.kind === 'movie' ? 'Movie' : 'TV   ';

        if (call.sources > 0) {
            console.log(
                `  ${DIM}${branch}${RESET} ${label}: ${GREEN}${call.sources} sources, ${call.subtitles} subtitles${RESET} ${DIM}(${call.ms}ms)${RESET}`
            );
            continue;
        }

        const cls = call.failureClass;
        const msg = truncate(call.error || 'no sources', 140);
        console.log(
            `  ${DIM}${branch}${RESET} ${label}: ${RED}FAIL${RESET} ` +
                `${CLASS_COLOR[cls]}${CLASS_LABEL[cls]}${RESET} ` +
                `${DIM}${call.ms}ms${RESET}`
        );
        console.log(`  ${DIM}   │  ${msg}${RESET}`);
        if (call.diagnostics.length > 1) {
            for (const d of call.diagnostics.slice(1, 4)) {
                console.log(
                    `  ${DIM}   │  + ${truncate(d, 120)}${RESET}`
                );
            }
        }
    }
}

function printFailureBuckets(failed: TestResult[]) {
    const buckets = new Map<FailureClass, TestResult[]>();
    for (const r of failed) {
        const key = r.primaryFailure ?? 'empty_unknown';
        const list = buckets.get(key) ?? [];
        list.push(r);
        buckets.set(key, list);
    }

    console.log(
        `\n${BOLD}${CYAN}── Failure classification (heuristic) ──${RESET}\n`
    );
    console.log(
        `${DIM}Use this to split EC2 vs laptop: IP/BOT_BLOCK + NETWORK/DNS/TLS ≈ egress;`
    );
    console.log(
        `catalog/auth/crypto/timeout need different fixes.${RESET}\n`
    );

    const order: FailureClass[] = [
        'ip_or_bot_block',
        'network_dns_tls',
        'rate_limit',
        'auth_or_token',
        'timestamp_clock',
        'crypto_or_decrypt',
        'timeout',
        'empty_catalog',
        'error_other',
        'empty_unknown'
    ];

    for (const key of order) {
        const list = buckets.get(key);
        if (!list?.length) continue;
        console.log(
            `${CLASS_COLOR[key]}${BOLD}${CLASS_LABEL[key]}${RESET} ${DIM}(${list.length})${RESET}`
        );
        for (const r of list) {
            const detail =
                r.calls
                    .filter((c) => c.failureClass !== 'ok' && c.failureClass !== 'skip')
                    .map(
                        (c) =>
                            `${c.kind}:${c.ms}ms ${truncate(c.error || '', 80)}`
                    )
                    .join(' · ') || '';
            console.log(
                `  ${RED}✗${RESET} ${r.id.padEnd(16)} ${DIM}${detail}${RESET}`
            );
        }
        console.log('');
    }

    const egressLike = [
        ...(buckets.get('ip_or_bot_block') ?? []),
        ...(buckets.get('network_dns_tls') ?? [])
    ];
    const other = failed.filter((r) => !egressLike.includes(r));

    console.log(`${BOLD}Triage suggestion:${RESET}`);
    console.log(
        `  ${RED}→ Scrape egress proxy (Option B) candidates:${RESET} ${
            egressLike.length
                ? egressLike.map((r) => r.id).join(', ')
                : '(none this run)'
        }`
    );
    console.log(
        `  ${YELLOW}→ Fix without proxy (auth/clock/crypto/catalog/timeout):${RESET} ${
            other.length ? other.map((r) => r.id).join(', ') : '(none this run)'
        }`
    );
}

async function main() {
    const { writeJson } = parseArgs();

    console.log(
        `\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}`
    );
    console.log(
        `${BOLD}${CYAN}║        CinePro Core — Provider Test Runner          ║${RESET}`
    );
    console.log(
        `${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}\n`
    );
    console.log(
        `${DIM}CAVEAT: resolve ≠ playback · local egress ≠ EC2. Classification is heuristic.${RESET}\n`
    );

    console.log(`${DIM}Discovering providers...${RESET}`);
    const providers = await discoverProviders();
    console.log(
        `${DIM}Found ${providers.length} providers. Testing...\n${RESET}`
    );

    const results: TestResult[] = [];
    const enabled = providers.filter((p) => p.enabled);
    const disabled = providers.filter((p) => !p.enabled);

    console.log(
        `${BOLD}━━━ Testing ${enabled.length} Enabled Providers ━━━${RESET}\n`
    );
    // Sequential is slower but clearer on EC2 logs and avoids burst rate-limits
    // masking IP blocks. Override with TEST_ALL_PARALLEL=1 if desired.
    const parallel = process.env.TEST_ALL_PARALLEL === '1';
    if (parallel) {
        for (let i = 0; i < enabled.length; i += 5) {
            const batch = enabled.slice(i, i + 5);
            const batchResults = await Promise.all(batch.map(testProvider));
            for (const r of batchResults) {
                printResult(r);
                results.push(r);
            }
        }
    } else {
        for (const p of enabled) {
            const r = await testProvider(p);
            printResult(r);
            results.push(r);
        }
    }

    if (disabled.length > 0) {
        console.log(
            `\n${BOLD}━━━ ${disabled.length} Disabled Providers ━━━${RESET}\n`
        );
        for (const p of disabled) {
            const r: TestResult = {
                id: p.id,
                name: p.name,
                enabled: false,
                duration: 0,
                calls: [],
                working: false,
                primaryFailure: null
            };
            printResult(r);
            results.push(r);
        }
    }

    const working = results.filter((r) => r.enabled && r.working);
    const failed = results.filter((r) => r.enabled && !r.working);

    console.log(
        `\n${BOLD}${CYAN}══════════════════════ Summary ══════════════════════${RESET}\n`
    );
    console.log(
        `  ${GREEN}${BOLD}✓ Working:${RESET}  ${GREEN}${working.length}${RESET} providers`
    );
    console.log(
        `  ${RED}${BOLD}✗ Failed:${RESET}   ${RED}${failed.length}${RESET} providers`
    );
    console.log(
        `  ${YELLOW}${BOLD}○ Disabled:${RESET} ${YELLOW}${disabled.length}${RESET} providers`
    );
    console.log(`  ${DIM}Total:${RESET}      ${results.length} providers\n`);

    if (working.length > 0) {
        console.log(`${GREEN}${BOLD}Working providers:${RESET}`);
        for (const r of working) {
            const sources = Math.max(
                ...r.calls.map((c) => c.sources),
                0
            );
            console.log(
                `  ${GREEN}✓${RESET} ${r.name} ${DIM}(${r.id})${RESET} — ${sources} sources`
            );
        }
    }

    if (failed.length > 0) {
        console.log(`\n${RED}${BOLD}Failed providers (raw):${RESET}`);
        for (const r of failed) {
            const errs = r.calls
                .filter((c) => c.error)
                .map((c) => `${c.kind}: ${truncate(c.error!, 70)}`)
                .join(' · ');
            console.log(
                `  ${RED}✗${RESET} ${r.name} ${DIM}(${r.id})${RESET} — ${errs || 'no sources'}`
            );
        }
        printFailureBuckets(failed);
    }

    if (writeJson) {
        const outDir = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            '..',
            'scripts'
        );
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, 'test-all-report.json');
        fs.writeFileSync(
            outPath,
            JSON.stringify(
                {
                    generatedAt: new Date().toISOString(),
                    host: process.env.HOSTNAME || null,
                    movie: {
                        tmdbId: movieMedia.tmdbId,
                        title: movieMedia.title
                    },
                    tv: {
                        tmdbId: tvMedia.tmdbId,
                        title: tvMedia.title,
                        s: tvMedia.s,
                        e: tvMedia.e
                    },
                    results
                },
                null,
                2
            )
        );
        console.log(`\n${DIM}Wrote ${outPath}${RESET}`);
    }

    console.log('');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
