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

function extractThumbnailTrack(html: string): string | null {
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

    const match = unpacked.match(/\{file:"([^"]+)",kind:"thumbnails"\}/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

export async function resolveDropload(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      Referer: url,
      ...extraHeaders,
    };

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Check for unavailable content
    if (
      html.includes('File Not Found') ||
      html.includes('Pending in queue')
    ) {
      return null;
    }

    // Extract playlist URL from packed JavaScript
    const playlistUrl = extractUrlFromPacked(html, [
      /sources:\[{file:"(.*?)"/,
    ]);
    if (!playlistUrl) return null;

    // Extract thumbnail track if available
    const thumbnailTrack = extractThumbnailTrack(html);

    const result: EmbedResult = {
      streams: [
        {
          url: playlistUrl,
          type: 'hls',
          quality: 'unknown',
        },
      ],
    };

    if (thumbnailTrack) {
      const mainPageUrl = new URL(url);
      result.subtitles = [
        {
          url: mainPageUrl.origin + thumbnailTrack,
          label: 'Thumbnails',
          format: 'vtt',
        },
      ];
    }

    return result;
  } catch {
    return null;
  }
}
