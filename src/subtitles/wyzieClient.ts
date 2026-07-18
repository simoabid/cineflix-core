/**
 * Server-side Wyzie subtitle search with multi-key rotation.
 *
 * Docs: https://sub.wyzie.io — require `key` query param.
 * Free tier ~1000 req/day per key; rotate via WYZIE_API_KEYS.
 */

import {
    markWyzieKeyFailed,
    markWyzieKeySuccess,
    pickWyzieKey,
    wyzieKeyCount,
    wyzieKeyPoolSummary
} from './wyzieKeys.js';
import type { CineProSubtitle, WyzieSearchParams } from './types.js';

/** Prefer official host; .ru may redirect / 401 without key. */
const WYZIE_BASE =
    process.env.WYZIE_API_BASE?.replace(/\/$/, '') || 'https://sub.wyzie.io';

export type WyzieRawSubtitle = {
    id?: string | number;
    url: string;
    format?: string;
    display?: string;
    language?: string;
    isHearingImpaired?: boolean;
    encoding?: string;
    source?: string;
    flagUrl?: string;
    release?: string | null;
};

function detectFormat(fmt: string | undefined, url: string): CineProSubtitle['format'] {
    const f = (fmt ?? '').toLowerCase().trim();
    if (f === 'srt' || f === 'vtt' || f === 'ass' || f === 'ssa' || f === 'ttml') {
        return f;
    }
    const u = url.toLowerCase();
    if (u.includes('.srt')) return 'srt';
    if (u.includes('.vtt')) return 'vtt';
    if (u.includes('.ass')) return 'ass';
    if (u.includes('.ssa')) return 'ssa';
    if (u.includes('.ttml') || u.includes('.xml')) return 'ttml';
    return 'srt';
}

function buildSearchUrl(params: WyzieSearchParams, apiKey: string): string {
    const q = new URLSearchParams();
    // Prefer IMDB when present (Wyzie resolves faster)
    const id = params.imdbId?.trim() || params.tmdbId?.trim();
    if (!id) throw new Error('tmdbId or imdbId required');
    q.set('id', id);
    q.set('key', apiKey);
    if (params.season != null && params.episode != null) {
        q.set('season', String(params.season));
        q.set('episode', String(params.episode));
    }
    if (params.language) q.set('language', params.language);
    if (params.format) q.set('format', params.format);
    return `${WYZIE_BASE}/search?${q.toString()}`;
}

function mapToCinePro(raw: WyzieRawSubtitle[]): CineProSubtitle[] {
    const seen = new Set<string>();
    const out: CineProSubtitle[] = [];
    for (const sub of raw) {
        if (!sub?.url || seen.has(sub.url)) continue;
        seen.add(sub.url);
        const label =
            (sub.display || sub.language || 'Unknown') +
            (sub.isHearingImpaired ? ' (SDH)' : '');
        out.push({
            url: sub.url,
            label,
            format: detectFormat(sub.format, sub.url),
            language: sub.language,
            isHearingImpaired: sub.isHearingImpaired,
            encoding: sub.encoding,
            source: sub.source ? `wyzie ${sub.source}` : 'wyzie',
            flagUrl: sub.flagUrl,
            release: sub.release ?? null
        });
    }
    return out;
}

async function fetchOnce(
    params: WyzieSearchParams,
    apiKey: string
): Promise<
    | { ok: true; subtitles: CineProSubtitle[] }
    | { ok: false; reason: 'auth' | 'rate_limit' | 'error'; status: number }
> {
    const url = buildSearchUrl(params, apiKey);
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'User-Agent':
                    'CINEFLIX-Core/1.0 (+https://cineflix.dev; subtitle proxy)'
            },
            signal: AbortSignal.timeout(20_000)
        });

        if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: 'auth', status: res.status };
        }
        if (res.status === 429) {
            return { ok: false, reason: 'rate_limit', status: res.status };
        }
        if (!res.ok) {
            return { ok: false, reason: 'error', status: res.status };
        }

        const data = (await res.json()) as unknown;
        // API may return array or { code, message } on error
        if (!Array.isArray(data)) {
            const obj = data as { code?: number; message?: string };
            if (obj?.code === 401 || /api key/i.test(obj?.message ?? '')) {
                return { ok: false, reason: 'auth', status: 401 };
            }
            return { ok: true, subtitles: [] };
        }
        return { ok: true, subtitles: mapToCinePro(data as WyzieRawSubtitle[]) };
    } catch {
        return { ok: false, reason: 'error', status: 0 };
    }
}

/**
 * Search Wyzie with automatic key rotation on auth / rate-limit failures.
 */
export async function searchWyzieSubtitles(
    params: WyzieSearchParams
): Promise<{
    subtitles: CineProSubtitle[];
    keysTried: number;
    keyPool: string;
    error?: string;
}> {
    const pool = wyzieKeyPoolSummary();
    if (wyzieKeyCount() === 0) {
        return {
            subtitles: [],
            keysTried: 0,
            keyPool: pool,
            error:
                'No WYZIE_API_KEYS configured on core. Add free keys from store.wyzie.io/redeem (server .env only).'
        };
    }

    const maxAttempts = Math.max(1, wyzieKeyCount());
    let keysTried = 0;
    let lastError = '';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const key = pickWyzieKey();
        if (!key) {
            lastError = 'All Wyzie API keys are cooling down (quota or auth).';
            break;
        }
        keysTried += 1;
        const result = await fetchOnce(params, key);
        if (result.ok) {
            markWyzieKeySuccess(key);
            return {
                subtitles: result.subtitles,
                keysTried,
                keyPool: pool
            };
        }
        markWyzieKeyFailed(key, result.reason);
        lastError = `Wyzie HTTP ${result.status} (${result.reason})`;
        // try next key
    }

    return {
        subtitles: [],
        keysTried,
        keyPool: pool,
        error: lastError || 'Wyzie search failed'
    };
}
