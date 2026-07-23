# iSurvey

Offline-first vegetation surveys in the browser — inspired by InfoFlora's
FloraApp. Record plot-based **relevés** (species lists with cover-abundance),
fast **transects** (walk-and-call-out species lists, voice-first), standardised
**EDGG grassland plots** (Eurasian Dry Grassland Group nested-plot protocol),
and quick single-species **observations**, entirely on your device. Installable
as an app; once opened once, it keeps working with zero connectivity — species
search, saving records, photos, everything.

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
3. **New relevé**: pick a **protocol** — a *standard* free-form relevé, or an
   *EDGG standardised plot* (a particular kind of relevé following the EDGG
   nested-plot methodology, see [EDGG Grassland Plots](#edgg-grassland-plots)
   below). Either way it's a relevé: it counts, filters and exports as one.
   For a standard relevé (and for a transect), GPS capture starts automatically
   the moment you open it — no button to remember to tap — and shows the fixed
   point on a small map with an accuracy circle while it locates; once it
   settles, that section collapses out of the way and the **species list is
   what you land on**, since that's the actual work of a survey. Add species by
   typing (abbreviation search: `dro rot` for *Drosera rotundifolia*) or by
   **voice logging** (see below). Sort the list — alphabetical, by family, by
   cover, by layer (relevé) or certainty (transect) — without touching the
   underlying recorded order. Every entry remembers exactly when it was logged.
4. **New transect**: walk and log a species list hands-free.
5. **New observation**: a quicker one-species record — species, GPS, date,
   photo, notes. The mic button next to its search box dictates a single name
   (see note below). GPS starts automatically here too.
6. **Records** tab: browse and search everything you've logged (EDGG plots are
   grouped under Relevés).
7. **Settings** tab: export to CSV (for GIS/stats tools) or a full JSON
   backup (records + photos, for moving to another device), import a backup,
   or erase local data.

## Field-recording features (from InfoFlora's FlorApp)

A few things carried over from studying how InfoFlora's own FlorApp handles
recording, adapted to stay local/offline:

- **cf. marker** — tap the `cf.` button on any species entry (relevé,
  transect, observation) to flag an uncertain determination, same convention
  as FlorApp and standard field botany usage.
- **Free-text species entry** — if nothing in the checklist matches (or you
  just want your own wording — a hybrid, a hint like "Carex sp."), the
  search dropdown always offers an `Add "…" as typed` option at the bottom.
  These are flagged `not in checklist` so you can find them again later.
- **Save an observation before you know the species** — attach a photo and
  save with no taxon picked yet; it shows as "Unidentified" in your records
  until you go back and fill it in. Matches FlorApp's "create an observation
  from an image" workflow.
- **Duplicate** (relevé/transect, editor header) — clones the plot structure
  and species list into a new unsaved draft, resetting GPS/date/photos for
  the new visit. Built for repeat monitoring of the same or a very similar
  plot without re-entering everything.
- **Native / non-native status** — shown inline in species rows wherever the
  bundled taxonomy provides it, not just buried in the search dropdown.
- **Map with a layer switcher** — Swisstopo topographic and aerial imagery,
  plus OpenStreetMap for outside Switzerland, shown under each captured GPS
  point (see below).
- **Species entry comes first** — opening a relevé lands you straight on the
  voice-logging button and the species search; the one-time plot setup (cover
  scale, assessment method) sits in a collapsed "Recording setup" sub-section
  so it never buries the actual field work.
- **Inline help (ⓘ)** — small circular info buttons sit next to anything that
  benefits from a word of explanation — cover-abundance scales (with a visual
  of the classes), GPS averaging, voice logging, the transect certainty/review
  flow, nested sampling. Tap one for a short, self-contained explanation
  without leaving the field screen.

Deliberately **not** carried over, since they need a server, an account, or
data this app doesn't have: live tracklog recording/GPX export, sync to an
online fieldbook, missions/monitoring protocols, cloud photo-identification
(FlorID), and automatic habitat-type classification.

### Map

Vendored [Leaflet](https://leafletjs.com) (no CDN) renders a small map under
the GPS fields in each editor once coordinates exist, with a layer switcher:
**Swisstopo — topo**, **Swisstopo — aerial** (official public tile
services), and **OpenStreetMap (global)** for use outside Switzerland. The
marker is surrounded by a shaded circle sized to the fix's real accuracy in
meters, with a `±N m` label — the point is never more precise than that
circle. Like voice dictation, this needs a connection — only the map *tiles*
are fetched live; your coordinates are already saved locally regardless, and
the map area just stays hidden/empty with no connection. The map updates
live as you type coordinates or capture GPS, and uses a plain circle marker
(not Leaflet's default pin) so no marker-icon image assets need vendoring.

## Data model

Everything is stored in this browser's IndexedDB (`isurvey` database) — never
uploaded anywhere:
- **releve**: plot metadata (date/time, GPS, altitude, area, slope, aspect,
  habitat, layer cover %), the cover-abundance scale and assessment method
  used, optional nested-sampling settings (see below), + a species list, each
  entry with a layer (tree/shrub/herb/moss), a cover-abundance value, native
  status, a `cf.` uncertainty flag, whether it was typed as free text, exactly
  when it was logged, and — if nested sampling is on — a grain size and
  corner. The species list is sortable on screen (alphabetical, family,
  cover, layer, or recorded order) without touching that stored order.
- **transect**: date/time, GPS, notes + a species list, each entry with a
  0–1 certainty score, a `reviewed` flag, its source (`voice`/`manual`),
  native status, a `cf.` flag, and when it was logged. No plot metadata or
  cover-abundance — it's the fast, list-building option. Also sortable
  on screen (alphabetical, family, certainty, or recorded order).
- **observation**: one taxon (+ native status, `cf.` flag, free-text flag) +
  GPS/date/photo/notes. The taxon can be blank if a photo is attached.
- **edgg**: a relevé recorded with the EDGG protocol — a standardised
  grassland plot; see [EDGG Grassland Plots](#edgg-grassland-plots) below for
  the full data captured (nested species lists per corner, cover spot-checks,
  structural variables, optional biomass). It's a `type: "edgg"` internally but
  is treated as a relevé everywhere in the UI (created from the *New relevé*
  protocol picker, counted and filtered under Relevés); its richer two-corner
  structure is why it keeps a dedicated editor rather than folding into the
  standard relevé form.
- **photos**: attached to a relevé, observation, or EDGG plot, stored as blobs.

### Cover-abundance scales

Selectable per relevé:
- **Braun-Blanquet**: `r + 1 2 3 4 5`
- **Braun-Blanquet extended**: `r + 1 2m 2a 2b 3 4 5`
- **Percentage cover**: direct 0–100 estimate

### Percentage-cover interpretation

When the scale is **Percentage cover**, the editor also asks *how the
per-species percentages combine* — the same plot yields a different total
under each convention, so mixing them makes relevés incomparable. A running
**Σ** total under the species list checks the values live against the chosen
convention, and an **ⓘ** button illustrates all three with small diagrams:

- **Independent cover** *(recommended, default)* — each species judged on its
  own as 0–100 % of the plot it overlies. Because vegetation grows in layers,
  the values can sum to **more than 100 %**. This is the Braun-Blanquet /
  phytosociological convention: every species is estimated separately (so one
  bad guess doesn't distort the rest), no field arithmetic is forced, and real
  structural information is preserved. Relative shares can always be derived
  afterwards by normalising. The Σ readout is neutral (any total is valid).
- **Projective ground cover** — the canopy is treated as one projected layer;
  species partition the ground and the rest is bare soil / litter / rock, so
  the total is **≤ 100 %**. The Σ readout shows the bare-ground remainder and
  warns if the sum exceeds 100 %. Use when gaps / bare ground are the point
  (erosion, grazing impact).
- **Relative share** — values are rescaled so the species sum to **exactly
  100 %**; each is a dominance / yield share rather than real ground cover. The
  Σ readout nudges toward 100 %. Use only when composition must sum to 100 %.

The chosen mode is stored per relevé and exported as `cover_pct_mode`.

### Cover-assessment method

Alongside the abundance *scale* (above — how a value is written down), a
relevé also records the *method* used to arrive at it: how you actually
looked at the plot to estimate cover. This is a documentation field, not a
different data-entry workflow — the species list works identically no
matter which one is picked.

Four field-practical methods are offered, each with a small diagram and an
**ⓘ** button giving the full picture (what it captures, and its accuracy,
subjectivity, time, equipment and weather-sensitivity, drawn from Table 2 of
the source paper):
- **Visual estimation** — the default; percentage cover judged by eye, no
  equipment.
- **Frame method (count / frequency)** — a subdivided quadrat frame, used
  either to count individuals (density) or to record presence per subcell
  (frequency).
- **Point-quadrat frame** — a pin frame lowered vertically at fixed points;
  first contact per pin gives cover.
- **Daget–Poissonet line analysis** — the line-transect variant of the
  point-quadrat method, common in French/Italian pasture surveys: a rod is
  lowered into the ground at regular intervals along a stretched tape.

Two methods from the source paper needing lab/field equipment beyond a
solo observer's reach — manual separation of harvested biomass, and
spectrometry — aren't offered as pickable methods here, since there's
nothing for the app to record differently for them.

Source: Peratoner, G. & Pötsch, E.M. (2015): *Erhebungsmethoden des
Pflanzenbestandes im Grünland*. 20. Alpenländisches Expertenforum, 15–22.

### Nested sampling (species-area design)

An optional per-relevé mode (off by default, in its own "Nested sampling"
fold) for building a species-area curve: each species is recorded by the
smallest sub-plot size it's first found in, the same principle as the EDGG
methodology's shoot-presence recording, but usable on any relevé, with a
configurable area progression instead of a fixed protocol.

Two independent choices:
- **Nesting geometry** — **centre-out**, concentric squares grown from a
  single anchor point; or **corner-based (EDGG-style)**, nested independently
  from two opposite corners of the plot (NW using the relevé's main GPS
  point, SE captured separately) — the same two-corner idea EDGG uses, just
  decoupled from that protocol's fixed sizes and variables.
- **Area progression** — the sequence of sub-plot sizes (m²) to nest through.
  **EDGG standard** (Dengler et al.'s 9-size series, 0.0001 to 100 m²) is one
  built-in preset; **classic nested quadrat** (×4 area each step, a common
  species-area-curve design) is another; or enter your own **custom**
  comma-separated list of areas.

A scaled diagram redraws live as you change either setting. Once enabled,
each species row gains a **grain size** dropdown (labelled by real edge
length, e.g. "10 cm" or "3.16 m", not just the raw m² value) and, in
corner-based mode, an **NW / SE** picker — otherwise the row looks and
behaves exactly like a normal relevé entry.

### Habitat analysis (TypoCH, Switzerland)

When a Swiss species pack is loaded, the relevé editor gains a **Habitat —
TypoCH** fold that classifies the plot from the species you've recorded,
using the Swiss habitat typology (TypoCH — Delarze, Gonseth, Eggenberg &
Vust 2015, *Lebensräume der Schweiz* / *Guide des milieux naturels de
Suisse*, 3rd ed.). Every habitat type has a set of **character species**;
the fold does the reverse lookup — it ranks the habitats whose character
species are most present, so the vegetation itself proposes the habitat.

- Suggestions update live as species are added, ranked by the **official
  InfoFlora *Lebensraumanalyse* score**, and each card shows that score plus
  how many of your species support it, with its TypoCH code, phytosociological
  alliance and EUNIS crosswalk.
- Tap a suggestion to **assign** it to the relevé, or **search the full
  typology** by name, code or alliance (localised DE / FR / IT names).
- It's a decision aid, not a verdict — confirm against the habitat on the
  ground.

**How the score is computed** (per *Anleitung für die TypoCH-Lebensraumanalyse
mit Artenlisten*, Documenta InfoFlora 2024): every recorded character species
adds points to each habitat it characterises —

```
ScoreLE = ΣK + 2·Σdom_K + 4·ΣC + 8·Σdom_C
```

An ordinary character species (K) scores 1, a *characteristic* species (C,
italic in the reference work) scores 4. The weight **doubles** for any taxon
recorded co-dominant in the plot (Braun-Blanquet class ≥ 2, or > 10 % cover)
that the habitat also *expects* to be dominant (bold in the reference work).
Without cover data this reduces to `ΣK + 4·ΣC`. The implementation reproduces
the guide's worked Tessin-forest example exactly (habitat 6.3.5 scoring 16 from
the list alone, 24 with cover weighting). The ⓘ button shows the formula and
per-species weights.

The assignment is stored per relevé and exported as `typoch_code`,
`typoch_id` and `typoch_name`. The data pack (`species/typoch-ch.json`) is
built from the InfoFlora TypoCH species-list workbook by
`scripts/build_typoch.py`, matching associations to the bundled checklist by
normalised name (324 habitat types across levels 1–4; ~4200 character-species
associations).

### GPS capture

Opening a **new** relevé, transect, or observation starts GPS capture
immediately, automatically — fixing the survey point is the first thing that
happens, not a button you have to remember to tap. It takes up to 10 GPS
readings and averages them, discarding any reading coarser than a
configurable accuracy threshold (**Settings → GPS precision threshold**,
default 10 m). Modern phone GPS (iPhone 14 Pro and later, with
dual-frequency GNSS — this includes iPhone 17 Pro) typically reaches 3–8 m
accuracy in open sky, so 10 m is achievable without a long wait; loosen it to
15–20 m under forest canopy or near buildings where satellite signal is
weaker. Tap the button again any time to cancel or recapture.

For a relevé/transect, the location section opens for this initial capture
so you can watch it settle on the map, then **automatically collapses**
once it's done — handing the screen over to the species list, which is
where you'll spend the rest of the survey. Reopen the location section any
time to review or recapture.

### Voice dictation & voice logging

Both use the browser's built-in speech recognition (Web Speech API). Unlike
the rest of the app, **this needs an active internet connection** — audio is
sent to Google's (Chrome/Edge/Brave/Arc) or Apple's (Safari) speech service,
there's no offline speech-to-text in a browser. Typing/search still work
fully offline; the mic buttons only appear if your browser supports it.

**Set your accent.** The recognizer transcribes Latin names far more
faithfully when it knows which language you're pronouncing them in, so
**Settings → Recognition language / accent** lets you pick English, Italian,
German or French — it's the single most effective thing you can do for
accuracy if you don't speak with an English accent, and it's applied to the
speech engine directly (it-IT / de-DE / fr-FR / en-US). It governs *both*
standard dictation and the AI option below.

The raw transcript is never trusted as a literal string — generic dictation
models mangle Latin binomials, and mishear the same word differently
depending on the speaker's accent. Instead, every recognized phrase (up to a
dozen of the engine's alternative guesses, not just its first pick) is scored
against the entire bundled taxon list using a **phonetic + fuzzy-edit-distance
match**. The phonetic code is deliberately *accent-invariant*: it normalizes
Latin digraphs and merges voiced/unvoiced consonant pairs (v/f, b/p, d/t, g/k,
z/s) — the differences that vary by accent — so a German "fulgaris"/"wulgaris"
still lands on *vulgaris* and "brunella" on *Prunella*. A whole-word-blob
comparison additionally rescues a Latin word mis-split into fake fragments
(e.g. "Drosera" heard as "dro sarah", or "Carex flacca" as "carrots flacca").
Then:
- **confident, clear winner** → filled in / added automatically
- **plausible but ambiguous** → shown as a short tap-to-pick list
- **not recognizable at all** → it speaks "that wasn't clear, please repeat"
  and listens again (up to 3 times, then falls back to manual entry)

**Two-step dictation (genus → species).** Under the observation search box,
*Dictate in two steps* splits a hard binomial into two short, easy utterances:
say the **genus** (short, distinctive, recognised reliably), then say just the
**epithet**, which is matched against *only* the species of that genus — a
handful of names instead of thousands. Much more reliable for long/unfamiliar
names and strong accents; verified to resolve even rough input like
"carrots" → *Carex*, "power" → *Poa*, then "bulgaria" → *vulgaris* within
*Silene*.

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

**Likely-species priors** (*Settings → "Prefer species that are likely here"*,
on by default). When resolving a spoken name, the matcher gently favours
species that are actually plausible at your location, which fixes the biggest
remaining source of wrong picks: a bare or ambiguous utterance landing on a
rare look-alike. Two signals feed it:
- **Frequency** — how commonly each species is recorded in Switzerland
  (bundled in `species/frequency-ch.json`, built from iNaturalist observation
  counts; works offline). So a spoken "Achillea" leans to the common
  *A. millefolium* over the rare *A. atrata* / *A. ageratum* — verified: with
  priors off, a genus-only "achillea" returns species alphabetically
  (*ageratum* first); with priors on, *A. millefolium* is first.
- **Nearby (the primary signal, global)** — when online with GPS, it fetches
  which species have actually been recorded around the record's location from
  iNaturalist — anywhere in the world, not just Switzerland. It queries several
  concentric rings (50 / 150 / 400 km) and weights each species by *how close*
  its nearest records are, so likelihood falls off with distance while
  regional species are still kept (broad, not a tight bubble). Cached per ~cell
  so a place you've visited keeps working offline. The bundled frequency table
  is the weaker offline/fallback baseline; the location signal wins where it's
  available.

It is deliberately **relaxed**: a prior only nudges the *ranking* of otherwise
comparable candidates — it never inflates the confidence used for auto-fill and
never gates a species out, so a rare plant you genuinely said is still found
(verified: "Achillea atrata" said clearly still returns *A. atrata* first, and
the whole accent-mishearing battery still resolves 14/14 with priors on).
Rebuild the frequency table any time with `scripts/build_frequency.py`.

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

**Ignoring conversation.** Continuous logging listens the whole time you're
walking, so it has to tell a species call from talking to a colleague. Two
guards do that, both calibrated by measurement against this checklist:

- **A match floor of 0.62.** Genuinely spoken names — including heavily
  accented mis-transcriptions like "brunella fulgaris" or "tactilis
  klomerata" — score 0.75–1.00, while ordinary field speech ("stop recording
  now", "did you write that down") tops out around 0.58. The floor sits in
  that gap, so conversation no longer lands on a wrong species.
- **A "does this even look like a name" test** on the fallback that records
  unmatched speech as typed: a Latin binomial never contains everyday function
  words ("the", "you", "next", "okay") or filler sounds ("mm", "uh"), and is at
  most four words with at least one substantial one. Anything failing that is
  treated as conversation and silently ignored rather than logged as junk.

On a mixed test session, 18/18 conversational phrases are now ignored (all 18
previously became entries needing manual deletion), while 0/16 genuine
utterances were lost.

**Exactly-spoken names are never second-guessed.** A match at 0.97 or above is
the taxon name itself, so it's accepted without the runner-up margin test —
otherwise a perfectly clear "Trifolium repens" would be flagged every time
purely because *Trifolium rubens* exists and sounds close.

**Species not in the checklist**: voice logging doesn't fight you if what you
said isn't in the bundled taxon list — rather than nagging you to repeat
indefinitely, anything with real content but no plausible match is added
exactly as heard, flagged `not in checklist` and unconfirmed, so it's there
to review and refine afterwards instead of lost. Only near-silence/noise
(fewer than 4 characters recognized) is ignored outright.

### AI-enhanced voice matching (experimental)

**Settings → AI-enhanced voice matching** — off by default. This replaces
the observation/search-box dictation mic with a fundamentally different
approach: instead of trusting a generic dictation engine's free-form guess
at what you said and then fuzzy-matching that *text* (the approach above),
this records the actual audio and scores it directly against every
plausible candidate name — "how well does this recording match exactly
*this* species name" for each candidate — using an on-device
[Whisper](https://github.com/openai/whisper) speech model
([transformers.js](https://github.com/huggingface/transformers.js),
vendored — no CDN at runtime). Concretely, per utterance: the audio is
transcribed to get a rough guess; that guess narrows the ~4,200-taxon
checklist down to a short list of plausible candidates via the same
phonetic/fuzzy matcher described above; each of those candidates is then
teacher-force-scored straight from the audio's acoustic encoding; and the
final pick **blends the acoustic score with the text-match score**, so the
winner has to satisfy both the recording *and* the spelling. That blend is
what kills most near-homophone confusions a text-only or audio-only pick
makes on its own — the accuracy of the feature rides on it. Obvious speech-
model hallucinations on quiet/breath clips ("thank you", subtitle credits,
music tags, bare punctuation) are filtered out so they can't be logged or
crowd out a real match.

**Accents (the big lever): recognition language.** A Latin binomial spoken by
an Italian, German or French botanist is transcribed far more faithfully when
Whisper decodes it under that speaker's *own* language than through an English
lens — and the acoustic score is only meaningful when computed under the same
language the utterance was produced in. So **Settings → Recognition language /
accent** lets you pick **English, Italian, German, French**, or **Multilingual**
(the default): in multilingual mode every utterance is decoded under all four
languages, their transcripts are pooled into the shortlist, and each candidate
is rescored under each language keeping its best — so the match lands on
whatever language your pronunciation is actually closest to, no matter the
accent. Picking your single language instead is faster (one language per
utterance) and ideal when the whole team shares an accent.

**Setup**: enabling it downloads the model from Hugging Face over a
connection, once — the same "needs network" carve-out voice dictation already
has. After that it's cached by the browser and runs fully on-device and
offline, like the rest of the app. **Model size** is a setting: the default
**base** model (~77 MB) is markedly more accurate on the unusual Latin names
this app depends on, and a **tiny** model (~40 MB, faster, less accurate) is
available if download size or per-utterance speed matters more. Changing the
size takes effect on the next app reload.

**Covers both dictation and voice logging.** Once enabled, it also replaces
the engine behind **"Start voice logging"** on a relevé or transect: instead
of the Web Speech API's own continuous-listening mode, a voice-activity
detector watches the microphone directly (rising volume starts capturing an
utterance, a sustained pause ends it) and each captured utterance goes
through the same audio-rescoring pipeline as single-field dictation. The
detector is **noise-adaptive**: it samples the ambient level at startup and
keeps tracking it, setting the speech threshold relative to that floor (with
hysteresis so a name isn't chopped mid-word), so it doesn't false-trigger on
wind or background in the field, and still catches normal speech in a quiet
spot.

**Tradeoffs**: recognition runs on your device's CPU, so each utterance
takes a few seconds and uses noticeably more battery than the standard
mic button — worth it for single-species lookups (the Observation search
box, the tap-to-correct picker), and workable but slower-paced for voice
logging than the Web Speech path. Multilingual mode multiplies the
transcription cost by the number of languages, so if it feels slow, set your
single language in Settings. Two species said back-to-back with too short a
pause between them may land in one utterance and get missed — there's no
equivalent yet of the text-based multi-species splitting (`segmentTranscript`)
the standard dictation path uses; say one species, pause, then the next.

### Correcting a species

Tap **any species name** — in a relevé's or transect's species list, the
transect Review screen, or an observation's chip — to fix it. This reuses
the same phonetic/fuzzy matcher that powers dictation, treating the current
(possibly wrong) name as a query and showing its top candidate matches
against the full taxon list, ranked with a confidence percentage, plus a
normal search box to type and pick — or add your own text if it's genuinely
not in the checklist. Picking a replacement clears any `unconfirmed`/`cf.`
flags and marks it as manually confirmed.

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

## EDGG Grassland Plots

A precise implementation of the Eurasian Dry Grassland Group's standardised
nested-plot sampling methodology for grassland diversity, following:

- Dengler, J., Löbel, S., Dolnik, C. (2016). *Environmental and community
  context matters for the fine-scale species-area relationship of vascular
  plants in dry grassland ecosystems* — the original EDGG methodology paper,
  "Assessing plant diversity and composition in grasslands across spatial
  scales: the standardised EDGG sampling methodology".
- Dengler, Biurrun, Dembicz et al. (2021), *"Standardised EDGG methodology for
  sampling grassland diversity: second amendment"* — extended it with the
  1000 m² module and quantitative biomass sampling.

An EDGG plot is a **relevé recorded with the EDGG protocol** — conceptually a
particular kind of relevé, so it's created from the *New relevé* protocol
picker and counts/filters as a relevé. What sets it apart is that it follows an
external scientific protocol exactly rather than a general-purpose field form,
so the geometry, grain sizes, and recorded variables below match the papers,
not a simplification of them — which is why it keeps its own dedicated editor.

### Plot geometry

The core unit is a **10 × 10 m (100 m²) plot**. Two opposite corners — the
**NW** and **SE** corners in the standard orientation — each anchor a nested
series of sub-plots at nine grain sizes, formed by repeated halving:
0.0001, 0.001, 0.01, 0.1, 1, 3 (a non-halved intermediate size used by EDGG
for continuity with older 3 m² data), 10, 30, and 100 m². Species are
recorded as newly appearing at the smallest grain size they're first found
in, so presence at a larger grain implies presence at every larger grain
above it but says nothing about the smaller ones. The **"Plot design"** fold
in the editor renders this layout as a scaled diagram (10 × 10 m outer
square, shaded nested corners at NW/SE, the 14.14 m diagonal) so you can see
exactly what to lay out on the ground before starting; toggle "Include 1000
m² extension" to see the second amendment's larger nested square drawn
around it instead.

Each corner captures its own GPS fix independently (same auto-start,
averaged, accuracy-thresholded capture as relevés/transects — see below),
since the two corners of a real 100 m² plot are usually 14 m apart and can
genuinely differ in position accuracy.

### Nested species recording

The **"Species — NW corner"** and **"Species — SE corner"** folds are where
you spend most of a survey. Add species the same way as a relevé (search,
voice logging, tap-to-correct — everything described above under "Voice
dictation" and "Correcting a species" applies here too), then set two things
per entry:
- **grain size** — the smallest nested sub-plot the species was first found
  in, from the dropdown of the nine standard sizes above.
- **cover %** — the standard EDGG addition of percentage cover estimated in
  the full 10 m² sub-plot, independent of the grain-size-of-first-occurrence
  value.

Sort each corner's list the same way as a relevé/transect (alphabetical,
family, grain size, or recorded order) without touching the underlying data.

### 100 m² / 1000 m² cover spot-check

A separate **cover spot-check** fold records percentage cover for species
across the *whole* 100 m² plot (not per-corner), which the papers specify as
a distinct step from the nested per-corner recording above — a species can
appear in this list even if it wasn't caught in either corner's nested
sub-plots. If the 1000 m² extension is enabled, a second spot-check list
covers that larger area.

### Structural & environmental variables

Each corner's **"Structural & environmental"** fold captures the full set of
EDGG-standard plot descriptors: cover of tree/shrub/herb/cryptogam layers,
cover by herb growth form (phanerophyte, chamaephyte, graminoid, legume,
other forb), maximum height per layer, litter cover, soil surface
composition (stones/gravel/fine earth), slope inclination and aspect,
microrelief, soil texture/pH/humus/carbon/nitrogen, land-use type (pasture,
meadow, or unused) with free-text detail, and whether the plot burned in the
current year. **Vegetation height** and **soil depth** are each recorded as
five individual point measurements per corner (the paper's prescribed
5-point sampling design), not a single averaged number — this preserves the
actual spread of the data.

### Biomass sampling (second amendment)

An optional **"Biomass"** fold implements the 2021 amendment's quantitative
biomass module: a small (0.08 m²) sample is clipped and sorted into four
fractions — necromass, bryophytes/lichens, herbs, woody material — at one or
both corners. Enter the dried weight per fraction in grams as actually
weighed from the 0.08 m² sample; export converts it to standard g/m² for you
(divides by 0.08), so the field values you type match what you'd read off a
scale.

### Export

`edgg_plots.csv`, `edgg_species.csv`, `edgg_cover_spotcheck.csv`,
`edgg_structural.csv`, and `edgg_biomass.csv` — one table per concern above,
joined by plot ID, alongside the relevé/transect/observation tables.

### What this doesn't do

Like the rest of iSurvey, this app records what you observe and measure in
the field — it doesn't simulate or replace the physical equipment the
protocol assumes (frame quadrats for the nested sub-plots, a scale for
biomass, a clinometer for slope). It's a precise, offline-capable data sheet
for the EDGG methodology, not a substitute for the field kit.

## Species database

Bundled offline in `species/`. Ships with the **InfoFlora Swiss Checklist
(2017)** (4,196 taxa, converted from tagit's bundled xlsx — see
`scripts/build_species_pack.py`). See [`species/README.md`](species/README.md)
for the pack format and how to add more lists (e.g. a Euro+Med pack later).

## Project layout

```
index.html / styles.css / app.js   — the app (no build step, no framework)
whisper.js                         — experimental on-device AI voice matching (lazy-loaded ES module)
sw.js / manifest.json / icons/     — PWA: offline caching + installability
species/                           — bundled offline taxon lists + frequency-ch.json (likely-species prior)
scripts/build_species_pack.py      — xlsx → species pack JSON converter
scripts/build_frequency.py         — iNaturalist Swiss counts → frequency-ch.json
```

## Privacy

No accounts, no analytics, no network calls except loading the page itself,
(optionally) your device's GPS, voice dictation/logging, and — only if you
opt in — the one-time AI voice matching model download. Everything you record stays in this
browser's local storage until you explicitly export it.
