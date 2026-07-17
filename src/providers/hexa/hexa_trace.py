#!/usr/bin/env python3
"""
hexa_trace.py - live diagnostic for the Hexa provider.

Hexa (hexa.su / flixer.su, api host theemoviedb.hexa.su) has no proof-of-work:
it gates on a random per-request api key plus a capability token minted by
enc-dec.app. This runs the whole flow (logic mirrored from the enc-dec.app
`hexa` sample) so we can learn:
  1. Are theemoviedb.hexa.su + enc-dec.app's enc/dec-hexa alive?
  2. What is the decrypted stream SHAPE (undocumented in the sample)?

Run locally (needs internet):
    pip install requests
    python3 hexa_trace.py > hexa_diag_output.txt 2>&1
Then send me hexa_diag_output.txt.

Flow:
  key    random 32-byte hex -> X-Api-Key header (also the dec key)
  token  GET  enc-dec.app/api/enc-hexa       -> { token } -> X-Cap-Token
  fetch  GET  theemoviedb.hexa.su/.../images -> encrypted text
  dec    POST enc-dec.app/api/dec-hexa { text, key } -> decrypted stream
"""

import json
import secrets

import requests

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    ),
    "Referer": "https://hexa.su/",
    "Accept": "text/plain",
    "X-Fingerprint-Lite": "e9136c41504646444",
}

API = "https://enc-dec.app/api"
BASE = "https://theemoviedb.hexa.su"
TIMEOUT = 30


def snippet(text, n=600):
    text = text or ""
    return text if len(text) <= n else text[:n] + " ...[truncated]"


def build_url(media):
    if media["type"] == "tv":
        return (
            BASE
            + "/api/tmdb/tv/"
            + media["tmdb_id"]
            + "/season/"
            + media.get("season", "1")
            + "/episode/"
            + media.get("episode", "1")
            + "/images"
        )
    return BASE + "/api/tmdb/movie/" + media["tmdb_id"] + "/images"


def run(media):
    print("=" * 70)
    print(media["label"] + "  (tmdb " + media["tmdb_id"] + ")")
    print("=" * 70)

    headers = dict(HEADERS)

    # 1. random 32-byte hex api key (also the dec key)
    key = secrets.token_hex(32)
    headers["X-Api-Key"] = key
    print("api key (X-Api-Key/dec key): " + key)

    # 2. cap token
    print("[enc-hexa] GET /enc-hexa")
    enc = requests.get(API + "/enc-hexa", timeout=TIMEOUT).json()
    print("  enc-hexa status: " + str(enc.get("status")))
    if enc.get("status") != 200:
        print("  error: " + str(enc.get("error")))
        return
    token = enc["result"]["token"]
    headers["X-Cap-Token"] = token
    print("  got cap token: " + snippet(token, 120))

    # 3. fetch encrypted
    url = build_url(media)
    print("[fetch] GET " + url)
    fetch = requests.get(url, headers=headers, timeout=TIMEOUT)
    print("  fetch status: " + str(fetch.status_code))
    encrypted = fetch.text
    print("  encrypted length: " + str(len(encrypted)))
    print("  encrypted head  : " + snippet(encrypted, 200))
    if fetch.status_code != 200 or not encrypted:
        return

    # 4. decrypt
    print("[dec-hexa] POST /dec-hexa")
    dec = requests.post(
        API + "/dec-hexa", json={"text": encrypted, "key": key}, timeout=TIMEOUT
    ).json()
    print("  dec-hexa status: " + str(dec.get("status")))
    if dec.get("status") != 200:
        print("  error: " + str(dec.get("error")))
        return
    print("  DECRYPTED (full):")
    print(json.dumps(dec["result"], indent=2, ensure_ascii=False))


def main():
    cases = [
        {
            "label": "TV - Cyberpunk: Edgerunners S1E1",
            "type": "tv",
            "title": "Cyberpunk: Edgerunners",
            "tmdb_id": "105248",
            "imdb_id": "tt12590266",
            "year": "2022",
            "season": "1",
            "episode": "1",
        },
        {
            "label": "MOVIE - Fight Club",
            "type": "movie",
            "title": "Fight Club",
            "tmdb_id": "550",
            "imdb_id": "tt0137523",
            "year": "1999",
        },
    ]
    for media in cases:
        run(media)
        print()


if __name__ == "__main__":
    main()
