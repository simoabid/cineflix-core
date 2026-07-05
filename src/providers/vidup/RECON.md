# Vidup.to Scraper — Reconnaissance Findings

## Summary

Vidup.to is a Next.js SPA with a heavily obfuscated player that uses a custom
bytecode VM to decrypt stream URLs. The player is significantly harder to
reverse-engineer than vidsrc because:

1. **No WASM** — the crypto is pure JS (WebCrypto + crypto-js polyfill)
2. **Bytecode VM** — the core logic (token decryption, server resolution) is
   compiled to a custom bytecode format that runs on an in-page VM interpreter
   (`az` generator function). The bytecode is XOR-encrypted with a key derived
   from the constant `0x6c0cf2e6`.
3. **Anti-tamper** — `a_()` function checks for headless browsers via platform
   mismatch, console.debug native code check, and timing-based devtools
   detection.
4. **String-table obfuscation** — every identifier is accessed via `o6(N)` /
   `o8(N)` which indexes into a 923-entry array that is **rotated at load time**
   until a checksum (189544) matches.

## Confirmed Architecture

### Embed API (officially documented)
- **Movies:** `https://vidup.to/movie/{id}?autoPlay=true` — `{id}` accepts IMDB (`tt6263850`) or TMDB (`533535`)
- **TV:** `https://vidup.to/tv/{id}/{season}/{episode}`
- **Optional params:** `title`, `poster`, `autoPlay`, `startAt`, `theme` (hex), `server`, `hideServer`, `fullscreenButton`, `chromecast`, `sub`, `nextButton`, `autoNext`

### RSC Payload (server-rendered)
The embed page is a Next.js App Router page. The server renders an RSC payload
containing the player's initial props:

```json
{
  "en": "ZQL5EXB44ki0-CEW5v8MEuGhOmzInFtvmUimdWesIIl9F6gVctXuDRhcjLgQrclE",
  "host": "vidup.to",
  "ad": true,
  "id": "533535",
  "title": "Deadpool & Wolverine",
  "year": "2024",
  "theme": "#e74c3c",
  "server": "$undefined",
  "season": "$undefined",   // TV only
  "episode": "$undefined"   // TV only
}
```

The `en` token is a ~64-char base64url string that changes on every page load.
It's the session token the player uses to authenticate API calls.

### Player Bundle Structure
- **`294-*.js`** (1.4MB) — the main player. Contains:
  - `aB()` — 923-entry obfuscated string array (base64-encoded, rotated at load)
  - `o7(t, e)` — string-table decoder: `t -= 413; nSqFud(aB()[t])`
  - `o6 = o7`, `o8 = o7` — aliases
  - `o4(t)` — custom base64 encoder (URL-safe + character substitution)
  - `ad` — bytecode Buffer (XOR-encrypted, built from 4 functions `aa/ai/as/am`)
  - `af` — 256-byte XOR key derived from `0x6c0cf2e6` via a hash function
  - `az(t, e, n)` — generator function (VM interpreter, ~30 opcodes)
  - `ag(t, e, n)` — async wrapper around `az` (drives the VM)
  - `av(t, e)` — entry point: `Object.assign(al, t); ay = e; ag(0, ad.length, {})`
  - `aU(t)` — React component (the player UI)
  - `a_()` — anti-tamper check (returns true if environment looks legit)
  - `aR()` — sub-check: platform vs UA mismatch, console.debug native check
  - `aN()` — sub-check (related to `new.target`)
- **`aaea2bcf-*.js`** (325KB) — crypto-js polyfill (AES-CBC, AES-GCM, etc.)
- **`213-*.js`** (284KB) — MUI (Material UI components)
- **`255-*.js`** + **`4bd1b696-*.js`** (173KB each) — React/Next runtime
- **`687-*.js`** (15KB) — small shared utilities

### Custom Base64 Encoder (`o4`)
```typescript
const INPUT  = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const OUTPUT = 'UweQMzkV6RZpB8IhiWq-y3mo2n7EsGuL0bT5YAjDfSNrvHacFJdl4_1t9OKPgCx';

function encodeVidupBase64(input: Uint8Array): string {
    const b64 = Buffer.from(input).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return b64.split('').map(c => {
        const i = INPUT.indexOf(c);
        return i >= 0 ? OUTPUT[i] : c;
    }).join('');
}
```

### API Endpoint (decoded from string table)
The player makes POST requests to:

```
POST https://vidup.to/b2b6f6ee/inu/10ca6917-3e8b-5a4d-a249-98109c7f9e13/72aa20c98f1586a9755903679a5ccbd86b522090/248034bb6eaf469ebf04986a057d13e17648b08aae00143c4a81c77554c833cc/{YOUTUBE_ID}/{r.data}
```

Where:
- The long `/b2b6f6ee/inu/...` path is a **constant** (string-table index 825)
- `{YOUTUBE_ID}` is one of: `qlUmUUnAo_U` (index 674, primary) or `IP4lIdkHyP4` (index 845, next-episode)
- `{r.data}` is a dynamic value from the selected server object (decrypted by the VM)

### Request Headers (constant)
```json
{
  "X-Requested-With": "XMLHttpRequest",
  "X-Csrf-Token": "PRXNAi2u5nlKPOd2akTf7Umma97GrjuH"
}
```

### Subtitle API
```
GET https://vidup.to/wyzie?id={tmdbId}[&season={s}&episode={e}]
```
Vidup uses the **wyzie subtitle API** (same as vidsrc!). The endpoint is at
string-table index 585 (`/wyzie?`).

### Fallback Domain
When all servers fail, the player redirects to:
- Movies: `https://ythd.org/embed/{tmdbId}`
- TV: `https://ythd.org/embed/{tmdbId}/{season}-{episode}`

### Anti-Tamper Checks (`a_()` / `aR()`)
1. **UA check**: `navigator.userAgent.toLowerCase().indexOf("chrome") !== -1`
2. **Platform check**: if UA says "Windows NT" but `navigator.platform` says "Linux" → bot detected
3. **Console.debug check**: `console.debug` must be a function with `[native code]` in its toString
4. **Timing check**: `console.log(array of 50 objects)` and check if it took ≤ 10ms (devtools detection)
5. **`aN()` check**: related to `new.target` (anti-Function-constructor)

If `a_()` returns false, the player's main `useEffect` returns early and `av()`
is never called — the player stays in "Getting things ready..." state forever.

## What We've Successfully Done

✅ Extracted the obfuscated string table (923 entries, decoded after rotation)
✅ Identified all URLs, paths, methods, headers used by the player
✅ Identified the API endpoint, CSRF token, and request structure
✅ Identified the subtitle API (wyzie — same as vidsrc)
✅ Identified the fallback domain (ythd.org)
✅ Confirmed the `en` token is in the RSC payload and changes per page load
✅ Confirmed the player renders in headless Chromium (with Xvfb + stealth)
✅ Found the player's global object (`vm_0x53f59a_18d6f5`) with 88 keys
✅ Found the Buffer polyfill at `g._0x3a5bd6.Buffer`
✅ Found the `encode` function (o4) at `g.encode`
✅ Identified `av` at `g._0x5ce885` (arity=2)

## What's Still Blocking

❌ **The VM (`az` generator) fails silently when called directly.** When we call
   `g._0x5ce885(props, {})` (which is `av`), it throws "Cannot read properties
   of undefined (reading 'call')". This means the VM bytecode is trying to
   access a property on `undefined` — likely a missing global in the `al`
   object or a React dependency.

❌ **The player stays in "Getting things ready..." state in headless browser.**
   The `av()` useEffect runs (we confirmed `a_()` passes), but the VM doesn't
   call `setServers`, so `t$` (the servers array) stays empty and no fetch is
   made.

## Recommended Implementation Strategy

Given the VM complexity, the most practical approach is a **hybrid**:

### Option A: Headless Browser (Playwright) — RECOMMENDED
- Load the embed page in headless Chromium with Xvfb + stealth
- Wait for the player to resolve streams (may need to debug why the VM fails)
- Intercept the POST request to `/b2b6f6ee/...` and capture the response
- Parse the response (may be AES-encrypted — decrypt with the `en` token)
- Return the stream URLs

**Pros:** Runs the player's own code, no need to reverse the VM
**Cons:** Heavy dependency (Playwright + Chromium), slow (~10s per request)

### Option B: Reproduce the VM in TypeScript — FUTURE WORK
- Statically extract the `ad` bytecode and `af` XOR key
- Implement the `az` generator interpreter in TS (~30 opcodes)
- Call it with the `en` token to get the server list
- Make the POST request ourselves

**Pros:** Lightweight, fast, no browser dependency
**Cons:** Very labor-intensive, fragile (any VM change breaks it)

### Option C: Use the wyzie subtitle API + ythd fallback — MINIMAL
- For subtitles: use `https://vidup.to/wyzie?id={tmdbId}` (already works)
- For streams: fall back to `https://ythd.org/embed/{tmdbId}` as an embed source
- Let the framework's embed resolver pipeline handle ythd

**Pros:** Simple, no VM reversing needed
**Cons:** ythd may have its own anti-bot, lower quality sources

## Next Steps

1. **Debug the VM failure** — the "Cannot read properties of undefined (reading 'call')" error
   suggests a missing function in the `al` object. Compare our `props` object
   against what the React component actually passes to `av()`. The component
   passes `Buffer: o9` where `o9 = n(5376).Buffer` — the player's OWN Buffer
   module. We found it at `g._0x3a5bd6.Buffer` but maybe we need to pass it
   differently.

2. **Try waiting longer in the headless browser** — the player might just be
   slow to resolve. Try 60s instead of 25s.

3. **Try interacting with the page** — the player might need a click or
   keyboard event to trigger stream resolution.

4. **Check if the `en` token has expired** — we extract it once but the VM
   might check its freshness. Try extracting a fresh token right before
   calling `av()`.
