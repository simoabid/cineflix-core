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

const API_URL = 'https://api.1anime.app';

interface StreamData {
  headers: {
    Referer: string;
    Origin?: string;
  };
  sources: Array<{
    url: string;
    isM3U8: boolean;
  }>;
  subtitles?: Array<{
    url: string;
    lang?: string;
    kind?: string;
  }>;
}

export async function resolveAnimekai(
  query: { type: string; tmdbId: string; season?: number; episode?: number },
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const { tmdbId } = query;

    const res = await fetch(
      `${API_URL}/anime/animekai/watch/${encodeURIComponent(tmdbId)}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ...extraHeaders,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) return null;

    const data = (await res.json()) as StreamData;
    if (!data?.sources?.length) return null;

    const hlsSource = data.sources.find((s) => s.isM3U8);
    if (!hlsSource) return null;

    const headers: Record<string, string> = {};
    if (data.headers?.Referer) {
      headers.Referer = data.headers.Referer;
      try {
        headers.Origin = new URL(data.headers.Referer).origin;
      } catch {
        // ignore invalid URL
      }
    }
    if (data.headers?.Origin) {
      headers.Origin = data.headers.Origin;
    }

    const subtitles: EmbedSubtitle[] = (data.subtitles ?? [])
      .filter((sub) => sub.lang && sub.kind !== 'thumbnails')
      .map((sub) => ({
        url: sub.url,
        label: sub.lang?.replace(/_\[.*?\]$/, '').trim() || 'Unknown',
        format: 'vtt',
      }));

    return {
      streams: [
        {
          url: hlsSource.url,
          type: 'hls',
          quality: 'unknown',
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        },
      ],
      subtitles: subtitles.length > 0 ? subtitles : undefined,
    };
  } catch {
    return null;
  }
}
