// These regex patterns are used that the proxy can identify which urls should be streamed.
// by default the most common video files are included in the @omss/framework

export const streamPatterns: RegExp[] = [
    /pixeldrain\.dev|pixeldra\.in/,
    /hub\.(raj\.lat|toxix\.buzz|oreao-cdn\.buzz)/,
    /wasabisys\.com/,
    /hakunaymatata\.com/,
    /streamflixserver\.site|tripplestream\.online/,
    /illimitableinkwell\.site/,
    /frostcomet5\.pro/,
    /(epimetheus63|earth14|pandora20)\.workers\.dev/, // streammafia's workers.dev proxy domains
    /tiktokcdn\.com/,
    /\/content\/(.)*\/page\-(.)*\.html/,
    /trendimovies\.com\/tgstream\/stream/,
    /cdn\.neuronix\.sbs/,
    /cdn\d*\.zenty\.store/,
    /febbox\.com/,
    /cloudnestra\.com/, // vidsrc rcp/prorcp player + {v4} stream host
    /neonhorizonworkshops\.com|wanderlynest\.com|orchidpixelgardens\.com/, // vidsrc {v1}-{v3} stream hosts
    /vidup\.to\/wyzie/, // vidup subtitle endpoints
    /ythd\.org\/embed/, // vidup fallback embed domain
    /niceoribit\.com/, // vidup direct stream CDN
    /111movies\.net\/wyzie/, // 111movies subtitle endpoints
    /dolphin-d55\.workers\.dev/, // 111movies stream CDN (Cloudflare Workers)
    /curly-lab-ca94\.dolphin-d55\.workers\.dev/, // 111movies stream CDN
    // VidKing: ONLY segment-like media must stream.
    // Matching whole hosts makes master .m3u8 take the "stream" path and skip
    // HLS rewrite. Leave .m3u8/.mpd unlisted so the proxy buffers + rewrites.
    // Hydrogen rotates many *.site CDNs under /r2/cdn*/; Oxygen uses
    // ironwallnet + interkh.com.
    /(?:ironbubble\.site|ironwallnet\.net|interkh\.com|lookcrew\d*\.site).+\.(?:ts|m4s|mp4|key)(?:\?|$)/i,
    /\/r2\/cdn\d*\/.+\.(?:ts|m4s|mp4|key)(?:\?|$)/i
];
