#!/usr/bin/env python3
"""Convert a bundled taxonomy .xlsx (taxon/family/... columns) into a compact
offline JSON species pack used by the app's search index.

Usage:
  python3 scripts/build_species_pack.py <source.xlsx> <dest.json> --id infoflora-ch --label "InfoFlora Swiss Checklist (2017)"
"""
import argparse
import json
import re
import zipfile
import xml.etree.ElementTree as ET

NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def col_letters(cellref):
    m = re.match(r"([A-Z]+)(\d+)", cellref)
    return m.group(1), int(m.group(2))


def read_xlsx_rows(path):
    z = zipfile.ZipFile(path)
    sst = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("a:si", NS):
            texts = si.findall(".//a:t", NS)
            sst.append("".join(t.text or "" for t in texts))

    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for row in sheet.findall(".//a:row", NS):
        cells = {}
        for c in row.findall("a:c", NS):
            col, _ = col_letters(c.get("r"))
            t = c.get("t")
            v = c.find("a:v", NS)
            val = v.text if v is not None else None
            if t == "s" and val is not None:
                val = sst[int(val)]
            cells[col] = val
        rows.append(cells)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("dest")
    ap.add_argument("--id", required=True)
    ap.add_argument("--label", required=True)
    args = ap.parse_args()

    rows = read_xlsx_rows(args.source)
    header = rows[0]
    col_by_name = {v.strip().lower(): k for k, v in header.items() if v}
    taxon_col = col_by_name.get("taxon")
    family_col = col_by_name.get("family")
    native_col = col_by_name.get("native")
    if not taxon_col:
        raise SystemExit("no 'taxon' column found")

    species = []
    for r in rows[1:]:
        taxon = (r.get(taxon_col) or "").strip()
        if not taxon:
            continue
        entry = {"t": taxon}
        if family_col and r.get(family_col):
            entry["f"] = r.get(family_col).strip()
        if native_col and r.get(native_col):
            entry["n"] = r.get(native_col).strip()
        species.append(entry)

    species.sort(key=lambda e: e["t"])

    pack = {
        "id": args.id,
        "label": args.label,
        "count": len(species),
        "species": species,
    }
    with open(args.dest, "w") as f:
        json.dump(pack, f, ensure_ascii=False, separators=(",", ":"))

    print(f"wrote {len(species)} taxa -> {args.dest}")


if __name__ == "__main__":
    main()
