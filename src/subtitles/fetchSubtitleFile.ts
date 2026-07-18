/**
 * Optional/debug subtitle file fetch — NOT used by SPA Path B default.
 *
 * Path B downloads OpenSubtitles in the browser (user residential IP).
 * This endpoint remains for manual EC2 debugging. EC2/datacenter IPs
 * (and free DC proxies) typically get Anubis, CF challenges, or
 * OpenSubtitles login-wall fake SRTs.
 */

import {
    getScrapeProxyUrl,
    scrapeFetch,
    shouldProxyHost
} from '../utils/scrapeFetch.js';
import { headersForSubtitleUpstream } from './proxyUrl.js';

const BLOCKED_HOST_PARTS = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    'metadata.google',
    '169.254.'
];

export function isBotChallengeHtml(text: string): boolean {
    const t = text.slice(0, 8000).toLowerCase();
    return (
        t.includes('anubis') ||
        t.includes('just a moment') ||
        t.includes('making sure you') ||
        t.includes('cf-challenge') ||
        t.includes('captcha') ||
        t.includes('_cf_chl') ||
        (t.includes('<!doctype html') && t.includes('challenge'))
    );
}

/** OpenSubtitles soft-block when IP is datacenter / unauthenticated. */
export function isOpenSubtitlesLoginWall(text: string): boolean {
    const t = text.slice(0, 4000);
    return (
        /need to Log In/i.test(t) ||
        /continue OpenSubtitles\.org/i.test(t) ||
        /you need to log in/i.test(t) ||
        (/OpenSubtitles\.org/i.test(t) &&
            /log\s*in/i.test(t) &&
            t.length < 800)
    );
}

export function looksLikeSubtitle(text: string): boolean {
    const t = text.trim();
    if (!t || t.length < 8) return false;
    if (isBotChallengeHtml(t)) return false;
    if (isOpenSubtitlesLoginWall(t)) return false;
    if (t.startsWith('/v1/proxy?data=')) return false;
    if (/^\s*<(!doctype|html)/i.test(t)) return false;
    // WEBVTT
    if (/^WEBVTT/i.test(t)) return true;
    // SRT-like: index + timestamp arrow
    if (
        /\d{1,2}:\d{2}:\d{2}[.,]\d{2,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}/.test(t)
    ) {
        // Still reject login-wall that happens to use SRT timestamps
        if (isOpenSubtitlesLoginWall(t)) return false;
        return true;
    }
    // microDVD {frame}{frame}text
    if (/^\{\d+\}\{\d+\}/m.test(t)) return true;
    // ASS
    if (/\[Script Info\]/i.test(t) || /Dialogue:/i.test(t)) return true;
    return false;
}

function assertSafePublicHttpsUrl(raw: string): URL {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw Object.assign(new Error('Invalid subtitle URL'), {
            statusCode: 400
        });
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw Object.assign(new Error('Only HTTP(S) subtitle URLs allowed'), {
            statusCode: 400
        });
    }
    const host = u.hostname.toLowerCase();
    for (const bad of BLOCKED_HOST_PARTS) {
        if (host.includes(bad) || host.startsWith(bad)) {
            throw Object.assign(new Error('Blocked subtitle host'), {
                statusCode: 400
            });
        }
    }
    if (
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|127\.)/.test(host) ||
        host === '::1'
    ) {
        throw Object.assign(new Error('Private network destinations blocked'), {
            statusCode: 400
        });
    }
    return u;
}

export type SubtitleFileResult =
    | {
          ok: true;
          status: number;
          body: string;
          contentType: string;
          viaProxy: boolean;
      }
    | {
          ok: false;
          status: number;
          body: string;
          contentType: string;
          error: string;
          viaProxy: boolean;
      };

/**
 * Debug/legacy: fetch one subtitle file from core egress.
 * SPA Path B should download OpenSubtitles in the browser instead.
 */
export async function fetchSubtitleFile(
    upstreamUrl: string
): Promise<SubtitleFileResult> {
    const u = assertSafePublicHttpsUrl(upstreamUrl);
    const headers = headersForSubtitleUpstream(u.href);
    const proxyConfigured = Boolean(getScrapeProxyUrl());
    const forceProxy =
        proxyConfigured &&
        (u.hostname.toLowerCase().includes('opensubtitles.org') ||
            shouldProxyHost(u.hostname));

    const res = await scrapeFetch(u.href, {
        method: 'GET',
        headers,
        timeoutMs: 25_000,
        viaProxy: forceProxy ? true : 'auto',
        redirect: 'follow'
    });

    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf-8');
    if (text.includes('\uFFFD') && !text.includes('-->')) {
        text = buf.toString('latin1');
    }

    const viaProxy = forceProxy;

    if (res.status < 200 || res.status >= 300) {
        return {
            ok: false,
            status: res.status === 403 ? 502 : res.status,
            body: '',
            contentType: 'text/plain; charset=utf-8',
            viaProxy,
            error: isBotChallengeHtml(text)
                ? `Subtitle CDN bot challenge (HTTP ${res.status}). SPA should download OpenSubtitles in the browser (user IP).`
                : `Upstream subtitle HTTP ${res.status}`
        };
    }

    if (isOpenSubtitlesLoginWall(text)) {
        return {
            ok: false,
            status: 502,
            body: '',
            contentType: 'text/plain; charset=utf-8',
            viaProxy,
            error:
                'OpenSubtitles returned a login-wall caption (datacenter IP blocked). Download from the browser instead.'
        };
    }

    if (isBotChallengeHtml(text) || !looksLikeSubtitle(text)) {
        return {
            ok: false,
            status: 502,
            body: '',
            contentType: 'text/plain; charset=utf-8',
            viaProxy,
            error:
                'Upstream did not return a caption file (bot challenge or empty). Path B uses browser download for OpenSubtitles.'
        };
    }

    return {
        ok: true,
        status: 200,
        body: text,
        contentType: 'text/plain; charset=utf-8',
        viaProxy
    };
}
