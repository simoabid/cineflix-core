#!/usr/bin/env python3
"""
onetouchtv_trace.py (v2 - route discovery) - live diagnostic for OneTouchTV.

The v1 trace revealed two things:
  * /web/vod/<id>-<slug>/episode/<ep> is a REAL route: it returned an encrypted
    88-byte blob (not the plaintext NotFoundError), but 404 because the sample
    content "150294-ghost-train-2024" is gone from the catalogue now.
  * every /web/search* guess returns plaintext {"error":"NotFoundError: This
    route doesn't exist!"} - so the api CLEANLY tells us when a route is bogus.

This v2 uses that to (A) decrypt the sample's 404 body so we see what OneTouchTV
returns, and (B) map the real routes by sweeping candidates: any response that
is NOT the NotFoundError is a real route, and if it looks encrypted we push it
through dec-onetouchtv too.

Run locally (needs internet):
    pip install requests
    python3 onetouchtv_trace.py > onetouchtv_diag_output.txt 2>&1
Then send me onetouchtv_diag_output.txt.
"""

import json
from urllib.parse import quote

import requests

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

API = "https://enc-dec.app/api"
BASE = "https://api3.devcorp.me/web"
ROOT = "https://api3.devcorp.me"
TIMEOUT = 30
NOT_FOUND = "NotFoundError"


def snippet(text, n=600):
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False)
    return text if len(text) <= n else text[:n] + " ...[truncated]"


def looks_like_route_miss(body):
    return NOT_FOUND in (body or "")


def try_decrypt(encrypted):
    """push a blob through dec-onetouchtv; return (ok, printable)."""
    try:
        dres = requests.post(
            API + "/dec-onetouchtv", json={"text": encrypted}, timeout=TIMEOUT
        ).json()
        if dres.get("status") == 200:
            return True, json.dumps(dres["result"], indent=2, ensure_ascii=False)
        return False, "dec status " + str(dres.get("status")) + " error " + str(
            dres.get("error")
        )
    except Exception as exc:
        return False, "dec request failed: " + repr(str(exc))


def probe(url, decrypt_if_encrypted=True, full_decrypt=False):
    print("[probe] GET " + url)
    try:
        res = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    except Exception as exc:
        print("    request failed: " + repr(str(exc)))
        print()
        return
    body = res.text
    ctype = res.headers.get("content-type", "")
    print("    status: " + str(res.status_code) + "   content-type: " + ctype)
    if looks_like_route_miss(body):
        print("    -> route does not exist")
        print()
        return
    # real route (encrypted blob or real json)
    if "json" in ctype and not body.strip().startswith("K"):
        print("    JSON: " + snippet(body))
    else:
        print("    body length: " + str(len(body)))
        print("    body head  : " + snippet(body, 160))
        if decrypt_if_encrypted and body:
            ok, printable = try_decrypt(body)
            tag = "DECRYPTED" if ok else "dec-failed"
            print("    [" + tag + "] " + (printable if full_decrypt else snippet(printable)))
    print()


def main():
    print("#" * 70)
    print("# A. decrypt the sample's 404 body (what does OneTouchTV return?)")
    print("#" * 70)
    probe(
        BASE + "/vod/150294-ghost-train-2024/episode/1",
        full_decrypt=True,
    )
    # also try the detail without /episode, and id-only
    probe(BASE + "/vod/150294-ghost-train-2024", full_decrypt=True)
    probe(BASE + "/vod/150294", full_decrypt=True)

    print("#" * 70)
    print("# B. map catalogue / browse routes")
    print("#" * 70)
    for path in [
        "",
        "/",
        "/vod",
        "/home",
        "/menu",
        "/sections",
        "/section",
        "/genres",
        "/genre",
        "/movies",
        "/movie",
        "/series",
        "/tv",
        "/discover",
        "/trending",
        "/catalog",
        "/catalogue",
        "/list",
    ]:
        probe(BASE + path)
    # non-/web roots
    for url in [ROOT + "/", ROOT + "/api", ROOT + "/mobile", ROOT + "/search"]:
        probe(url)

    print("#" * 70)
    print("# C. search: param-key sweep on /web/search")
    print("#" * 70)
    term = quote("Ghost Train")
    for key in ["query", "text", "title", "name", "s", "term", "word", "search"]:
        probe(BASE + "/search?" + key + "=" + term)

    print("#" * 70)
    print("# D. search: path-style + alt bases")
    print("#" * 70)
    for url in [
        BASE + "/search/" + term,
        BASE + "/vod/search/" + term,
        BASE + "/vod/search?query=" + term,
        BASE + "/vod?search=" + term,
        BASE + "/vod?title=" + term,
        ROOT + "/search?keyword=" + term,
        ROOT + "/api/search?keyword=" + term,
    ]:
        probe(url)


if __name__ == "__main__":
    main()
