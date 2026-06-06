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

export async function resolveStreamtape(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Streamtape embeds the URL in a JS snippet:
    //   document.getElementById('robotlink').innerHTML = '//foo' + ('bar')
    const match = html.match(/robotlink'\)\.innerHTML = (.*)'/);
    if (!match?.[1]) return null;

    const [fh, sh] = match[1].split("+ ('");
    if (!fh || !sh) return null;

    const videoUrl = `https:${fh.replace(/'/g, '').trim()}${sh.substring(3).trim()}`;

    return {
      streams: [
        {
          url: videoUrl,
          type: 'mp4',
          quality: 'unknown',
          headers: {
            Referer: 'https://streamtape.com',
          },
        },
      ],
    };
  } catch {
    return null;
  }
}
