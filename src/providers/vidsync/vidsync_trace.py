#!/usr/bin/env python3
"""
vidsync_trace.py - live diagnostic for the VidSync provider.

Mirrors the enc-dec.app `vidsync` sample end to end so we can confirm the flow
resolves and, crucially, SEE THE DECRYPTED STREAM SHAPE (the sample never
documents it). Run this on your local machine (it needs internet):

    pip install requests
    python3 vidsync_trace.py > vidsync_diag_output.txt 2>&1

Then send me vidsync_diag_output.txt.

Flow per server:
  1. GET  enc-dec.app/api/enc-vidsync            -> { token }  (Turnstile token)
  2. GET  vidsync.xyz/api/stream/fetch?...       -> encrypted text
         (with header X-Cf-Turnstile: token)
  3. POST enc-dec.app/api/dec-vidsync {text,id}  -> decrypted stream
"""

import json
import requests
from urllib.parse import urlencode

API = "https://enc-dec.app/api"
BASE = "https://vidsync.xyz"

HEADERS = {
    "Accept": "*/*",
    "Origin": "https://vidsync.xyz",
    "Referer": "https://vidsync.xyz/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    ),
    "X-Requested-With": "XMLHttpRequest",
}

DEFAULT_SERVERS = [
    "cinevault",
    "cinedub",
    "cinebox",
    "cineflix",
    "cinevip",
    "cinecloud",
    "cine4k",
]

TIMEOUT = 25


def line(char="-", n=70):
    print(char * n)


def snippet(text, n=600):
    text = text or ""
    return text if len(text) <= n else text[:n] + " ...[truncated]"


def get_server_list():
    url = BASE + "/api/stream/serverList"
    print("GET " + url)
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        print("  status: " + str(r.status_code))
        print("  raw   : " + snippet(r.text, 300))
        data = r.json()
        if isinstance(data, list):
            names = [s for s in data if isinstance(s, str)]
            if names:
                return names
        if isinstance(data, dict) and isinstance(data.get("servers"), list):
            names = [s for s in data["servers"] if isinstance(s, str)]
            if names:
                return names
    except Exception as exc:  # noqa: BLE001
        print("  serverList failed: " + repr(exc))
    print("  -> falling back to DEFAULT_SERVERS")
    return DEFAULT_SERVERS


def get_token():
    url = API + "/enc-vidsync"
    r = requests.get(url, timeout=TIMEOUT)
    try:
        j = r.json()
    except Exception:  # noqa: BLE001
        print("  enc-vidsync non-json: " + snippet(r.text, 200))
        return None
    status = j.get("status")
    token = (j.get("result") or {}).get("token") if isinstance(
        j.get("result"), dict
    ) else None
    print("  enc-vidsync status: " + str(status))
    if token:
        print("  token: " + token[:40] + "... (len " + str(len(token)) + ")")
    else:
        print("  token: MISSING  full=" + snippet(json.dumps(j), 200))
    return token if status == 200 else None


def build_fetch_url(media, server):
    params = {
        "type": media["type"],
        "title": media["title"],
        "mediaId": str(media["tmdb_id"]),
        "serverName": server,
    }
    if media.get("year"):
        params["releaseYear"] = str(media["year"])
    if media["type"] == "tv":
        params["season"] = str(media.get("season", 1))
        params["episode"] = str(media.get("episode", 1))
    # urlencode uses quote_plus (spaces -> +), matching the sample.
    return BASE + "/api/stream/fetch?" + urlencode(params)


def trace_server(media, server):
    line()
    print("SERVER: " + server)
    line()

    print("[1] Turnstile token")
    token = get_token()
    if not token:
        print("  -> no token, skipping server\n")
        return

    print("[2] vidsync fetch")
    url = build_fetch_url(media, server)
    print("  GET " + url)
    headers = dict(HEADERS)
    headers["X-Cf-Turnstile"] = token
    r = requests.get(url, headers=headers, timeout=TIMEOUT)
    print("  status: " + str(r.status_code))
    text = r.text
    print("  raw body: " + snippet(text))
    if not text:
        print("  -> empty body, skipping\n")
        return

    print("[3] dec-vidsync")
    r2 = requests.post(
        API + "/dec-vidsync",
        json={"text": text, "id": str(media["tmdb_id"])},
        timeout=TIMEOUT,
    )
    try:
        j2 = r2.json()
    except Exception:  # noqa: BLE001
        print("  dec non-json: " + snippet(r2.text, 300))
        return
    print("  dec status: " + str(j2.get("status")))
    if j2.get("status") != 200:
        print("  error: " + str(j2.get("error")))
        print()
        return
    print("  DECRYPTED (full):")
    print(json.dumps(j2.get("result"), indent=2, ensure_ascii=False))
    print()


def main():
    cases = [
        {
            "label": "MOVIE - Fight Club",
            "type": "movie",
            "title": "Fight Club",
            "tmdb_id": "550",
            "year": "1999",
        },
        {
            "label": "TV - Game of Thrones S1E1",
            "type": "tv",
            "title": "Game of Thrones",
            "tmdb_id": "1399",
            "year": "2011",
            "season": 1,
            "episode": 1,
        },
    ]

    line("=")
    print("vidsync server list")
    line("=")
    servers = get_server_list()
    print("servers: " + json.dumps(servers))
    print()

    for media in cases:
        line("=")
        print(media["label"] + "  (tmdb " + media["tmdb_id"] + ")")
        line("=")
        for server in servers:
            trace_server(media, server)


if __name__ == "__main__":
    main()
