import JsUnpacker from '../jsunpack.js';
import type { EmbedResult } from './filemoon.js';

const STREAMWISH_DOMAINS = [
  'hgplaycdn.com',
  'habetar.com',
  'yuguaab.com',
  'guxhag.com',
  'auvexiug.com',
  'xenolyzb.com',
  'tryzendm.com',
];

const DEFAULT_HEADERS: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Encoding': '*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
};

function rotateDomain(url: string): string {
  const domain =
    STREAMWISH_DOMAINS[Math.floor(Math.random() * STREAMWISH_DOMAINS.length)];
  const path = new URL(url).pathname + new URL(url).search;
  return `https://${domain}${path}`;
}

export async function resolveStreamwish(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const fetchUrl = rotateDomain(url);
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...extraHeaders,
    };

    const res = await fetch(fetchUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Find packed JS (Dean Edwards packer)
    const packedMatch = html.match(
      /<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d.*?\)[\s\S]*?)<\/script>/,
    );
    if (!packedMatch?.[1]) return null;

    const unpacker = new JsUnpacker(packedMatch[1]);
    if (!unpacker.detect()) return null;

    const unpacked = unpacker.unpack();
    if (!unpacked) return null;

    // Extract hls2 URL from unpacked JS
    const hls2Match = unpacked.match(/"hls2"\s*:\s*"([^"]+)"/);
    if (!hls2Match?.[1]) return null;

    let videoUrl = hls2Match[1];

    // If relative, prepend swiftplayers.com
    if (!/^https?:\/\//.test(videoUrl)) {
      videoUrl = `https://swiftplayers.com/${videoUrl.replace(/^\/+/, '')}`;
    }

    const referer = new URL(fetchUrl).origin + '/';

    return {
      streams: [
        {
          url: videoUrl,
          type: 'hls',
          quality: 'unknown',
          headers: {
            Referer: referer,
            Origin: referer,
          },
        },
      ],
    };
  } catch {
    return null;
  }
}
