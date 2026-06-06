import type { EmbedResult } from './filemoon.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PLAYLIST_HEADERS: Record<string, string> = {
  Referer: 'https://ridoo.net/',
  Origin: 'https://ridoo.net',
};

export async function resolveRidoo(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      Referer: 'https://ridomovies.tv/',
      ...extraHeaders,
    };

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Extract file URL from script tags
    const regexPattern = /file:"([^"]+)"/g;
    const match = regexPattern.exec(html);
    if (!match?.[1]) return null;

    return {
      streams: [
        {
          url: match[1],
          type: 'hls',
          quality: 'unknown',
          headers: PLAYLIST_HEADERS,
        },
      ],
    };
  } catch {
    return null;
  }
}
