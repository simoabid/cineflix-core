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

const BASE_URL = 'https://second.vidnest.fun';
const PASSPHRASE = 'A7kP9mQeXU2BWcD4fRZV+Sg8yN0/M5tLbC1HJQwYe6pOKFaE3vTnPZsRuYdVmLq2';

const SERVER_CONFIGS: Record<
  string,
  { streamDomains: string[] | null; origin: string; referer: string }
> = {
  hollymoviehd: {
    streamDomains: ['pkaystream.cc', 'flashstream.cc'],
    origin: 'https://flashstream.cc',
    referer: 'https://flashstream.cc/',
  },
  allmovies: {
    streamDomains: null,
    origin: '',
    referer: '',
  },
};

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decryptVidnestData(encryptedBase64: string): Promise<unknown> {
  const encryptedBytes = base64ToUint8Array(encryptedBase64);
  const iv = encryptedBytes.slice(0, 12);
  const ciphertext = encryptedBytes.slice(12, -16);
  const tag = encryptedBytes.slice(-16);
  const keyData = base64ToUint8Array(PASSPHRASE).slice(0, 32);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    combined,
  );
  return JSON.parse(new TextDecoder('utf-8').decode(decrypted));
}

export async function resolveVidnest(
  serverId: string,
  query: { type: string; tmdbId: string; season?: number; episode?: number },
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const config = SERVER_CONFIGS[serverId];
    if (!config) return null;

    const { type, tmdbId, season, episode } = query;
    const endpoint =
      type === 'movie'
        ? `/${serverId}/movie/${tmdbId}`
        : `/${serverId}/tv/${tmdbId}/${season}/${episode}`;

    const res = await fetch(`${BASE_URL}${endpoint}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { data?: string };
    if (!data?.data) return null;

    const decrypted = (await decryptVidnestData(data.data)) as {
      sources?: Array<{ file?: string; url?: string }>;
      streams?: Array<{ file?: string; url?: string }>;
    };

    const sources = decrypted.sources || decrypted.streams || [];
    const streams: EmbedStream[] = [];

    for (const source of sources) {
      const url = source.file || source.url;
      if (!url) continue;
      if (
        config.streamDomains &&
        !config.streamDomains.some((d) => url.includes(d))
      ) {
        continue;
      }
      streams.push({
        url,
        type: 'hls',
        quality: 'unknown',
        headers:
          config.origin || config.referer
            ? {
                ...(config.origin ? { Origin: config.origin } : {}),
                ...(config.referer ? { Referer: config.referer } : {}),
              }
            : undefined,
      });
    }

    if (streams.length === 0) return null;
    return { streams };
  } catch {
    return null;
  }
}
