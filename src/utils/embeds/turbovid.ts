import type { EmbedResult } from './filemoon.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const API_HEADERS: Record<string, string> = {
  'User-Agent': DEFAULT_UA,
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Connection: 'keep-alive',
  'Content-Type': 'application/json',
  'X-Turbo': 'TurboVidClient',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

function hexToChar(hex: string): string {
  return String.fromCharCode(parseInt(hex, 16));
}

function decrypt(data: string, key: string): string {
  const formattedData =
    data.match(/../g)?.map(hexToChar).join('') || '';
  return formattedData
    .split('')
    .map((char, i) =>
      String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(i % key.length)),
    )
    .join('');
}

export async function resolveTurbovid(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<EmbedResult | null> {
  try {
    const baseUrl = new URL(url).origin;

    const embedRes = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA, ...extraHeaders },
      signal: AbortSignal.timeout(15_000),
    });
    if (!embedRes.ok) return null;

    const embedPage = await embedRes.text();

    // Extract apkey and xxid from embed page
    const apkey = embedPage.match(/const\s+apkey\s*=\s*"(.*?)";/)?.[1];
    const xxid = embedPage.match(/const\s+xxid\s*=\s*"(.*?)";/)?.[1];

    if (!apkey || !xxid) return null;

    // Fetch the encoded juice key
    const juiceKeyRes = await fetch(`${baseUrl}/api/cucked/juice_key`, {
      headers: {
        ...API_HEADERS,
        Referer: url,
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!juiceKeyRes.ok) return null;

    const juiceKeyJson = (await juiceKeyRes.json()) as { juice?: string };
    if (!juiceKeyJson.juice) return null;

    const juiceKey = atob(juiceKeyJson.juice);

    // Fetch the encrypted data
    const queryParams = new URLSearchParams({ [apkey]: xxid });
    const dataRes = await fetch(
      `${baseUrl}/api/cucked/the_juice_v2/?${queryParams.toString()}`,
      {
        headers: {
          ...API_HEADERS,
          Referer: url,
          ...extraHeaders,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!dataRes.ok) return null;

    const dataJson = (await dataRes.json()) as { data?: string };
    if (!dataJson.data) return null;

    // Decrypt the playlist URL
    const playlist = decrypt(dataJson.data, juiceKey);

    return {
      streams: [
        {
          url: playlist,
          type: 'hls',
          quality: 'unknown',
          headers: {
            Referer: `${baseUrl}/`,
            Origin: baseUrl,
          },
        },
      ],
    };
  } catch {
    return null;
  }
}
