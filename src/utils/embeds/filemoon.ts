import { load } from 'cheerio';
import JsUnpacker from '../jsunpack.js';

export type EmbedStream = {
  url: string;
  type: 'hls' | 'mp4';
  quality?: string;
  headers?: Record<string, string>;
};

export type EmbedSubtitle = {
  url: string;
  label: string;
  format: string;
};

export type EmbedResult = {
  streams: EmbedStream[];
  subtitles?: EmbedSubtitle[];
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function resolveFilemoon(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      ...extraHeaders,
    };

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const $ = load(html);

    // Filemoon embeds contain an iframe pointing to the actual player
    const iframe = $('iframe').first();
    const iframeSrc = iframe.attr('src');
    if (!iframeSrc) return null;

    // Fetch the player page
    const iframeRes = await fetch(iframeSrc, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!iframeRes.ok) return null;

    const iframeHtml = await iframeRes.text();
    const $player = load(iframeHtml);

    // Find packed JS (Dean Edwards packer)
    const scripts = $player('script')
      .map((_, el) => $player(el).html())
      .get()
      .filter(Boolean);

    for (const script of scripts) {
      if (!script) continue;

      const unpacker = new JsUnpacker(script);
      if (!unpacker.detect()) continue;

      const unpacked = unpacker.unpack();
      if (!unpacked) continue;

      // Extract m3u8 URL from unpacked JS
      const match = unpacked.match(/file:\s*"([^"]+\.m3u8[^"]*)"/i);
      if (match?.[1]) {
        return {
          streams: [
            {
              url: match[1],
              type: 'hls',
              quality: 'unknown',
              headers: {
                Referer: new URL(iframeSrc).origin + '/',
                'User-Agent': DEFAULT_UA,
              },
            },
          ],
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
