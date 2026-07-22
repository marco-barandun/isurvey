#!/usr/bin/env python3
"""Build species/frequency-ch.json — a bundled "how common is this species in
Switzerland" table used as an always-on, offline recognition prior.

Source: iNaturalist observation counts per species within Switzerland
(place_id 7236, iconic taxon Plantae). The count is a solid proxy for how
likely you are to encounter/record a species, which lets the voice matcher
gently prefer common species over rare congeners (e.g. Achillea millefolium
over A. atrata) without hard-gating anything.

Matched to the bundled InfoFlora checklist at species level (Genus + specific
epithet); infraspecific taxa in the checklist inherit their species' count.
Only checklist species are written, keeping the file small.

Run occasionally to refresh; nothing here runs at app time.
"""
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.join(HERE, "..", "species", "infoflora-ch.json")
OUT = os.path.join(HERE, "..", "species", "frequency-ch.json")
PLACE_ID = 7236  # Switzerland
API = "https://api.inaturalist.org/v1/observations/species_counts"


def species_key(name):
    """Genus + specific epithet, lowercased — the level iNat counts live at."""
    words = re.sub(r"[^A-Za-z\s-]", " ", name).lower().split()
    words = [w for w in words if w not in ("subsp", "var", "f", "subvar", "aggr", "cf", "x")]
    return " ".join(words[:2]) if len(words) >= 2 else (words[0] if words else "")


def fetch_all_counts():
    counts = {}
    page = 1
    while True:
        url = f"{API}?place_id={PLACE_ID}&iconic_taxa=Plantae&per_page=500&page={page}"
        req = urllib.request.Request(url, headers={"User-Agent": "isurvey-frequency-build/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
        results = data.get("results", [])
        if not results:
            break
        for res in results:
            name = (res.get("taxon") or {}).get("name") or ""
            key = species_key(name)
            if key:
                counts[key] = max(counts.get(key, 0), res.get("count", 0))
        total = data.get("total_results", 0)
        print(f"  page {page}: {len(results)} taxa (running keys={len(counts)}, total={total})", file=sys.stderr)
        if page * 500 >= total:
            break
        page += 1
        time.sleep(1.0)  # be polite to the API
    return counts


def main():
    with open(PACK) as f:
        pack = json.load(f)
    checklist = pack["species"]

    print("Fetching Swiss iNaturalist species counts…", file=sys.stderr)
    counts = fetch_all_counts()
    print(f"Fetched {len(counts)} species-level counts.", file=sys.stderr)

    freq = {}
    matched = 0
    for sp in checklist:
        key = species_key(sp["t"])
        c = counts.get(key)
        if c:
            freq[sp["t"]] = c
            matched += 1

    out = {
        "source": "iNaturalist observation counts, Switzerland (place_id 7236, Plantae)",
        "built": time.strftime("%Y-%m-%d"),
        "matched": matched,
        "checklist": len(checklist),
        "freq": freq,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {OUT}: matched {matched}/{len(checklist)} checklist species.", file=sys.stderr)


if __name__ == "__main__":
    main()
