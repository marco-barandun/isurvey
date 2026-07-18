# iSurvey

Offline-first vegetation surveys in the browser — inspired by InfoFlora's
FloraApp. Record plot-based **relevés** (species lists with cover-abundance)
and quick single-species **sightings**, entirely on your device. Installable
as an app; once opened once, it keeps working with zero connectivity —
species search, saving records, photos, everything.

## Quick start

1. Serve the `isurvey/` folder over HTTP (a service worker needs `http(s)://`,
   not `file://`):
   ```
   python3 -m http.server 8123
   ```
   then open `http://localhost:8123/index.html`.
2. **Install it**: use your browser's "Install app" / "Add to Home Screen"
   prompt. From then on it opens like a native app and works fully offline —
   the first load caches everything it needs (app code + species database).
3. **New relevé**: capture GPS, fill in plot structure (area, slope, aspect,
   habitat, layer cover), pick a cover-abundance scale, then search and add
   species. Search is abbreviation-based — type `dro rot` for *Drosera
   rotundifolia*, `dact fuch` for *Dactylorhiza maculata* subsp. *fuchsii*. Tap
   the mic icon next to the search box to dictate a species name instead of
   typing (see note below).
4. **New sighting**: a quicker one-species record — species, GPS, date,
   photo, notes.
5. **Records** tab: browse and search everything you've logged.
6. **Settings** tab: export to CSV (for GIS/stats tools) or a full JSON
   backup (records + photos, for moving to another device), import a backup,
   or erase local data.

## Data model

Everything is stored in this browser's IndexedDB (`isurvey` database) — never
uploaded anywhere:
- **releve**: plot metadata (date/time, GPS, altitude, area, slope, aspect,
  habitat, layer cover %) + a species list, each entry with a layer
  (tree/shrub/herb/moss) and a cover-abundance value.
- **sighting**: one taxon + GPS/date/photo/notes.
- **photos**: attached to either, stored as blobs.

### Cover-abundance scales

Selectable per relevé:
- **Braun-Blanquet**: `r + 1 2 3 4 5`
- **Braun-Blanquet extended**: `r + 1 2m 2a 2b 3 4 5`
- **Percentage cover**: direct 0–100 estimate

### GPS capture

"Capture GPS location" takes up to 10 GPS readings and averages them,
discarding any reading coarser than a configurable accuracy threshold
(**Settings → GPS precision threshold**, default 10 m). Modern phone GPS
(iPhone 14 Pro and later, with dual-frequency GNSS — this includes iPhone 17
Pro) typically reaches 3–8 m accuracy in open sky, so 10 m is achievable
without a long wait; loosen it to 15–20 m under forest canopy or near
buildings where satellite signal is weaker. Tap the button again to cancel a
capture in progress.

### Voice dictation

The mic button next to a species search box uses the browser's built-in
speech recognition (Web Speech API) to fill in a spoken name. Unlike the rest
of the app, **this needs an active internet connection** — browsers send
audio to a cloud speech service, there's no offline speech-to-text available
in-browser. It's a convenience for when you have signal; typing / search
still works fully offline. The button only appears if your browser supports
it.

## Species database

Bundled offline in `species/`. Ships with the **InfoFlora Swiss Checklist
(2017)** (4,196 taxa, converted from tagit's bundled xlsx — see
`scripts/build_species_pack.py`). See [`species/README.md`](species/README.md)
for the pack format and how to add more lists (e.g. a Euro+Med pack later).

## Project layout

```
index.html / styles.css / app.js   — the app (no build step, no framework)
sw.js / manifest.json / icons/     — PWA: offline caching + installability
species/                           — bundled offline taxon lists
scripts/build_species_pack.py      — xlsx → species pack JSON converter
```

## Privacy

No accounts, no analytics, no network calls except loading the page itself
and (optionally) your device's GPS. Everything you record stays in this
browser's local storage until you explicitly export it.
