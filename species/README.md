# Species packs

Each file here is a bundled, offline taxon list used for the app's search
(relevé species list, sighting picker). `index.json` lists which packs are
available; the app loads every pack listed there.

## Format

```json
{
  "id": "infoflora-ch",
  "label": "InfoFlora Swiss Checklist (2017)",
  "count": 4196,
  "species": [
    { "t": "Abies alba", "f": "Pinaceae", "n": "CH_NATIVE" },
    ...
  ]
}
```

- `t` — taxon name (required)
- `f` — family (optional)
- `n` — any short status tag, e.g. native/non-native (optional, free text)

## Adding a pack

1. Convert your source list (xlsx/csv) to this JSON shape — see
   `scripts/build_species_pack.py` for a converter from `taxon`/`family`/
   `native` xlsx columns (the same shape as tagit's bundled taxonomies).
2. Drop the JSON file in this folder.
3. Add an entry to `index.json`.
4. Add the file path to `SHELL_ASSETS` in `sw.js` so it's cached for offline
   use, then bump `CACHE_NAME`.

## About Euro+Med

An Euro+Med PlantBase pack (pan-European/Mediterranean checklist, tens of
thousands of taxa) was requested but isn't bundled yet: it isn't available as
a simple flat CSV/XLSX the way the InfoFlora checklist was, and the full
dataset is large enough that pulling and converting it needs a deliberate,
separate pass (checking usage terms, fetching from GBIF/Berlin's Euro+Med
services, and deciding whether to ship all of it or a filtered subset). The
pack format above is ready for it — drop a converted file in and register it
here whenever that source is available.
