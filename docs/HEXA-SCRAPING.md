# Hexa Scraping Field Notes

> Case study for the **Hexa** provider (`hexa.su` / `theemoviedb.hexa.su`), built
> after the enc-dec.app `enc-hexa` endpoint was permanently disabled.
>
> Companion to [SCRAPING-MASTERCLASS.md](./SCRAPING-MASTERCLASS.md) (methodology +
> vidsrc / vidking). This document is the Hexa-specific war diary: what broke,
> what we tried, and what finally worked.

**Status:** resolve path works in Node (2026-07). Cap mint + WASM multi-server
list/source fetch return proxied HLS URLs for movies and TV.

---

## 0. Caveats first (do not skip)

These are not footnotes — they are the difference between “tests green” and
“users can watch.”

### Resolve ≠ playback

A provider can return beautiful `createProxyUrl(...)` m3u8 links that still
**403 / 410** when the player loads segments through the proxy. We learned this
on **VidKing Oxygen**. Hexa resolve success only proves:

1. Cap token mint succeeded
2. HMAC-signed list/source requests succeeded
3. WASM decrypt produced URLs

It does **not** prove segment-level playback on a given network.

### Local ≠ EC2 / production

Cap Standalone, `theemoviedb.hexa.su`, and stream CDNs can treat:

- residential / local IPs
- EC2 / datacenter IPs
- Cloudflare-fronted public hosts (`core.cineflix.dev`)

…differently. Always re-smoke on the **same host and egress** that production
uses after deploy. Local green is necessary, not sufficient.

These caveats are also mirrored as comments in:

- `src/providers/hexa/hexa.ts`
- `src/providers/hexa/hexaClient.ts`
- `src/providers/hexa/capSolver.ts`

---

## 1. Why Hexa broke (and why “just fix the provider” was wrong)

Original Hexa provider depended on **enc-dec.app**:

```
GET  enc-dec.app/api/enc-hexa     → { token }  as X-Cap-Token
GET  theemoviedb.hexa.su/.../images  + X-Api-Key + X-Cap-Token
POST enc-dec.app/api/dec-hexa     → decrypted stream
```

Live check (2026-07):

```json
GET /api/enc-hexa
→ { "status": 500, "error": "Generation failure: disabled" }
```

That is a **server-side shutoff** of enc-dec’s Hexa mint, not a bug in our
headers. The SPA on `hexa.su` still works for real browsers — so a **native**
path must exist.

---

## 2. Entry model (SPA recon)

| Piece       | Value                                                 |
| ----------- | ----------------------------------------------------- |
| Site        | `https://hexa.su` — React SPA                         |
| Analytics   | `https://1414.hexa.su/script.js`                      |
| Stream API  | `https://theemoviedb.hexa.su`                         |
| Cap         | `https://cap.hexa.su/15d2cf0395/` (Cap.js Standalone) |
| WASM / glue | **Byte-identical** to vidsrc’s `img_data` module      |

Key discovery: Hexa’s `tmdb-image-enhancer.js` and WASM match **vidsrc**. The
crypto pipeline is the same; Hexa adds **Cap** as a gate.

Browser network (Godfather `tmdb=238`, after Cap solve) looks like:

```http
GET /api/time?t=…
GET /api/tmdb/movie/238/images
  Accept: text/plain
  Origin/Referer: https://hexa.su
  bW90aGFmYWth: 1                 # list flag (base64 "mothafaka")
  x-api-key: <64-char WASM key>
  x-cap-token: <cap redeem token>
  x-client-fingerprint: …
  x-fingerprint-lite: e9136c41504646444
  x-request-nonce / timestamp / signature   # HMAC over path

GET /api/tmdb/movie/238/images
  X-Only-Sources: 1
  X-Server: alpha
  x-cap-token: <same>
  … fresh HMAC headers …
```

Responses are **ciphertext** (AES via WASM `process_img_data`), same as vidsrc.

---

## 3. Cap.js — the real gate

### 3.1 Protocol

| Step      | Request                                  | Response                                                 |
| --------- | ---------------------------------------- | -------------------------------------------------------- |
| Challenge | `POST …/15d2cf0395/challenge` empty body | `{ challenge:{c,s,d}, token, expires, instrumentation }` |
| PoW       | local                                    | `solutions: number[]` (one nonce per challenge)          |
| Instr     | local                                    | `{ i, state, ts }`                                       |
| Redeem    | `POST …/redeem` JSON                     | `{ success, token, expires }`                            |

Typical challenge: `c=80`, `s=32`, `d=4` (~12s PoW on a laptop).

Redeem token format (example):

```text
e1bf7d79fe713558:72acfc41c8ba6858e1fee137cd2fa0
```

Sent as **`x-cap-token`** (not JWT). TTL on the order of **~2 hours** (Cap
Standalone default token TTL; SPA also keeps a multi-hour in-memory cache).

### 3.2 Why Playwright / bare Node failed

Without instrumentation, redeem returns:

```json
{
    "instr_error": true,
    "error": "Blocked by instrumentation",
    "reason": "missing_instrumentation_response"
}
```

With a forged `instr.i` / random `state`:

```json
{ "reason": "id_mismatch" } // or failed_challenge
```

Cap’s open source (`generateInstrumentation` / `verifyInstrumentationResult`)
makes this explicit:

- Server **precomputes** four expected integers when minting the blob.
- Client must return `state[varName] === expectedVals[i]` for all four.
- Values are **not** forgeable; pure arithmetic + **DOM tree walk**  
  (`createElement` / `appendChild` / `innerText` / walk parents).
- Heavy **antibot** probes block headless automation.

### 3.3 What worked: re-execute Cap’s math in Node

We do **not** reimplement Cap Standalone as a product. We:

1. `inflateRaw` the `instrumentation` base64 blob.
2. Locate the computation chain after antibot  
   (`return;}var a=0x..,b=0x..,c=0x..,d=0x..; … var OUT={};return OUT…`).
3. Keep the string-table bootstrap (decoder + rotate IIFE).
4. Rewrite decoder calls `alias(0xNNN)` → `__dec(0xNNN)` (aliases are random).
5. Run in `vm` with a **minimal DOM mock** (no layout engine).
6. Evaluate the `'nonce': <expr>` expression for `instr.i`.
7. PoW + redeem; cache token; **retry** new challenges on solve failures  
   (obfuscation variance across blobs).

Proved against a real browser capture: **same `i` and same `state` numbers**.

Implementation: `src/providers/hexa/capSolver.ts`.

---

## 4. WASM / HMAC path (vidsrc twin)

Reuse:

- `src/providers/vidsrc/vidsrcWasm.ts` + vendored `img_data` WASM
- Same HMAC message: `` `${key}:${timestamp}:${nonce}:${path}` ``
- Same list flag header `bW90aGFmYWth: 1`
- Same per-server headers `X-Only-Sources` / `X-Server`

Hexa-only additions:

- `x-cap-token` on every image API call
- Origin/Referer `https://hexa.su`
- API host `theemoviedb.hexa.su`

Implementation: `src/providers/hexa/hexaClient.ts` (patterned on
`vidsrcClient.ts`).

---

## 5. Code map

```
src/providers/hexa/
  hexa.ts           # BaseProvider, proxy wrap, caveats comment
  hexaClient.ts     # Cap token + list + multi-server resolve
  capSolver.ts      # Cap challenge / PoW / instr math / redeem + cache
  hexa.types.ts
  test.ts           # standalone smoke (movie 238, TV 1399)

docs/HEXA-SCRAPING.md   # this file
```

Shared dependency: vidsrc WASM under `src/providers/vidsrc/wasm/`.

---

## 6. Failure modes & ops notes

| Symptom                                                | Likely cause                       | Action                                                         |
| ------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------- |
| `enc-hexa` / “cap token” diagnostics from **old** code | Stale deploy                       | Deploy native Hexa                                             |
| Cap mint fails after retries                           | Blob shape change / Cap blocked IP | Capture new challenge blob; extend extractor; check EC2 egress |
| `INVALID_TIMESTAMP`                                    | Clock skew / stale time cache      | Restart process; check host clock                              |
| Resolve OK, player 403/410                             | CDN / proxy path                   | Segment-level probe; streamPatterns; compare EC2 vs local      |
| Works local, empty on EC2                              | Cap or API IP reputation           | Capture redeem + list from EC2; compare status bodies          |

Cold Cap mint is **slow** (PoW ~10–20s). Token is cached in-process ~2h so
warm requests stay fast.

---

## 7. How we used a real browser (once)

When automation could not pass Cap instrumentation, we asked for DevTools
captures instead of Playwright:

1. Cap **challenge** (headers + full JSON including `instrumentation`)
2. Cap **redeem** (full request body with `solutions` + `instr`, + response)
3. **List** `/images` Copy-as-cURL (with all signing headers)
4. Optional per-server `/images` with `X-Server`

Those dumps grounded the protocol and validated the Node math solver against
ground-truth `instr.state`.

---

## 8. Relation to the masterclass method

| Masterclass step       | Hexa                                                    |
| ---------------------- | ------------------------------------------------------- |
| Entry URL / SPA vs SSR | SPA shell; sources from API not HTML                    |
| Bundle recon           | Identical WASM/enhancer to vidsrc; Cap on `cap.hexa.su` |
| Reproduce request      | Browser cURL dumps for Cap + signed list                |
| Decode response        | WASM `process_img_data`                                 |
| Bypass protections     | Cap instr re-exec in Node (not enc-dec)                 |
| Integrate + harden     | Provider + proxy + retries + caveats                    |

See also: [SCRAPING-MASTERCLASS.md](./SCRAPING-MASTERCLASS.md) §2–§4, §6
(vidsrc WASM), §6b (vidking).

---

## 9. Smoke commands

```bash
# Unit-ish standalone provider test
npx tsx src/providers/hexa/test.ts

# Optional Cap math probe (dev)
npx tsx scripts/probe-cap-math.mts   # if present

# Production-shaped: hit local core after deploy
curl -sS 'http://127.0.0.1:PORT/v1/sources?type=movie&id=238' | jq '.sources[] | select(.provider.id=="hexa")'
```

Always follow with **real player playback** on the target environment.

---

_Written from the Hexa native rebuild (2026-07). Cap obfuscation and host
names will age; the “enc-dec dead → SPA recon → Cap contract → WASM twin”
method will not._
