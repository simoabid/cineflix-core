# VidSync Scraping Field Notes

> Case study for the **VidSync** provider (`vidsync.live`), built after the
> enc-dec.app `enc-vidsync` / `dec-vidsync` path died.
>
> Companion to [SCRAPING-MASTERCLASS.md](./SCRAPING-MASTERCLASS.md). This is the
> VidSync-specific war diary: what broke, what we proved, and why we do **not**
> ship a browser/Playwright Turnstile token injector.

**Status (2026-07-15):**

| Layer                        | State                                |
| ---------------------------- | ------------------------------------ |
| Host / serverList            | Works (`vidsync.live`)               |
| bro.wasm decrypt (pure Node) | **Proved** on live ciphertext        |
| Cloudflare Turnstile mint    | **Blocked** for pure Node (see §3)   |
| Provider `enabled`           | **`false`** until a pure mint exists |

---

## 0. Caveats first (do not skip)

### Resolve ≠ playback

Even after decrypt yields `file.cinevibe.workers.dev/stream/...` MP4 URLs, the
CDN/proxy may still 403/410. Resolve success only proves:

1. Turnstile was accepted (when a token is present)
2. `/api/stream/fetch` returned ciphertext
3. bro.wasm `verify` + `decrypt` produced JSON with URLs

### Local ≠ EC2 / production

Turnstile, Cloudflare, and stream CDNs treat residential vs datacenter IPs
differently. Re-smoke on the **same egress** as production after any future
enablement.

### No Playwright / no 1–2h token babysitting

Unlike Hexa’s **Cap.js** (open PoW + instrumentation we re-execute in Node),
VidSync’s gate is **Cloudflare Turnstile** — closed, browser-attested, short
TTL. Shipping:

- Playwright / real-browser mint, or
- Operator paste of `VIDSYNC_TURNSTILE_TOKEN` every ~1h

…is **explicitly out of scope**. Unreliable, ops-hostile, and not the Hexa-class
solution. Prefer leave disabled over that.

Anti-DevTools on the embed (`disable-devtool` + infinite `debugger`) also makes
casual browser recon painful; **mitmproxy / mitmweb** is the right capture tool
(see §6).

---

## 1. Why VidSync broke (and why “fix enc-dec” was wrong)

Historical path:

```
GET  enc-dec.app/api/enc-vidsync  → { token } as X-CF-Turnstile
GET  vidsync…/api/stream/fetch    + token
POST enc-dec.app/api/dec-vidsync  → decrypted stream
```

Live check (2026-07):

```json
GET enc-dec.app/api/enc-vidsync
→ {
  "status": 500,
  "error": "Generation failure: InitTabs2 must be called before generating a token"
}
```

Server-side break of enc-dec’s Turnstile mint, not a header bug. The SPA on
`vidsync.live` still works for real browsers → **native** path exists.

---

## 2. Entry model (SPA recon)

| Piece       | Value                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Site        | `https://vidsync.live` (`vidsync.xyz` → 301)                            |
| Embed       | `/embed/movie/{tmdbId}`, `/embed/tv/...`                                |
| Server list | `GET /api/stream/serverList` → JSON string array                        |
| Stream API  | `GET /api/stream/fetch?type&title&mediaId&serverName&releaseYear…`      |
| Auth header | `X-CF-Turnstile: <turnstile token>`                                     |
| Uptime      | `GET /api/uptime` → `{ server_start_epoch_ms }` (cache invalidation)    |
| Crypto      | `GET /bro.wasm` — AssemblyScript exports `serve` / `verify` / `decrypt` |
| Turnstile   | sitekey `0x4AAAAAAB_8pfVJvAg9lSQ4`, action `stream_fetch`, invisible    |
| Anti-debug  | `cdn.jsdelivr.net/npm/disable-devtool` + obfuscated traps               |

Embed client (chunk `96fa5e81961f95b0.js`):

```text
init wasm → Function(serve())() → wait window.hash → verify(hash)
→ mint/reuse Turnstile → fetch stream → decrypt(ciphertext, mediaId)
→ JSON.parse → sources[]
```

Browser caches Turnstile in `localStorage` (`turnstile_token` / `turnstile_time`)
for ~1 hour unless `server_start_epoch_ms` is newer than mint time.

---

## 3. Cloudflare Turnstile — the real remaining gate

### 3.1 Protocol (observed)

```http
GET /api/stream/fetch?type=movie&title=The+Godfather&mediaId=238
  &season=&episode=&releaseYear=1972&serverName=cinebox
Origin/Referer: https://vidsync.live
X-Requested-With: XMLHttpRequest
X-CF-Turnstile: 1.6Y…   # ~800 char token, three dotted segments
```

Without a valid token:

```http
HTTP/2 401
{"error":"Verification failed"}
```

With a valid browser-minted token (mitmweb capture, Godfather / cinebox):

```http
HTTP/2 200
content-type: text/plain; charset=utf-8
content-length: 20564

a6c11c724039769f0dd669…   # hex ciphertext
```

### 3.2 Why pure Node cannot mint (unlike Cap)

| Cap.js (Hexa)                         | Turnstile (VidSync)                          |
| ------------------------------------- | -------------------------------------------- |
| Challenge + PoW + open instr math     | Closed Cloudflare challenge platform         |
| We re-ran math in `vm` + DOM mock     | Requires browser attestation / CF private    |
| Token format simple `id:secret`       | Long signed blob (`1.6Y… . … . …`)           |
| Headless often blocked, but math pure | Headless routinely fails (`postMessage`/etc) |

There is **no** open `instrumentation` blob we can re-execute. Solving Turnstile
in-process means either:

1. Embedding a full browser (rejected), or
2. Paying a captcha farm API (out of scope here), or
3. Waiting for CF to change / another upstream mint (enc-dec is dead).

### 3.3 What we refuse to ship

- Playwright / puppeteer “open embed, scrape token”
- `VIDSYNC_TURNSTILE_TOKEN` ops rotation every 1–2h as a product design
- Any dependency on a human pasting tokens for production

Those are fine for **one-shot research** (this session), not for a long-lived
provider.

---

## 4. bro.wasm — solved in pure Node (Hexa-class win)

### 4.1 Browser contract

```js
// env.seed = Date.now() * Math.random()
// env.abort = throw
const { serve, verify, decrypt, __new, memory } = exports;
Function(serve())();              // sets window.X1..X50 + async window.hash
await until typeof window.hash === 'string';
verify(hash);                     // unlocks decrypt
decrypt(ciphertext, Number(tmdbId));
```

Strings are AssemblyScript UTF-16 (`__new(len<<1, 2)`).

### 4.2 Why eval(serve()) fails in Node

`serve()` returns ~112KB of obfuscated JS (anti-debug, string-array rotation).
Naïve `vm` / `Function` evaluation **OOMs or hangs**. Not required.

### 4.3 Hash algorithm (from browser `crypto.subtle.digest` hook)

Across multiple seeds:

```text
algo   = SHA-512
input  = SERVE_HASH_PREFIX + window.X12
output = lowercase hex (128 chars) → window.hash
```

`SERVE_HASH_PREFIX` is **constant for a given bro.wasm build**:

```text
1nD9pVguvnD9pwfs1nD9acTg3LSlsfw9iqVgsfDuunD9smZgPcZaaGDj3SVqFmZjO
```

`X12` is a large decimal string emitted as `window.X12 = "…"` in `serve()` text
— extract with regex, no eval.

If a future wasm update breaks `verify()`, re-capture PREFIX the same way
(hook `subtle.digest` once in a real browser / mitm is optional; PREFIX is in
the obfuscated table).

### 4.4 Live proof (2026-07-15)

Capture: Godfather `mediaId=238`, `serverName=cinebox`, 200 OK, 20564-byte hex
body (mitmweb + real Chrome).

```text
createBroWasm() → verify OK
decrypt(ciphertext, 238) → JSON ~10KB
```

Shape:

```json
{
    "sourceMode": "mp4_qualities",
    "sources": [
        {
            "url": "https://file.cinevibe.workers.dev/stream/…",
            "quality": "1080p",
            "streamType": "mp4",
            "server": "1080p • Cinebox"
        }
        // 720p, 480p, 360p, …
    ],
    "subtitles": [
        /* file/label tracks */
    ]
}
```

Implementation: `src/providers/vidsync/broWasm.ts`.

---

## 5. Code map

```
src/providers/vidsync/
  vidsync.ts        # BaseProvider — DISABLED until Turnstile pure mint
  broWasm.ts        # pure Node serve-hash / verify / decrypt
  vidsync.types.ts  # decrypted payload shapes
  test.ts           # bro.wasm unit smoke + disabled-provider check
  wasm/bro.wasm     # vendored; copy:wasm → dist/
  vidsync_trace.py  # historical enc-dec tracer (legacy)

docs/
  VIDSYNC-SCRAPING.md   # this file
vidsync_instructions.txt  # human mitmweb capture checklist
```

---

## 6. How we captured (mitmweb — preferred over DevTools)

Embed loads `disable-devtool` and infinite `debugger` traps. Opening Chrome
DevTools blanks the page or freezes on “Paused in debugger”.

**Working approach:**

1. `mitmweb` (or Charles / HTTP Toolkit) with system Chrome + installed CA
2. Browse `https://vidsync.live/embed/movie/238` **without** DevTools
3. Filter `stream/fetch`
4. Copy `X-CF-Turnstile` + response body for offline bro.wasm tests

Artifacts from this session:

- `vidsync_x_cf_turnsile_cURL.txt`
- `vidsync_x_cf_turnsile_full_raw_request_response.txt`

---

## 7. Decision record

| Option                                  | Verdict                                      |
| --------------------------------------- | -------------------------------------------- |
| Re-enable enc-dec path                  | Dead (`InitTabs2`)                           |
| Pure bro.wasm decrypt                   | **Done**                                     |
| Pure Turnstile mint in Node             | **Not available** (CF closed)                |
| Playwright token injector + 1h cache    | **Rejected** (reliability / ops)             |
| Paid captcha API                        | Not adopted; revisit only if product demands |
| Ship provider enabled without pure mint | **No**                                       |
| Keep bro.wasm + docs; `enabled = false` | **Yes — current**                            |

When (if) a pure Turnstile-equivalent appears (new upstream mint, protocol
change, or an acceptable captcha integration decision), wire:

```text
mintToken() → GET stream/fetch + X-CF-Turnstile → bro.decrypt → normalize
```

and flip `enabled` to `true`. Decrypt is not the open question anymore.

---

## 8. Smoke commands (research only)

```bash
# bro.wasm only (no network token needed for verify self-test)
npx tsx src/providers/vidsync/test.ts

# Offline decrypt of a captured body (research):
#   cipher file + mediaId 238
```

Provider resolve smoke will report disabled / missing pure Turnstile path until
§7 changes.

---

## 9. Related

- [HEXA-SCRAPING.md](./HEXA-SCRAPING.md) — Cap pure Node mint (contrast with Turnstile)
- [SCRAPING-MASTERCLASS.md](./SCRAPING-MASTERCLASS.md) — general method + caveats
