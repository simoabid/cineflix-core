# CinePro Scraping Masterclass — A Field Guide to Reverse‑Engineering Streaming Providers

> A practical "book" distilled from building the **vidsrc** provider end‑to‑end.
> Read this when a provider breaks, or when you want to add a *new* hard provider.
> It is written from absolute scratch: methodology first, then the vidsrc case
> study, then a failure/maintenance playbook.

---

## 0. How to use this book

- If a provider **just broke**, jump to **§8 Failure Playbook** and **§9 Decision Framework**.
- If you're **adding a new provider**, read **§2 → §3 → §4** (the repeatable method), then copy patterns from **§7 Reusable Assets**.
- The **§6 vidsrc case study** is the worked example that every section refers to.

Golden rule learned the hard way: **change one variable at a time, and always
get the *real* error before theorizing.** Most of the time we lost was from
guessing instead of surfacing the actual HTTP status/response body.

---

## 1. The engine model (what a "provider" is)

CinePro Core is built on **`@omss/framework`**. You only write *provider*
classes; the framework does routing, caching, proxying, TMDB validation, and
response shaping.

A provider:

- lives in `src/providers/<name>/<name>.ts`, extends `BaseProvider`
- is **auto‑discovered** by scanning `src/providers/` at startup
- implements `getMovieSources(media)` and `getTVSources(media)`
- returns `{ sources, subtitles, diagnostics }`
- must wrap every stream URL in `this.createProxyUrl(url, headers)`

Key input `ProviderMediaObject`: `{ type: 'movie'|'tv', tmdbId, imdbId?, title, releaseYear?, s?, e? }`.

Key output `Source`: `{ url, type: 'hls'|'mp4'|…, quality, audioTracks:[{language,label}], provider:{id,name} }`.

**Non‑obvious framework behaviours (they bit us — see §8):**

- Discovery **imports every `.ts`** in a provider folder. Any file with
  top‑level side effects (e.g. `await main()`) will **execute at server
  startup**. Keep dev/recon scripts *out* of the providers directory.
- Discovery also recurses into `_archive/`. A stale archived provider with the
  **same `id`** wins registration and blocks your new one
  (`Provider with id 'x' is already registered`).
- Responses are **cached** (memory in dev, ~1h). A failed first call is cached;
  later calls replay the stale result. Restart or use a fresh TMDB id to test.
- Provider errors go into the response's **`diagnostics[]`**, not the console by
  default. Add `this.console.log` in your catch to see them live.

---

## 2. The universal methodology (the repeatable playbook)

This is the core value of the whole exercise. Every hard provider follows the
same funnel:

```
ENTRY URL
  │  (§2.1) What renders the page? server HTML vs client SPA
  ▼
WHERE DO SOURCES COME FROM?
  │  (§2.2) bundle recon + browser Network tab → find the API call(s)
  ▼
REPRODUCE THE REQUEST
  │  (§2.3) headers, cookies, query, body, signing, tokens
  ▼
DECODE THE RESPONSE
  │  (§2.4) plaintext? JSON? encrypted? → find the decode step
  ▼
BYPASS PROTECTIONS
  │  (§2.5) anti‑tamper (WASM/env checks), anti‑bot (CF/headers/TLS)
  ▼
INTEGRATE + HARDEN
     (§2.6) provider class, proxying, subtitles, concurrency, diagnostics
```

### 2.1 Determine the rendering model

Fetch the entry URL with plain `curl`/`fetch` and look at the raw bytes:

- **Server‑rendered**: the HTML already contains iframes / `file:` / `.m3u8`.
  You can scrape it directly (classic approach).
- **Client SPA** (React/Vite/etc.): tiny HTML shell (~2KB), a `<div id=root>`,
  and `<script src=/assets/index-*.js>`. The tell‑tale: `href="/vite.svg"`,
  fixed small byte size, no real content. **The sources are built in the
  browser by JS** → scraping HTML returns nothing.

> vidsrc.ru is an SPA. That's why the archived HTML‑chain scraper was "dead":
> the site had been rewritten as a client app.

### 2.2 Find where sources come from

Two complementary techniques — **use both**:

**A) Bundle recon (offline, scriptable).** Download the SPA shell, extract the
`/assets/*.js` chunk URLs, download them, and grep the (minified) code for:

- absolute URLs / API hosts (`https://…`)
- api‑like path fragments (`/api/…`, `/sources`, `/servers`, `/player`)
- `.m3u8` / `.mp4` hints
- `fetch(` / `axios` call sites
- crypto hints (`atob`, `CryptoJS`, `AES`, `crypto.subtle`, `wasm`, `.wasm`)
- print **code context windows** around each hit (±200 chars) to read the logic

**B) Browser DevTools → Network → Fetch/XHR** (ground truth). Play a title and
watch which request returns the servers/stream JSON and the final `.m3u8`.
Right‑click → **Copy → Copy as cURL (bash)** to get *every* header verbatim
(including cookies). This is the single most valuable artifact — it removes all
guesswork about headers.

### 2.3 Reproduce the request

From the cURL / bundle, reproduce **exactly**:

- HTTP method, full URL (+ query)
- **All headers** the browser sends (UA, `Referer`, `Origin`, `Accept`,
  `sec-ch-ua`, `Sec-Fetch-*`, and any custom `X-*`)
- Any **cookies** (if present → may need a browser/session; see §2.5)
- Any **signed headers** (timestamp, nonce, HMAC signature, api key,
  fingerprint) — reproduce the signing algorithm in TS
- Request **body** for POSTs

> The header that cost us hours: `X-Fingerprint-Lite` — a *constant* anti‑bot
> token injected by the site's global `fetch` wrapper. Missing it → the backend
> soft‑blocks with a **decoy** `403 {"error":"no sources found"}`.

### 2.4 Decode the response

- Plaintext / JSON → parse directly.
- **Encrypted** (looks like base64/gibberish) → find the decode function in the
  bundle. It may be plain JS crypto (`CryptoJS`, `crypto.subtle`) — reproduce it
  in TS — **or** it may be inside a **WASM** module (see §2.5 / §5).

### 2.5 Bypass protections (the hard part)

Three independent layers, diagnosed separately:

1. **Anti‑tamper / obfuscation (WASM):** the secret logic (key derivation,
   decryption, signing) is compiled to WebAssembly and gated behind a
   **browser‑environment fingerprint** (canvas, `navigator`, `screen`,
   `localStorage`, timezone). Running it in Node throws coded errors (e.g.
   `E18`, `E22`) until you **shim** those globals. See §5.
2. **Anti‑bot at the app layer:** missing header / token / cookie →
   decoy error. Fix by matching the browser request exactly (§2.3).
3. **Anti‑bot at the transport layer:** TLS/JA3 + HTTP/2 fingerprint. If the
   browser's *own* key/headers fail from Node but work in Chrome, and an
   unsigned endpoint on the same host works from Node, it's transport‑level →
   you need TLS impersonation (`curl-impersonate`, `cycletls`) or a headless
   browser. (vidsrc turned out **not** to be this — it was a missing header.)

**The decisive isolation test** (how to tell layer 2 from layer 3): grab the
browser's real key/fingerprint and replay the request from Node.

- Works from Node with browser identity → it was app‑layer (header/token). Fix
  in code.
- Fails from Node even with browser identity, *but* an unsigned endpoint on the
  same host works → transport‑layer. Escalate to TLS‑impersonation/headless.

### 2.6 Integrate + harden

- Wrap streams in `createProxyUrl`; add subtitles; set `provider.name` per
  variant (e.g. `VidSrc (Alpha)`).
- **Per‑request session reset** if the target uses `localStorage` counters.
- **Bounded concurrency** for multi‑server fetches (not unbounded bursts).
- Put failures in `diagnostics` *and* `this.console.log`.
- Keep the provider dir clean (only runtime files). Ship WASM assets via a
  build copy step.

---

## 3. Tooling cheat sheet

| Need | Tool / command |
|---|---|
| See raw server response + status | `curl -sS -i -A "<chrome UA>" '<url>'` |
| Rendering model | look for `/vite.svg`, tiny fixed byte size |
| Every request header (ground truth) | DevTools → Network → right‑click → Copy as cURL (bash) |
| Bundle recon | download shell → `/assets/*.js` → grep for urls/api/crypto + context |
| Inspect WASM strings | `strings -n 5 file.wasm \| grep -iE 'error\|api\|http\|key\|canvas\|headless'` |
| List wasm‑bindgen exports/imports | `grep -nE 'export function\|imports.wbg.__wbg_' glue.js` |
| HMAC / AES in Node | `globalThis.crypto.subtle` (SubtleCrypto) |
| Run TS quickly | `npx tsx path/to/script.ts` |
| Format / typecheck (CI parity) | `npx prettier --check src && npm run build` |

---

## 4. Reverse‑engineering a WASM (wasm‑bindgen) module in Node

When the logic lives in `*_bg.wasm` + a `*.js` glue (wasm‑bindgen "web" target):

1. **Load it in Node** by feeding the `.wasm` bytes to the glue's default init:
   `await init({ module_or_path: bytes })` (bytes avoids any `fetch`/URL path,
   so it works offline).
2. **Discover what it touches**: `grep 'imports.wbg.__wbg_'` in the glue lists
   every host function the wasm calls. That's the *exact* set of browser globals
   you must provide. If it's only `fetch`/`crypto`/`TextEncoder` → easy. If it's
   `document`/`navigator`/`screen`/`localStorage`/canvas → it fingerprints the
   environment.
3. **Shim the environment** (see §5). Iterate: run, read the coded error, add the
   missing global, repeat until the exported function returns a valid value.
4. **Read the WASM's strings** (`strings file.wasm`) to understand gates: error
   codes, `HeadlessChrome/Selenium` checks, canvas font strings, crypto crate
   names (`aes-0.8.4`) etc.
5. **Only call the pure‑compute exports** from Node (e.g. key derivation +
   decryption). Reimplement the *networking/signing* in TS yourself — it's
   simpler and easier to debug than driving the whole site's JS.

---

## 5. The browser‑environment shim pattern (reusable)

Install these globals **before** instantiating the wasm. Values only need to be
*plausible and stable* (the fingerprint gates that they exist, not their exact
value — because a real server can't know a device's canvas hash):

- `class Window/HTMLCanvasElement/CanvasRenderingContext2D` (so `instanceof`
  guards pass)
- `window` = an instance of `Window` with: `document`, `localStorage`,
  `navigator {userAgent, platform, language}`, `screen {width,height,colorDepth}`,
  `performance {now}`; also `window.window = window`, `window.self = window`
- `document`: `createElement('canvas') → {getContext('2d') → ctx, toDataURL()}`,
  and `getElementsByTagName('body'|'script') → [nonEmpty]` (some gates read
  `body`/`script` counts)
- `localStorage`: in‑memory `Map` with `getItem/setItem/removeItem/clear`
- Set `globalThis.window/self/document/localStorage/screen` + the three classes

**Watch out for `localStorage` counters.** If the wasm stores a call counter /
session there, a long‑lived server process accumulates it and the wasm starts
refusing. **Clear localStorage at the start of every resolution** (the site
does exactly this). This was the fix that made vidsrc work reliably in‑server.

---

## 6. Case study: vidsrc (what we actually found)

**Site type:** Vite SPA on `vidsrc.ru` / `vidsrc.su`. Raw HTML = 2.3KB shell.

**Architecture discovered via bundle recon + Network tab:**

1. App chunk `index-*.js` lazy‑loads two ES modules from
   `https://themoviedb.vidsrc.su/assets/client/`:
   `tmdb-image-enhancer.js` (the real logic) and `tmdb-poster-utils.js`.
2. Those load a **wasm‑bindgen** module `…/assets/wasm/img_data.js` +
   `img_data_bg.wasm`, exposing `get_img_key()` and `process_img_data(text,key)`.
3. **Flow** (`enhanceTmdbImageData`):
   - `key = get_img_key()` → a **64‑char per‑session key** (client‑generated,
     sent as `X-Api-Key`; not a fixed server secret).
   - Build `…/api/tmdb/movie/{id}/images` (TV: `/tv/{id}/season/{s}/episode/{e}/images`).
   - **Sign** with headers: `X-Api-Key`, `X-Request-Timestamp` (from `/api/time`),
     `X-Request-Nonce` (random), `X-Request-Signature = base64(HMAC_SHA256(key,
     "key:ts:nonce:path"))`, `X-Client-Fingerprint`, plus constant
     `X-Fingerprint-Lite` and a literal `bW90aGFmYWth: 1` header.
   - Response body is **AES‑encrypted**; `process_img_data(body, key)` (WASM)
     decrypts → `{ servers, sources }`.
   - Loop NATO server names (`alpha`, `bravo`, …) re‑fetching with
     `X-Only-Sources:1 / X-Server:<name>`; each decrypts to a signed `.m3u8`
     (`mto/lva/fha.nexlunar99.site/…`).
4. **Subtitles**: separate public API `https://sub.wyzie.ru/search?id=<tmdbId>[&season=&episode=]` (no WASM, no auth).

**What we run in Node:** the WASM only for `get_img_key` + `process_img_data`
(pure compute). Everything else (time sync, nonce, HMAC signing, the server
loop) is reimplemented in TypeScript.

**The gauntlet we cleared, in order:**

- SPA (not server HTML) → target the backend API, not the page.
- `403 Cloudflare` → add browser headers (UA + `sec-ch-ua` + `Sec-Fetch-*`).
- `403 {"error":"no sources found"}` (decoy) → **missing `X-Fingerprint-Lite`**
  constant + wrong `Sec-Fetch-Site`. This was *the* blocker; proven by the
  browser‑key A/B test that ruled out TLS.
- WASM `E18`/`E22` in Node → **browser shim** (document/canvas/navigator/…
  + non‑empty `getElementsByTagName('body'|'script')`).
- 0 sources in‑server → **localStorage session not reset** between requests.
- No vidsrc at all in `/v1/movies` → **id collision** with `_archive/vidsrc`
  + dev scripts executing during discovery.
- Slow (23s) → **bounded‑concurrency pool** (default 8, no delay).

**Final file layout** (`src/providers/vidsrc/`): `vidsrc.ts` (provider),
`vidsrcClient.ts` (signing + server loop), `vidsrcWasm.ts` (wasm loader + shim +
`clearVidsrcSession`), `wasm/img_data.js`, `wasm/img_data_bg.wasm`. Build step
copies `wasm/` into `dist/`.

---

## 7. Reusable assets (keep these)

These scripts from this build are generic — reuse for any SPA target:

- **`inspect-bundle.ts`** — download shell + chunks, grep code context around
  api/crypto/url tokens.
- **`inspect-wasm.ts`** — follow the client modules, download `.wasm` + glue,
  print loader context.
- **`resolver-test.ts`** — standalone tester with `VIDSRC_KEY`/`VIDSRC_FP`
  overrides and a `PRINT_CURL` mode that emits a ready‑to‑run curl (great for
  the app‑vs‑transport isolation test).
- **The shim** in `vidsrcWasm.ts` — copy for any wasm‑bindgen target.

> Keep these in a `tools/` or `scripts/` folder **outside** `src/providers/`, or
> discovery will execute them at startup.

---

## 8. Failure playbook — what breaks & how to fix fast

When it stops working, **get the real error first**:
`curl -s <server>/v1/movies/<freshId> | jq '.diagnostics'` and read the
`[VidSrc] Failed: …` line in `npm run dev`. Then match the symptom:

| Symptom | Most likely cause | Fix |
|---|---|---|
| `server list HTTP 403` + Cloudflare HTML | CF challenge / headers stale | refresh browser headers; if it's a JS challenge, need TLS‑impersonation/headless |
| `403 {"error":"no sources found"}` (JSON decoy) | a required header/token changed (e.g. `X-Fingerprint-Lite`) | re‑capture a browser request; diff headers; update the constant |
| WASM throws `E<nn>` / `get_img_key` fails | they shipped a **new `.wasm`** with new env checks | re‑download `img_data.js`+`img_data_bg.wasm`; re‑inspect imports; extend the shim |
| Key length ≠ 64 / decrypt fails | key derivation or AES params changed | re‑read the client module; adjust signing/decoding |
| `getaddrinfo ENOTFOUND` / domain dead | they moved/renamed the domain | update `API_BASE`/host list from the new site's bundle |
| Works once then 0 sources | localStorage counter not reset | ensure `clearVidsrcSession()` runs per request |
| 0 sources on parallel burst | server rate limit | lower `concurrency`, add small `delayMs` |
| Registered but `/v1/movies` shows none | id collision or cached failure | remove duplicate id; restart to clear cache; test fresh id |

**Refresh routine (do this first when it breaks):**

1. Re‑run bundle/wasm recon → download fresh client modules + `.wasm`.
2. Capture one live browser request (Copy as cURL) → diff headers vs our code.
3. Run `resolver-test.ts` (offline key check + live resolve). The stage that
   fails tells you which layer changed.

---

## 9. Decision framework: fix vs investigate vs rebuild

- **Header/token/constant changed** (most common, ~1‑line): *fix in place*.
  Update `vidsrcClient.ts`. Minutes.
- **New WASM / new env checks**: *investigate + patch*. Re‑download assets,
  extend the shim, re‑test. Tens of minutes.
- **Endpoint/domain/flow changed** but still an SPA+WASM design: *partial
  rebuild* of `vidsrcClient.ts` using this book's §2 method. An hour‑ish.
- **Whole site re‑architected** (e.g. moves to server‑side TLS gating, or a
  fundamentally different player): *rebuild from scratch* — but you now have the
  **method** (§2) and the **reusable tools** (§7), so it's a guided process, not
  a blank page.

Either way: **the method is the durable asset, not the specific key.** A changed
key/header is a minutes‑fix; a changed architecture is a guided rebuild. You
never start from zero again.

---

## 10. Glossary

- **SPA**: Single‑Page App; HTML shell + JS builds the page client‑side.
- **wasm‑bindgen**: Rust→WASM toolchain; produces a `.wasm` + JS glue with
  `__wbg_*` host imports and `init`/exported functions.
- **JA3/JA4**: TLS ClientHello fingerprint used by anti‑bot systems.
- **Decoy error**: a misleading message (e.g. "no sources found") returned to
  requests that fail a hidden bot check, to waste a scraper's time.
- **Soft‑block**: request accepted but served junk/empty due to a failed
  fingerprint check (vs a hard 401/403 auth error).
- **NATO servers**: vidsrc's server aliases (`alpha`, `bravo`, …).

---

*Written from the vidsrc build. The specifics will age; the method won't.*
