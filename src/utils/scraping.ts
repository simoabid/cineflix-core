import * as cheerio from 'cheerio';
import { scrapeFetch, type ScrapeFetchInit } from './scrapeFetch.js';

/**
 * Fetch HTML and return cheerio-loaded document.
 * Returns null on any failure (network error, non-OK status, etc.).
 * Uses scrape egress proxy (Option B) when host is allowlisted.
 */
export async function fetchHtml(
    url: string,
    headers?: Record<string, string>
): Promise<cheerio.CheerioAPI | null> {
    try {
        const res = await scrapeFetch(url, {
            headers: headers ?? {},
            timeoutMs: 15_000
        });
        if (!res.ok) return null;
        const html = await res.text();
        return cheerio.load(html);
    } catch {
        return null;
    }
}

/**
 * Fetch JSON with type safety.
 * Returns null on any failure.
 */
export async function fetchJson<T = unknown>(
    url: string,
    headers?: Record<string, string>,
    init?: ScrapeFetchInit
): Promise<T | null> {
    try {
        const res = await scrapeFetch(url, {
            headers: { 'Content-Type': 'application/json', ...headers },
            timeoutMs: 15_000,
            ...init
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

/**
 * Fetch raw text.
 * Returns null on any failure.
 */
export async function fetchText(
    url: string,
    headers?: Record<string, string>,
    init?: ScrapeFetchInit
): Promise<string | null> {
    try {
        const res = await scrapeFetch(url, {
            headers: headers ?? {},
            timeoutMs: 15_000,
            ...init
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
}

/**
 * Extract m3u8/mp4 stream URLs from HTML using regex patterns.
 * Returns deduplicated list of matching URLs.
 */
export function extractStreamUrls(html: string): string[] {
    const patterns = [
        /(?:file|src|url|source|stream|playlist)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)/gi,
        /(?:file|src|url|source|stream)\s*[:=]\s*["']([^"']+\.mp4[^"']*)/gi,
        /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi,
        /https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi
    ];
    const urls = new Set<string>();
    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(html)) !== null) {
            urls.add(match[1] ?? match[0]);
        }
    }
    return [...urls];
}

/**
 * Extract the first iframe src from HTML.
 */
export function extractIframeSrc(html: string): string | null {
    const match = html.match(/<iframe[^>]*\s+src=["']([^"']+)["'][^>]*>/i);
    return match?.[1] ?? null;
}

/**
 * Normalize a quality string/number to a standard format like "720p", "1080p", etc.
 * Returns "unknown" if the quality cannot be determined.
 */
export function normalizeQuality(quality: string | number | undefined): string {
    if (quality === undefined || quality === null) return 'unknown';
    const q = quality.toString().toLowerCase().trim();
    if (/^(2160|4k|uhd)/.test(q)) return '2160p';
    if (/^(1080|fhd|fullhd)/.test(q)) return '1080p';
    if (/^(720|hd)/.test(q)) return '720p';
    if (/^(480|sd)/.test(q)) return '480p';
    if (/^(360)/.test(q)) return '360p';
    if (/^\d{3,4}p$/.test(q)) return q;
    return 'unknown';
}

/**
 * Detect subtitle format from a URL based on its file extension.
 * Defaults to 'vtt' if no known extension is found.
 */
export function detectSubtitleFormat(
    url: string
): 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' {
    if (url.includes('.srt')) return 'srt';
    if (url.includes('.ass')) return 'ass';
    if (url.includes('.ssa')) return 'ssa';
    if (url.includes('.ttml') || url.includes('.xml')) return 'ttml';
    return 'vtt';
}

/**
 * Build a URL from a base, path, and optional query parameters.
 */
export function buildUrl(
    base: string,
    path: string,
    params?: Record<string, string>
): string {
    const url = new URL(path, base);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, v);
        }
    }
    return url.toString();
}
