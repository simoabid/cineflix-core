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

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomId(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
  }
  return result;
}

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

const PASS_MD5_PATTERNS: RegExp[] = [
  /\$\.get\(['"]?(\/pass_md5\/[^'"]+)['"]?\)/,
  /\$\.get\(["']?(\/pass_md5\/[^"']+)["']?\)/,
];

const TOKEN_PATTERNS: RegExp[] = [
  /token["']?\s*[:=]\s*["']([^"']+)["']/,
  /makePlay.*?token=([^"&']+)/,
];

function extractFirst(html: string, patterns: RegExp[]): string | null {
  for (const pat of patterns) {
    const m = pat.exec(html);
    if (m?.[1]) return m[1];
  }
  return null;
}

function resolveAbsoluteUrl(base: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

export async function resolveDood(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    let pageUrl = url;

    // Replace dood.watch with myvidplay.com to avoid Cloudflare
    try {
      const parsed = new URL(pageUrl);
      if (parsed.hostname === 'dood.watch') {
        pageUrl = `https://myvidplay.com${parsed.pathname}${parsed.search}`;
      }
    } catch {
      // keep original
    }

    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      Connection: 'keep-alive',
      ...extraHeaders,
    };

    // Follow redirects to get the final URL
    const pageRes = await fetch(pageUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!pageRes.ok) return null;

    const finalUrl = pageRes.url || pageUrl;
    const body = await pageRes.text();

    // Extract pass_md5 path
    const passMd5Match = extractFirst(body, PASS_MD5_PATTERNS);
    if (!passMd5Match) return null;

    const baseUrl = new URL(finalUrl).origin;
    const passMd5Url = resolveAbsoluteUrl(baseUrl, passMd5Match);

    // Collect cookies from the page response
    const setCookies = pageRes.headers.getSetCookie();
    const cookieHeader = setCookies
      .map((c) => c.split(';')[0])
      .join('; ');

    // Call pass_md5 endpoint
    const passMd5Res = await fetch(passMd5Url, {
      headers: {
        ...headers,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        Referer: finalUrl,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!passMd5Res.ok) return null;

    const videoBase = (await passMd5Res.text()).trim();
    if (!videoBase) return null;

    // Extract token and append random suffix + expiry
    const tokenMatch = extractFirst(body, TOKEN_PATTERNS);
    let videoUrl: string;
    if (tokenMatch) {
      const suffix = randomId(10);
      const expiry = Date.now();
      videoUrl = `${videoBase}${suffix}?token=${tokenMatch}&expiry=${expiry}`;
    } else {
      videoUrl = videoBase;
    }

    const origin = new URL(finalUrl).origin;

    return {
      streams: [
        {
          url: videoUrl,
          type: 'mp4',
          quality: 'unknown',
          headers: {
            Referer: origin,
          },
        },
      ],
    };
  } catch {
    return null;
  }
}
