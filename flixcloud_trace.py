#!/usr/bin/env python3
"""
flixcloud_trace.py - live diagnostic for the FlixCloud hoster resolver.

FlixCloud (flixcloud.cc) is an embed HOSTER, so this validates the full two-step
enc-dec chain against the sample embed url:
  1. scrape the inline `data:{...}` object from the embed page,
  2. POST dec-flixcloud?type=token  -> { token, context },
  3. GET  flixcloud.cc/api/m3u8/<token> -> encrypted stream json,
  4. POST dec-flixcloud?type=stream -> { stream, context.w_payload },
  5. GET  parse-flixcloud?url=&w_payload= -> the final decrypted manifest.

Run locally (needs internet):
    pip install requests json5
    python3 flixcloud_trace.py > flixcloud_diag_output.txt 2>&1
Then send me flixcloud_diag_output.txt.

Note: the enc-dec sample used a live embed url; hoster embeds expire, so if the
sample 404s / yields no data, grab a fresh flixcloud.cc/e/<id> url from a site
that uses this hoster and set EMBED_URL below.
"""

import json
import re
from urllib.parse import urlencode

import requests

try:
    import json5  # embed data is a js-object literal (json5), not strict json
except ImportError:
    json5 = None

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    ),
    "Referer": "https://flixcloud.cc/",
}

API = "https://enc-dec.app/api"
SITE = "https://flixcloud.cc"
TIMEOUT = 30
EMBED_URL = "https://flixcloud.cc/e/olygrhle7ty7?v=2"


def snippet(value, n=500):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= n else text[:n] + " ...[truncated]"


def loads_loose(literal):
    if json5 is not None:
        return json5.loads(literal)
    print("  (json5 not installed - trying strict json, may fail)")
    return json.loads(literal)


def main():
    print("embed url: " + EMBED_URL)

    # 1. fetch embed page + extract inline data object
    page = requests.get(EMBED_URL, headers=HEADERS, timeout=TIMEOUT)
    print("page status: " + str(page.status_code) + "  len: " + str(len(page.text)))
    match = re.search(
        r'type:\s*["\']data["\']\s*,\s*data:\s*(\{.*?\})\s*,\s*uses:',
        page.text,
        re.S,
    )
    if not match:
        print("!! could not find the embedded data object")
        print("page head: " + snippet(page.text, 400))
        return

    data = loads_loose(match.group(1))
    subtitles = data.pop("subtitles", None)
    print("data keys: " + str(list(data.keys())))
    print("subtitles: " + (snippet(subtitles, 300) if subtitles else "None"))

    # 2. token
    tr = requests.post(
        API + "/dec-flixcloud?type=token", json={"data": data}, timeout=TIMEOUT
    ).json()
    print("\n[token] status: " + str(tr.get("status")) + "  error: " + str(tr.get("error")))
    if tr.get("status") != 200:
        return
    token = tr["result"]["token"]
    context = tr["result"]["context"]
    print("  token: " + snippet(str(token), 80))
    print("  context keys: " + str(list(context.keys()) if isinstance(context, dict) else type(context)))

    # 3. encrypted stream json
    sr = requests.get(SITE + "/api/m3u8/" + str(token), headers=HEADERS, timeout=TIMEOUT)
    print("\n[m3u8] status: " + str(sr.status_code))
    stream_response = sr.json()
    print("  stream_response: " + snippet(stream_response, 300))

    # 4. decrypt stream
    dr = requests.post(
        API + "/dec-flixcloud?type=stream",
        json={"data": {"context": context, "stream_response": stream_response}},
        timeout=TIMEOUT,
    ).json()
    print("\n[stream] status: " + str(dr.get("status")) + "  error: " + str(dr.get("error")))
    if dr.get("status") != 200:
        return
    resolved = dr["result"]
    print("  STREAM URL: " + str(resolved.get("stream")))
    w_payload = resolved.get("context", {}).get("w_payload")
    print("  w_payload: " + snippet(str(w_payload), 80))

    # 5. parse manifest
    params = urlencode({"url": resolved["stream"], "w_payload": w_payload or ""})
    pm = requests.get(API + "/parse-flixcloud?" + params, timeout=TIMEOUT)
    print("\n[parse] status: " + str(pm.status_code))
    print("  MANIFEST head:\n" + snippet(pm.text, 700))


if __name__ == "__main__":
    main()
