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

const BASE_URL = 'https://backend.xaiby.sbs';
const DEFAULT_HEADERS = {
  referer: 'https://vidnest.fun/',
  origin: 'https://vidnest.fun',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
};

export async function resolveZunime(
  serverId: string,
  query: { type: string; tmdbId: string; season?: number; episode?: number },
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const { tmdbId, episode } = query;

    const params = new URLSearchParams({
      id: String(tmdbId),
      ep: String(episode ?? 1),
      host: serverId,
      type: 'dub',
    });

    const res = await fetch(`${BASE_URL}/sources?${params.toString()}`, {
      headers: {
        ...DEFAULT_HEADERS,
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      success?: boolean;
      sources?: {
        url?: string;
        headers?: Record<string, string>;
      };
    };

    if (!data?.success || !data?.sources?.url) return null;

    const streamUrl = data.sources.url;
    const upstreamHeaders =
      data.sources.headers && Object.keys(data.sources.headers).length > 0
        ? data.sources.headers
        : DEFAULT_HEADERS;

    return {
      streams: [
        {
          url: streamUrl,
          type: 'hls',
          quality: 'unknown',
          headers: upstreamHeaders,
        },
      ],
    };
  } catch {
    return null;
  }
}
