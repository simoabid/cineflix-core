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
  'Mozilla/5.0 (Linux; Android 11; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

const SYMBOL_MAP: [string, string][] = [
  ['@$', '_'],
  ['^^', '_'],
  ['~@', '_'],
  ['%?', '_'],
  ['*~', '_'],
  ['!!', '_'],
  ['#&', '_'],
];

function cleanSymbols(s: string): string {
  let result = s;
  for (const [from, to] of SYMBOL_MAP) {
    result = result.replaceAll(from, to);
  }
  return result;
}

function cleanUnderscores(s: string): string {
  return s.replace(/_/g, '');
}

function shiftBack(s: string, n: number): string {
  return Array.from(s)
    .map((c) => String.fromCharCode(c.charCodeAt(0) - n))
    .join('');
}

export async function resolveVoe(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    let defaultDomain: string | undefined;
    try {
      const u = new URL(url);
      defaultDomain = `${u.protocol}//${u.host}/`;
    } catch {
      // ignore
    }

    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      ...(defaultDomain ? { Referer: defaultDomain } : {}),
      ...extraHeaders,
    };

    let html = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });

    // Handle redirect page
    if (html.includes('Redirecting...')) {
      const match = html.match(/href\s*=\s*'(.*?)';/);
      if (!match?.[1]) return null;

      html = await fetch(match[1], {
        headers,
        signal: AbortSignal.timeout(15_000),
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
    }

    // Find obfuscated JSON script
    const jsonScriptMatch = html.match(
      /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
    );
    if (!jsonScriptMatch?.[1]) return null;

    const obfuscatedScript = jsonScriptMatch[1];
    const encodedMatch = obfuscatedScript.match(/\["(.*?)"\]/);
    if (!encodedMatch?.[1]) return null;

    const encodedData = encodedMatch[1];

    // Multi-step decoding pipeline (from old implementation)
    let decoded = rot13(encodedData);
    decoded = cleanSymbols(decoded);
    decoded = cleanUnderscores(decoded);
    decoded = Buffer.from(decoded, 'base64').toString('utf-8');
    decoded = shiftBack(decoded, 3);
    decoded = decoded.split('').reverse().join('');
    decoded = Buffer.from(decoded, 'base64').toString('utf-8');

    const json = JSON.parse(decoded) as Record<string, unknown>;
    const videoUrl = json?.source;
    if (typeof videoUrl !== 'string' || !videoUrl) return null;

    const origin = defaultDomain?.replace(/\/$/, '') ?? new URL(url).origin;

    return {
      streams: [
        {
          url: videoUrl,
          type: 'hls',
          quality: 'unknown',
          headers: {
            Referer: defaultDomain ?? url,
            Origin: origin,
            'User-Agent': DEFAULT_UA,
          },
        },
      ],
    };
  } catch {
    return null;
  }
}
