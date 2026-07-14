import type { EmbedResult, EmbedSubtitle } from './filemoon.js';

/**
 * FlixCloud hoster resolver (flixcloud.cc/e/<id>).
 *
 * FlixCloud is an embed HOSTER (used by anime sites like reanime.to,
 * 1anime.app), not a catalogue - so this is a URL-based resolver in the same
 * family as resolveStreamwish / resolveVoe. A source provider that emits a
 * flixcloud.cc embed url calls resolveFlixcloud(url) to get a playable stream.
 *
 * Flow (mirrors the enc-dec.app `flixcloud` sample), a two-step enc-dec:
 *   1. GET the embed page, scrape the inline `data: { ... }` object.
 *   2. POST dec-flixcloud?type=token { data }        -> { token, context }.
 *   3. GET flixcloud.cc/api/m3u8/<token>             -> encrypted stream json.
 *   4. POST dec-flixcloud?type=stream { data:{ context, stream_response } }
 *                                                    -> { stream, context }.
 *   5. Wrap the stream in parse-flixcloud?url=&w_payload= -> a manifest whose
 *      audio/video tracks are decrypted automatically (it does NOT proxy media
 *      segments), which is the url a player consumes.
 *
 * Returns null on any failure so callers can fall through to other hosters.
 *
 * STATUS (2026-07-10): validated live. Page scrape + dec-flixcloud?type=token
 * + /api/m3u8/<token> + dec-flixcloud?type=stream all returned 200, yielding a
 * real fetch4.flixcloud.cc/.../master.m3u8 (JWT) plus subtitles. The OPTIONAL
 * parse-flixcloud manifest fetch returned 522 (enc-dec.app Cloudflare upstream
 * timeout, transient); the decrypt chain itself is confirmed working.
 */

const API = 'https://enc-dec.app/api';
const SITE = 'https://flixcloud.cc';
const TIMEOUT_MS = 15_000;

const DEFAULT_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Referer: 'https://flixcloud.cc/'
};

interface EncDecEnvelope<T> {
    status: number;
    result: T;
    error?: string;
}

interface FlixcloudTokenResult {
    token: string;
    context: Record<string, unknown>;
}

interface FlixcloudStreamResult {
    stream: string;
    context: { w_payload?: string; [key: string]: unknown };
}

/**
 * Parse the inline embed object. It is a JS-object literal (json5-ish: possibly
 * unquoted keys / single quotes / trailing commas), so strict JSON is tried
 * first and a guarded Function-eval is the fallback. The captured text is a
 * plain data literal (no calls), and any parse error is swallowed to null.
 */
function parseLooseObject(literal: string): Record<string, unknown> | null {
    try {
        return JSON.parse(literal) as Record<string, unknown>;
    } catch {
        // not strict json - fall through to the loose parse
    }
    try {
        const value = new Function(`return (${literal});`)() as unknown;
        return value && typeof value === 'object'
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function detectFormat(url: string): string {
    const u = url.toLowerCase();
    if (u.includes('.srt')) return 'srt';
    if (u.includes('.ass')) return 'ass';
    if (u.includes('.ssa')) return 'ssa';
    if (u.includes('.ttml')) return 'ttml';
    return 'vtt';
}

function extractSubtitles(raw: unknown): EmbedSubtitle[] {
    if (!Array.isArray(raw)) return [];
    const subs: EmbedSubtitle[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const o = entry as Record<string, unknown>;
        const url = (o.url ?? o.file ?? o.src) as string | undefined;
        if (!url || typeof url !== 'string') continue;
        const kind = String(o.kind ?? o.type ?? '').toLowerCase();
        if (kind.includes('thumb')) continue;
        const label = o.label ?? o.language ?? o.lang ?? o.name ?? 'Unknown';
        subs.push({ url, label: String(label), format: detectFormat(url) });
    }
    return subs;
}

export async function resolveFlixcloud(
    url: string,
    extraHeaders?: Record<string, string>
): Promise<EmbedResult | null> {
    try {
        const headers = { ...DEFAULT_HEADERS, ...extraHeaders };

        // 1. fetch embed page + extract the inline `data: { ... }` object
        const pageRes = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (!pageRes.ok) return null;
        const html = await pageRes.text();

        const match = html.match(
            /type:\s*["']data["']\s*,\s*data:\s*(\{[\s\S]*?\})\s*,\s*uses:/
        );
        if (!match?.[1]) return null;

        const data = parseLooseObject(match[1]);
        if (!data) return null;

        // subtitles ride on the embed data; pull them aside before tokenizing
        // (the token endpoint signs the remaining data, matching the sample).
        const subtitles = extractSubtitles(data.subtitles);
        delete data.subtitles;

        // 2. resolve stream token
        const tokenRes = await fetch(`${API}/dec-flixcloud?type=token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (!tokenRes.ok) return null;
        const tokenJson =
            (await tokenRes.json()) as EncDecEnvelope<FlixcloudTokenResult>;
        if (tokenJson.status !== 200 || !tokenJson.result?.token) return null;
        const { token, context } = tokenJson.result;

        // 3. fetch the encrypted stream json from the hoster
        const streamRes = await fetch(`${SITE}/api/m3u8/${token}`, {
            headers,
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (!streamRes.ok) return null;
        const streamResponse = (await streamRes.json()) as unknown;

        // 4. decrypt the stream
        const decRes = await fetch(`${API}/dec-flixcloud?type=stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: { context, stream_response: streamResponse }
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (!decRes.ok) return null;
        const decJson =
            (await decRes.json()) as EncDecEnvelope<FlixcloudStreamResult>;
        if (decJson.status !== 200 || !decJson.result?.stream) return null;
        const resolved = decJson.result;

        // 5. wrap the stream in parse-flixcloud (decrypts a/v tracks). w_payload
        //    comes from the decrypted stream context.
        const wPayload = resolved.context?.w_payload;
        const params = new URLSearchParams({ url: resolved.stream });
        if (typeof wPayload === 'string' && wPayload) {
            params.set('w_payload', wPayload);
        }
        const manifestUrl = `${API}/parse-flixcloud?${params.toString()}`;

        return {
            streams: [
                {
                    url: manifestUrl,
                    type: 'hls',
                    quality: 'unknown',
                    headers: { Referer: DEFAULT_HEADERS.Referer }
                }
            ],
            subtitles: subtitles.length > 0 ? subtitles : undefined
        };
    } catch {
        return null;
    }
}
