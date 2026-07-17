"""
vidcore_trace.py  -  trace + diagnose the VidCore (vidcore.net) handshake.

Same enc-dec.app mechanism as vidfast, so this script both:
  * dumps servers_decrypted / stream_decrypted if the flow works, AND
  * shows the raw `servers` response (status + body) if it 404s like vidfast did,
    so we can immediately tell whether vidcore is alive or also stale.

Run:
    pip install requests
    python3 vidcore_trace.py
Then copy the WHOLE output back to me.
"""

import json
import re
import requests

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
HEADERS = {
    "User-Agent": UA,
    "Referer": "https://vidcore.net/",
    "X-Requested-With": "XMLHttpRequest",
}
SITE = "https://vidcore.net"
API = "https://enc-dec.app/api"
MAX_SERVERS_TO_TRACE = 3

TESTS = [
    {"label": "TV - Game of Thrones S1E1", "type": "tv", "tmdb_id": "1399", "season": "1", "episode": "1"},
    {"label": "MOVIE - Fight Club", "type": "movie", "tmdb_id": "550"},
]


def dump(label, obj):
    print("\n===== " + label + " =====")
    try:
        print(json.dumps(obj, indent=2, ensure_ascii=False))
    except Exception:
        print(repr(obj))


def show_resp(tag, r):
    print("\n--- " + tag + " ---")
    print("HTTP " + str(r.status_code) + "   content-type=" + str(r.headers.get("content-type")))
    body = r.text
    print("body length: " + str(len(body)))
    print("body[:600]: " + body[:600])
    return body


def looks_like_ciphertext(body):
    if not body:
        return False
    b = body.strip()
    if len(b) < 24 or "<" in b[:50] or b[:1] in "{[":
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9+/=_\-]+", b))


def dec(text, tag):
    resp = requests.post(API + "/dec-vidcore", json={"text": text}, timeout=20).json()
    if resp.get("status") != 200:
        print("\n!! dec-vidcore ERROR (" + tag + "): status=" + str(resp.get("status")) + " error=" + str(resp.get("error")))
        return None
    return resp["result"]


def page_url_for(case):
    if case["type"] == "movie":
        return SITE + "/movie/" + case["tmdb_id"]
    return SITE + "/tv/" + case["tmdb_id"] + "/" + case["season"] + "/" + case["episode"] + "/"


def trace(case):
    print("\n\n" + "#" * 70 + "\n# " + case["label"] + "\n" + "#" * 70)

    page_url = page_url_for(case)
    print("[1] GET page: " + page_url)
    html = requests.get(page_url, headers=HEADERS, timeout=20).text
    match = re.search(r'\\"en\\":\\"(.*?)\\"', html)
    if not match:
        print("    !! no en-token found (page length " + str(len(html)) + ")")
        return
    text = match.group(1)
    print("    token (" + str(len(text)) + " chars): " + text[:60] + "...")

    print("[2] GET enc-vidcore")
    parts = requests.get(API + "/enc-vidcore?text=" + text, timeout=20).json()
    if parts.get("status") != 200:
        print("    !! enc-vidcore error: " + str(parts))
        return
    parts = parts["result"]
    dump("enc-vidcore result (servers / stream / token)", parts)
    servers_url = parts["servers"]
    stream_prefix = parts["stream"]
    token = parts["token"]
    print("    token repr: " + repr(token))
    HEADERS["X-CSRF-Token"] = token

    print("[3] POST servers url")
    servers_body = show_resp("servers response", requests.post(servers_url, headers=HEADERS, timeout=20))
    if not looks_like_ciphertext(servers_body):
        print("\n    !! servers response is NOT ciphertext (likely 404/HTML) -> vidcore is stale like vidfast.")
        return
    servers_dec = dec(servers_body, "servers")
    dump(">>> servers_decrypted (SERVER LIST SHAPE)", servers_dec)
    if not isinstance(servers_dec, list):
        print("    !! expected a list; see shape above.")
        return

    for i, server in enumerate(servers_dec[:MAX_SERVERS_TO_TRACE]):
        data = server.get("data") if isinstance(server, dict) else None
        if not data:
            print("    server[" + str(i) + "] has no 'data': " + repr(server))
            continue
        print("[4." + str(i) + "] POST stream url (server " + str(i) + ")")
        stream_body = requests.post(stream_prefix + "/" + data, headers=HEADERS, timeout=20).text
        if not looks_like_ciphertext(stream_body):
            print("    !! stream response not ciphertext: " + stream_body[:300])
            continue
        stream_dec = dec(stream_body, "stream")
        dump(">>> stream_decrypted [server " + str(i) + "]  (THE STREAM SHAPE I NEED)", stream_dec)


if __name__ == "__main__":
    for case in TESTS:
        try:
            trace(case)
        except Exception as e:
            print("\n!! " + case["label"] + " failed: " + type(e).__name__ + ": " + str(e))
    print("\n\nDONE. Copy everything above back to me.")
