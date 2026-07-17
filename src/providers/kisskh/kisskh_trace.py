#!/usr/bin/env python3
"""
kisskh_trace.py - live diagnostic for the KissKH provider.

KissKH (kisskh.do) is keyed by its own numeric episode ids, so this validates
BOTH halves of the provider:
  A. the title -> drama -> episode resolver (KissKH public DramaList api), now
     SEASON-AWARE and mirroring the provider's pickDrama logic, and
  B. the enc-dec.app flow (enc-kisskh vid/sub -> Episode/Sub -> dec-kisskh),
     which mirrors the documented sample (already confirmed working).

Run locally (needs internet):
    pip install requests
    python3 kisskh_trace.py > kisskh_diag_output.txt 2>&1
Then send me kisskh_diag_output.txt.

It prints every stage's status + the real json shapes, and now also prints the
SEASON-AWARE pick so we can confirm "Squid Game" S1 -> "Squid Game Season 1"
(not Season 3) and that the movie matcher no longer grabs an unrelated hit.
It also runs the sample's known-good episode id (192143) directly.
"""

import json
from urllib.parse import quote

import requests

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://kisskh.do/",
    "Origin": "https://kisskh.do",
}

API = "https://enc-dec.app/api"
BASE = "https://kisskh.do"
TIMEOUT = 30


def snippet(text, n=600):
    text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    return text if len(text) <= n else text[:n] + " ...[truncated]"


def pick_drama(hits, media):
    """Mirror of the provider's season-aware pickDrama."""
    base = media["title"].strip().lower()
    season = media.get("season", 1) if media["type"] == "tv" else None

    forms = []
    if season is not None:
        forms.append(base + " season " + str(season))
        if season == 1:
            forms.append(base)
    else:
        forms.append(base)

    # 1. exact match against a preferred form
    for form in forms:
        for h in hits:
            if h.get("title", "").strip().lower() == form:
                return h

    # 2. tv season > 1: starts-with base AND names the season
    if season is not None and season > 1:
        for h in hits:
            t = h.get("title", "").strip().lower()
            if t.startswith(base) and ("season " + str(season)) in t:
                return h
        return None

    # 3. movie / season 1: prefix match, shortest title first
    prefix = [
        h
        for h in hits
        if h.get("title", "").strip().lower() == base
        or h.get("title", "").strip().lower().startswith(base + " ")
        or h.get("title", "").strip().lower().startswith(base + ":")
    ]
    prefix.sort(key=lambda h: len(h.get("title", "")))
    return prefix[0] if prefix else None


def get_key(episode_id, kind):
    url = API + "/enc-kisskh?text=" + str(episode_id) + "&type=" + kind
    print("  [enc-kisskh " + kind + "] GET " + url)
    data = requests.get(url, timeout=TIMEOUT).json()
    print("    status: " + str(data.get("status")))
    if data.get("status") != 200:
        print("    error: " + str(data.get("error")))
        return None
    print("    kkey: " + snippet(str(data["result"]), 120))
    return data["result"]


def run_encdec(episode_id):
    print("-" * 50)
    print("enc-dec flow for episode id " + str(episode_id))
    print("-" * 50)

    vid_key = get_key(episode_id, "vid")
    if vid_key:
        vurl = (
            BASE
            + "/api/DramaList/Episode/"
            + str(episode_id)
            + ".png?err=false&ts=&time=&kkey="
            + quote(str(vid_key))
        )
        print("  [video] GET " + vurl)
        vres = requests.get(vurl, headers=HEADERS, timeout=TIMEOUT)
        print("    status: " + str(vres.status_code))
        try:
            print("    VIDEO json: " + snippet(vres.json()))
        except Exception as exc:
            print("    (not json) " + repr(str(exc)) + " body: " + snippet(vres.text, 200))

    sub_key = get_key(episode_id, "sub")
    if sub_key:
        surl = (
            BASE + "/api/Sub/" + str(episode_id) + "?kkey=" + quote(str(sub_key))
        )
        print("  [sub] GET " + surl)
        sres = requests.get(surl, headers=HEADERS, timeout=TIMEOUT)
        print("    status: " + str(sres.status_code))
        subs = []
        try:
            subs = sres.json()
            print("    SUB json: " + snippet(subs))
        except Exception as exc:
            print("    (not json) " + repr(str(exc)))
        if isinstance(subs, list) and subs and subs[0].get("src"):
            src = subs[0]["src"]
            durl = API + "/dec-kisskh?url=" + quote(src)
            print("  [dec-kisskh] GET " + durl)
            dres = requests.get(durl, timeout=TIMEOUT)
            print("    status: " + str(dres.status_code))
            print("    DECRYPTED sub head: " + snippet(dres.text, 200))


def resolve(media):
    print("=" * 70)
    print("RESOLVER - " + media["label"])
    print("=" * 70)

    surl = BASE + "/api/DramaList/Search?q=" + quote(media["title"]) + "&type=0"
    print("[search] GET " + surl)
    sres = requests.get(surl, headers=HEADERS, timeout=TIMEOUT)
    print("  status: " + str(sres.status_code))
    try:
        hits = sres.json()
    except Exception as exc:
        print("  (not json) " + repr(str(exc)) + " body: " + snippet(sres.text, 200))
        return
    print("  hits: " + snippet(hits))
    if not isinstance(hits, list) or not hits:
        print("  no hits")
        return

    drama = pick_drama(hits, media)
    if not drama:
        print("  SEASON-AWARE pick: none (clean empty result)")
        return
    drama_id = drama.get("id")
    print(
        "  SEASON-AWARE pick: id "
        + str(drama_id)
        + " title "
        + str(drama.get("title"))
    )

    durl = BASE + "/api/DramaList/Drama/" + str(drama_id) + "?isq=false"
    print("[detail] GET " + durl)
    dres = requests.get(durl, headers=HEADERS, timeout=TIMEOUT)
    print("  status: " + str(dres.status_code))
    try:
        detail = dres.json()
    except Exception as exc:
        print("  (not json) " + repr(str(exc)))
        return
    eps = detail.get("episodes") if isinstance(detail, dict) else None
    print("  episodes count: " + str(len(eps) if isinstance(eps, list) else "n/a"))
    if isinstance(eps, list) and eps:
        eps_sorted = sorted(eps, key=lambda e: float(e.get("number", 0)))
        if media["type"] == "movie":
            chosen = next(
                (e for e in eps_sorted if float(e.get("number", -1)) == 1.0),
                eps_sorted[0],
            )
        else:
            target = media.get("episode", 1)
            chosen = next(
                (e for e in eps_sorted if float(e.get("number", -1)) == float(target)),
                None,
            )
        if chosen:
            print("  chosen episode id: " + str(chosen.get("id")))
            run_encdec(chosen.get("id"))
        else:
            print("  no episode matched")


def main():
    print("#" * 70)
    print("# SANITY: sample episode id 192143 (enc-dec flow only)")
    print("#" * 70)
    run_encdec(192143)
    print()

    cases = [
        {
            "label": "TV - Squid Game S1E1 (expect 'Squid Game Season 1')",
            "type": "tv",
            "title": "Squid Game",
            "season": 1,
            "episode": 1,
        },
        {
            "label": "TV - Squid Game S2E1 (expect 'Squid Game Season 2')",
            "type": "tv",
            "title": "Squid Game",
            "season": 2,
            "episode": 1,
        },
        {
            "label": "MOVIE - Train to Busan (expect exact 'Train to Busan')",
            "type": "movie",
            "title": "Train to Busan",
        },
    ]
    for media in cases:
        resolve(media)
        print()


if __name__ == "__main__":
    main()
