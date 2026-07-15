#!/usr/bin/env node
/**
 * Production smoke test for the VidKing provider.
 *
 * Run ON the EC2 host (or any machine that can reach your core API):
 *
 *   # after deploy, against the live instance
 *   BASE_URL=http://127.0.0.1:3000 node scripts/smoke-vidking.mjs
 *
 *   # or against the public reverse-proxy URL
 *   BASE_URL=https://core.example.com node scripts/smoke-vidking.mjs
 *
 * What it proves (in order):
 *   1. API is up
 *   2. `vidking` is registered and enabled
 *   3. Movie/TV resolution returns VidKing sources
 *   4. Proxy URL returns a real HLS/DASH body (not 403/HTML)
 *   5. (optional) first media playlist/segment is also fetchable
 *
 * Exit 0 = green. Non-zero = which gate failed.
 */

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(
    /\/$/,
    ''
);
const MOVIE_ID = process.env.MOVIE_TMDB || '155';
const TV_ID = process.env.TV_TMDB || '1399';
const TV_S = process.env.TV_S || '1';
const TV_E = process.env.TV_E || '1';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90_000);

const results = [];
let failed = 0;

function log(step, ok, detail) {
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${step}${detail ? ` — ${detail}` : ''}`);
    results.push({ step, ok, detail });
    if (!ok) failed++;
}

async function fetchJson(path, timeoutMs = TIMEOUT_MS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${BASE}${path}`, {
            headers: { Accept: 'application/json' },
            signal: ctrl.signal
        });
        const text = await res.text();
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            body = text;
        }
        return { status: res.status, body, headers: res.headers };
    } finally {
        clearTimeout(t);
    }
}

async function fetchBytes(url, timeoutMs = 25_000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: {
                Accept: '*/*',
                'User-Agent':
                    'Mozilla/5.0 (compatible; VidKing-Smoke/1.0; +cinepro)'
            },
            signal: ctrl.signal,
            redirect: 'follow'
        });
        const buf = new Uint8Array(await res.arrayBuffer());
        const text = new TextDecoder('utf-8', { fatal: false }).decode(
            buf.slice(0, 800)
        );
        return {
            status: res.status,
            contentType: res.headers.get('content-type') || '',
            text,
            size: buf.length
        };
    } finally {
        clearTimeout(t);
    }
}

function collectVidkingSources(body) {
    const sources = Array.isArray(body?.sources) ? body.sources : [];
    return sources.filter((s) => {
        const name = s?.provider?.name || '';
        const id = s?.provider?.id || '';
        return (
            id === 'vidking' ||
            /vidking/i.test(name) ||
            /vidking/i.test(String(s?.url || ''))
        );
    });
}

function isPlayableManifest(text, type) {
    const head = (text || '').trimStart();
    if (type === 'dash' || head.includes('<MPD') || head.includes('<?xml')) {
        return head.includes('MPD') || head.includes('Representation');
    }
    // HLS
    return head.startsWith('#EXTM3U') || head.includes('#EXTINF');
}

function absolutize(baseUrl, maybeRelative) {
    try {
        return new URL(maybeRelative, baseUrl).href;
    } catch {
        return null;
    }
}

function firstHlsRef(manifestText, manifestUrl) {
    for (const line of manifestText.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        return absolutize(manifestUrl, t);
    }
    // EXT-X-STREAM-INF or URI="..."
    const m = manifestText.match(/URI="([^"]+)"/i);
    if (m) return absolutize(manifestUrl, m[1]);
    return null;
}

async function checkProxyPlayable(source) {
    let url = source.url;
    // Proxy URLs from createProxyUrl may be absolute http://localhost/... when
    // PUBLIC_URL is unset. Rewrite to the BASE we are smoke-testing.
    try {
        const u = new URL(url);
        if (
            u.pathname.includes('/v1/proxy') &&
            (u.hostname === 'localhost' ||
                u.hostname === '127.0.0.1' ||
                u.hostname === '0.0.0.0')
        ) {
            url = `${BASE}${u.pathname}${u.search}`;
        }
    } catch {
        /* keep as-is */
    }

    const got = await fetchBytes(url);
    const type = (source.type || '').toLowerCase();
    const playable =
        got.status >= 200 &&
        got.status < 300 &&
        isPlayableManifest(got.text, type);

    return { url, got, playable };
}

async function main() {
    console.log(`VidKing production smoke → ${BASE}\n`);

    // 1. health / providers
    try {
        const providers = await fetchJson('/v1/providers', 15_000);
        if (providers.status !== 200) {
            log('providers endpoint', false, `HTTP ${providers.status}`);
        } else {
            const list = Array.isArray(providers.body) ? providers.body : [];
            const vk = list.find(
                (p) => p.id === 'vidking' || /vidking/i.test(p.name || '')
            );
            if (!vk) {
                log(
                    'vidking registered',
                    false,
                    `not in list (${list.length} providers). Deploy missing?`
                );
            } else {
                log(
                    'vidking registered',
                    true,
                    `id=${vk.id} enabled=${vk.enabled}`
                );
                if (vk.enabled === false) {
                    log('vidking enabled', false, 'provider is disabled');
                }
            }
        }
    } catch (e) {
        log('providers endpoint', false, e.message || String(e));
        console.error(
            '\nCannot reach BASE_URL. Is the core process running and PORT correct?'
        );
        process.exit(2);
    }

    // 2. movie sources
    let movieVk = [];
    try {
        const movie = await fetchJson(`/v1/movies/${MOVIE_ID}`);
        if (movie.status !== 200) {
            log('movie resolve', false, `HTTP ${movie.status}`);
        } else {
            movieVk = collectVidkingSources(movie.body);
            log(
                'movie VidKing sources',
                movieVk.length > 0,
                `${movieVk.length} source(s) (tmdb ${MOVIE_ID})`
            );
            for (const s of movieVk.slice(0, 5)) {
                console.log(
                    `      · [${s.type}] ${s.quality} ${s.provider?.name} ${String(s.url).slice(0, 90)}…`
                );
            }
        }
    } catch (e) {
        log('movie resolve', false, e.message || String(e));
    }

    // 3. TV sources
    let tvVk = [];
    try {
        const tv = await fetchJson(`/v1/tv/${TV_ID}/${TV_S}/${TV_E}`);
        if (tv.status !== 200) {
            log('tv resolve', false, `HTTP ${tv.status}`);
        } else {
            tvVk = collectVidkingSources(tv.body);
            log(
                'tv VidKing sources',
                tvVk.length > 0,
                `${tvVk.length} source(s) (tmdb ${TV_ID} S${TV_S}E${TV_E})`
            );
        }
    } catch (e) {
        log('tv resolve', false, e.message || String(e));
    }

    // 4. proxy playback (prefer HLS)
    const candidates = [...movieVk, ...tvVk].sort((a, b) => {
        const score = (s) =>
            (s.type || '').toLowerCase() === 'hls' ||
            String(s.url).includes('m3u8')
                ? 0
                : 1;
        return score(a) - score(b);
    });

    if (candidates.length === 0) {
        log('proxy playback', false, 'no VidKing sources to probe');
    } else {
        let anyPlayable = false;
        let lastDetail = '';
        // Try up to 3 sources (Hydrogen CDN vs Oxygen CDN may differ on AWS IPs)
        for (const src of candidates.slice(0, 3)) {
            try {
                const { url, got, playable } = await checkProxyPlayable(src);
                lastDetail = `${src.provider?.name} HTTP ${got.status} ct=${got.contentType} head=${JSON.stringify(got.text.slice(0, 60))}`;
                if (playable) {
                    anyPlayable = true;
                    log(
                        'proxy playback',
                        true,
                        `${src.provider?.name} ${src.quality} → valid ${src.type || 'manifest'}`
                    );

                    // 5. follow one HLS child ref when possible
                    if (
                        (src.type || '').toLowerCase() === 'hls' ||
                        got.text.includes('#EXTM3U')
                    ) {
                        const child = firstHlsRef(got.text, url);
                        if (child) {
                            const childGot = await fetchBytes(child, 20_000);
                            const childOk =
                                childGot.status >= 200 &&
                                childGot.status < 300 &&
                                (childGot.text.includes('#EXT') ||
                                    childGot.size > 0);
                            log(
                                'proxy segment/playlist',
                                childOk,
                                `HTTP ${childGot.status} size=${childGot.size} ${child.slice(0, 80)}…`
                            );
                        }
                    }
                    break;
                }
                console.log(`      · not playable yet: ${lastDetail}`);
            } catch (e) {
                lastDetail = e.message || String(e);
                console.log(`      · probe error: ${lastDetail}`);
            }
        }
        if (!anyPlayable) {
            log(
                'proxy playback',
                false,
                lastDetail ||
                    'all probes failed (possible AWS IP block on CDN — check proxy headers / streamPatterns)'
            );
        }
    }

    console.log('\n--- summary ---');
    for (const r of results) {
        console.log(`${r.ok ? '✓' : '✗'} ${r.step}`);
    }
    if (failed > 0) {
        console.log(
            `\n${failed} gate(s) failed. Common prod fixes:\n` +
                `  • PUBLIC_URL must be the public/core base clients use (proxy links)\n` +
                `  • streamPatterns includes ironbubble.site|ironwallnet.net\n` +
                `  • Restart after deploy so auto-discovery loads vidking\n` +
                `  • If proxy returns 403 HTML from CDN: AWS IP blocked — need residential proxy/egress\n`
        );
        process.exit(1);
    }
    console.log('\nAll gates passed. VidKing is production-ready on this host.');
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(2);
});
