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

const BASE_URL = 'https://backend.animetsu.net';
const DEFAULT_HEADERS = {
  referer: 'https://animetsu.net/',
  origin: 'https://backend.animetsu.net',
  accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
};

export async function resolveAnimetsu(
  serverId: string,
  query: { type: string; tmdbId: string; season?: number; episode?: number },
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const { type, tmdbId, episode } = query;

    if (type !== 'movie' && type !== 'show') return null;

    const params = new URLSearchParams({
      server: serverId,
      id: String(tmdbId),
      num: String(episode ?? 1),
      subType: 'dub',
    });

    const res = await fetch(
      `${BASE_URL}/api/anime/tiddies?${params.toString()}`,
      {
        headers: {
          ...DEFAULT_HEADERS,
          ...extraHeaders,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) return null;

    const data = (await res.json()) as {
      sources?: Array<{
        url?: string;
        type?: string;
        quality?: string;
      }>;
    };

    const source = data?.sources?.[0];
    if (!source?.url) return null;

    const streamUrl = source.url;
    const sourceType = source.type;
    const sourceQuality = source.quality;

    if (sourceType === 'mp4') {
      let qualityKey: string = 'unknown';
      if (sourceQuality) {
        const qualityMatch = sourceQuality.match(/(\d+)p?/);
        if (qualityMatch) {
          qualityKey = qualityMatch[1];
        }
      }

      return {
        streams: [
          {
            url: streamUrl,
            type: 'mp4',
            quality: qualityKey,
            headers: DEFAULT_HEADERS,
          },
        ],
      };
    }

    return {
      streams: [
        {
          url: streamUrl,
          type: 'hls',
          quality: 'unknown',
          headers: DEFAULT_HEADERS,
        },
      ],
    };
  } catch {
    return null;
  }
}
