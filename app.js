"use strict";

/* ============================================================
   iSurvey — offline vegetation survey app
   Vanilla JS, IndexedDB storage, no build step, no dependencies.
   ============================================================ */

const APP_VERSION = "1.0.0";

/* ---------------------------------------------------------- */
/* small utils                                                 */
/* ---------------------------------------------------------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function pad2(n) { return String(n).padStart(2, "0"); }
function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function nowTime() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, kind) {
  const host = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ---------------------------------------------------------- */
/* IndexedDB layer                                              */
/* ---------------------------------------------------------- */

const DB_NAME = "isurvey";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("records")) {
        const store = db.createObjectStore("records", { keyPath: "id" });
        store.createIndex("type", "type", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("photos")) {
        db.createObjectStore("photos", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

function idbPut(storeName, value) {
  return tx(storeName, "readwrite").then(store => new Promise((resolve, reject) => {
    const r = store.put(value);
    r.onsuccess = () => resolve(value);
    r.onerror = () => reject(r.error);
  }));
}
function idbGet(storeName, key) {
  return tx(storeName, "readonly").then(store => new Promise((resolve, reject) => {
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
function idbDelete(storeName, key) {
  return tx(storeName, "readwrite").then(store => new Promise((resolve, reject) => {
    const r = store.delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}
function idbAll(storeName) {
  return tx(storeName, "readonly").then(store => new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
function idbClear(storeName) {
  return tx(storeName, "readwrite").then(store => new Promise((resolve, reject) => {
    const r = store.clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}

const Store = {
  allRecords: () => idbAll("records"),
  getRecord: id => idbGet("records", id),
  saveRecord: rec => { rec.updatedAt = Date.now(); return idbPut("records", rec); },
  deleteRecord: id => idbDelete("records", id),
  savePhoto: photo => idbPut("photos", photo),
  getPhoto: id => idbGet("photos", id),
  deletePhoto: id => idbDelete("photos", id),
  allPhotos: () => idbAll("photos"),
  getSettings: () => idbGet("settings", "app").then(s =>
    Object.assign({ key: "app", defaultScale: "bb", activePacks: null, gpsThreshold: 10, voiceSpeakFeedback: true, voiceReviewCheckpoint: 30 }, s || {})),
  saveSettings: s => { s.key = "app"; return idbPut("settings", s); },
  wipeAll: () => Promise.all([idbClear("records"), idbClear("photos"), idbClear("settings")]),
};

/* ---------------------------------------------------------- */
/* species database                                            */
/* ---------------------------------------------------------- */

const Species = {
  packs: [],       // [{id,label,region,count}]
  byTaxonLower: new Map(), // lowercase taxon -> {t,f,n}
  all: [],         // flattened list (deduped)
  loaded: false,

  async loadIndex() {
    const res = await fetch("species/index.json");
    return res.json();
  },

  async loadAll() {
    const index = await this.loadIndex();
    const settings = await Store.getSettings();
    const active = settings.activePacks || index.map(p => p.id);

    this.packs = [];
    this.byTaxonLower.clear();

    for (const meta of index) {
      if (!active.includes(meta.id)) continue;
      try {
        const res = await fetch("species/" + meta.file);
        const pack = await res.json();
        this.packs.push({ id: meta.id, label: meta.label, region: meta.region, count: pack.count });
        for (const sp of pack.species) {
          const key = sp.t.toLowerCase();
          if (!this.byTaxonLower.has(key)) this.byTaxonLower.set(key, sp);
        }
      } catch (e) {
        console.warn("failed to load species pack", meta, e);
      }
    }
    this.all = Array.from(this.byTaxonLower.values());
    this.loaded = true;
    return this.packs;
  },

  /* Abbreviation search: "dro rot" matches "Drosera rotundifolia",
     "dact fuch" matches "Dactylorhiza maculata subsp. fuchsii" — each
     query word must prefix-match a taxon word, in left-to-right order,
     but query words may skip over unmatched taxon words in between. */
  search(query, limit) {
    limit = limit || 25;
    const qWords = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!qWords.length) return [];

    const scored = [];
    for (const sp of this.all) {
      const taxonWords = sp.t.toLowerCase().replace(/\./g, "").split(/\s+/);
      let wi = 0;
      let gap = 0;
      let exactCount = 0;
      let ok = true;
      for (const qw of qWords) {
        let found = -1;
        for (let j = wi; j < taxonWords.length; j++) {
          if (taxonWords[j].startsWith(qw)) { found = j; break; }
        }
        if (found === -1) { ok = false; break; }
        if (taxonWords[found] === qw) exactCount++;
        gap += found - wi;
        wi = found + 1;
      }
      if (!ok) continue;
      scored.push({ sp, gap, exactCount, len: sp.t.length });
    }
    scored.sort((a, b) => (b.exactCount - a.exactCount) || (a.gap - b.gap) || (a.len - b.len) || a.sp.t.localeCompare(b.sp.t));
    return scored.slice(0, limit).map(s => s.sp);
  },
};

/* ---------------------------------------------------------- */
/* cover-abundance scales                                       */
/* ---------------------------------------------------------- */

const COVER_SCALES = {
  bb: { label: "Braun-Blanquet", values: ["r", "+", "1", "2", "3", "4", "5"] },
  "bb-ext": { label: "Braun-Blanquet extended", values: ["r", "+", "1", "2m", "2a", "2b", "3", "4", "5"] },
  pct: { label: "Percentage", type: "number" },
};

function coverInputHtml(scaleKey, currentValue) {
  const scale = COVER_SCALES[scaleKey] || COVER_SCALES.bb;
  if (scale.type === "number") {
    return `<input type="number" class="input small sp-cover" min="0" max="100" value="${esc(currentValue || "")}" placeholder="%">`;
  }
  const opts = scale.values.map(v => `<option value="${v}" ${v === currentValue ? "selected" : ""}>${v}</option>`).join("");
  return `<select class="input small sp-cover"><option value="">–</option>${opts}</select>`;
}

/* ---------------------------------------------------------- */
/* view / navigation                                            */
/* ---------------------------------------------------------- */

const viewStack = ["home"];
const viewLeaveHooks = {}; // viewName -> fn; set by wireVoiceLogging to stop a stray mic session on navigation

function showView(name) {
  for (const [viewName, hook] of Object.entries(viewLeaveHooks)) {
    if (viewName !== name && $("#view-" + viewName)?.classList.contains("active")) hook();
  }
  $all(".view").forEach(v => v.classList.remove("active"));
  const el = $("#view-" + name);
  if (el) el.classList.add("active");
  $all(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
}

function pushView(name) {
  viewStack.push(name);
  showView(name);
}
function popView() {
  if (viewStack.length > 1) viewStack.pop();
  showView(viewStack[viewStack.length - 1]);
}
function resetToTab(name) {
  viewStack.length = 0;
  viewStack.push(name);
  showView(name);
}

/* ---------------------------------------------------------- */
/* generic autocomplete widget                                  */
/* ---------------------------------------------------------- */

function wireAutocomplete(inputEl, menuEl, onPick) {
  let hiIndex = -1;
  let currentResults = [];

  function render(results) {
    currentResults = results;
    hiIndex = -1;
    if (!results.length) {
      menuEl.innerHTML = inputEl.value.trim() ? `<div class="ac-empty">No match — check spelling or try fewer letters</div>` : "";
      menuEl.classList.toggle("show", !!inputEl.value.trim());
      return;
    }
    menuEl.innerHTML = results.map((sp, i) => `
      <div class="ac-item" data-i="${i}">
        <div class="sp-name" style="font-style:italic">${esc(sp.t)}</div>
        <div class="fam">${esc(sp.f || "")} ${sp.n ? `<span class="native-tag">· ${esc(sp.n.replace(/^CH_/, "").replace(/_/g, " ").toLowerCase())}</span>` : ""}</div>
      </div>`).join("");
    menuEl.classList.add("show");
  }

  inputEl.addEventListener("input", () => {
    const q = inputEl.value;
    if (!q.trim()) { render([]); return; }
    render(Species.search(q, 25));
  });
  inputEl.addEventListener("focus", () => {
    if (inputEl.value.trim()) render(Species.search(inputEl.value, 25));
  });
  inputEl.addEventListener("keydown", e => {
    if (!menuEl.classList.contains("show") || !currentResults.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); hiIndex = Math.min(hiIndex + 1, currentResults.length - 1); highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hiIndex = Math.max(hiIndex - 1, 0); highlight(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = currentResults[hiIndex >= 0 ? hiIndex : 0];
      if (pick) choose(pick);
    } else if (e.key === "Escape") { menuEl.classList.remove("show"); }
  });
  function highlight() {
    $all(".ac-item", menuEl).forEach((el, i) => el.classList.toggle("hi", i === hiIndex));
  }
  menuEl.addEventListener("mousedown", e => {
    const item = e.target.closest(".ac-item");
    if (!item) return;
    e.preventDefault();
    choose(currentResults[Number(item.dataset.i)]);
  });
  function choose(sp) {
    onPick(sp);
    inputEl.value = "";
    menuEl.classList.remove("show");
  }
  document.addEventListener("click", e => {
    if (e.target !== inputEl && !menuEl.contains(e.target)) menuEl.classList.remove("show");
  });
}

/* ---------------------------------------------------------- */
/* photo helpers                                                */
/* ---------------------------------------------------------- */

async function addPhotosFromInput(fileInput, photoIds, gridEl) {
  const files = Array.from(fileInput.files || []);
  for (const file of files) {
    const id = uid();
    await Store.savePhoto({ id, blob: file, mime: file.type, createdAt: Date.now() });
    photoIds.push(id);
  }
  fileInput.value = "";
  await renderPhotoGrid(photoIds, gridEl);
}

async function renderPhotoGrid(photoIds, gridEl) {
  gridEl.innerHTML = "";
  for (const id of photoIds) {
    const photo = await Store.getPhoto(id);
    if (!photo) continue;
    const url = URL.createObjectURL(photo.blob);
    const div = document.createElement("div");
    div.className = "photo-thumb";
    div.innerHTML = `<img src="${url}" alt=""><button class="rm" data-id="${id}" type="button">×</button>`;
    gridEl.appendChild(div);
  }
  $all(".rm", gridEl).forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const idx = photoIds.indexOf(id);
      if (idx >= 0) photoIds.splice(idx, 1);
      await Store.deletePhoto(id);
      renderPhotoGrid(photoIds, gridEl);
    });
  });
}

/* ---------------------------------------------------------- */
/* GPS capture — averages N fixes, keeping only ones at or     */
/* below a configurable accuracy threshold                     */
/* ---------------------------------------------------------- */

const GPS_TARGET_COUNT = 10;
const GPS_MAX_WAIT_MS = 60000;

function averagedGpsCapture(opts) {
  const { statusEl, latEl, lonEl, altEl, accEl, threshold, targetCount } = opts;
  if (!navigator.geolocation) {
    statusEl.textContent = "Geolocation not available on this device.";
    return null;
  }
  const readings = [];
  let watchId = null;
  let timeoutId = null;
  let done = false;

  function finish(success) {
    if (done) return;
    done = true;
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    if (timeoutId) clearTimeout(timeoutId);
    if (success && readings.length) {
      const n = readings.length;
      const avgLat = readings.reduce((s, r) => s + r.lat, 0) / n;
      const avgLon = readings.reduce((s, r) => s + r.lon, 0) / n;
      const alts = readings.filter(r => r.alt != null).map(r => r.alt);
      const avgAcc = readings.reduce((s, r) => s + r.acc, 0) / n;
      latEl.value = avgLat.toFixed(6);
      lonEl.value = avgLon.toFixed(6);
      if (altEl && alts.length) altEl.value = Math.round(alts.reduce((a, b) => a + b, 0) / alts.length);
      if (accEl) accEl.value = avgAcc.toFixed(1);
      statusEl.textContent = n >= targetCount
        ? `Averaged ${n} fixes ≤${threshold} m — mean accuracy ±${avgAcc.toFixed(1)} m`
        : `Stopped early with ${n}/${targetCount} fixes ≤${threshold} m — mean accuracy ±${avgAcc.toFixed(1)} m`;
    } else if (readings.length === 0) {
      statusEl.textContent = `No fix reached ≤${threshold} m accuracy. Try open sky, or loosen the threshold in Settings.`;
    }
    opts.onDone && opts.onDone();
  }

  statusEl.textContent = `Locating… 0/${targetCount} fixes ≤${threshold} m — keep the device still`;
  watchId = navigator.geolocation.watchPosition(
    pos => {
      const c = pos.coords;
      if (c.accuracy <= threshold) {
        readings.push({ lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: c.accuracy });
        statusEl.textContent = `Locating… ${readings.length}/${targetCount} fixes ≤${threshold} m (last ±${Math.round(c.accuracy)} m)`;
        if (readings.length >= targetCount) finish(true);
      } else {
        statusEl.textContent = `Locating… ${readings.length}/${targetCount} fixes ≤${threshold} m (current ±${Math.round(c.accuracy)} m, too coarse)`;
      }
    },
    err => {
      if (err.code === err.PERMISSION_DENIED) {
        statusEl.textContent = "Location permission denied — allow it in your browser/device settings to capture GPS.";
        finish(false);
      } else {
        statusEl.textContent = `GPS error: ${err.message} — retrying…`;
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: GPS_MAX_WAIT_MS }
  );
  timeoutId = setTimeout(() => finish(true), GPS_MAX_WAIT_MS);

  return { cancel: () => { statusEl.textContent = "Location capture cancelled."; if (watchId != null) navigator.geolocation.clearWatch(watchId); if (timeoutId) clearTimeout(timeoutId); done = true; opts.onDone && opts.onDone(); } };
}

function wireGpsButton(btn, statusEl, latEl, lonEl, altEl, accEl) {
  let active = null;
  btn.addEventListener("click", async () => {
    if (active) { active.cancel(); active = null; setBtnState(false); return; }
    const settings = await Store.getSettings();
    const threshold = Number(settings.gpsThreshold) || 10;
    setBtnState(true);
    active = averagedGpsCapture({
      statusEl, latEl, lonEl, altEl, accEl, threshold, targetCount: GPS_TARGET_COUNT,
      onDone: () => { active = null; setBtnState(false); },
    });
  });
  function setBtnState(capturing) {
    btn.lastChild.textContent = capturing ? " Cancel locating…" : " Capture GPS location (averaged)";
    btn.classList.toggle("btn-danger", capturing);
  }
}

/* ---------------------------------------------------------- */
/* voice dictation for species names (Web Speech API — needs   */
/* connectivity; the app degrades gracefully without it)       */
/*                                                               */
/* The raw transcript is NOT trusted as a literal search string —*/
/* generic dictation models mangle Latin binomials. Instead we   */
/* treat it as "which of our ~4000 known taxa did they most      */
/* likely say": score every ASR alternative against every taxon  */
/* with a phonetic + fuzzy-edit-distance match, then decide to    */
/* auto-fill (confident), offer a tap list (ambiguous), or speak  */
/* "that wasn't clear, please repeat" and re-listen (uncertain).  */
/* ---------------------------------------------------------- */

/* Latin/scientific-name-tuned phonetic code — not a strict
   Metaphone port, just consonant-skeleton reduction so that
   differently-mispronounced or mis-transcribed words with the
   same underlying sound structure land close together. */
function phoneticCode(word) {
  let w = (word || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w
    .replace(/ae|oe/g, "e")
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/rh/g, "r")
    .replace(/ch/g, "k")
    .replace(/qu/g, "k")
    .replace(/y/g, "i")
    .replace(/z/g, "s")
    .replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/([a-z])\1+/g, "$1");
  const first = w[0];
  const rest = w.slice(1).replace(/[aeiou]/g, "").replace(/([a-z])\1+/g, "$1");
  return (first + rest).slice(0, 8);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
function strSim(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
function wordScore(qw, tw, qPhon, tPhon) {
  if (!qw || !tw) return 0;
  let score = strSim(qw, tw) * 0.55 + strSim(qPhon, tPhon) * 0.35;
  if (tw.startsWith(qw) || qw.startsWith(tw)) score += 0.10;
  return Math.min(1, score);
}

/* Infraspecific rank markers — spoken (and often typed) forms
   frequently drop these ("Dactylorhiza maculata fuchsii" instead of
   "...subsp. fuchsii"), so they're excluded from the "how much of
   the taxon did you actually cover" penalties below rather than
   being treated like any other required word. */
const RANK_WORDS = new Set(["subsp", "var", "f", "subvar", "aggr", "cf"]);

/* Alternate/spoken forms normalized to the abbreviation used in the
   taxonomy, so e.g. saying "aggregate" matches a taxon written with
   "aggr." — applied identically to query words and taxon words so
   both sides land on the same canonical token. */
const WORD_SYNONYMS = {
  aggregate: "aggr", agg: "aggr",
  subspecies: "subsp",
  variety: "var",
  forma: "f", form: "f",
  confer: "cf", compare: "cf",
};
function canonicalizeWord(w) { return WORD_SYNONYMS[w] || w; }

function ensureSpeciesIndexed(sp) {
  if (sp._words) return;
  sp._words = sp.t.toLowerCase().replace(/\./g, "").split(/\s+/).map(canonicalizeWord);
  sp._phon = sp._words.map(phoneticCode);
  sp._concat = sp._words.join("");
  sp._concatPhon = phoneticCode(sp._concat);
  sp._coreWordCount = sp._words.filter(w => !RANK_WORDS.has(w)).length;
}

function tokenize(text) {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean).map(canonicalizeWord);
  return { words, phon: words.map(phoneticCode) };
}

/* Score one taxon against one word window using two complementary
   strategies, taking whichever scores higher:

   1. Word-by-word greedy alignment (query words matched to taxon
      words in order, same left-to-right skipping idea as the typed
      abbreviation search) — precise when word boundaries in the
      query roughly match the taxon's.
   2. Whole-string concatenation match (all words joined, spaces
      removed, compared as one blob) — dictation engines routinely
      split an unfamiliar Latin word into fake English-sounding
      fragments (e.g. "Drosera" heard as "dro sarah"); comparing the
      full letter sequence ignores where those spurious word breaks
      landed, so it stays accurate exactly when strategy 1 breaks
      down. */
function scoreTaxonAgainstWords(sp, words, phon) {
  ensureSpeciesIndexed(sp);
  let wi = 0, total = 0;
  const matchedTaxonIdx = new Set();
  for (let i = 0; i < words.length; i++) {
    let bestW = 0, bestJ = -1;
    for (let j = wi; j < sp._words.length; j++) {
      const s = wordScore(words[i], sp._words[j], phon[i], sp._phon[j]);
      if (s > bestW) { bestW = s; bestJ = j; }
    }
    total += bestW;
    if (bestJ >= 0) { wi = bestJ + 1; matchedTaxonIdx.add(bestJ); }
  }
  // Taxon words never said are only penalized when they're real
  // content words — a skipped rank marker ("subsp.") isn't a sign
  // of a weaker match.
  let unmatchedTaxonWords = 0;
  for (let j = 0; j < sp._words.length; j++) {
    if (!matchedTaxonIdx.has(j) && !RANK_WORDS.has(sp._words[j])) unmatchedTaxonWords++;
  }
  const wordAlignScore = (total / words.length) * Math.max(0.5, 1 - 0.06 * unmatchedTaxonWords);

  const concat = words.join("");
  const concatPhon = phoneticCode(concat);
  const charSim = strSim(concat, sp._concat);
  const phonSim = strSim(concatPhon, sp._concatPhon);
  const lenDiff = Math.abs(concat.length - sp._concat.length) / Math.max(concat.length, sp._concat.length, 1);
  const lenPenalty = 1 - Math.min(0.3, lenDiff * 0.6);
  const wholeScore = (charSim * 0.5 + phonSim * 0.5) * lenPenalty;

  return Math.max(wordAlignScore, wholeScore);
}

/* Best (and second-best) taxon for one specific word window, used
   by the multi-species segmenter below. Unlike whole-phrase
   matching (where a genus-only utterance is deliberately allowed
   to score high, since it's legitimately ambiguous among several
   species and should surface as a tap-to-pick list), a segmentation
   window competes against OTHER possible windows over the same
   words — so a short window that only partially covers a candidate
   taxon (e.g. one word matching just the genus of a two-word
   species) needs to be scored down hard. Otherwise the DP below is
   incentivized to fragment a correct multi-word match into cheaper-
   looking partial pieces, since each fragment can cheaply find some
   same-genus species to match against. */
function bestTaxaForWords(words, phon) {
  let best = null, second = null;
  for (const sp of Species.all) {
    ensureSpeciesIndexed(sp);
    const raw = scoreTaxonAgainstWords(sp, words, phon);
    // Coverage is measured against the taxon's core (non-rank-marker)
    // word count, so omitting "subsp."/"var."/etc. isn't treated as
    // an incomplete match the way skipping a real name word would be.
    const coverage = Math.min(1, words.length / Math.max(1, sp._coreWordCount));
    const score = coverage < 1 ? raw * coverage * coverage : raw;
    if (!best || score > best.score) { second = best; best = { sp, score }; }
    else if (!second || score > second.score) { second = { sp, score }; }
  }
  return { best, second };
}

/* Score every taxon against every ASR alternative transcript (as a
   single whole phrase) — used where we know only one species was
   said (single-field dictation). Returns top matches sorted by
   descending confidence. */
function fuzzyMatchTranscripts(transcripts, limit) {
  limit = limit || 6;
  const qSets = transcripts.map(tokenize).filter(q => q.words.length);
  if (!qSets.length) return [];

  const scored = [];
  for (const sp of Species.all) {
    let best = 0;
    for (const q of qSets) {
      const score = scoreTaxonAgainstWords(sp, q.words, q.phon);
      if (score > best) best = score;
    }
    if (best > 0.15) scored.push({ sp, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/* Segment a transcript into one-or-more species names via dynamic
   programming (like segmenting run-on text against a dictionary):
   scores every possible word window against the entire taxon list
   and finds the split that maximizes total match confidence. This
   is what lets continuous voice logging correctly resolve a phrase
   like "achillea millefolium silene vulgaris" — captured as a
   single recognized utterance because two names were said close
   together — into two separate species instead of trying (and
   failing) to match the whole blob as one taxon. A small per-word
   skip option lets it route around filler/junk words instead of
   letting them drag a real match's score down. */
const SEG_MAX_LEN = 4;
const SEG_MIN_SCORE = 0.32;
const SEG_PENALTY = 0.03;
const SEG_SKIP_PENALTY = 0.06;

function segmentTranscript(transcript) {
  const { words, phon } = tokenize(transcript);
  const n = words.length;
  if (!n) return [];

  const dp = new Array(n + 1).fill(null);
  dp[0] = { score: 0, segs: [] };
  for (let i = 1; i <= n; i++) {
    if (dp[i - 1]) {
      const cand = dp[i - 1].score - SEG_SKIP_PENALTY;
      if (!dp[i] || cand > dp[i].score) dp[i] = { score: cand, segs: dp[i - 1].segs };
    }
    for (let len = 1; len <= SEG_MAX_LEN && i - len >= 0; len++) {
      const j = i - len;
      if (!dp[j]) continue;
      const { best, second } = bestTaxaForWords(words.slice(j, i), phon.slice(j, i));
      if (!best || best.score < SEG_MIN_SCORE) continue;
      // Weight by segment length so one solid multi-word match is
      // preferred over splitting the same words into several
      // cheaper-looking fragments.
      const cand = dp[j].score + best.score * len - SEG_PENALTY;
      if (!dp[i] || cand > dp[i].score) {
        dp[i] = { score: cand, segs: [...dp[j].segs, { sp: best.sp, score: best.score, second: second ? second.score : 0, from: j, to: i }] };
      }
    }
  }
  return dp[n] ? dp[n].segs : [];
}

function speak(text, onEnd) {
  if (!("speechSynthesis" in window)) { if (onEnd) setTimeout(onEnd, 900); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    if (onEnd) u.onend = onEnd;
    else if (!onEnd) u.onerror = () => {};
    speechSynthesis.speak(u);
  } catch (e) { if (onEnd) setTimeout(onEnd, 900); }
}

function renderVoiceCandidates(menuEl, matches, onPick) {
  menuEl.innerHTML = `<div class="ac-empty">Did you mean:</div>` + matches.map((m, i) => `
    <div class="ac-item" data-i="${i}">
      <div class="sp-name" style="font-style:italic">${esc(m.sp.t)}</div>
      <div class="fam">${esc(m.sp.f || "")}</div>
    </div>`).join("");
  menuEl.classList.add("show");
  $all(".ac-item", menuEl).forEach(el => {
    el.addEventListener("mousedown", ev => {
      ev.preventDefault();
      onPick(matches[Number(el.dataset.i)].sp);
      menuEl.classList.remove("show");
    });
  });
}

const VOICE_HIGH_CONF = 0.72;
const VOICE_LOW_CONF = 0.40;
const VOICE_MAX_RETRIES = 3;

function wireDictation(btn, inputEl, menuEl, statusEl, onPick) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  btn.hidden = false;
  const rec = new SR();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 6;
  let listening = false;
  let retries = 0;
  let manualStop = false;

  function setStatus(text) { if (statusEl) statusEl.textContent = text || ""; }
  function startListening() { try { rec.start(); } catch (e) { /* already running */ } }

  btn.addEventListener("click", () => {
    if (listening) { manualStop = true; rec.stop(); setStatus(""); return; }
    retries = 0;
    manualStop = false;
    setStatus("Listening…");
    startListening();
  });

  rec.addEventListener("start", () => { listening = true; btn.classList.add("listening"); });
  rec.addEventListener("end", () => { listening = false; btn.classList.remove("listening"); });
  rec.addEventListener("error", e => {
    listening = false; btn.classList.remove("listening");
    if (e.error !== "aborted" && !manualStop) { toast("Dictation failed — needs a connection", "err"); setStatus(""); }
  });

  rec.addEventListener("result", e => {
    const transcripts = Array.from(e.results[0]).map(alt => alt.transcript);
    const matches = fuzzyMatchTranscripts(transcripts, 6);
    const top = matches[0];
    const second = matches[1];

    if (top && top.score >= VOICE_HIGH_CONF && (!second || top.score - second.score >= 0.12)) {
      inputEl.value = top.sp.t;
      inputEl.dispatchEvent(new Event("input"));
      inputEl.focus();
      setStatus(`Heard "${transcripts[0]}" → ${top.sp.t}`);
      retries = 0;
      return;
    }
    if (top && top.score >= VOICE_LOW_CONF) {
      renderVoiceCandidates(menuEl, matches.slice(0, 5), sp => { onPick(sp); setStatus(""); });
      setStatus(`Not sure — heard "${transcripts[0]}"`);
      retries = 0;
      return;
    }
    if (retries < VOICE_MAX_RETRIES) {
      retries++;
      setStatus(`Didn't catch that — listen again (${VOICE_MAX_RETRIES - retries + 1} tries left)…`);
      speak("Sorry, that wasn't clear. Please say the species name again.", () => {
        if (!manualStop) startListening();
      });
    } else {
      setStatus("Couldn't recognize a species — type it instead.");
      speak("I still couldn't recognize that. Please type the species name instead.");
      inputEl.value = transcripts[0] || "";
      inputEl.dispatchEvent(new Event("input"));
      inputEl.focus();
      retries = 0;
    }
  });
}

/* ---------------------------------------------------------- */
/* continuous "walking" voice logging for a relevé species     */
/* list — toggle on, call out species as you walk the plot,    */
/* each recognized name is matched and added automatically     */
/* ---------------------------------------------------------- */

function wireVoiceLogging(btn, statusEl, viewName, addSpecies) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  btn.hidden = false;
  const rec = new SR();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 6;
  // Deliberately NOT continuous: Chrome's continuous mode batches speech
  // into fewer, longer results with looser endpointing, which is exactly
  // what causes several species said in sequence to get glued into one
  // recognized phrase. Restarting a single-shot session immediately after
  // each result (below) gives the same tight per-utterance segmentation
  // that makes the single-field dictation accurate, while still being
  // hands-free — the gap between stop and restart is a few milliseconds.

  let active = false;    // user has toggled logging on
  let running = false;   // a recognition session is currently alive
  let unclearStreak = 0;
  let speakFeedback = true;

  function setStatus(t) { if (statusEl) statusEl.textContent = t || ""; }
  function setBtnState() {
    btn.classList.toggle("listening", active);
    btn.lastChild.textContent = active ? " Stop voice logging" : " Start voice logging";
  }
  function startSession() {
    if (!active || running) return;
    try { rec.start(); } catch (e) { /* already running */ }
  }

  function stopLogging() {
    if (!active) return;
    active = false;
    setBtnState();
    setStatus("Voice logging stopped.");
    try { rec.stop(); } catch (e) { /* not running */ }
  }
  viewLeaveHooks[viewName] = stopLogging;

  btn.addEventListener("click", async () => {
    if (active) { stopLogging(); return; }
    active = true;
    setBtnState();
    const settings = await Store.getSettings();
    speakFeedback = settings.voiceSpeakFeedback !== false;
    unclearStreak = 0;
    setStatus("Listening — say each species as you spot it…");
    startSession();
  });

  rec.addEventListener("start", () => { running = true; });
  rec.addEventListener("end", () => {
    running = false;
    if (active) startSession(); // keep listening indefinitely until the user toggles off
  });
  rec.addEventListener("error", e => {
    running = false;
    if (e.error === "no-speech" || e.error === "aborted") return; // silence while walking is normal, not an error
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      active = false; setBtnState();
      setStatus("Microphone permission denied.");
      return;
    }
    // transient network hiccup etc — 'end' will fire next and restart while active
  });

  rec.addEventListener("result", async e => {
    const res = e.results[e.results.length - 1];
    const transcripts = Array.from(res).map(alt => alt.transcript);

    // Segment every ASR alternative into one-or-more species (usually
    // one, but a phrase like "achillea millefolium silene vulgaris" said
    // without enough of a pause resolves into two) and keep whichever
    // alternative's segmentation scores best overall.
    let segs = null, segsScore = -Infinity;
    for (const t of transcripts.slice(0, 3)) {
      const s = segmentTranscript(t);
      if (!s.length) continue;
      const total = s.reduce((sum, seg) => sum + seg.score, 0);
      if (total > segsScore) { segsScore = total; segs = s; }
    }
    const usable = (segs || []).filter(seg => seg.score >= VOICE_LOW_CONF);

    if (!usable.length) {
      unclearStreak++;
      setStatus(`Didn't catch that ("${transcripts[0] || "…"}") — say the species again`);
      if (unclearStreak <= 2 && speakFeedback) {
        speak("Sorry, I didn't catch that. Please repeat the species name.");
      }
      return;
    }
    unclearStreak = 0;

    const addedNames = [], unsureNames = [];
    let lastCheckpoint = null;
    for (const seg of usable) {
      const confident = seg.score >= VOICE_HIGH_CONF && (seg.score - (seg.second || 0) >= 0.12);
      const result = await addSpecies(seg.sp, { unconfirmed: !confident, score: seg.score, silent: true });
      if (!result || result.added === false) continue;
      (confident ? addedNames : unsureNames).push(seg.sp.t);
      if (result.checkpoint) lastCheckpoint = result.checkpoint;
    }

    const all = [...addedNames, ...unsureNames];
    if (!all.length) {
      setStatus("Already logged.");
    } else {
      setStatus(`Added: ${all.join(", ")}${unsureNames.length ? " (please confirm)" : ""}`);
      if (speakFeedback) {
        if (all.length === 1) speak(unsureNames.length ? `${all[0]}, please confirm` : all[0]);
        else speak(`Added ${all.length} species${unsureNames.length ? `, ${unsureNames.length} need confirming` : ""}.`);
      }
    }
    if (lastCheckpoint) {
      toast(`${lastCheckpoint} taxa logged — review when ready`);
      if (speakFeedback) speak(`${lastCheckpoint} species logged. Review when you're ready.`);
    }
  });
}

/* ============================================================
   RELEVÉ EDITOR
   ============================================================ */

const ReleveEditor = {
  current: null,

  blank() {
    return {
      id: uid(), type: "releve", createdAt: Date.now(), updatedAt: Date.now(),
      name: "REL-" + todayDate().replace(/-/g, "") + "-" + Math.floor(Math.random() * 90 + 10),
      date: todayDate(), time: nowTime(),
      lat: "", lon: "", alt: "", acc: "",
      area: "", slope: "", aspect: "", habitat: "",
      coverTree: "", coverShrub: "", coverHerb: "", coverMoss: "",
      coverScale: "bb",
      species: [], photoIds: [], notes: "",
    };
  },

  async openNew() {
    const settings = await Store.getSettings();
    this.current = this.blank();
    this.current.coverScale = settings.defaultScale || "bb";
    await this.render();
    pushView("releve");
  },

  async openExisting(id) {
    const rec = await Store.getRecord(id);
    if (!rec) return;
    this.current = rec;
    await this.render();
    pushView("releve");
  },

  async render() {
    const r = this.current;
    $("#releveName").value = r.name;
    $("#releveDate").value = r.date;
    $("#releveTime").value = r.time;
    $("#releveLat").value = r.lat;
    $("#releveLon").value = r.lon;
    $("#releveAlt").value = r.alt;
    $("#releveAcc").value = r.acc;
    $("#releveArea").value = r.area;
    $("#releveSlope").value = r.slope;
    $("#releveAspect").value = r.aspect;
    $("#releveHabitat").value = r.habitat;
    $("#coverTree").value = r.coverTree;
    $("#coverShrub").value = r.coverShrub;
    $("#coverHerb").value = r.coverHerb;
    $("#coverMoss").value = r.coverMoss;
    $("#coverScaleSelect").value = r.coverScale;
    $("#releveNotes").value = r.notes;
    $("#releveGpsStatus").textContent = "";
    this.renderSpecies();
    await renderPhotoGrid(r.photoIds, $("#relevePhotos"));
  },

  renderSpecies() {
    const r = this.current;
    $("#speciesCount").textContent = r.species.length ? r.species.length : "";
    const host = $("#speciesTable");
    if (!r.species.length) {
      host.innerHTML = `<div class="empty-note">No species added yet.</div>`;
      return;
    }
    host.innerHTML = r.species.map((s, i) => `
      <div class="species-row" data-i="${i}">
        <div class="sp-info">
          <div class="sp-name">${esc(s.taxon)}${s.voiceUnconfirmed ? ` <button type="button" class="sp-unconfirmed-badge" title="Voice match — tap to confirm it's correct">unconfirmed</button>` : ""}</div>
          <div class="sp-fam">${esc(s.family || "")}</div>
        </div>
        <select class="input small sp-layer">
          ${["herb", "shrub", "tree", "moss"].map(l => `<option value="${l}" ${l === s.layer ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        ${coverInputHtml(r.coverScale, s.cover)}
        <button type="button" class="rm-btn" title="Remove">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>`).join("");

    $all(".species-row", host).forEach(row => {
      const i = Number(row.dataset.i);
      $(".sp-layer", row).addEventListener("change", e => { r.species[i].layer = e.target.value; });
      $(".sp-cover", row).addEventListener("change", e => { r.species[i].cover = e.target.value; });
      $(".rm-btn", row).addEventListener("click", () => { r.species.splice(i, 1); this.renderSpecies(); });
      const badge = $(".sp-unconfirmed-badge", row);
      if (badge) badge.addEventListener("click", () => { r.species[i].voiceUnconfirmed = false; this.renderSpecies(); });
    });
  },

  addSpecies(sp, opts) {
    opts = opts || {};
    const r = this.current;
    if (r.species.some(s => s.taxon === sp.t)) {
      if (!opts.silent) toast("Already in the list");
      return { added: false };
    }
    r.species.push({ taxon: sp.t, family: sp.f || "", layer: "herb", cover: "", voiceUnconfirmed: !!opts.unconfirmed });
    this.renderSpecies();
    return { added: true };
  },

  readForm() {
    const r = this.current;
    r.name = $("#releveName").value.trim() || r.name;
    r.date = $("#releveDate").value;
    r.time = $("#releveTime").value;
    r.lat = $("#releveLat").value;
    r.lon = $("#releveLon").value;
    r.alt = $("#releveAlt").value;
    r.acc = $("#releveAcc").value;
    r.area = $("#releveArea").value;
    r.slope = $("#releveSlope").value;
    r.aspect = $("#releveAspect").value;
    r.habitat = $("#releveHabitat").value;
    r.coverTree = $("#coverTree").value;
    r.coverShrub = $("#coverShrub").value;
    r.coverHerb = $("#coverHerb").value;
    r.coverMoss = $("#coverMoss").value;
    r.coverScale = $("#coverScaleSelect").value;
    r.notes = $("#releveNotes").value;
  },

  async save() {
    this.readForm();
    await Store.saveRecord(this.current);
    toast("Relevé saved", "ok");
    popView();
    Home.refresh();
  },

  async remove() {
    if (!confirm("Delete this relevé? This cannot be undone.")) return;
    for (const id of this.current.photoIds) await Store.deletePhoto(id);
    await Store.deleteRecord(this.current.id);
    toast("Relevé deleted");
    popView();
    Home.refresh();
  },
};

/* ============================================================
   OBSERVATION EDITOR
   ============================================================ */

const ObservationEditor = {
  current: null,

  blank() {
    return {
      id: uid(), type: "observation", createdAt: Date.now(), updatedAt: Date.now(),
      taxon: "", family: "",
      date: todayDate(), time: nowTime(),
      lat: "", lon: "",
      photoIds: [], notes: "",
    };
  },

  openNew() {
    this.current = this.blank();
    this.render();
    pushView("observation");
  },

  async openExisting(id) {
    const rec = await Store.getRecord(id);
    if (!rec) return;
    this.current = rec;
    await this.render();
    pushView("observation");
  },

  async render() {
    const s = this.current;
    $("#observationDate").value = s.date;
    $("#observationTime").value = s.time;
    $("#observationLat").value = s.lat;
    $("#observationLon").value = s.lon;
    $("#observationNotes").value = s.notes;
    $("#observationGpsStatus").textContent = "";
    this.renderTaxonChip();
    await renderPhotoGrid(s.photoIds, $("#observationPhotos"));
  },

  renderTaxonChip() {
    const s = this.current;
    const host = $("#observationTaxonChip");
    if (!s.taxon) { host.innerHTML = ""; return; }
    host.innerHTML = `<span class="chip" style="font-style:italic">${esc(s.taxon)}<button type="button" id="clearTaxonBtn">×</button></span>`;
    $("#clearTaxonBtn").addEventListener("click", () => { s.taxon = ""; s.family = ""; this.renderTaxonChip(); });
  },

  setTaxon(sp) {
    this.current.taxon = sp.t;
    this.current.family = sp.f || "";
    this.renderTaxonChip();
  },

  readForm() {
    const s = this.current;
    s.date = $("#observationDate").value;
    s.time = $("#observationTime").value;
    s.lat = $("#observationLat").value;
    s.lon = $("#observationLon").value;
    s.notes = $("#observationNotes").value;
  },

  async save() {
    this.readForm();
    if (!this.current.taxon) { toast("Pick a species first", "err"); return; }
    await Store.saveRecord(this.current);
    toast("Observation saved", "ok");
    popView();
    Home.refresh();
  },

  async remove() {
    if (!confirm("Delete this observation? This cannot be undone.")) return;
    for (const id of this.current.photoIds) await Store.deletePhoto(id);
    await Store.deleteRecord(this.current.id);
    toast("Observation deleted");
    popView();
    Home.refresh();
  },
};

/* ============================================================
   TRANSECT EDITOR — a fast, "incomplete" walking survey: no plot
   metadata or cover-abundance, just a running species list built
   by voice (hands-free) or manual search, each entry carrying a
   certainty score and a reviewed flag for later approval.
   ============================================================ */

function certaintyPillHtml(s) {
  if (s.reviewed) return `<span class="certainty-pill c-high" title="Confirmed">✓</span>`;
  const pct = Math.round((s.certainty || 0) * 100);
  const cls = pct >= 85 ? "c-high" : pct >= 50 ? "c-mid" : "c-low";
  return `<button type="button" class="certainty-pill ${cls}" title="Tap to approve">${pct}%</button>`;
}

const TransectEditor = {
  current: null,

  blank() {
    return {
      id: uid(), type: "transect", createdAt: Date.now(), updatedAt: Date.now(),
      name: "TRA-" + todayDate().replace(/-/g, "") + "-" + Math.floor(Math.random() * 90 + 10),
      date: todayDate(), time: nowTime(),
      lat: "", lon: "", alt: "", acc: "",
      species: [], notes: "",
    };
  },

  openNew() {
    this.current = this.blank();
    this.render();
    pushView("transect");
  },

  async openExisting(id) {
    const rec = await Store.getRecord(id);
    if (!rec) return;
    this.current = rec;
    this.render();
    pushView("transect");
  },

  render() {
    const t = this.current;
    $("#transectName").value = t.name;
    $("#transectDate").value = t.date;
    $("#transectTime").value = t.time;
    $("#transectLat").value = t.lat;
    $("#transectLon").value = t.lon;
    $("#transectAlt").value = t.alt;
    $("#transectAcc").value = t.acc;
    $("#transectNotes").value = t.notes;
    $("#transectGpsStatus").textContent = "";
    $("#transectVoiceLogStatus").textContent = "";
    this.renderSpecies();
  },

  renderSpecies() {
    const t = this.current;
    const unreviewed = t.species.filter(s => !s.reviewed).length;
    $("#transectSpeciesCount").textContent = t.species.length ? t.species.length : "";
    $("#transectListStatus").textContent = t.species.length
      ? `${t.species.length} logged · ${unreviewed} awaiting review`
      : "";
    $("#transectReviewBtn").textContent = unreviewed ? `Review & approve (${unreviewed})` : "Review & approve";

    const host = $("#transectSpeciesTable");
    if (!t.species.length) {
      host.innerHTML = `<div class="empty-note">No species logged yet.</div>`;
      return;
    }
    host.innerHTML = t.species.map((s, i) => `
      <div class="species-row" data-i="${i}">
        <div class="sp-info">
          <div class="sp-name">${esc(s.taxon)}</div>
          <div class="sp-fam">${esc(s.family || "")}</div>
        </div>
        ${certaintyPillHtml(s)}
        <button type="button" class="rm-btn" title="Remove">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>`).join("");

    $all(".species-row", host).forEach(row => {
      const i = Number(row.dataset.i);
      $(".rm-btn", row).addEventListener("click", () => { t.species.splice(i, 1); this.renderSpecies(); });
      const pill = $(".certainty-pill", row);
      if (pill) pill.addEventListener("click", () => { t.species[i].reviewed = true; this.renderSpecies(); });
    });
  },

  async addSpecies(sp, opts) {
    opts = opts || {};
    const t = this.current;
    if (t.species.some(s => s.taxon === sp.t)) {
      if (!opts.silent) toast("Already in the list");
      return { added: false };
    }
    const certainty = opts.score != null ? opts.score : 1;
    t.species.push({
      taxon: sp.t, family: sp.f || "",
      certainty,
      reviewed: certainty >= VOICE_HIGH_CONF,
      source: opts.score != null ? "voice" : "manual",
      loggedAt: Date.now(),
    });
    this.renderSpecies();

    let checkpoint = null;
    if (opts.score != null) {
      const settings = await Store.getSettings();
      const cpSize = Math.max(5, Number(settings.voiceReviewCheckpoint) || 30);
      if (t.species.length % cpSize === 0) checkpoint = t.species.length;
    }
    return { added: true, checkpoint };
  },

  readForm() {
    const t = this.current;
    t.name = $("#transectName").value.trim() || t.name;
    t.date = $("#transectDate").value;
    t.time = $("#transectTime").value;
    t.lat = $("#transectLat").value;
    t.lon = $("#transectLon").value;
    t.alt = $("#transectAlt").value;
    t.acc = $("#transectAcc").value;
    t.notes = $("#transectNotes").value;
  },

  async save() {
    this.readForm();
    await Store.saveRecord(this.current);
    toast("Transect saved", "ok");
    popView();
    Home.refresh();
  },

  async remove() {
    if (!confirm("Delete this transect? This cannot be undone.")) return;
    await Store.deleteRecord(this.current.id);
    toast("Transect deleted");
    popView();
    Home.refresh();
  },
};

/* ============================================================
   TRANSECT REVIEW — batch approve/edit/remove unreviewed entries,
   sorted lowest-certainty first so the ones most likely to need
   attention surface at the top.
   ============================================================ */

const TransectReview = {
  replacingIndex: null,

  open() {
    this.replacingIndex = null;
    $("#reviewReplaceBox").hidden = true;
    this.render();
    pushView("transect-review");
  },

  render() {
    const t = TransectEditor.current;
    const items = t.species
      .map((s, i) => ({ s, i }))
      .filter(x => !x.s.reviewed)
      .sort((a, b) => (a.s.certainty || 0) - (b.s.certainty || 0));

    $("#reviewCount").textContent = items.length ? items.length : "";
    const host = $("#reviewList");
    if (!items.length) {
      host.innerHTML = `<div class="empty-note">Nothing left to review.</div>`;
      return;
    }
    host.innerHTML = items.map(({ s, i }) => {
      const pct = Math.round((s.certainty || 0) * 100);
      const cls = pct >= 85 ? "c-high" : pct >= 50 ? "c-mid" : "c-low";
      return `
      <div class="review-row" data-i="${i}">
        <div class="review-info">
          <div class="review-name">${esc(s.taxon)}</div>
          <div class="review-fam">${esc(s.family || "")}</div>
        </div>
        <span class="certainty-pill ${cls}">${pct}%</span>
        <button type="button" class="btn btn-icon review-approve" title="Approve">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" class="btn btn-icon review-edit" title="Pick the correct species">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4l10-10-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" class="btn btn-icon review-remove" title="Remove">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>`;
    }).join("");

    $all(".review-row", host).forEach(row => {
      const i = Number(row.dataset.i);
      $(".review-approve", row).addEventListener("click", () => {
        t.species[i].reviewed = true;
        this.render(); TransectEditor.renderSpecies();
      });
      $(".review-remove", row).addEventListener("click", () => {
        t.species.splice(i, 1);
        this.render(); TransectEditor.renderSpecies();
      });
      $(".review-edit", row).addEventListener("click", () => { this.startReplace(i); });
    });
  },

  startReplace(i) {
    const t = TransectEditor.current;
    this.replacingIndex = i;
    $("#reviewReplaceLabel").textContent = `Replacing: ${t.species[i].taxon}`;
    $("#reviewReplaceBox").hidden = false;
    $("#reviewReplaceInput").value = "";
    $("#reviewReplaceInput").focus();
  },

  finishReplace(sp) {
    const t = TransectEditor.current;
    if (this.replacingIndex == null) return;
    t.species[this.replacingIndex] = {
      taxon: sp.t, family: sp.f || "", certainty: 1, reviewed: true, source: "manual", loggedAt: Date.now(),
    };
    this.replacingIndex = null;
    $("#reviewReplaceBox").hidden = true;
    this.render();
    TransectEditor.renderSpecies();
  },

  cancelReplace() {
    this.replacingIndex = null;
    $("#reviewReplaceBox").hidden = true;
  },

  approveAllAbove(threshold) {
    const t = TransectEditor.current;
    let n = 0;
    t.species.forEach(s => { if (!s.reviewed && s.certainty >= threshold) { s.reviewed = true; n++; } });
    this.render();
    TransectEditor.renderSpecies();
    toast(n ? `Approved ${n} taxa` : "Nothing to approve above that threshold");
  },
};

/* ============================================================
   RECORD LIST RENDERING (shared by Home + Records views)
   ============================================================ */

function recordIcon(type) {
  if (type === "releve") return `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 9h10M7 13h10M7 17h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  if (type === "transect") return `<svg viewBox="0 0 24 24"><path d="M3 18c4-8 6 6 10-2 2-4 4-4 8-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="12.2" r="1.4" fill="currentColor"/><circle cx="13.3" cy="14.8" r="1.4" fill="currentColor"/><circle cx="19" cy="11.5" r="1.4" fill="currentColor"/></svg>`;
  return `<svg viewBox="0 0 24 24"><path d="M12 21s-7-5.2-7-10.5C5 6.9 8.1 4 12 4s7 2.9 7 6.5C19 15.8 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="10.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
}

function recordTitle(rec) {
  if (rec.type === "releve" || rec.type === "transect") return rec.name || (rec.type === "releve" ? "Relevé" : "Transect");
  return rec.taxon || "Observation";
}
function recordSub(rec) {
  const bits = [rec.date];
  if (rec.type === "releve") bits.push(`${rec.species.length} spp.`);
  else if (rec.type === "transect") {
    const unreviewed = rec.species.filter(s => !s.reviewed).length;
    bits.push(`${rec.species.length} spp.${unreviewed ? `, ${unreviewed} to review` : ""}`);
  } else if (rec.family) bits.push(rec.family);
  if (rec.lat && rec.lon) bits.push("GPS");
  return bits.filter(Boolean).join(" · ");
}

function renderRecordList(records, hostEl) {
  if (!records.length) {
    hostEl.innerHTML = `<div class="empty-note">Nothing here yet.</div>`;
    return;
  }
  hostEl.innerHTML = records.map(rec => `
    <div class="record-item" data-id="${rec.id}" data-type="${rec.type}">
      <div class="kind">${recordIcon(rec.type)}</div>
      <div class="info">
        <div class="title" style="${rec.type === "observation" ? "font-style:italic" : ""}">${esc(recordTitle(rec))}</div>
        <div class="sub">${esc(recordSub(rec))}</div>
      </div>
      <div class="chev"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    </div>`).join("");

  $all(".record-item", hostEl).forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.id, type = el.dataset.type;
      if (type === "releve") ReleveEditor.openExisting(id);
      else if (type === "transect") TransectEditor.openExisting(id);
      else ObservationEditor.openExisting(id);
    });
  });
}

/* ============================================================
   HOME VIEW
   ============================================================ */

const Home = {
  async refresh() {
    const records = await Store.allRecords();
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    const releveCount = records.filter(r => r.type === "releve").length;
    const observationCount = records.filter(r => r.type === "observation").length;
    const transectCount = records.filter(r => r.type === "transect").length;
    const speciesSet = new Set();
    records.forEach(r => {
      if (r.type === "releve" || r.type === "transect") r.species.forEach(s => speciesSet.add(s.taxon));
      else if (r.taxon) speciesSet.add(r.taxon);
    });

    $("#homeStats").innerHTML = `
      <div class="stat-card"><div class="n">${releveCount}</div><div class="l">Relevés</div></div>
      <div class="stat-card"><div class="n">${transectCount}</div><div class="l">Transects</div></div>
      <div class="stat-card"><div class="n">${observationCount}</div><div class="l">Observations</div></div>
      <div class="stat-card"><div class="n">${speciesSet.size}</div><div class="l">Taxa recorded</div></div>
    `;

    renderRecordList(records.slice(0, 6), $("#recentList"));
  },
};

/* ============================================================
   RECORDS VIEW (full list, filter + search)
   ============================================================ */

const Records = {
  async refresh() {
    const records = await Store.allRecords();
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    const q = $("#recordsSearch").value.trim().toLowerCase();
    const activeTypes = $all("#recordsFilter input:checked").map(i => i.value);

    const filtered = records.filter(r => {
      if (!activeTypes.includes(r.type)) return false;
      if (!q) return true;
      const hay = r.type === "releve"
        ? [r.name, r.habitat, ...r.species.map(s => s.taxon)].join(" ").toLowerCase()
        : r.type === "transect"
        ? [r.name, r.notes, ...r.species.map(s => s.taxon)].join(" ").toLowerCase()
        : [r.taxon, r.family, r.notes].join(" ").toLowerCase();
      return hay.includes(q);
    });
    renderRecordList(filtered, $("#recordsListFull"));
  },
};

/* ============================================================
   SETTINGS VIEW
   ============================================================ */

const Settings = {
  async refresh() {
    $("#appVersion").textContent = APP_VERSION;
    const settings = await Store.getSettings();
    $("#defaultScaleSelect").value = settings.defaultScale || "bb";
    $("#gpsThresholdInput").value = settings.gpsThreshold || 10;
    $("#voiceSpeakFeedback").checked = settings.voiceSpeakFeedback !== false;
    $("#voiceReviewCheckpointInput").value = settings.voiceReviewCheckpoint || 30;

    $("#speciesPackList").innerHTML = Species.packs.map(p => `
      <div class="tx-item">
        <span class="name">${esc(p.label)}</span>
        <span class="count">${p.count} taxa</span>
      </div>`).join("") || `<div class="empty-note">No species packs loaded.</div>`;

    const records = await Store.allRecords();
    const photos = await Store.allPhotos();
    let photoBytes = 0;
    photos.forEach(p => { if (p.blob && p.blob.size) photoBytes += p.blob.size; });
    $("#storageStats").textContent =
      `${records.length} record${records.length === 1 ? "" : "s"} · ${photos.length} photo${photos.length === 1 ? "" : "s"} (${(photoBytes / 1024 / 1024).toFixed(1)} MB) stored on this device.`;
  },
};

/* ============================================================
   EXPORT / IMPORT
   ============================================================ */

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportCsv() {
  const records = await Store.allRecords();
  const releves = records.filter(r => r.type === "releve");
  const observations = records.filter(r => r.type === "observation");
  const transects = records.filter(r => r.type === "transect");

  const releveRows = [["id", "name", "date", "time", "lat", "lon", "alt", "accuracy_m", "area_m2", "slope_deg", "aspect", "habitat", "cover_tree_pct", "cover_shrub_pct", "cover_herb_pct", "cover_moss_pct", "cover_scale", "species_count", "notes"]];
  const speciesRows = [["releve_id", "releve_name", "taxon", "family", "layer", "cover"]];
  releves.forEach(r => {
    releveRows.push([r.id, r.name, r.date, r.time, r.lat, r.lon, r.alt, r.acc, r.area, r.slope, r.aspect, r.habitat, r.coverTree, r.coverShrub, r.coverHerb, r.coverMoss, r.coverScale, r.species.length, r.notes]);
    r.species.forEach(s => speciesRows.push([r.id, r.name, s.taxon, s.family, s.layer, s.cover]));
  });

  const observationRows = [["id", "taxon", "family", "date", "time", "lat", "lon", "notes"]];
  observations.forEach(s => observationRows.push([s.id, s.taxon, s.family, s.date, s.time, s.lat, s.lon, s.notes]));

  const transectRows = [["id", "name", "date", "time", "lat", "lon", "alt", "accuracy_m", "species_count", "notes"]];
  const transectSpeciesRows = [["transect_id", "transect_name", "taxon", "family", "certainty", "reviewed", "source", "logged_at"]];
  transects.forEach(t => {
    transectRows.push([t.id, t.name, t.date, t.time, t.lat, t.lon, t.alt, t.acc, t.species.length, t.notes]);
    t.species.forEach(s => transectSpeciesRows.push([t.id, t.name, s.taxon, s.family, (s.certainty ?? 1).toFixed(2), s.reviewed ? "yes" : "no", s.source || "", s.loggedAt ? new Date(s.loggedAt).toISOString() : ""]));
  });

  const zipLike = [
    "# releves.csv\n" + toCsv(releveRows),
    "# releves_species.csv\n" + toCsv(speciesRows),
    "# observations.csv\n" + toCsv(observationRows),
    "# transects.csv\n" + toCsv(transectRows),
    "# transects_species.csv\n" + toCsv(transectSpeciesRows),
  ].join("\n\n");

  downloadBlob(new Blob([zipLike], { type: "text/csv" }), `isurvey-export-${todayDate()}.csv`);
  toast("CSV exported", "ok");
}

async function exportJson() {
  const records = await Store.allRecords();
  const photos = await Store.allPhotos();
  const photosOut = [];
  for (const p of photos) {
    const b64 = await blobToBase64(p.blob);
    photosOut.push({ id: p.id, mime: p.mime, createdAt: p.createdAt, data: b64 });
  }
  const settings = await Store.getSettings();
  const payload = { version: APP_VERSION, exportedAt: new Date().toISOString(), records, photos: photosOut, settings };
  downloadBlob(new Blob([JSON.stringify(payload)], { type: "application/json" }), `isurvey-backup-${todayDate()}.json`);
  toast("Backup exported", "ok");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
async function base64ToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

async function importJson(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  if (!payload.records) throw new Error("Not a valid iSurvey backup file");

  for (const p of payload.photos || []) {
    const blob = await base64ToBlob(p.data);
    await Store.savePhoto({ id: p.id, blob, mime: p.mime, createdAt: p.createdAt });
  }
  for (const r of payload.records) {
    await Store.saveRecord(r);
  }
  if (payload.settings) await Store.saveSettings(payload.settings);
  toast(`Imported ${payload.records.length} records`, "ok");
  Home.refresh();
  Settings.refresh();
}

/* ============================================================
   WIRE UP
   ============================================================ */

function wireNav() {
  $all(".navbtn").forEach(btn => {
    btn.addEventListener("click", () => {
      resetToTab(btn.dataset.view);
      if (btn.dataset.view === "home") Home.refresh();
      if (btn.dataset.view === "records") Records.refresh();
      if (btn.dataset.view === "settings") Settings.refresh();
    });
  });
  $all("[data-back]").forEach(btn => btn.addEventListener("click", () => { popView(); Home.refresh(); }));
}

function wireHome() {
  $("#newReleveBtn").addEventListener("click", () => ReleveEditor.openNew());
  $("#newObservationBtn").addEventListener("click", () => ObservationEditor.openNew());
  $("#newTransectBtn").addEventListener("click", () => TransectEditor.openNew());
  $("#seeAllBtn").addEventListener("click", () => { resetToTab("records"); pushView("records"); Records.refresh(); });
}

function wireTransectEditor() {
  wireGpsButton($("#transectGpsBtn"), $("#transectGpsStatus"), $("#transectLat"), $("#transectLon"), $("#transectAlt"), $("#transectAcc"));
  wireAutocomplete($("#transectSearchInput"), $("#transectAcMenu"), sp => TransectEditor.addSpecies(sp));
  wireVoiceLogging($("#transectVoiceLogBtn"), $("#transectVoiceLogStatus"), "transect", (sp, opts) => TransectEditor.addSpecies(sp, opts));
  $("#transectReviewBtn").addEventListener("click", () => TransectReview.open());
  $("#transectSaveBtn").addEventListener("click", () => TransectEditor.save());
  $("#transectDeleteBtn").addEventListener("click", () => TransectEditor.remove());
}

function wireTransectReview() {
  wireAutocomplete($("#reviewReplaceInput"), $("#reviewReplaceMenu"), sp => TransectReview.finishReplace(sp));
  $("#reviewReplaceCancelBtn").addEventListener("click", () => TransectReview.cancelReplace());
  $("#reviewApproveAllBtn").addEventListener("click", () => TransectReview.approveAllAbove(0.9));
}

function wireReleveEditor() {
  wireGpsButton($("#releveGpsBtn"), $("#releveGpsStatus"), $("#releveLat"), $("#releveLon"), $("#releveAlt"), $("#releveAcc"));
  wireAutocomplete($("#speciesSearchInput"), $("#speciesAcMenu"), sp => ReleveEditor.addSpecies(sp));
  wireVoiceLogging($("#voiceLogBtn"), $("#voiceLogStatus"), "releve", (sp, opts) => ReleveEditor.addSpecies(sp, opts));
  $("#coverScaleSelect").addEventListener("change", () => {
    ReleveEditor.current.coverScale = $("#coverScaleSelect").value;
    ReleveEditor.renderSpecies();
  });
  $("#relevePhotoInput").addEventListener("change", e => addPhotosFromInput(e.target, ReleveEditor.current.photoIds, $("#relevePhotos")));
  $("#releveSaveBtn").addEventListener("click", () => ReleveEditor.save());
  $("#releveDeleteBtn").addEventListener("click", () => ReleveEditor.remove());
}

function wireObservationEditor() {
  wireGpsButton($("#observationGpsBtn"), $("#observationGpsStatus"), $("#observationLat"), $("#observationLon"), null, null);
  wireAutocomplete($("#observationTaxonInput"), $("#observationAcMenu"), sp => ObservationEditor.setTaxon(sp));
  wireDictation($("#observationDictateBtn"), $("#observationTaxonInput"), $("#observationAcMenu"), $("#observationDictateStatus"), sp => ObservationEditor.setTaxon(sp));
  $("#observationPhotoInput").addEventListener("change", e => addPhotosFromInput(e.target, ObservationEditor.current.photoIds, $("#observationPhotos")));
  $("#observationSaveBtn").addEventListener("click", () => ObservationEditor.save());
  $("#observationDeleteBtn").addEventListener("click", () => ObservationEditor.remove());
}

function wireRecords() {
  $("#recordsSearch").addEventListener("input", () => Records.refresh());
  $all("#recordsFilter input").forEach(i => i.addEventListener("change", () => Records.refresh()));
}

function wireSettings() {
  $("#settingsBtn").addEventListener("click", () => { resetToTab("settings"); pushView("settings"); Settings.refresh(); });
  $("#defaultScaleSelect").addEventListener("change", async () => {
    const s = await Store.getSettings();
    s.defaultScale = $("#defaultScaleSelect").value;
    await Store.saveSettings(s);
  });
  $("#gpsThresholdInput").addEventListener("change", async () => {
    const s = await Store.getSettings();
    s.gpsThreshold = Math.max(1, Number($("#gpsThresholdInput").value) || 10);
    $("#gpsThresholdInput").value = s.gpsThreshold;
    await Store.saveSettings(s);
  });
  $("#voiceSpeakFeedback").addEventListener("change", async () => {
    const s = await Store.getSettings();
    s.voiceSpeakFeedback = $("#voiceSpeakFeedback").checked;
    await Store.saveSettings(s);
  });
  $("#voiceReviewCheckpointInput").addEventListener("change", async () => {
    const s = await Store.getSettings();
    s.voiceReviewCheckpoint = Math.max(5, Number($("#voiceReviewCheckpointInput").value) || 30);
    $("#voiceReviewCheckpointInput").value = s.voiceReviewCheckpoint;
    await Store.saveSettings(s);
  });
  $("#exportCsvBtn").addEventListener("click", () => exportCsv());
  $("#exportJsonBtn").addEventListener("click", () => exportJson());
  $("#importJsonInput").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    try { await importJson(file); }
    catch (err) { toast("Import failed: " + err.message, "err"); }
    e.target.value = "";
  });
  $("#wipeDataBtn").addEventListener("click", async () => {
    if (!confirm("Erase ALL local data — every relevé, observation and photo? This cannot be undone.")) return;
    await Store.wipeAll();
    toast("All data erased");
    Home.refresh();
    Settings.refresh();
  });
}

function wireNetStatus() {
  const el = $("#netStatus"), text = $("#netStatusText");
  function update() {
    const online = navigator.onLine;
    text.textContent = online ? "Online" : "Offline";
    el.classList.toggle("offline", !online);
  }
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

async function init() {
  wireNav(); wireHome(); wireReleveEditor(); wireObservationEditor(); wireTransectEditor(); wireTransectReview(); wireRecords(); wireSettings(); wireNetStatus();
  showView("home");
  try {
    await Species.loadAll();
  } catch (e) {
    toast("Could not load species database", "err");
    console.error(e);
  }
  await Home.refresh();
}

document.addEventListener("DOMContentLoaded", init);
