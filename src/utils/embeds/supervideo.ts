import { load } from 'cheerio';

import JsUnpacker from '../jsunpack.js';
import type { EmbedResult } from './filemoon.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function extractUrlFromPacked(html: string, patterns: RegExp[]): string | null {
  const $ = load(html);

  const scripts = $('script')
    .map((_, el) => $(el).html())
    .get()
    .filter(Boolean);

  for (const script of scripts) {
    if (!script) continue;

    const unpacker = new JsUnpacker(script);
    if (!unpacker.detect()) continue;

    const unpacked = unpacker.unpack();
    if (!unpacked) continue;

    for (const pattern of patterns) {
      const match = unpacked.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
  }

  return null;
}

export async function resolveSupervideo(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    // Normalize URL - replace /e/ and /k/ and /embed- with /
    let fetchUrl = url
      .replace('/e/', '/')
      .replace('/k/', '/')
      .replace('/embed-', '/');

    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      Referer: url,
      ...extraHeaders,
    };

    let res = await fetch(fetchUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    let html = await res.text();

    // Check if video can only be watched as embed
    if (html.includes('This video can be watched as embed only')) {
      const embedUrl = fetchUrl.replace(/\/([^/]*)$/, '/e$1');
      res = await fetch(embedUrl, {
        headers: { ...headers, Referer: embedUrl },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      html = await res.text();
    }

    // Check for deleted/expired/processing videos
    if (/The file was deleted|The file expired|Video is processing/.test(html)) {
      return null;
    }

    // Extract m3u8 URL from packed JavaScript
    const m3u8Url = extractUrlFromPacked(html, [/sources:\[{file:"(.*?)"/]);
    if (!m3u8Url) return null;

    return {
      streams: [
        {
          url: m3u8Url,
          type: 'hls',
          quality: 'unknown',
        },
      ],
    };
  } catch {
    return null;
  }
}
