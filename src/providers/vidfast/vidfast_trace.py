"""
vidfast_trace.py

Standalone tracer for the VidFast (vidfast.vc) enc-dec.app handshake.
Its ONLY job is to print the exact JSON shape of:
  1. the decrypted SERVER LIST   (servers_decrypted)
  2. the decrypted STREAM object (stream_decrypted) for the first few servers

That is the piece the TypeScript provider's normalizer needs pinned down.

Run:
    pip install requests        # if you don't already have it
    python3 vidfast_trace.py

Then copy the WHOLE output back to me.
"""

import json
import re
import requests

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

HEADERS = {
    "User-Agent": UA,
    "Referer": "https://vidfast.vc/",
    "X-Requested-With": "XMLHttpRequest",
}

SITE = "https://vidfast.vc"
API = "https://enc-dec.app/api"

# How many servers to fully resolve (each = 2 extra requests). 3 is plenty.
MAX_SERVERS_TO_TRACE = 3

# --- Test cases: one TV episode + one movie ---------------------------------
TESTS = [
    {"label": "TV - Game of Thrones S1E1", "type": "tv", "tmdb_id": "1399", "season": "1", "episode": "1"},
    {"label": "MOVIE - Fight Club", "type": "movie", "tmdb_id": "550"},
]


def validate(data, path):
    if data.get("status") != 200:
        print("\n" + "!" * 20 + " API ERROR " + "!" * 20)
        print("Path: " + str(path))
        print("Status: " + str(data.get("status")) + "  Error: " + str(data.get("error", "unknown")))
        return None
    return data["result"]


def dump(label, obj):
    print("\n===== " + label + " =====")
    try:
        print(json.dumps(obj, indent=2, ensure_ascii=False))
    except Exception:
        print(repr(obj))


def page_url_for(case):
    if case["type"] == "movie":
        return SITE + "/movie/" + case["tmdb_id"]
    return SITE + "/tv/" + case["tmdb_id"] + "/" + case["season"] + "/" + case["episode"] + "/"


def trace(case):
    print("\n\n" + "#" * 70 + "\n# " + case["label"] + "\n" + "#" * 70)

    # 1. page url + scrape the escaped \"en\":\"<token>\" blob
    page_url = page_url_for(case)
    print("[1] GET page: " + page_url)
    html = requests.get(page_url, headers=HEADERS, timeout=20).text
    match = re.search(r'\\"en\\":\\"(.*?)\\"', html)
    if not match:
        print("    !! could not find the escaped en-token in the page HTML.")
        print("    (page length was " + str(len(html)) + " chars)")
        return
    text = match.group(1)
    print("    token extracted (" + str(len(text)) + " chars): " + text[:60] + "...")

    # 2. enc-vidfast -> { servers, stream, token }
    enc_url = API + "/enc-vidfast?text=" + text
    print("[2] GET enc-vidfast")
    parts = validate(requests.get(enc_url, timeout=20).json(), enc_url)
    if not parts:
        return
    dump("enc-vidfast result (servers / stream / token)", parts)
    servers_url = parts["servers"]
    stream_prefix = parts["stream"]
    token = parts["token"]

    HEADERS["X-CSRF-Token"] = token

    # 3. POST servers url -> encrypted -> dec-vidfast -> server list
    print("[3] POST servers url -> dec-vidfast")
    servers_enc = requests.post(servers_url, headers=HEADERS, timeout=20).text
    servers_dec = validate(
        requests.post(API + "/dec-vidfast", json={"text": servers_enc}, timeout=20).json(),
        "dec-vidfast (servers)",
    )
    dump(">>> servers_decrypted  (THE SERVER LIST SHAPE)", servers_dec)

    if not isinstance(servers_dec, list):
        print("    !! expected a list of servers; see shape above.")
        return

    # 4. resolve the first few servers -> stream payload
    for i, server in enumerate(servers_dec[:MAX_SERVERS_TO_TRACE]):
        data = server.get("data") if isinstance(server, dict) else None
        if not data:
            print("    server[" + str(i) + "] has no 'data' field: " + repr(server))
            continue
        stream_url = stream_prefix + "/" + data
        name = ""
        if isinstance(server, dict):
            name = str(server.get("name") or server.get("label") or i)
        print("[4." + str(i) + "] POST stream url -> dec-vidfast  (server=" + name + ")")
        stream_enc = requests.post(stream_url, headers=HEADERS, timeout=20).text
        stream_dec = validate(
            requests.post(API + "/dec-vidfast", json={"text": stream_enc}, timeout=20).json(),
            "dec-vidfast (stream)",
        )
        dump(">>> stream_decrypted [server " + str(i) + "]  (THE STREAM SHAPE I NEED)", stream_dec)


if __name__ == "__main__":
    for case in TESTS:
        try:
            trace(case)
        except Exception as e:
            print("\n!! " + case["label"] + " failed: " + type(e).__name__ + ": " + str(e))
    print("\n\nDONE. Copy everything above (especially the >>> stream_decrypted blocks) back to me.")
