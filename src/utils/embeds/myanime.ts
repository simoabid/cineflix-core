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

const BASE_URL = 'https://anime.aether.mom';

interface StreamResponse {
  results?: {
    streamingLink?: {
      link?: {
        file?: string;
      };
      tracks?: Array<{
        file: string;
        label?: string;
        kind?: string;
      }>;
      intro?: { start?: string; end?: string } | null;
      outro?: { start?: string; end?: string } | null;
    };
  };
}

export async function resolveMyanime(
  variant: 'sub' | 'dub',
  query: { type: string; tmdbId: string; season?: number; episode?: number },
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const { tmdbId } = query;

    const params = new URLSearchParams({
      id: String(tmdbId),
      server: 'HD-2',
      type: variant,
    });

    const res = await fetch(`${BASE_URL}/api/stream?${params.toString()}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as StreamResponse;
    const streamingLink = data?.results?.streamingLink;

    if (!streamingLink?.link?.file) return null;

    const streamUrl = streamingLink.link.file;
    const headers = {
      Referer: 'https://rapid-cloud.co/',
    };

    const subtitles: EmbedSubtitle[] = (streamingLink.tracks ?? [])
      .filter((track) => track.kind !== 'thumbnails')
      .map((track) => ({
        url: track.file,
        label: track.label || 'Unknown',
        format: track.file.endsWith('.vtt')
          ? 'vtt'
          : track.file.endsWith('.srt')
            ? 'srt'
            : 'vtt',
      }));

    return {
      streams: [
        {
          url: streamUrl,
          type: 'hls',
          quality: 'unknown',
          headers,
        },
      ],
      subtitles: subtitles.length > 0 ? subtitles : undefined,
    };
  } catch {
    return null;
  }
}
