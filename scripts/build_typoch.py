#!/usr/bin/env python3
"""Build species/typoch-ch.json from the InfoFlora TypoCH species-list workbook
(artenliste_..._typoch_*.xlsx). Two things come out of it:

  • habitats — the TypoCH habitat typology (Delarze et al. 2015, "Lebensräume
    der Schweiz"): hierarchical code, id, level, DE/FR/IT names, the
    phytosociological alliance name, and the EUNIS crosswalk.
  • species — for every checklist species, the habitats it is a *character
    species* of, with the CAR code and characteristic/dominant flags.

That lets the app do "habitat analysis from a species list": given the species
recorded in a relevé, rank the habitats whose character species are present.

Species are matched to the bundled InfoFlora checklist by normalised name
(genus + epithet), so only species present in that checklist are kept.

Usage: python3 scripts/build_typoch.py  (path to xlsx as arg, or edit XLSX below)
"""
import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.join(HERE, "..", "species", "infoflora-ch.json")
OUT = os.path.join(HERE, "..", "species", "typoch-ch.json")
XLSX = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    "~/Downloads/artenliste_liste-des-especes_lista-delle-specie_typoch_2024-05-29_01(2).xlsx")
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def load_sheets(path):
    z = zipfile.ZipFile(path)
    ss = []
    for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS + "si"):
        ss.append("".join(t.text or "" for t in si.iter(NS + "t")))

    def colnum(ref):
        m = re.match(r"([A-Z]+)", ref)
        n = 0
        for c in m.group(1):
            n = n * 26 + (ord(c) - 64)
        return n - 1

    def rows(sheet):
        out = []
        for row in ET.fromstring(z.read(sheet)).iter(NS + "row"):
            cells = {}
            for c in row.findall(NS + "c"):
                v = c.find(NS + "v")
                val = ss[int(v.text)] if (c.get("t") == "s" and v is not None) else (v.text if v is not None else "")
                cells[colnum(c.get("r"))] = val
            out.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])
        return out

    return rows("xl/worksheets/sheet1.xml"), rows("xl/worksheets/sheet2.xml")


def norm(name):
    """Normalise to 'genus epithet' (lowercased) for cross-list matching."""
    name = re.sub(r"\bspp?\.\b", "sp", name or "")
    words = re.sub(r"[^A-Za-z\s.-]", " ", name).lower().split()
    words = [w.strip(".") for w in words if w.strip(".") and w.strip(".") not in
             ("subsp", "var", "f", "subvar", "aggr", "cf", "x", "l", "s", "str")]
    return " ".join(words[:2])


def main():
    sp_rows, hab_rows = load_sheets(XLSX)
    checklist = json.load(open(PACK))["species"]
    check_norm = {}
    for sp in checklist:
        check_norm.setdefault(norm(sp["t"]), sp["t"])

    # --- habitats (sheet "TypoCH") ---
    hhdr = hab_rows[0]
    idx = {h: i for i, h in enumerate(hhdr)}
    habitats = []
    hab_by_id = {}
    for r in hab_rows[1:]:
        code = (r[idx["Code TypoCH"]] if idx.get("Code TypoCH") is not None and idx["Code TypoCH"] < len(r) else "").strip()
        hid = (r[idx["ID TypoCH"]] if idx["ID TypoCH"] < len(r) else "").strip()
        if not hid:
            continue
        def g(k):
            j = idx.get(k)
            return (r[j].strip() if j is not None and j < len(r) else "")
        h = {
            "code": code, "id": hid, "level": len([p for p in code.split(".") if p]) if code else 1,
            "de": g("Name Deutsch"), "fr": g("nom français"), "it": g("nome italiano"),
            "sci": g("scientific name"), "eunis": g("eunis"),
        }
        habitats.append(h)
        hab_by_id[hid] = h

    # --- species → habitat associations (sheet "TypoCH-Species") ---
    # find header row
    hi = next(i for i, r in enumerate(sp_rows) if any(str(c).strip() == "Code TypoCH" for c in r))
    shdr = sp_rows[hi]
    sidx = {h: i for i, h in enumerate(shdr)}

    def sg(r, k):
        j = sidx.get(k)
        return (r[j].strip() if j is not None and j < len(r) else "")

    species = {}
    assoc_total = 0
    matched = 0
    truthy = {"y", "yes", "o", "oui", "si", "1", "x", "j", "ja"}
    for r in sp_rows[hi + 1:]:
        hid = sg(r, "ID TypoCH")
        orig = sg(r, "Species 2015 original name")
        cl = sg(r, "Name Checklist 2017")
        if not hid or not (orig or cl):
            continue
        assoc_total += 1
        key = None
        for cand in (orig, cl):
            k = norm(cand)
            if k in check_norm:
                key = check_norm[k]
                break
        if not key:
            continue
        matched += 1
        car = sg(r, "CAR 2015")
        char = 1 if sg(r, "caracteristic").lower() in truthy else 0
        dom = 1 if sg(r, "dominant").lower() in truthy else 0
        entry = {"id": hid, "car": car}
        if char:
            entry["c"] = 1
        if dom:
            entry["d"] = 1
        species.setdefault(key, []).append(entry)

    out = {
        "source": "TypoCH — Delarze, Gonseth, Eggenberg & Vust (2015), Lebensräume der Schweiz / Guide des milieux naturels de Suisse (3rd ed.); InfoFlora species-list export 2024-05-29",
        "habitats": habitats,
        "species": species,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"habitats: {len(habitats)}  (levels: {sorted(set(h['level'] for h in habitats))})", file=sys.stderr)
    print(f"associations: {assoc_total} rows, matched to checklist: {matched} ({len(species)} distinct species)", file=sys.stderr)
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
