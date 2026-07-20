# iSurvey

Offline-first vegetation surveys in the browser — inspired by InfoFlora's
FloraApp. Record plot-based **relevés** (species lists with cover-abundance),
fast **transects** (walk-and-call-out species lists, voice-first), and quick
single-species **observations**, entirely on your device. Installable as an app;
once opened once, it keeps working with zero connectivity — species search,
saving records, photos, everything.

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
   habitat, layer cover), pick a cover-abundance scale, then add species —
   either type (abbreviation search: `dro rot` for *Drosera rotundifolia*,
   `dact fuch` for *Dactylorhiza maculata* subsp. *fuchsii*) or use **voice
   logging** (see below) to log species hands-free while walking the plot.
4. **New observation**: a quicker one-species record — species, GPS, date,
   photo, notes. The mic button next to its search box dictates a single name
   (see note below).
5. **New transect**: the fastest option — no plot metadata or cover-abundance,
   just GPS plus a running species list. Toggle **Start voice logging** and
   walk, calling out each species as you spot it; entries are added
   hands-free with a certainty score, and anything uncertain surfaces in
   **Review & approve** for you to confirm, fix, or discard afterwards (see
   below).
6. **Records** tab: browse and search everything you've logged.
7. **Settings** tab: export to CSV (for GIS/stats tools) or a full JSON
   backup (records + photos, for moving to another device), import a backup,
   or erase local data.

## Data model

Everything is stored in this browser's IndexedDB (`isurvey` database) — never
uploaded anywhere:
- **releve**: plot metadata (date/time, GPS, altitude, area, slope, aspect,
  habitat, layer cover %) + a species list, each entry with a layer
  (tree/shrub/herb/moss) and a cover-abundance value.
- **transect**: date/time, GPS, notes + a species list, each entry with a
  0–1 certainty score, a `reviewed` flag, and its source (`voice`/`manual`).
  No plot metadata or cover-abundance — it's the fast, list-building option.
- **observation**: one taxon + GPS/date/photo/notes.
- **photos**: attached to a relevé or observation, stored as blobs.

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

### Voice dictation & voice logging

Both use the browser's built-in speech recognition (Web Speech API). Unlike
the rest of the app, **this needs an active internet connection** — audio is
sent to Google's (Chrome/Edge/Brave/Arc) or Apple's (Safari) speech service,
there's no offline speech-to-text in a browser. Typing/search still work
fully offline; the mic buttons only appear if your browser supports it.

The raw transcript is never trusted as a literal string — generic dictation
models mangle Latin binomials, and mishear the same word differently
depending on the speaker's accent. Instead, every recognized phrase (the
engine's top several alternative guesses, not just its first pick) is scored
against the entire bundled taxon list using a phonetic + fuzzy-edit-distance
match, including a whole-word-blob comparison specifically so that a Latin
word getting mis-split into fake English fragments (e.g. "Drosera" heard as
"dro sarah") still resolves correctly. Then:
- **confident, clear winner** → filled in / added automatically
- **plausible but ambiguous** → shown as a short tap-to-pick list
- **not recognizable at all** → it speaks "that wasn't clear, please repeat"
  and listens again (up to 3 times, then falls back to manual entry)

**Voice logging specifically** (walking a relevé or transect) uses one more
layer on top: since several species said in sequence can land in a single
recognized phrase (the pause between them wasn't quite long enough), each
result is run through a word-segmentation pass — the same kind of
dictionary-based segmentation used to split run-on text — scoring every
possible word window against the whole taxon list and finding the split that
maximizes total confidence, so "achillea millefolium silene vulgaris" heard
as one phrase still resolves into two separate species instead of failing to
match either.

**Nomenclature tolerance**: rank markers (`subsp.`, `var.`, `f.`, `aggr.`,
`cf.`) are optional when matching, not required — saying "Dactylorhiza
maculata fuchsii" matches *Dactylorhiza maculata* subsp. *fuchsii* exactly as
well as saying "subsp." would, since skipping a rank word isn't treated as
an incomplete match the way skipping a real name word is. A few spoken/typed
alternate forms are also normalized to the abbreviation used in the
taxonomy — "aggregate" or "agg" both match a taxon written with "aggr."

**Observation form**: the mic button dictates one species name into the search
box.

**"Start voice logging"** (relevé species list, and transects): a hands-free
mode for walking and calling out species as you spot them. Toggle it on, and
it keeps listening continuously (auto-restarting between phrases) until you
toggle it off — no need to touch the screen between species. Confident
matches are added straight to the list with a spoken confirmation; matches
that were ambiguous are still added, but flagged for you to check afterwards.
Turn off spoken confirmations in **Settings → Voice logging** if you'd rather
work in silence. In a relevé this just flags the entry `unconfirmed`; in a
transect, see below — every entry carries a real certainty score.

## Transects

The lightest-weight survey type: no plot metadata, no cover-abundance, just
GPS plus a species list. Meant for walking a line and building a species list
as fast as possible — by voice, by manual search, or both mixed together.

Every entry gets a **certainty score** (0–100%): manual picks are always
100%; voice-logged entries carry the real match confidence from the phonetic
matcher described above. Anything below the confidence threshold used for
auto-approval starts unreviewed, shown with a colored percentage pill in the
species list (tap it to approve on the spot).

**Review & approve** is a dedicated screen (reachable any time from the
transect editor) listing every unreviewed entry, lowest-certainty first, with
three actions per row:
- **✓ Approve** — confirm it's correct
- **✎ Edit** — search and swap in the actual species (marks it reviewed)
- **✕ Remove** — it was a false catch, discard it

There's also a bulk **"Approve all ≥ 90% certainty"** button for quickly
clearing the obvious ones. While voice logging is running, every time you
cross a multiple of **Settings → Review checkpoint every N taxa** (default
30), you get a non-blocking toast/spoken nudge — it doesn't interrupt your
walk, it's just a natural point to open Review if convenient. Review whenever
suits you: after every checkpoint, or all at once at the end.

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
