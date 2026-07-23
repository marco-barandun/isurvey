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
// Update a button's own label text without disturbing sibling children (icon,
// nested info-dot). Targets the first non-empty direct text node rather than
// btn.lastChild, since an inline (i) dot is often the actual last child now.
function setBtnLabel(btn, text) {
  for (const n of btn.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) { n.textContent = text; return; }
  }
  btn.insertBefore(document.createTextNode(text), btn.firstChild);
}
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
    Object.assign({ key: "app", defaultScale: "bb", activePacks: null, gpsThreshold: 10, voiceSpeakFeedback: true, voiceReviewCheckpoint: 30, aiVoiceEnabled: false, aiVoiceQuality: "accurate", aiVoiceLang: "multi", contextPriors: true }, s || {})),
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
const viewLeaveHooks = {}; // viewName -> fn[]; run when navigating away (stop a stray mic session, cancel an in-flight GPS capture, …)
function addLeaveHook(viewName, fn) {
  (viewLeaveHooks[viewName] || (viewLeaveHooks[viewName] = [])).push(fn);
}

function showView(name) {
  for (const [viewName, hooks] of Object.entries(viewLeaveHooks)) {
    if (viewName !== name && $("#view-" + viewName)?.classList.contains("active")) hooks.forEach(h => h());
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

  function freeTextRowHtml(q) {
    if (!q) return "";
    return `<div class="ac-item ac-freetext" data-freetext="1"><div class="sp-name">Add "${esc(q)}" as typed</div><div class="fam">Not in checklist</div></div>`;
  }

  function render(results) {
    currentResults = results;
    hiIndex = -1;
    const q = inputEl.value.trim();
    if (!results.length) {
      menuEl.innerHTML = q ? `<div class="ac-empty">No match — check spelling or try fewer letters</div>${freeTextRowHtml(q)}` : "";
      menuEl.classList.toggle("show", !!q);
      return;
    }
    menuEl.innerHTML = results.map((sp, i) => `
      <div class="ac-item" data-i="${i}">
        <div class="sp-name" style="font-style:italic">${esc(sp.t)}</div>
        <div class="fam">${esc(sp.f || "")} ${sp.n ? `<span class="native-tag">· ${esc(sp.n.replace(/^CH_/, "").replace(/_/g, " ").toLowerCase())}</span>` : ""}</div>
      </div>`).join("") + freeTextRowHtml(q);
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
    if (!menuEl.classList.contains("show")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); if (currentResults.length) { hiIndex = Math.min(hiIndex + 1, currentResults.length - 1); highlight(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (currentResults.length) { hiIndex = Math.max(hiIndex - 1, 0); highlight(); } }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = currentResults[hiIndex >= 0 ? hiIndex : 0];
      if (pick) choose(pick);
      else if (inputEl.value.trim()) choose({ t: inputEl.value.trim(), f: "", freeText: true });
    } else if (e.key === "Escape") { menuEl.classList.remove("show"); }
  });
  function highlight() {
    $all(".ac-item", menuEl).forEach((el, i) => el.classList.toggle("hi", i === hiIndex));
  }
  menuEl.addEventListener("mousedown", e => {
    const item = e.target.closest(".ac-item");
    if (!item) return;
    e.preventDefault();
    if (item.dataset.freetext) { choose({ t: inputEl.value.trim(), f: "", freeText: true }); return; }
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
      // .value assignment doesn't fire input events on its own — dispatch
      // so anything listening (e.g. the location map) picks up the change.
      latEl.dispatchEvent(new Event("input"));
      lonEl.dispatchEvent(new Event("input"));
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

function wireGpsButton(btn, statusEl, latEl, lonEl, altEl, accEl, viewName) {
  let active = null;
  let onDoneExtra = null;

  async function start() {
    if (active) return;
    const settings = await Store.getSettings();
    const threshold = Number(settings.gpsThreshold) || 10;
    setBtnState(true);
    active = averagedGpsCapture({
      statusEl, latEl, lonEl, altEl, accEl, threshold, targetCount: GPS_TARGET_COUNT,
      onDone: () => { active = null; setBtnState(false); const extra = onDoneExtra; onDoneExtra = null; if (extra) extra(); },
    });
  }
  function cancel() {
    if (active) { active.cancel(); active = null; setBtnState(false); }
  }

  btn.addEventListener("click", () => { if (active) cancel(); else start(); });
  function setBtnState(capturing) {
    setBtnLabel(btn, capturing ? "Cancel locating…" : "Capture GPS location (averaged)");
    btn.classList.toggle("btn-danger", capturing);
  }
  if (viewName) addLeaveHook(viewName, cancel);

  // `onDone` fires once after the next capture completes/cancels — used to
  // auto-collapse the location fold only for the initial auto-capture on a
  // new record, not for later manual recaptures mid-edit.
  return { start: onDone => { onDoneExtra = onDone || null; start(); }, cancel };
}

/* ---------------------------------------------------------- */
/* location map — Swisstopo (topo + aerial) and OpenStreetMap  */
/* (global) as switchable layers, via Leaflet (vendored, no    */
/* CDN). Tile images still need a connection; the app degrades */
/* gracefully — the wrap just stays hidden without one.        */
/* ---------------------------------------------------------- */

function swissTileLayers() {
  return {
    "Swisstopo — topo": L.tileLayer(
      "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
      { maxNativeZoom: 18, maxZoom: 20, attribution: "© swisstopo" }
    ),
    "Swisstopo — aerial": L.tileLayer(
      "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg",
      { maxNativeZoom: 19, maxZoom: 20, attribution: "© swisstopo" }
    ),
    "OpenStreetMap (global)": L.tileLayer(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "© OpenStreetMap contributors" }
    ),
  };
}

/* One map instance per editor, created lazily and reused across
   record switches within that editor (Leaflet can't be re-init'd
   on the same container). `update` shows/hides the wrap and moves
   the marker; `invalidate` fixes Leaflet's sizing when the map's
   container becomes visible after being hidden (e.g. a <details>
   fold opening). */
function createLocationMap(containerId, wrapId) {
  let map = null, marker = null, accCircle = null, accLabelEl = null;

  function ensureMap(lat, lon) {
    if (map) return;
    const layers = swissTileLayers();
    map = L.map(containerId, { attributionControl: true, layers: [layers["Swisstopo — topo"]] });
    L.control.layers(layers, null, { collapsed: false }).addTo(map);
    accCircle = L.circle([lat, lon], { radius: 0, color: "#2f6b47", weight: 1, fillColor: "#2f6b47", fillOpacity: 0, opacity: 0, interactive: false }).addTo(map);
    marker = L.circleMarker([lat, lon], { radius: 8, color: "#2f6b47", weight: 2, fillColor: "#4fa971", fillOpacity: 0.9 }).addTo(map);
    const accCtl = L.control({ position: "bottomleft" });
    accCtl.onAdd = () => { accLabelEl = L.DomUtil.create("div", "map-acc-label"); return accLabelEl; };
    accCtl.addTo(map);
    map.setView([lat, lon], 15);
  }

  return {
    // accStr: GPS accuracy in meters, drawn as an uncertainty circle
    // around the marker — "the point" is never more precise than this.
    update(latStr, lonStr, accStr) {
      const wrap = document.getElementById(wrapId);
      const lat = Number(latStr), lon = Number(lonStr);
      const acc = Number(accStr);
      const hasCoords = latStr !== "" && lonStr !== "" && !isNaN(lat) && !isNaN(lon);
      if (!wrap) return;
      wrap.hidden = !hasCoords;
      if (!hasCoords) return;
      if (!map) ensureMap(lat, lon);
      else { marker.setLatLng([lat, lon]); map.setView([lat, lon], map.getZoom()); }
      const hasAcc = !isNaN(acc) && acc > 0;
      if (accCircle) {
        accCircle.setLatLng([lat, lon]);
        accCircle.setRadius(hasAcc ? acc : 0);
        accCircle.setStyle({ opacity: hasAcc ? 1 : 0, fillOpacity: hasAcc ? 0.12 : 0 });
      }
      if (accLabelEl) accLabelEl.textContent = hasAcc ? `±${Math.round(acc)} m` : "";
      setTimeout(() => map && map.invalidateSize(), 60);
    },
    invalidate() { if (map) setTimeout(() => map.invalidateSize(), 60); },
  };
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

/* ============================================================
   CONTEXT PRIORS — weight the candidate set by what's actually plausible
   here and now, so the matcher gently prefers likely species over rare
   look-alikes. Two signals:
     • national frequency — bundled (species/frequency-ch.json, from Swiss
       iNaturalist observation counts): always on, offline. Fixes generic
       ranking ("Achillea millefolium" ≫ "A. atrata" ≫ "A. ageratum").
     • nearby occurrence — fetched live from iNaturalist by the record's GPS
       (cached per ~cell): the sharper "seen right here" signal, when online.
   Deliberately RELAXED: a prior only NUDGES ranking (a small multiplicative
   boost used for sorting), never inflates confidence and never gates a
   species out — a rare plant you actually said is still fully findable.
   ============================================================ */
function speciesKey(name) {
  const words = (name || "").toLowerCase().replace(/[^a-z\s-]/g, " ").split(/\s+/)
    .filter(w => w && !RANK_WORDS.has(w) && w !== "x");
  return words.slice(0, 2).join(" ");
}
const PRIOR_STRENGTH = 0.28;   // relaxed: how much the prior can reorder ties
// Concentric rings (km) for the geographic prior. Broad on purpose — the far
// ring still includes regional species, they're just weighted down by
// distance. Works anywhere on Earth (iNaturalist is global); the closeness
// weight makes likelihood fall off with distance from the record.
const PRIOR_RINGS_KM = [50, 150, 400];
const PRIOR_DIST_SCALE = 120;  // higher = gentler distance falloff
function ringCloseness(km) { return Math.min(1, 1.3 / (1 + km / PRIOR_DIST_SCALE)); } // 50→0.92, 150→0.58, 400→0.30
const ContextPriors = {
  enabled: true,
  freq: null, freqLogMax: 1,          // bundled baseline commonness (by full name), offline fallback
  nearby: null,                       // { speciesKey: weight 0..1 } distance-graded, or null
  _cell: null,

  async loadFreq() {
    try {
      const r = await fetch("species/frequency-ch.json");
      const d = await r.json();
      this.freq = d.freq || {};
      const max = Object.values(this.freq).reduce((m, c) => c > m ? c : m, 1);
      this.freqLogMax = Math.log1p(max);
    } catch { this.freq = {}; }
  },

  // 0..1 prior weight for a species. The nearby (location) signal is the
  // primary, global one; the bundled baseline commonness is a weaker fallback
  // used offline / where no observations are recorded. Take the max so a
  // species that's actually near you is preferred, without ever penalising one
  // that isn't.
  weight(fullName) {
    if (!this.enabled) return 0;
    let w = 0;
    if (this.freq) {
      const c = this.freq[fullName] || 0;
      // Baseline is a gentler signal than local presence — cap its reach.
      if (c > 0) w = 0.7 * (Math.log1p(c) / this.freqLogMax);
    }
    if (this.nearby) {
      const nw = this.nearby[speciesKey(fullName)] || 0;
      if (nw > w) w = nw;
    }
    return w;
  },

  // Set the active location and (re)load the distance-graded nearby prior for
  // its cell. Coarse ~0.1° cell so small GPS jitter doesn't refetch; cached in
  // localStorage so a revisited area keeps working offline.
  async setLocation(lat, lon) {
    if (!this.enabled) return;
    if (lat == null || lon == null || lat === "" || lon === "" || isNaN(+lat) || isNaN(+lon)) return;
    const cell = (+lat).toFixed(1) + "," + (+lon).toFixed(1);
    if (cell === this._cell && this.nearby) return;
    this._cell = cell;
    const cacheKey = "isurvey.nearby." + cell;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) { this.nearby = JSON.parse(cached); return; }
    } catch { /* ignore */ }

    // Fetch each ring (closest first); a species keeps the smallest ring it
    // appears in (= nearest observation band) and the count in that band.
    const firstRing = {}; // key -> { ring: index, count }
    let any = false;
    for (let i = 0; i < PRIOR_RINGS_KM.length; i++) {
      try {
        const url = `https://api.inaturalist.org/v1/observations/species_counts?lat=${+lat}&lng=${+lon}&radius=${PRIOR_RINGS_KM[i]}&iconic_taxa=Plantae&per_page=500`;
        const r = await fetch(url);
        if (!r.ok) continue;
        const d = await r.json();
        for (const res of d.results || []) {
          const nm = res.taxon && res.taxon.name;
          if (!nm) continue;
          const k = speciesKey(nm);
          if (k && !(k in firstRing)) { firstRing[k] = { ring: i, count: res.count || 0 }; any = true; }
        }
      } catch { /* skip this ring */ }
    }
    if (!any) return; // offline / API down — baseline frequency still applies

    // Convert to a 0..1 weight: closeness (inverse distance) × a mild
    // local-abundance factor.
    let logMax = 0;
    for (const k in firstRing) { const l = Math.log1p(firstRing[k].count); if (l > logMax) logMax = l; }
    logMax = logMax || 1;
    const map = {};
    for (const k in firstRing) {
      const { ring, count } = firstRing[k];
      const cf = 0.55 + 0.45 * (Math.log1p(count) / logMax);
      map[k] = +(ringCloseness(PRIOR_RINGS_KM[ring]) * cf).toFixed(4);
    }
    this.nearby = map;
    try { localStorage.setItem(cacheKey, JSON.stringify(map)); } catch { /* quota */ }
  },
};

/* ============================================================
   TypoCH — Swiss habitat typology (Delarze, Gonseth, Eggenberg & Vust 2015,
   "Lebensräume der Schweiz"). Bundled from InfoFlora's TypoCH species-list
   export (species/typoch-ch.json): the habitat hierarchy plus, for each
   species, the habitats it is a character species of. Powers "habitat
   analysis from a species list" — rank the habitats whose character species
   are present in a relevé. Only loaded/offered when the Swiss checklist is
   active. See scripts/build_typoch.py.
   ============================================================ */
const TypoCH = {
  habitats: null, byId: null, byKey: null, loaded: false, loading: null,

  async load() {
    if (this.loaded || this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const r = await fetch("species/typoch-ch.json");
        const d = await r.json();
        this.habitats = d.habitats;
        this.byId = {};
        for (const h of d.habitats) this.byId[h.id] = h;
        // Index associations by species-key (genus+epithet) so a relevé's
        // subspecies/aggregate still finds its species' habitats.
        this.byKey = {};
        for (const name in d.species) {
          const k = speciesKey(name);
          if (!this.byKey[k]) this.byKey[k] = d.species[name];
        }
        this.loaded = true;
      } catch { this.habitats = null; }
    })();
    try { await this.loading; } finally { this.loading = null; }
  },
  available() { return this.loaded && !!this.habitats; },
  name(h) {
    if (!h) return "";
    const l = (navigator.language || "").slice(0, 2);
    return h[l] || h.de || h.fr || h.it || h.id;
  },

  // Rank habitats by the official TypoCH "Lebensraumanalyse" score. Each
  // recorded character species contributes to every habitat it characterises:
  //
  //   ScoreLE = ΣK + 2·Σdom_K + 4·ΣC + 8·Σdom_C
  //
  // where K = ordinary character species (weight 1), C = characteristic
  // species (weight 4, italic/"Charakterart" in Delarze et al. 2015), and the
  // weight is doubled for a taxon that is BOTH recorded co-dominant in the plot
  // (cover ≥ threshold) AND expected co-dominant for that habitat (the `d`
  // flag, bold in the reference work). Without cover data it reduces to the
  // simple ΣK + 4·ΣC. Source: Documenta InfoFlora, "Anleitung für die
  // TypoCH-Lebensraumanalyse mit Artenlisten" (2024), Abb. 7–8.
  //
  // `items` is the relevé's species array ({taxon, cover}); a plain array of
  // name strings also works (treated as no cover, so no doubling).
  analyze(items, limit, coverScale) {
    if (!this.available()) return [];
    const score = new Map(), support = new Map();
    for (const it of items || []) {
      const name = typeof it === "string" ? it : it.taxon;
      const assocs = this.byKey[speciesKey(name)];
      if (!assocs) continue;
      const codom = typeof it === "string" ? false : isCoDominant(it.cover, coverScale);
      for (const e of assocs) {
        let w = e.c ? 4 : 1;
        const doubled = codom && !!e.d;
        if (doubled) w *= 2;
        score.set(e.id, (score.get(e.id) || 0) + w);
        if (!support.has(e.id)) support.set(e.id, []);
        support.get(e.id).push({ taxon: name, c: !!e.c, doubled });
      }
    }
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit || 6)
      .map(([id, s]) => ({ hab: this.byId[id], score: s, support: support.get(id) }))
      .filter(x => x.hab);
  },
};

// TypoCH treats a taxon as co-dominant when its recorded cover reaches the
// threshold: Braun-Blanquet class ≥ 2 (values 2/2m/2a/2b/3/4/5), or > 10 % for
// percentage cover (the guide's rule of thumb). Below that, no dominance bonus.
function isCoDominant(cover, scale) {
  const v = (cover == null ? "" : String(cover)).trim();
  if (!v) return false;
  if (scale === "pct") { const n = parseFloat(v); return isFinite(n) && n > 10; }
  const d = parseInt(v[0], 10); // "2m"/"2a"/"2b" → 2; "+"/"r" → NaN
  return isFinite(d) && d >= 2;
}

/* Latin/scientific-name-tuned phonetic code — not a strict Metaphone port,
   a consonant-skeleton reduction that is deliberately *accent-invariant*, so
   the same Latin word lands on the same code whether an English, Italian,
   German or French speaker said it (and however the recognizer then spelt it).
   The key moves: normalize digraphs (ph→f, ch→k, sch→s, gn→n, qu→k …); drop
   silent-across-accents h; map w→v, j→i/s, y→i; and — the accent lever —
   merge voiced/unvoiced consonant pairs (v/f, b/p, d/t, g/k, z/s), since which
   member a speaker uses is exactly what varies by accent (German "fulgaris"
   for "vulgaris", "brunella" for "prunella", etc.). Validated against a
   battery of real mishearings to lift accent-match margins without collapsing
   distinct near-neighbour species together. */
function phoneticCode(word) {
  let w = (word || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w
    .replace(/sch/g, "s").replace(/sh/g, "s")
    .replace(/ph/g, "f").replace(/th/g, "t").replace(/rh/g, "r").replace(/gh/g, "g")
    .replace(/ch/g, "k").replace(/ck/g, "k")
    .replace(/qu/g, "k").replace(/q/g, "k")
    .replace(/x/g, "ks").replace(/gn/g, "n")
    .replace(/ae|oe/g, "e")
    .replace(/y/g, "i").replace(/j/g, "i").replace(/w/g, "v").replace(/h/g, "")
    .replace(/c(?=[ei])/g, "s").replace(/g(?=[ei])/g, "j").replace(/c/g, "k")
    // voiced/unvoiced merges — accent voicing invariance
    .replace(/[vf]/g, "f").replace(/[bp]/g, "p").replace(/[dt]/g, "t")
    .replace(/[gk]/g, "k").replace(/[zs]/g, "s").replace(/j/g, "s")
    .replace(/([a-z])\1+/g, "$1");
  const first = w[0];
  const rest = w.slice(1).replace(/[aeiou]/g, "").replace(/([a-z])\1+/g, "$1");
  return (first + rest).slice(0, 10);
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
function scoreTaxonAgainstWords(sp, words, phon, qConcat, qConcatPhon) {
  ensureSpeciesIndexed(sp);
  // The whole-string blob of the query is identical for every taxon a given
  // window/phrase is scored against, so callers in hot loops (the segmenter's
  // DP, fuzzyMatchTranscripts) precompute it once and pass it in; fall back to
  // computing it here for any caller that doesn't.
  const concat = qConcat !== undefined ? qConcat : words.join("");
  const concatPhon = qConcatPhon !== undefined ? qConcatPhon : phoneticCode(concat);

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

  const charSim = strSim(concat, sp._concat);
  const phonSim = strSim(concatPhon, sp._concatPhon);
  const lenDiff = Math.abs(concat.length - sp._concat.length) / Math.max(concat.length, sp._concat.length, 1);
  const lenPenalty = 1 - Math.min(0.3, lenDiff * 0.6);
  const wholeScore = (charSim * 0.5 + phonSim * 0.5) * lenPenalty;

  return Math.max(wordAlignScore, wholeScore);
}

/* Candidate-narrowing index for the hot matching loops: taxa bucketed by the
   possible first *sounds* of their genus, so a window is scored against just
   the relevant buckets (~a few hundred taxa) instead of all ~4200.

   The onset is deliberately fuzzy because the very first sound is where
   recognizers and accents diverge most: soft vs. hard C (Cynosurus heard
   "kynosurus"), silent K (Knautia heard "nautia"), silent G/P (Gnaphalium,
   Psilurus), x→"s", w→"v", y→"i". Each genus is filed under *every* plausible
   onset key, and a query is looked up under its own onset keys — as long as
   the two sets intersect the true genus is found, so the pruning stays lossless
   on the accent battery while keeping the buckets small. */
function onsetKeys(word) {
  const w = (word || "").toLowerCase();
  const keys = new Set();
  if (!w) return keys;
  const p = phoneticCode(w);
  if (p) keys.add(p[0]);
  const a = w[0], b = w[1];
  keys.add(a);
  if (a === "c") { keys.add("k"); keys.add("s"); }           // soft/hard C
  if (a === "k") { keys.add("k"); if (b === "n") keys.add("n"); } // silent K (knautia)
  if (a === "g" && b === "n") keys.add("n");                  // silent G (gnaphalium)
  if (a === "p" && (b === "s" || b === "t")) keys.add("s");   // silent P (psilurus, ptelea)
  if (a === "x") keys.add("s");
  if (a === "w") { keys.add("v"); keys.add("f"); }
  if (a === "y") keys.add("i");
  if (a === "z") keys.add("s");
  if (a === "h") keys.add("");                                 // silent/aspirated H
  return keys;
}
function genusPhonBuckets() {
  if (Species._genusBuckets) return Species._genusBuckets;
  const m = new Map();
  for (const sp of Species.all) {
    ensureSpeciesIndexed(sp);
    for (const k of onsetKeys(sp._words[0])) {
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(sp);
    }
  }
  Species._genusBuckets = m;
  return m;
}
// Union of the buckets a query's first spoken word could plausibly point at.
function genusCandidates(firstWord) {
  const buckets = genusPhonBuckets();
  const keys = onsetKeys(firstWord);
  if (keys.size <= 1) { const k = [...keys][0] || ""; return buckets.get(k) || []; }
  const seen = new Set();
  for (const k of keys) { const b = buckets.get(k); if (b) for (const sp of b) seen.add(sp); }
  return [...seen];
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
  // Precompute the query blob once for the whole window (not per taxon).
  const qConcat = words.join("");
  const qConcatPhon = phoneticCode(qConcat);
  // Only taxa whose genus could start with the window's first spoken word are
  // scored. A window whose first sound matches no genus (junk/filler) yields no
  // candidates and correctly contributes no segment.
  const candidates = genusCandidates(words[0]);
  let best = null, second = null;
  for (const sp of candidates) {
    const raw = scoreTaxonAgainstWords(sp, words, phon, qConcat, qConcatPhon);
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
  // Precompute each query's whole-string blob once, and gather the genus
  // buckets its first sound points at, so only plausible taxa are scored
  // instead of the whole checklist.
  const candidates = new Set();
  for (const q of qSets) {
    q.concat = q.words.join("");
    q.concatPhon = phoneticCode(q.concat);
    for (const sp of genusCandidates(q.words[0])) candidates.add(sp);
  }

  const scored = [];
  for (const sp of candidates) {
    let best = 0;
    for (const q of qSets) {
      const score = scoreTaxonAgainstWords(sp, q.words, q.phon, q.concat, q.concatPhon);
      if (score > best) best = score;
    }
    if (best > 0.15) {
      // Context prior nudges the SORT key only — the reported .score stays the
      // honest acoustic/text match (so confidence/auto-fill isn't inflated by
      // "this species is common"), while a likelier species is surfaced first
      // among otherwise-comparable candidates.
      const rank = best * (1 + PRIOR_STRENGTH * ContextPriors.weight(sp.t));
      scored.push({ sp, score: best, rank });
    }
  }
  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit);
}

/* ---- genus-then-epithet matching (for the two-step guided dictation) ------
   Saying a long binomial in one breath is the hard case for any recognizer;
   said as two short pieces — genus, pause, epithet — each is far easier to
   get right. These helpers match each piece independently: the genus against
   the list of distinct genera, then the epithet against ONLY the species of
   that genus, so the search space for the second half is a handful of names
   instead of 4,000. */
let _generaIndex = null;
function generaIndex() {
  if (_generaIndex) return _generaIndex;
  const m = new Map();
  for (const sp of Species.all) {
    const g = sp.t.split(/\s+/)[0];
    const key = g.toLowerCase();
    if (!m.has(key)) m.set(key, { genus: g, phon: phoneticCode(key) });
  }
  _generaIndex = [...m.values()];
  return _generaIndex;
}
function matchGenus(transcripts, limit) {
  limit = limit || 5;
  const qSets = transcripts.map(tokenize).filter(q => q.words.length);
  if (!qSets.length) return [];
  const scored = [];
  for (const { genus, phon: gp } of generaIndex()) {
    const gw = genus.toLowerCase();
    let best = 0;
    for (const q of qSets) {
      for (let i = 0; i < q.words.length; i++) {
        const s = wordScore(q.words[i], gw, q.phon[i], gp);
        if (s > best) best = s;
      }
      const concat = q.words.join(""), cp = phoneticCode(concat);
      const blob = 0.5 * strSim(concat, gw) + 0.5 * strSim(cp, gp);
      if (blob > best) best = blob;
    }
    if (best > 0.3) scored.push({ genus, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
// Score the spoken epithet against one species' epithet words only (the genus
// is already known), so an unspoken genus isn't penalised.
function scoreEpithet(sp, words, phon) {
  ensureSpeciesIndexed(sp);
  const ew = sp._words.slice(1).filter(w => !RANK_WORDS.has(w));
  if (!ew.length) return 0;
  const ep = ew.map(phoneticCode);
  let wi = 0, total = 0;
  for (let i = 0; i < words.length; i++) {
    let b = 0, bj = -1;
    for (let j = wi; j < ew.length; j++) { const s = wordScore(words[i], ew[j], phon[i], ep[j]); if (s > b) { b = s; bj = j; } }
    total += b; if (bj >= 0) wi = bj + 1;
  }
  const align = total / Math.max(words.length, ew.length);
  const concat = words.join(""), cp = phoneticCode(concat);
  const et = ew.join(""), etp = phoneticCode(et);
  const blob = 0.5 * strSim(concat, et) + 0.5 * strSim(cp, etp);
  return Math.max(align, blob);
}
function matchWithinGenus(genus, transcripts, limit) {
  limit = limit || 6;
  const gl = genus.toLowerCase();
  const qSets = transcripts.map(tokenize).filter(q => q.words.length);
  const scored = [];
  for (const sp of Species.all) {
    if (sp.t.toLowerCase().split(/\s+/)[0] !== gl) continue;
    let best = 0;
    for (const q of qSets) { const s = scoreEpithet(sp, q.words, q.phon); if (s > best) best = s; }
    scored.push({ sp, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
function generaSpecies(genus, limit) {
  const gl = genus.toLowerCase();
  return Species.all.filter(sp => sp.t.toLowerCase().split(/\s+/)[0] === gl).slice(0, limit || 8).map(sp => ({ sp, score: 1 }));
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
/* Floor for accepting a match as a species at all. Measured on this checklist:
   genuinely-spoken names — including heavily accented mis-transcriptions like
   "brunella fulgaris" / "tactilis klomerata" — score 0.75–1.00, while ordinary
   field conversation ("stop recording now", "did you write that down") tops out
   around 0.58. A floor of 0.62 sits in that gap, so chatter no longer maps onto
   a wrong species while every genuine utterance still lands. */
const VOICE_LOW_CONF = 0.62;
/* At/above this the transcript is effectively the taxon name itself, so it's
   accepted without the runner-up margin test below — otherwise a perfectly
   spoken name with a near-twin in the checklist (repens vs. rubens) would be
   needlessly flagged every single time. */
const VOICE_EXACT_CONF = 0.97;
const VOICE_MAX_RETRIES = 3;

/* Everyday function words never occur in a Latin binomial, so their presence
   marks an utterance as conversation rather than a species call. Used only to
   gate the "record it as typed" fallback — a confident species match is always
   kept, whatever else was said around it. */
const CHATTER_WORDS = new Set(["a","an","the","and","or","but","if","is","it","its","this","that","these","those",
  "you","your","we","our","us","i","me","my","he","she","they","them","to","of","in","on","at","for","with","from",
  "by","not","no","yes","yeah","yep","nope","okay","ok","so","just","now","then","here","there","what","when","where",
  "how","why","who","can","could","would","should","will","shall","do","does","did","done","have","has","had","be",
  "been","was","were","am","are","get","got","go","going","gone","let","lets","next","last","stop","start","again",
  "please","thanks","thank","sorry","hold","wait","see","look","think","know","say","said","up","down","out","over",
  "very","really","much","more","most","some","any","all","one","two","three","right","left","back","over","about",
  // filler / disfluency sounds a recognizer emits for throat-clearing and hesitation
  "mm","hmm","hm","mhm","uh","um","uhm","er","erm","ah","eh","oh","huh","hey"]);
function looksLikeSpeciesName(text) {
  const words = (text || "").toLowerCase().replace(/[^a-zà-ÿ\s.-]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  if (words.some(w => CHATTER_WORDS.has(w.replace(/\.$/, "")))) return false;
  // Every real taxon name has at least one substantial word (shortest genus in
  // the checklist is 3 letters, but those match the checklist directly and never
  // reach this fallback) — so a string of tiny tokens is noise, not a name.
  return words.some(w => w.replace(/\.$/, "").length >= 4);
}

// Records via WhisperVoice, transcribes, narrows candidates with the same
// text fuzzy-matcher used for Web Speech results, then rescores that
// shortlist directly against the recorded audio. Auto-fills the top match
// and always also shows it (plus runners-up) as a tap-to-pick list, since
// these are raw log-likelihoods rather than the 0–1 confidence scale the
// Web Speech path calibrates its auto-fill threshold against.
async function runAiDictation(inputEl, menuEl, setStatus, onPick) {
  setStatus("Transcribing…");
  try {
    const blob = await AiVoice._pendingRecording;
    AiVoice._pendingRecording = null;
    const pcm = await AiVoice.mod.blobToPCM16k(blob);
    const { transcript, hypotheses, encoderHandle } = await AiVoice.mod.transcribeAudio(pcm);
    if (!transcript || transcript.length < 2) { setStatus("Didn't catch that — type it instead."); return; }
    // Larger shortlist than the walking path — a one-off lookup can afford the
    // extra rescoring passes for maximum recall.
    const result0 = await aiRankUtterance(hypotheses, encoderHandle, 30);
    if (!result0) {
      inputEl.value = transcript;
      inputEl.dispatchEvent(new Event("input"));
      inputEl.focus();
      setStatus(`Heard "${transcript}" — not in the checklist, typed as-is`);
      return;
    }
    const top = result0.ranked[0].sp;
    inputEl.value = top.t;
    inputEl.dispatchEvent(new Event("input"));
    inputEl.focus();
    setStatus(`Heard "${transcript}" → ${top.t}`);
    // Always also show the top few as a tap-to-pick list — audio matching is
    // strong but not infallible on near-homophone names, and one tap to the
    // runner-up is faster than retyping.
    const menuMatches = result0.ranked.slice(0, 5).map(r => ({ sp: r.sp, score: r.final }));
    renderVoiceCandidates(menuEl, menuMatches, sp => { onPick(sp); setStatus(""); });
  } catch (e) {
    console.error(e);
    setStatus("AI voice matching failed: " + (e.message || e));
  }
}

// The device (Web Speech) recognizer transcribes accented Latin far better
// when told the speaker's actual language, so the one voice-language setting
// drives BOTH this path and the AI one. Web Speech takes a single BCP-47 tag
// per session (it can't multiplex languages), so "multilingual" — an AI-only
// capability — falls back to the device's own locale here.
const SPEECH_LANG_TAGS = { en: "en-US", it: "it-IT", de: "de-DE", fr: "fr-FR" };

// One-shot device recognition: start listening, resolve with the engine's
// alternative transcripts on the first result (or [] on silence/timeout).
// Used by the two-step guided flow, which needs to await one utterance,
// process it, then await the next.
function recognizeOnceWebSpeech(lang) {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { reject(new Error("speech recognition not available")); return; }
    const rec = new SR();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = SPEECH_MAX_ALTERNATIVES;
    let settled = false;
    rec.addEventListener("result", e => { if (!settled) { settled = true; resolve(Array.from(e.results[0]).map(a => a.transcript)); } });
    rec.addEventListener("error", e => { if (!settled) { settled = true; if (e.error === "no-speech" || e.error === "aborted") resolve([]); else reject(new Error(e.error || "speech error")); } });
    rec.addEventListener("end", () => { if (!settled) { settled = true; resolve([]); } });
    try { rec.start(); } catch (err) { if (!settled) { settled = true; reject(err); } }
  });
}

// Guided two-step dictation: say the genus, then the epithet. Each half is a
// short, low-ambiguity utterance, and the epithet is matched only within the
// recognised genus — much more reliable than one long binomial for hard names
// or strong accents. Uses the device recognizer (the stronger one) in the
// language chosen in Settings.
async function twoStepDictation(inputEl, menuEl, setStatus, onPick, btn) {
  const settings = await Store.getSettings();
  const lang = deviceSpeechLang(settings);
  if (btn) btn.classList.add("listening");
  const finish = () => { if (btn) btn.classList.remove("listening"); };
  try {
    setStatus("Step 1 — say the genus…");
    const gWords = await recognizeOnceWebSpeech(lang);
    if (!gWords.length) { setStatus("Didn't catch the genus — tap to try again."); finish(); return; }
    const genera = matchGenus(gWords, 5);
    if (!genera.length) { setStatus(`Heard "${gWords[0]}" — no matching genus. Tap to retry.`); finish(); return; }
    const genus = genera[0].genus;

    setStatus(`Genus: ${genus} — step 2, say the species…`);
    await new Promise(r => setTimeout(r, 350)); // brief gap before re-listening
    const eWords = await recognizeOnceWebSpeech(lang);
    finish();
    if (!eWords.length) {
      // No epithet heard — offer the genus's species to tap instead.
      renderVoiceCandidates(menuEl, generaSpecies(genus, 8), sp => { onPick(sp); setStatus(""); });
      setStatus(`Genus ${genus} — pick the species:`);
      return;
    }
    const matches = matchWithinGenus(genus, eWords, 6).filter(m => m.score > 0.2);
    if (!matches.length) {
      renderVoiceCandidates(menuEl, generaSpecies(genus, 8), sp => { onPick(sp); setStatus(""); });
      setStatus(`Heard "${eWords[0]}" — pick a ${genus} species:`);
      return;
    }
    const top = matches[0].sp;
    inputEl.value = top.t;
    inputEl.dispatchEvent(new Event("input"));
    inputEl.focus();
    setStatus(`${genus} → ${top.t}`);
    renderVoiceCandidates(menuEl, matches.slice(0, 5), sp => { onPick(sp); setStatus(""); });
  } catch (e) {
    finish();
    console.error(e);
    setStatus("Two-step dictation failed: " + (e.message || e));
  }
}

function deviceSpeechLang(settings) {
  return SPEECH_LANG_TAGS[settings && settings.aiVoiceLang] || navigator.language || "en-US";
}
// More alternatives = more chances the strong matcher finds the true name
// behind the recognizer's language-model "snap" to common words.
const SPEECH_MAX_ALTERNATIVES = 12;

function wireDictation(btn, inputEl, menuEl, statusEl, onPick) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  btn.hidden = false;
  const rec = new SR();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = SPEECH_MAX_ALTERNATIVES;
  let listening = false;
  let retries = 0;
  let manualStop = false;
  let aiRecording = false;

  function setStatus(text) { if (statusEl) statusEl.textContent = text || ""; }
  function startListening() { try { rec.start(); } catch (e) { /* already running */ } }

  btn.addEventListener("click", async () => {
    const settings = await Store.getSettings();
    if (settings.aiVoiceEnabled && AiVoice.mod && AiVoice.mod.isLoaded()) {
      if (aiRecording) {
        aiRecording = false;
        btn.classList.remove("listening");
        AiVoice.mod.stopRecording();
        await runAiDictation(inputEl, menuEl, setStatus, onPick);
      } else {
        try {
          AiVoice._pendingRecording = AiVoice.mod.startRecording();
          aiRecording = true;
          btn.classList.add("listening");
          setStatus("Recording — tap again when done…");
        } catch (e) {
          setStatus("Microphone access failed: " + (e.message || e));
        }
      }
      return;
    }
    if (listening) { manualStop = true; rec.stop(); setStatus(""); return; }
    retries = 0;
    manualStop = false;
    rec.lang = deviceSpeechLang(settings);
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

    if (top && (top.score >= VOICE_EXACT_CONF || (top.score >= VOICE_HIGH_CONF && (!second || top.score - second.score >= 0.12)))) {
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

// --- AI candidate ranking (shared by single-field dictation and continuous
// voice logging). The accuracy of the whole feature rides on this: rather
// than trusting the transcript's TEXT, it (1) builds a generous text shortlist
// (phonetic + fuzzy) from the transcript so the true name is very likely to be
// somewhere in it, (2) rescores that shortlist directly against the recorded
// AUDIO — asking the model how well the recording matches each exact name —
// and (3) blends the acoustic score with the text score so the final pick has
// to satisfy BOTH the recording and the spelling, which kills most of the
// near-homophone confusions a text-only or audio-only pick makes on its own.
const AI_BLEND_ACOUSTIC = 0.65;   // audio is the primary signal
const AI_BLEND_TEXT = 0.35;       // spelling as a sanity check / tiebreak
const AI_ACOUSTIC_TEMP = 0.4;     // sharpness of acoustic→[0,1] normalisation

async function aiRankUtterance(hypotheses, encoderHandle, shortlistSize) {
  // fuzzyMatchTranscripts keeps the best text score per taxon across every
  // string handed to it (one today; ready for several if multi-hypothesis
  // decoding returns).
  const shortlist = fuzzyMatchTranscripts(hypotheses, shortlistSize);
  if (!shortlist.length) return null;
  const spByText = new Map(shortlist.map(m => [m.sp.t, m.sp]));
  const textScore = new Map(shortlist.map(m => [m.sp.t, m.score]));
  const acoustic = await AiVoice.mod.rescoreCandidates(encoderHandle, [...spByText.keys()]);
  const maxA = acoustic[0].score; // rescoreCandidates returns sorted desc
  const ranked = acoustic.map(a => {
    const aNorm = Math.exp((a.score - maxA) / AI_ACOUSTIC_TEMP); // winner = 1
    const text = textScore.get(a.text) || 0;
    return { sp: spByText.get(a.text), acoustic: a.score, text, final: AI_BLEND_ACOUSTIC * aNorm + AI_BLEND_TEXT * text };
  });
  ranked.sort((x, y) => y.final - x.final);
  const margin = ranked[1] ? ranked[0].final - ranked[1].final : null;
  return { ranked, margin };
}

// Blended-margin → 0–1 confidence on the same scale addSpecies()/the
// certainty-pill UI expect. A clear winner that both signals agree on lands
// above VOICE_HIGH_CONF; a close call sits below it and is flagged to confirm.
function aiConfidence(topFinal, margin) {
  const clarity = margin == null ? 1 : Math.min(1, margin / 0.35);
  return Math.max(0, Math.min(0.98, 0.5 * topFinal + 0.5 * clarity));
}

// Handles one VAD-captured utterance in AI voice-logging mode: transcribe,
// shortlist via the text fuzzy-matcher, rescore that shortlist against the
// audio, then feed the winner through the same addSpecies()/checkpoint/
// spoken-feedback contract the Web Speech path below uses — so both paths
// look identical from the editor's point of view.
async function handleAiVoiceSegment(blob, addSpecies, setStatus, speakFeedback) {
  try {
    const pcm = await AiVoice.mod.blobToPCM16k(blob);
    const { transcript, hypotheses, encoderHandle } = await AiVoice.mod.transcribeAudio(pcm);
    const heard = (transcript || "").trim();
    if (heard.length < 3) return; // breath/noise while walking — not worth interrupting for
    if (!looksLikeSpeciesName(heard)) return; // conversation, not a species call

    // Shortlist kept smaller here (vs. dictation's larger list) because each
    // candidate costs its own decoder pass and this runs mid-walk where
    // latency matters more; the base model's transcript is usually good
    // enough that the true name sits near the top of the text shortlist.
    const result0 = await aiRankUtterance(hypotheses, encoderHandle, 18);
    if (!result0) {
      const sp = { t: heard.charAt(0).toUpperCase() + heard.slice(1), f: "", freeText: true };
      const result = await addSpecies(sp, { unconfirmed: true, silent: true });
      if (result && result.added !== false) {
        setStatus(`Added as typed (not in checklist): ${sp.t} — please review`);
        if (speakFeedback) speak(`Added ${sp.t}. Not in the checklist, please review.`);
        if (result.checkpoint) {
          toast(`${result.checkpoint} taxa logged — review when ready`);
          if (speakFeedback) speak(`${result.checkpoint} species logged. Review when you're ready.`);
        }
      } else {
        setStatus(`Already logged: ${sp.t}`);
      }
      return;
    }

    const certainty = aiConfidence(result0.ranked[0].final, result0.margin);
    const confident = certainty >= VOICE_HIGH_CONF;
    const sp = result0.ranked[0].sp;

    const result = await addSpecies(sp, { unconfirmed: !confident, score: certainty, silent: true });
    if (!result || result.added === false) { setStatus(`Already logged: ${sp.t}`); return; }
    setStatus(`Heard "${heard}" → ${sp.t}${confident ? "" : " (please confirm)"}`);
    if (speakFeedback) speak(confident ? sp.t : `${sp.t}, please confirm`);
    if (result.checkpoint) {
      toast(`${result.checkpoint} taxa logged — review when ready`);
      if (speakFeedback) speak(`${result.checkpoint} species logged. Review when you're ready.`);
    }
  } catch (e) {
    console.error(e);
    setStatus("AI voice matching error: " + (e.message || e));
  }
}

function wireVoiceLogging(btn, statusEl, viewName, addSpecies) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  btn.hidden = false;
  const rec = new SR();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = SPEECH_MAX_ALTERNATIVES;
  // Deliberately NOT continuous: Chrome's continuous mode batches speech
  // into fewer, longer results with looser endpointing, which is exactly
  // what causes several species said in sequence to get glued into one
  // recognized phrase. Restarting a single-shot session immediately after
  // each result (below) gives the same tight per-utterance segmentation
  // that makes the single-field dictation accurate, while still being
  // hands-free — the gap between stop and restart is a few milliseconds.

  let active = false;    // user has toggled logging on
  let running = false;   // a recognition session is currently alive
  let speakFeedback = true;

  // AI mode: VAD-segmented continuous capture instead of the Web Speech API.
  // Segments can arrive faster than one finishes processing (they keep
  // being captured while a previous one is still transcribing/rescoring),
  // so they're queued and drained one at a time — the underlying ONNX
  // Runtime sessions aren't safe to call concurrently with themselves.
  let aiMode = false;
  let aiStop = null;
  const aiQueue = [];
  let aiDraining = false;
  async function drainAiQueue() {
    if (aiDraining) return;
    aiDraining = true;
    while (aiQueue.length) await handleAiVoiceSegment(aiQueue.shift(), addSpecies, setStatus, speakFeedback);
    aiDraining = false;
  }

  function setStatus(t) { if (statusEl) statusEl.textContent = t || ""; }
  function setBtnState() {
    btn.classList.toggle("listening", active);
    setBtnLabel(btn, active ? "Stop voice logging" : "Start voice logging");
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
    if (aiMode) {
      aiMode = false;
      if (aiStop) { aiStop(); aiStop = null; }
      aiQueue.length = 0;
      return;
    }
    try { rec.stop(); } catch (e) { /* not running */ }
  }
  addLeaveHook(viewName, stopLogging);

  btn.addEventListener("click", async () => {
    if (active) { stopLogging(); return; }
    const settings = await Store.getSettings();
    speakFeedback = settings.voiceSpeakFeedback !== false;
    if (settings.aiVoiceEnabled && AiVoice.mod && AiVoice.mod.isLoaded()) {
      try {
        aiStop = await AiVoice.mod.startContinuousCapture(blob => { aiQueue.push(blob); drainAiQueue(); });
      } catch (e) {
        setStatus("Microphone access failed: " + (e.message || e));
        return;
      }
      active = true;
      aiMode = true;
      setBtnState();
      setStatus("Listening (AI) — say each species as you spot it…");
      return;
    }
    active = true;
    rec.lang = deviceSpeechLang(settings);
    setBtnState();
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
      const heard = (transcripts[0] || "").trim();
      // A few characters is more likely a stray noise/breath than an
      // attempted name — not worth recording or interrupting for.
      if (heard.length < 4) return;
      // Nothing in the checklist came close AND it reads like ordinary talk
      // ("did you write that down") rather than a name — that's a conversation
      // picked up mid-walk, so stay quiet instead of logging junk to review.
      if (!looksLikeSpeciesName(heard)) return;
      // Otherwise trust that a real (if unlisted) species was said —
      // record it as typed rather than fighting the speaker; it's
      // flagged for review same as any other low-confidence entry.
      const sp = { t: heard.charAt(0).toUpperCase() + heard.slice(1), f: "", freeText: true };
      const result = await addSpecies(sp, { unconfirmed: true, silent: true });
      if (result && result.added !== false) {
        setStatus(`Added as typed (not in checklist): ${sp.t} — please review`);
        if (speakFeedback) speak(`Added ${sp.t}. Not in the checklist, please review.`);
        if (result.checkpoint) {
          toast(`${result.checkpoint} taxa logged — review when ready`);
          if (speakFeedback) speak(`${result.checkpoint} species logged. Review when you're ready.`);
        }
      } else {
        setStatus(`Already logged: ${sp.t}`);
      }
      return;
    }

    const addedNames = [], unsureNames = [];
    let lastCheckpoint = null;
    for (const seg of usable) {
      const confident = seg.score >= VOICE_EXACT_CONF
        || (seg.score >= VOICE_HIGH_CONF && (seg.score - (seg.second || 0) >= 0.12));
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
   INFO MODAL (generic — used by the cover-method picker)
   ============================================================ */

function openInfoModal(title, html) {
  $("#infoModalTitle").textContent = title;
  $("#infoModalBody").innerHTML = html;
  $("#infoModal").hidden = false;
}
function closeInfoModal() { $("#infoModal").hidden = true; }
function wireInfoModal() {
  $("#infoModalClose").addEventListener("click", closeInfoModal);
  $("#infoModal").addEventListener("click", e => { if (e.target.id === "infoModal") closeInfoModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#infoModal").hidden) closeInfoModal(); });
  // One delegated handler for every inline "i" dot in the app. stopPropagation
  // + preventDefault so a dot nested inside a button (GPS/voice) or a <summary>
  // opens its help instead of triggering that control or toggling the fold.
  const openDotTopic = dot => {
    const topic = INFO_TOPICS[dot.getAttribute("data-info")];
    if (topic) openInfoModal(topic.title, topic.html);
  };
  // Capture phase (third arg true) so this runs BEFORE the click reaches the
  // enclosing button/summary's own bubbling handler — otherwise stopPropagation
  // is too late and tapping a dot inside e.g. the GPS or two-step button would
  // ALSO fire that button. stopImmediatePropagation prevents the host control.
  document.addEventListener("click", e => {
    const dot = e.target.closest && e.target.closest(".info-dot[data-info]");
    if (!dot) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    openDotTopic(dot);
  }, true);
  // The dots are spans with role=button (so they can nest legally inside real
  // buttons/summaries) — wire keyboard activation to match a real button.
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const dot = e.target.closest && e.target.closest(".info-dot[data-info]");
    if (!dot) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    openDotTopic(dot);
  }, true);
}

/* Inline-help content for the (i) dots scattered through the editors. Kept
   here as one registry so the same explanation is reused everywhere a concept
   appears, and so the wording lives next to the code it describes. Small SVGs
   use currentColor so they follow the light/dark theme. */
const INFO_TOPICS = {
  typoch: {
    title: "Habitat analysis (TypoCH)",
    html: `
      <p>Every habitat type in the Swiss typology (TypoCH — Delarze, Gonseth,
      Eggenberg &amp; Vust 2015, <em>Lebensräume der Schweiz</em>) has a set of
      <strong>character species</strong>. This does the reverse: from the species
      you've recorded, it ranks the habitats whose character species are most
      present — so the vegetation itself proposes the habitat.</p>
      ${typochBarSvg()}
      <p><strong>How the score is computed.</strong> This is the official
      InfoFlora <em>Lebensraumanalyse</em> score. Each character species you
      recorded adds points to every habitat it belongs to:</p>
      ${typochScoreSvg()}
      <p>An ordinary character species scores <strong>1</strong>; a
      <em>characteristic</em> species (italic in the reference work — a stronger
      indicator) scores <strong>4</strong>. If a species is recorded
      <em>co-dominant</em> in your plot (cover ≥ Braun-Blanquet 2, or &gt; 10 %)
      <em>and</em> the habitat expects it to be dominant, its points double
      (1→2, 4→8). The habitat score is the sum over all your species:</p>
      <p style="text-align:center"><code>Score = ΣK + 2·Σdom&#8202;K + 4·ΣC + 8·Σdom&#8202;C</code></p>
      <p>Each suggestion shows this <strong>score</strong> and how many of your
      species support it, with its TypoCH code, alliance and EUNIS crosswalk.
      Tap one to assign it, or search the full typology by name/code.</p>
      <p>It's a decision aid, not a verdict — the top hit for a good species list
      is usually right, but confirm against the habitat on the ground.</p>
      <p class="hint">Source: Documenta InfoFlora, <em>Anleitung für die
      TypoCH-Lebensraumanalyse mit Artenlisten</em> (2024).</p>`,
  },
  contextPriors: {
    title: "Likely-species priors",
    html: `
      <p>At any spot, only a fraction of the species are actually plausible.
      When it's matching what you said, this leans toward the likely ones:</p>
      <p>• <strong>Near your location</strong> (the main signal — works anywhere
      in the world). When online with GPS, it looks up which species have been
      recorded around you via iNaturalist, across a wide area, and weights each
      by <em>how close</em> its records are — likelihood falls off with
      distance, but far-away regional species are still included, just lower.
      Cached per area, so a place you've visited keeps working offline.</p>
      ${priorDistanceSvg()}
      <p>• <strong>General commonness</strong> — a bundled fallback for when
      you're offline or a species isn't recorded nearby, so a spoken "Achillea"
      still leans to the common <em>A. millefolium</em> over rare congeners.</p>
      <p><strong>Broad and relaxed on purpose:</strong> the area is wide, not a
      tight bubble, and priors only <em>nudge the order</em> of candidates —
      they never inflate confidence and never hide a species, so a rare plant
      you genuinely said is still found.</p>`,
  },
  twoStep: {
    title: "Two-step dictation (genus → species)",
    html: `
      <p>Saying a whole binomial in one breath is the hardest thing for any
      speech engine to get right. This splits it into two short, easy pieces:</p>
      <p><strong>1.</strong> Tap the button and say just the <strong>genus</strong>
      (e.g. "Ranunculus"). It's short and distinctive, so it's recognised
      reliably.</p>
      <p><strong>2.</strong> When prompted, say just the <strong>species
      epithet</strong> (e.g. "acris"). It's matched against <em>only</em> the
      species of that genus — a handful of names instead of thousands — so even
      a rough pronunciation lands on the right one.</p>
      ${twoStepFunnelSvg()}
      <p>Great for long or unfamiliar names and for strong accents. Uses your
      chosen recognition language (Settings).</p>`,
  },
  voiceLang: {
    title: "Recognition language / accent",
    html: `
      <p>The speech engine transcribes a Latin name much more faithfully when it
      knows which language you're pronouncing it in — the same word sounds
      different from an English, Italian, German or French mouth, and telling it
      your language is the single biggest thing you can do for accuracy.</p>
      <p><strong>Set this to your own accent</strong> (Italian / German / French /
      English) if you can — it's faster and more accurate than guessing.</p>
      <p><strong>Auto / multilingual</strong>: standard dictation follows your
      device's language; the AI option (if enabled) actually listens in all four
      languages at once and keeps whichever fits best — most robust for mixed
      teams or unknown accents, but a little slower.</p>
      <p>This setting applies to <em>both</em> standard dictation and the AI
      matching option.</p>`,
  },
  voiceModes: {
    title: "Voice logging & dictation",
    html: `
      <p><strong>Two ways to add species by voice:</strong></p>
      <p>• <strong>Dictate one name</strong> — the mic button next to a search box listens for a single species, matches it, and fills it in.</p>
      <p>• <strong>Start voice logging</strong> — hands-free continuous mode for walking a plot or line: leave it on and call out each species as you spot it. Confident matches are added straight away; unsure ones are still added but flagged for you to check.</p>
      <p>Latin names are never trusted as raw text — every phrase is matched against the whole checklist by sound and spelling, so a mangled "dro sarah" still resolves to <em>Drosera</em>.</p>
      <p><strong>Near-perfect mode:</strong> turn on <em>Settings → AI-enhanced voice matching</em> to run an on-device speech model that scores the actual audio against each candidate name — markedly better on Latin names, at the cost of a few seconds per species. Standard dictation needs a connection; the AI model works offline once downloaded.</p>`,
  },
  speciesSearch: {
    title: "Adding species by typing",
    html: `
      <p>Type an <strong>abbreviation of each word</strong> — <code>dro rot</code> finds <em>Drosera rotundifolia</em>, <code>dact fuch</code> finds <em>Dactylorhiza maculata</em> subsp. <em>fuchsii</em>. Words match in order; you can skip rank markers like subsp./var.</p>
      <p>If nothing in the checklist fits (a hybrid, a "Carex sp.", your own wording), the dropdown always offers <strong>Add "…" as typed</strong> at the bottom — it's kept and flagged <em>not in checklist</em>.</p>
      <p><strong>Wrong match?</strong> Tap any species name already in the list to re-pick it from the top candidates or retype it.</p>`,
  },
  coverScale: {
    title: "Cover-abundance scales",
    html: `
      <p>How each species' abundance is recorded. Set once per plot; every species row then uses it.</p>
      <p><strong>Braun-Blanquet</strong> — the classic 7-point scale. <code>r</code> = one or few individuals, <code>+</code> = few, small cover; then <code>1–5</code> by increasing cover:</p>
      ${coverScaleSvg()}
      <p><strong>Braun-Blanquet extended</strong> — splits class 2 into <code>2m / 2a / 2b</code> for finer low-cover resolution.</p>
      <p><strong>Percentage cover</strong> — enter a direct 0–100 % estimate instead of a class. Best when you want continuous values for analysis.</p>`,
  },
  coverPctMode: {
    title: "Percentage-cover interpretation",
    html: coverPctModeInfoHtml(),
  },
  gps: {
    title: "GPS capture",
    html: `
      <p>Capture <strong>averages up to 10 satellite fixes</strong> and keeps only those at or below your accuracy threshold (<em>Settings → GPS precision threshold</em>, default 10 m), then shows the point on a small map with a shaded circle for its real accuracy:</p>
      ${gpsAccuracySvg()}
      <p>On a new record it starts automatically — fixing the location is the first thing that happens, then the section collapses so the species list takes over. Tap the button again any time to re-capture.</p>
      <p>Only the map <em>tiles</em> need a connection; your coordinates are saved locally either way.</p>`,
  },
  transectReview: {
    title: "Certainty & Review",
    html: `
      <p>Every transect entry carries a <strong>certainty score</strong>: manual picks are 100 %; voice-logged entries carry the real match confidence, shown as a coloured pill. Low-confidence entries start unreviewed.</p>
      <p><strong>Review &amp; approve</strong> lists the unreviewed ones, lowest certainty first, with one tap each to approve, swap in the right species, or discard a false catch. There's also a bulk "approve all ≥ 90 %".</p>
      <p>While voice logging you get a gentle nudge every N taxa (<em>Settings</em>) as a natural point to review — but you can review whenever suits.</p>`,
  },
  nested: {
    title: "Nested sampling",
    html: `
      <p>Optional. Records each species by the <strong>smallest sub-plot area it first appears in</strong>, to build a species-area curve — off by default; the species list works the same either way.</p>
      <p><strong>Geometry:</strong> <em>centre-out</em> grows concentric squares from one point; <em>corner-based</em> nests from two opposite plot corners (the EDGG style).</p>
      <p><strong>Area progression:</strong> the sequence of sub-plot sizes — EDGG's standard 9-step series, a classic ×4 nested-quadrat series, or your own custom list of areas.</p>
      <p>When on, each species row gains a grain-size picker (labelled by real edge length, e.g. "3.16 m" for 10 m²).</p>`,
  },
};

// Small theme-aware visuals used inside the info topics above.
function coverScaleSvg() {
  const classes = [["r", 2], ["+", 4], ["1", 10], ["2", 20], ["3", 37], ["4", 62], ["5", 87]];
  const w = 300, barW = 34, gap = 6, h = 98, base = 66;
  const bars = classes.map(([lbl, pct], i) => {
    const x = 8 + i * (barW + gap);
    const bh = Math.max(4, (pct / 100) * 52);
    return `<rect x="${x}" y="${base - bh}" width="${barW}" height="${bh}" rx="2" fill="currentColor" opacity="${0.25 + i * 0.1}"/>
      <text x="${x + barW / 2}" y="${base + 12}" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">${lbl}</text>
      <text x="${x + barW / 2}" y="${base - bh - 4}" font-size="8" fill="currentColor" text-anchor="middle" opacity="0.7">${pct}%</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:300px;height:auto;display:block;margin:6px auto">${bars}
    <text x="8" y="${base + 26}" font-size="9" fill="currentColor" opacity="0.6">approx. mid cover of each class</text></svg>`;
}
function gpsAccuracySvg() {
  return `<svg viewBox="0 0 200 120" style="width:100%;max-width:200px;height:auto;display:block;margin:6px auto">
    <circle cx="100" cy="60" r="46" fill="currentColor" opacity="0.10"/>
    <circle cx="100" cy="60" r="46" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>
    <circle cx="100" cy="60" r="5" fill="currentColor"/>
    <line x1="100" y1="60" x2="146" y2="60" stroke="currentColor" stroke-width="1" opacity="0.6"/>
    <text x="120" y="52" font-size="10" fill="currentColor" opacity="0.8">± accuracy</text>
    <text x="100" y="112" font-size="9" fill="currentColor" text-anchor="middle" opacity="0.6">point is never more precise than the circle</text>
  </svg>`;
}
function typochBarSvg() {
  const bars = [["Mesobromion", 0.95, 7], ["Xerobromion", 0.55, 5], ["Arrhenatherion", 0.3, 3]];
  const rowH = 26, w = 300, labelW = 96, barMax = 150, base = 8;
  const rows = bars.map(([lbl, frac, n], i) => {
    const y = base + i * rowH;
    return `<text x="0" y="${y + 12}" font-size="11" fill="currentColor">${lbl}</text>
      <rect x="${labelW}" y="${y + 3}" width="${(barMax * frac).toFixed(0)}" height="14" rx="3" fill="currentColor" opacity="${(0.35 + 0.5 * frac).toFixed(2)}"/>
      <text x="${labelW + barMax * frac + 6}" y="${y + 14}" font-size="10" fill="currentColor" opacity="0.75">${n} sp.</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${base * 2 + bars.length * rowH}" style="width:100%;max-width:300px;height:auto;display:block;margin:6px auto">${rows}</svg>`;
}
// The four per-species weights of the official TypoCH score, as labelled chips.
function typochScoreSvg() {
  const cells = [
    ["Character sp.", "1", 0.3], ["+ co-dominant", "2", 0.45],
    ["Characteristic", "4", 0.62], ["+ co-dominant", "8", 0.85],
  ];
  const W = 300, cw = 68, gap = 8, y = 6, h = 46;
  const cellsSvg = cells.map(([lbl, val, op], i) => {
    const x = 4 + i * (cw + gap);
    return `<rect x="${x}" y="${y}" width="${cw}" height="${h}" rx="6" fill="currentColor" opacity="${op}"/>
      <text x="${x + cw / 2}" y="${y + 22}" font-size="18" font-weight="800" fill="currentColor" text-anchor="middle">${val}</text>
      <text x="${x + cw / 2}" y="${y + 38}" font-size="8" fill="currentColor" text-anchor="middle" opacity="0.85">${lbl}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${h + 12}" style="width:100%;max-width:300px;height:auto;display:block;margin:6px auto">${cellsSvg}</svg>`;
}
// Likelihood falling off with distance from the survey point — the core idea
// behind the geographic prior (near species weighted up, far ones kept but low).
function priorDistanceSvg() {
  const W = 300, H = 120, x0 = 30, x1 = 288, y0 = 12, yB = 92;
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const x = x0 + t * (x1 - x0);
    const y = yB - (yB - y0) * Math.exp(-t * 3.2);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const rings = [[0.14, "near"], [0.42, "mid"], [0.8, "far"]].map(([t, lbl]) => {
    const x = x0 + t * (x1 - x0);
    const y = yB - (yB - y0) * Math.exp(-t * 3.2);
    return `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yB}" stroke="currentColor" stroke-width="0.7" stroke-dasharray="2 2" opacity="0.4"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="currentColor"/>
      <text x="${x.toFixed(1)}" y="${yB + 12}" font-size="9" fill="currentColor" text-anchor="middle" opacity="0.7">${lbl}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:300px;height:auto;display:block;margin:6px auto">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${yB}" stroke="currentColor" stroke-width="1" opacity="0.5"/>
    <line x1="${x0}" y1="${yB}" x2="${x1}" y2="${yB}" stroke="currentColor" stroke-width="1" opacity="0.5"/>
    <polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="2"/>
    ${rings}
    <text x="${x0 - 6}" y="${y0 + 6}" font-size="9" fill="currentColor" text-anchor="end" opacity="0.7">high</text>
    <text x="${x0 - 6}" y="${yB}" font-size="9" fill="currentColor" text-anchor="end" opacity="0.7">low</text>
    <text x="6" y="${(y0 + yB) / 2}" font-size="9" fill="currentColor" opacity="0.7" transform="rotate(-90 10 ${(y0 + yB) / 2})">likelihood</text>
    <text x="${(x0 + x1) / 2}" y="${H - 4}" font-size="9" fill="currentColor" text-anchor="middle" opacity="0.7">distance from your location →</text>
  </svg>`;
}
// The two-step idea: matching an epithet against one genus is a tiny shortlist
// versus the whole checklist.
function twoStepFunnelSvg() {
  const W = 300, rowH = 30;
  const row = (y, frac, label, op) => {
    const w = Math.max(10, (W - 120) * frac);
    return `<rect x="8" y="${y}" width="${w.toFixed(0)}" height="20" rx="3" fill="currentColor" opacity="${op}"/>
      <text x="${w + 16}" y="${y + 14}" font-size="11" fill="currentColor">${label}</text>`;
  };
  return `<svg viewBox="0 0 ${W} ${rowH * 2 + 8}" style="width:100%;max-width:300px;height:auto;display:block;margin:6px auto">
    ${row(6, 1, "~4200 names (whole checklist)", 0.22)}
    ${row(6 + rowH, 0.035, "~10 in one genus", 0.6)}
  </svg>`;
}

/* ============================================================
   COVER-ASSESSMENT METHODS
   Field-practical subset of Peratoner & Pötsch (2015), "Erhebungsmethoden
   des Pflanzenbestandes im Grünland", 20. Alpenländisches Expertenforum,
   Table 2. Stats legend: - none, + low, ++ medium, +++ high, ++++ very high.
   ============================================================ */

const COVER_METHOD_DIAGRAMS = {
  visual: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:120px;display:block;margin:0 auto">
    <path d="M50 18 Q70 4 90 18 Q70 32 50 18 Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <circle cx="70" cy="18" r="4.5" fill="currentColor"/>
    <line x1="70" y1="24" x2="70" y2="40" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 3" opacity="0.6"/>
    <rect x="20" y="44" width="100" height="42" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <path d="M28 68 Q34 56 46 60 Q56 64 50 74 Q40 80 28 76 Z" fill="currentColor" opacity="0.35"/>
    <path d="M65 80 Q70 64 84 66 Q96 68 92 80 Q80 86 65 80 Z" fill="currentColor" opacity="0.35"/>
    <path d="M96 52 Q104 48 110 54 Q108 62 100 60 Z" fill="currentColor" opacity="0.35"/>
  </svg>`,
  frame: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:120px;display:block;margin:0 auto">
    <rect x="24" y="10" width="92" height="72" fill="none" stroke="currentColor" stroke-width="2"/>
    <line x1="47" y1="10" x2="47" y2="82" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <line x1="70" y1="10" x2="70" y2="82" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <line x1="93" y1="10" x2="93" y2="82" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <line x1="24" y1="28" x2="116" y2="28" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <line x1="24" y1="46" x2="116" y2="46" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <line x1="24" y1="64" x2="116" y2="64" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <rect x="24" y="10" width="23" height="18" fill="currentColor" opacity="0.25"/>
    <rect x="70" y="28" width="23" height="18" fill="currentColor" opacity="0.25"/>
    <rect x="93" y="46" width="23" height="18" fill="currentColor" opacity="0.25"/>
    <rect x="47" y="64" width="23" height="18" fill="currentColor" opacity="0.25"/>
  </svg>`,
  point: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:120px;display:block;margin:0 auto">
    <line x1="20" y1="14" x2="20" y2="78" stroke="currentColor" stroke-width="2"/>
    <line x1="120" y1="14" x2="120" y2="78" stroke="currentColor" stroke-width="2"/>
    <line x1="20" y1="14" x2="120" y2="14" stroke="currentColor" stroke-width="2"/>
    <line x1="10" y1="78" x2="130" y2="78" stroke="currentColor" stroke-width="1.6"/>
    <line x1="30" y1="14" x2="30" y2="72" stroke="currentColor" stroke-width="1.2"/><circle cx="30" cy="72" r="2.2" fill="currentColor"/>
    <line x1="55" y1="14" x2="55" y2="64" stroke="currentColor" stroke-width="1.2"/><circle cx="55" cy="64" r="2.2" fill="currentColor"/>
    <line x1="80" y1="14" x2="80" y2="72" stroke="currentColor" stroke-width="1.2"/><circle cx="80" cy="72" r="2.2" fill="currentColor"/>
    <line x1="105" y1="14" x2="105" y2="66" stroke="currentColor" stroke-width="1.2"/><circle cx="105" cy="66" r="2.2" fill="currentColor"/>
  </svg>`,
  daget: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:120px;display:block;margin:0 auto">
    <line x1="12" y1="66" x2="128" y2="66" stroke="currentColor" stroke-width="1.6" stroke-dasharray="1 4"/>
    <line x1="20" y1="40" x2="20" y2="66" stroke="currentColor" stroke-width="1.4"/><circle cx="20" cy="66" r="2" fill="currentColor"/>
    <line x1="40" y1="48" x2="40" y2="66" stroke="currentColor" stroke-width="1.4"/><circle cx="40" cy="66" r="2" fill="currentColor"/>
    <line x1="60" y1="40" x2="60" y2="66" stroke="currentColor" stroke-width="1.4"/><circle cx="60" cy="66" r="2" fill="currentColor"/>
    <line x1="80" y1="48" x2="80" y2="66" stroke="currentColor" stroke-width="1.4"/><circle cx="80" cy="66" r="2" fill="currentColor"/>
    <line x1="100" y1="40" x2="100" y2="66" stroke="currentColor" stroke-width="1.4"/><circle cx="100" cy="66" r="2" fill="currentColor"/>
    <line x1="120" y1="48" x2="120" y2="66" stroke="currentColor" stroke-width="1.4"/><circle cx="120" cy="66" r="2" fill="currentColor"/>
    <line x1="12" y1="72" x2="128" y2="72" stroke="currentColor" stroke-width="1" opacity="0.5"/>
  </svg>`,
};

const COVER_METHODS = [
  {
    id: "visual", label: "Visual estimation",
    info: `<p>Estimate each species' percentage cover (or yield share) directly by eye, without equipment. The fastest method and the only one needing no gear at all — but the most subjective, and accuracy depends heavily on the observer's training and experience.</p>
      <p>Works best on small plots with compact, clearly distinguishable patches; harder on layered, grass-dominated stands. Flowering plants tend to get overestimated. Best practice: judge the weakest (rarest) species first — they're easier to estimate precisely — and always assess from within the plot, not from its edge.</p>
      <table class="method-stats">
        <tr><th>Captures</th><td>Cover, yield share</td></tr>
        <tr><th>Accuracy / repeatability</th><td>Low* <span class="hint">(*strongly observer-dependent; can be good for the same experienced observer over time)</span></td></tr>
        <tr><th>Subjectivity</th><td>Very high</td></tr>
        <tr><th>Time needed</th><td>Low <span class="hint">(even lower with an interval-based scale)</span></td></tr>
        <tr><th>Equipment</th><td>None</td></tr>
        <tr><th>Weather-sensitive</th><td>Low</td></tr>
      </table>`,
  },
  {
    id: "frame", label: "Frame method (count / frequency)",
    info: `<p>A frame of known area — often subdivided into a grid of subcells — is laid on the plot. Used two ways: as a <strong>count frame</strong>, tallying individuals inside it for plant density; or as a <strong>frequency frame</strong>, recording presence/absence of each species per subcell to get its frequency (% of subcells occupied).</p>
      <p>A rooting-inside-the-frame rule is needed for plants straddling the edge. Smaller frames give a larger edge-to-area ratio and more of these borderline calls, so 0.5×0.5 m or 1×1 m frames are typical in grassland work.</p>
      <table class="method-stats">
        <tr><th>Captures</th><td>Density (count frame) or frequency (frequency frame)</td></tr>
        <tr><th>Accuracy / repeatability</th><td>Medium–high</td></tr>
        <tr><th>Subjectivity</th><td>Low</td></tr>
        <tr><th>Time needed</th><td>Low–medium</td></tr>
        <tr><th>Equipment</th><td>Low <span class="hint">(a frame, ideally gridded)</span></td></tr>
        <tr><th>Weather-sensitive</th><td>Low</td></tr>
      </table>`,
  },
  {
    id: "point", label: "Point-quadrat frame",
    info: `<p>Also called point-intercept or pin-frame method. A rack lowers thin pins or wires vertically at fixed points; whichever species each pin touches is recorded. If only the first (topmost) contact per pin counts, the result is projective cover; if every contact along the pin is recorded, the result also approximates relative biomass.</p>
      <p>Good objectivity and precision for tracking vegetation change over time, but slow, and hard or impossible to use in wind or in tall, dense stands. Rare species usually need many pins to be caught reliably.</p>
      <table class="method-stats">
        <tr><th>Captures</th><td>Cover, yield share, frequency</td></tr>
        <tr><th>Accuracy / repeatability</th><td>Medium</td></tr>
        <tr><th>Subjectivity</th><td>Low</td></tr>
        <tr><th>Time needed</th><td>High</td></tr>
        <tr><th>Equipment</th><td>Medium <span class="hint">(pin frame or rack)</span></td></tr>
        <tr><th>Weather-sensitive</th><td>Medium <span class="hint">(wind moves the pins)</span></td></tr>
      </table>`,
  },
  {
    id: "daget", label: "Daget–Poissonet line analysis",
    info: `<p>A line-transect variant of the point-quadrat method, common in French and Italian pasture surveys (Daget &amp; Poissonet, 1971). A tape is stretched across the plot and a bayonet or thin metal rod is lowered into the ground at regular intervals along it; the species touched at each point is recorded.</p>
      <p>Simpler to carry and set up than a full pin frame, and works well along a walked transect. Like the point-quadrat method it needs still air and moderate vegetation height to work reliably.</p>
      <table class="method-stats">
        <tr><th>Captures</th><td>Yield share, frequency</td></tr>
        <tr><th>Accuracy / repeatability</th><td>Medium</td></tr>
        <tr><th>Subjectivity</th><td>Low</td></tr>
        <tr><th>Time needed</th><td>High</td></tr>
        <tr><th>Equipment</th><td>Low <span class="hint">(tape + bayonet/rod)</span></td></tr>
        <tr><th>Weather-sensitive</th><td>Low</td></tr>
      </table>`,
  },
];

function coverMethodInfoHtml(m) {
  return m.info + `<p class="hint">Source: Peratoner, G. &amp; Pötsch, E.M. (2015): Erhebungsmethoden des Pflanzenbestandes im Grünland. 20. Alpenländisches Expertenforum, 15–22.</p>`;
}

function renderMethodPicker(hostId, selected, onPick) {
  const host = $(hostId);
  host.innerHTML = COVER_METHODS.map(m => `
    <button type="button" class="method-card ${m.id === selected ? "selected" : ""}" data-method="${m.id}">
      <span class="method-info-btn" data-info="${m.id}" title="More about this method" aria-label="More about this method">i</span>
      ${COVER_METHOD_DIAGRAMS[m.id]}
      <span class="method-label">${m.label}</span>
    </button>`).join("");
  $all(".method-card", host).forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest(".method-info-btn")) return;
      onPick(card.dataset.method);
    });
  });
  $all(".method-info-btn", host).forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const m = COVER_METHODS.find(x => x.id === btn.dataset.info);
      openInfoModal(m.label, coverMethodInfoHtml(m));
    });
  });
}

/* ============================================================
   PERCENTAGE-COVER INTERPRETATION
   When cover is recorded as a raw % rather than a class, three
   conventions exist for how the per-species values relate to the
   plot and to each other. They are NOT interchangeable, so the plot
   must state which one was used. "independent" (overlap-allowed
   absolute cover) is the phytosociological standard and the default.
   ============================================================ */

const COVER_PCT_MODES = [
  { id: "independent", label: "Independent cover", tag: "overlap ok · Σ can exceed 100 %", recommended: true },
  { id: "ground", label: "Projective ground cover", tag: "one layer · Σ ≤ 100 %" },
  { id: "relative", label: "Relative share", tag: "normalised · Σ = 100 %" },
];
const COVER_PCT_MODE_IDS = COVER_PCT_MODES.map(m => m.id);

function coverPctMode(r) {
  return COVER_PCT_MODE_IDS.includes(r && r.coverPctMode) ? r.coverPctMode : "independent";
}

// Small theme-aware diagram illustrating each interpretation.
function coverPctModeSvg(kind) {
  const fx = 8, fw = 284;
  const seg = (x, w, lbl, op, y = 8, h = 26) =>
    `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" fill="currentColor" opacity="${op}"/>` +
    (w > 16 ? `<text x="${(x + w / 2).toFixed(1)}" y="${y + h / 2 + 4}" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">${lbl}</text>` : "");
  const frame = `<rect x="${fx}" y="8" width="${fw}" height="26" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.55"/>`;
  const wrap = (h, inner) => `<svg viewBox="0 0 300 ${h}" style="width:100%;max-width:300px;height:auto;display:block;margin:6px auto">${inner}</svg>`;

  if (kind === "relative") {
    let x = fx, s = "";
    for (const [lbl, pct, op] of [["A", 45, 0.5], ["B", 35, 0.33], ["C", 20, 0.18]]) { const w = fw * pct / 100; s += seg(x, w, lbl, op); x += w; }
    return wrap(52, frame + s + `<text x="${fx}" y="49" font-size="10" fill="currentColor" opacity="0.75">Σ = 100 % — every value rescaled to fill the bar exactly</text>`);
  }
  if (kind === "ground") {
    let x = fx, s = "";
    for (const [lbl, pct, op] of [["A", 40, 0.5], ["B", 25, 0.33], ["C", 15, 0.18]]) { const w = fw * pct / 100; s += seg(x, w, lbl, op); x += w; }
    const bw = fw * 20 / 100;
    s += `<rect x="${x.toFixed(1)}" y="8" width="${bw.toFixed(1)}" height="26" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="3 2" opacity="0.5"/><text x="${(x + bw / 2).toFixed(1)}" y="25" font-size="8" fill="currentColor" text-anchor="middle" opacity="0.6">bare</text>`;
    return wrap(52, frame + s + `<text x="${fx}" y="49" font-size="10" fill="currentColor" opacity="0.75">Σ ≤ 100 % — one projected layer; the rest is bare ground</text>`);
  }
  // independent — three separate 0–100 bars, each judged alone; they overlap
  let s = "", y = 6;
  for (const [lbl, pct, op] of [["A", 60, 0.5], ["B", 50, 0.33], ["C", 30, 0.18]]) {
    s += `<rect x="${fx}" y="${y}" width="${fw}" height="14" fill="currentColor" opacity="0.09"/>` +
      `<rect x="${fx}" y="${y}" width="${(fw * pct / 100).toFixed(1)}" height="14" fill="currentColor" opacity="${op}"/>` +
      `<text x="${fx + 5}" y="${y + 11}" font-size="10" font-weight="700" fill="currentColor">${lbl}</text>` +
      `<text x="${fx + fw}" y="${y + 11}" font-size="9" fill="currentColor" text-anchor="end" opacity="0.8">${pct}%</text>`;
    y += 20;
  }
  return wrap(y + 14, s + `<text x="${fx}" y="${y + 10}" font-size="10" fill="currentColor" opacity="0.75">Σ = 140 % — layers stack, so the total can pass 100 %</text>`);
}

function coverPctModeInfoHtml() {
  return `
    <p>When you record cover as a plain percentage, decide up front what those numbers mean together. The three conventions give different totals for the same plot, so mixing them makes relevés incomparable.</p>
    <p><strong>Independent cover</strong> — each species is judged on its own as the share of the plot its foliage covers when projected down, 0–100 %. Because plants grow in layers, the values can add up to more than 100 %.</p>
    ${coverPctModeSvg("independent")}
    <p><strong>Projective ground cover</strong> — treat the vegetation as a single canopy projected onto the ground; species divide up the surface and the remainder is bare soil / litter / rock, so the total never exceeds 100 %.</p>
    ${coverPctModeSvg("ground")}
    <p><strong>Relative share</strong> — values are rescaled so the species always sum to exactly 100 %; each is a species' share of the total vegetation (a dominance / yield share) rather than its real ground cover.</p>
    ${coverPctModeSvg("relative")}
    <p><strong>Recommended: Independent cover.</strong> It's the Braun-Blanquet / phytosociological convention and the safest default: every species is estimated on its own (so one bad guess doesn't distort the rest), no field arithmetic is forced, and it preserves real structural information — a two-layer stand genuinely covering 140 % looks different from an open one summing to 60 %. You can always derive relative shares afterwards by normalising. Use <em>projective ground cover</em> only when gaps and bare ground are the point (e.g. erosion, grazing impact), and <em>relative share</em> only when you specifically need composition to sum to 100 %.</p>`;
}

// Live total of the numeric cover values + a mode-aware validation hint.
function coverPctSummary(r) {
  const vals = r.species.map(s => parseFloat(s.cover)).filter(v => isFinite(v));
  const sum = vals.reduce((a, b) => a + b, 0);
  const n = vals.length;
  const mode = coverPctMode(r);
  const sumTxt = `Σ = ${Number(sum.toFixed(sum % 1 ? 1 : 0))} %`;
  if (!n) return { sum, n, mode, level: "muted", text: "Enter a % for each species to see the running total." };
  if (mode === "relative") {
    if (Math.abs(sum - 100) <= 1) return { sum, n, mode, level: "ok", text: `${sumTxt} · sums to 100 %` };
    return { sum, n, mode, level: "warn", text: `${sumTxt} · should total 100 % — rescale the values` };
  }
  if (mode === "ground") {
    if (sum > 100.5) return { sum, n, mode, level: "warn", text: `${sumTxt} · over 100 % — impossible for one projected layer` };
    return { sum, n, mode, level: "ok", text: `${sumTxt} · ${Number((100 - sum).toFixed(sum % 1 ? 1 : 0))} % bare / unvegetated` };
  }
  return { sum, n, mode, level: "muted", text: `${sumTxt} · overlap allowed — a total above 100 % is fine` };
}

/* ============================================================
   NESTED SAMPLING (species-area design)
   Optional nested sub-plot mode for relevés: either concentric
   ("centre-out") or anchored at two opposite plot corners
   ("corner-based", as in the EDGG methodology — see the EDGG plot
   editor for the full standardised protocol). The area progression
   is configurable; EDGG's own progression is offered as one preset.
   ============================================================ */

const NEST_PROGRESSIONS = {
  edgg: { label: "EDGG standard (Dengler et al.)", sizes: [0.0001, 0.001, 0.01, 0.1, 1, 3, 10, 30, 100] },
  quarter: { label: "Classic nested quadrat (×4 area/step)", sizes: [0.01, 0.04, 0.16, 0.64, 2.56, 10.24, 40.96, 100] },
};

function areaEdgeLabel(areaM2) {
  const a = Number(areaM2);
  if (!isFinite(a) || a <= 0) return "";
  const edge = Math.sqrt(a);
  if (edge < 1) return `${Number((edge * 100).toFixed(1))} cm`;
  return `${Number(edge.toFixed(2))} m`;
}

function parseCustomProgression(str) {
  return (str || "")
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

function activeProgression(r) {
  if (r.progressionPreset === "custom") return parseCustomProgression(r.customProgression);
  return (NEST_PROGRESSIONS[r.progressionPreset] || NEST_PROGRESSIONS.edgg).sizes;
}

function nestedDiagramSvg(nestingType, sizes) {
  if (!sizes || !sizes.length) return `<p class="hint">Set an area progression above to see the plot diagram.</p>`;
  const pxPerM = 24;
  const maxSize = sizes[sizes.length - 1];
  const outerEdge = Math.max(Math.sqrt(maxSize) * pxPerM, 20);
  const pad = 44;
  const size = outerEdge + pad * 2;

  if (nestingType === "center") {
    const cx = size / 2, cy = size / 2;
    const rects = sizes.map((s, i) => {
      const edge = Math.max(Math.sqrt(s) * pxPerM, 4);
      const isOuter = i === sizes.length - 1;
      return `<rect x="${cx - edge / 2}" y="${cy - edge / 2}" width="${edge}" height="${edge}" fill="${isOuter ? "none" : "currentColor"}" opacity="${isOuter ? 1 : 0.10 + i * 0.05}" stroke="currentColor" stroke-width="${isOuter ? 2 : 1}"/>`;
    }).join("");
    return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:300px;display:block;margin:0 auto">
      ${rects}
      <circle cx="${cx}" cy="${cy}" r="2.5" fill="currentColor"/>
      <text x="${cx}" y="${pad - 12}" font-size="9" fill="currentColor" text-anchor="middle" opacity="0.7">${sizes.length} nested sizes, centre-out</text>
      <text x="${cx}" y="${size - 10}" font-size="9" fill="currentColor" text-anchor="middle" opacity="0.7">${areaEdgeLabel(sizes[0])} → ${maxSize} m²</text>
    </svg>`;
  }

  const nestSizes = sizes.slice(0, -1);
  const x0 = pad, y0 = pad, x1 = pad + outerEdge, y1 = pad + outerEdge;
  const nwRects = nestSizes.map((s, i) => {
    const edge = Math.max(Math.sqrt(s) * pxPerM, 4);
    return `<rect x="${x0}" y="${y0}" width="${edge}" height="${edge}" fill="currentColor" opacity="${0.10 + i * 0.06}"/>`;
  }).join("");
  const seRects = nestSizes.map((s, i) => {
    const edge = Math.max(Math.sqrt(s) * pxPerM, 4);
    return `<rect x="${x1 - edge}" y="${y1 - edge}" width="${edge}" height="${edge}" fill="currentColor" opacity="${0.10 + i * 0.06}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:300px;display:block;margin:0 auto">
    <rect x="${x0}" y="${y0}" width="${outerEdge}" height="${outerEdge}" fill="none" stroke="currentColor" stroke-width="2"/>
    <line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y0}" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.5"/>
    ${nwRects}
    <text x="${x0 + 2}" y="${y0 - 6}" font-size="10" font-weight="700" fill="currentColor">NW</text>
    ${seRects}
    <text x="${x1 - 24}" y="${y1 + 16}" font-size="10" font-weight="700" fill="currentColor">SE</text>
    <text x="${(x0 + x1) / 2}" y="${y1 + 30}" font-size="9" fill="currentColor" text-anchor="middle" opacity="0.7">${nestSizes.length} nested size${nestSizes.length === 1 ? "" : "s"} per corner, ${maxSize} m² whole plot</text>
  </svg>`;
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
      coverScale: "bb", coverPctMode: "independent",
      assessmentMethod: "visual",
      nestedEnabled: false, nestingType: "center", progressionPreset: "edgg", customProgression: "",
      seLat: "", seLon: "", seAlt: "", seAcc: "",
      typoId: "", typoCode: "", typoName: "",
      species: [], photoIds: [], notes: "",
    };
  },

  async openNew() {
    const settings = await Store.getSettings();
    this.current = this.blank();
    this.current.coverScale = settings.defaultScale || "bb";
    await this.render();
    pushView("releve");
    // Fix the survey point immediately — the location fold auto-collapses
    // once it's done, handing visual focus to the species list below.
    const locFold = $("#releveLocationFold");
    if (locFold) locFold.open = true;
    this._gps.start(() => { if (locFold) locFold.open = false; });
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
    this._map = this._map || createLocationMap("releveMap", "releveMapWrap");
    this._map.update(r.lat, r.lon, r.acc);
    ContextPriors.setLocation(r.lat, r.lon);
    this.renderCoverPctMode();
    this.renderAssessmentMethod();
    this.renderNested();
    this.renderSpecies();
    this.renderHabitat();
    await renderPhotoGrid(r.photoIds, $("#relevePhotos"));
  },

  // Percentage-cover interpretation picker + live total. The sub-mode only
  // matters when cover is recorded as a raw %, so the whole block hides for
  // the Braun-Blanquet scales.
  renderCoverPctMode() {
    const r = this.current;
    const isPct = r.coverScale === "pct";
    const block = $("#coverPctModeBlock");
    if (block) block.hidden = !isPct;
    if (isPct) {
      const mode = coverPctMode(r);
      $all('input[name="coverPctMode"]').forEach(el => { el.checked = el.value === mode; });
    }
    this.renderCoverSummary();
  },

  renderCoverSummary() {
    const r = this.current, el = $("#coverPctSummary");
    if (!el) return;
    if (r.coverScale !== "pct" || !r.species.length) { el.hidden = true; el.textContent = ""; return; }
    const s = coverPctSummary(r);
    el.hidden = false;
    el.className = "cover-sum " + s.level;
    el.textContent = s.text;
  },

  // TypoCH habitat analysis + selection (Switzerland only, when loaded).
  renderHabitat() {
    const fold = $("#releveHabitatFold");
    if (!fold) return;
    if (!TypoCH.available()) { fold.hidden = true; return; }
    fold.hidden = false;
    const r = this.current;

    // Ranked suggestions from the recorded species, scored by the official
    // TypoCH Lebensraumanalyse (cover-weighted when a % / BB value is present).
    const ranked = TypoCH.analyze(r.species, 5, r.coverScale);
    const host = $("#habitatSuggestions");
    if (!ranked.length) {
      host.innerHTML = `<div class="habitat-empty">Add a few species and the likely habitat types will appear here.</div>`;
    } else {
      const maxScore = ranked[0].score || 1;
      host.innerHTML = `<div class="habitat-list">` + ranked.map(x => {
        const sel = x.hab.id === r.typoId ? " selected" : "";
        const barH = Math.max(0.25, x.score / maxScore);
        const chars = x.support.filter(s => s.c).length;
        const title = `Score ${x.score} · ${x.support.length} character species${chars ? ` (${chars} characteristic)` : ""}`;
        return `<button type="button" class="habitat-card${sel}" data-id="${x.hab.id}">
          <span class="h-bar" style="opacity:${(0.4 + 0.55 * barH).toFixed(2)}"></span>
          <span class="h-main">
            <span class="h-name">${esc(TypoCH.name(x.hab))}</span>
            <span class="h-meta">${esc(x.hab.code)}${x.hab.sci ? " · " + esc(x.hab.sci) : ""}${x.hab.eunis ? " · EUNIS " + esc(x.hab.eunis.split(";")[0]) : ""}</span>
          </span>
          <span class="h-count" title="${esc(title)}"><span class="h-score">${x.score}</span><span class="h-sp">${x.support.length} sp.</span></span>
        </button>`;
      }).join("") + `</div>`;
      $all(".habitat-card", host).forEach(btn => btn.addEventListener("click", () => this.selectHabitat(btn.dataset.id)));
    }
    this.renderHabitatSelected();
  },
  renderHabitatSelected() {
    const el = $("#habitatSelected"), r = this.current;
    if (r.typoId) {
      el.innerHTML = `Assigned: <strong>${esc(r.typoName)}</strong> (${esc(r.typoCode)}) <button type="button" id="habitatClearBtn" class="link-btn" style="padding:0 4px">clear</button>`;
      $("#habitatClearBtn").addEventListener("click", () => this.selectHabitat(null));
    } else {
      el.textContent = "";
    }
  },
  selectHabitat(id) {
    const r = this.current;
    if (!id) { r.typoId = ""; r.typoCode = ""; r.typoName = ""; }
    else { const h = TypoCH.byId[id]; if (!h) return; r.typoId = h.id; r.typoCode = h.code; r.typoName = TypoCH.name(h); }
    this.renderHabitat();
  },

  renderAssessmentMethod() {
    renderMethodPicker("#methodPicker", this.current.assessmentMethod, m => {
      this.current.assessmentMethod = m;
      this.renderAssessmentMethod();
    });
  },

  renderNested() {
    const r = this.current;
    $("#nestedEnableBox").checked = r.nestedEnabled;
    $("#nestedOptions").hidden = !r.nestedEnabled;
    $all('input[name="nestingType"]').forEach(el => { el.checked = el.value === r.nestingType; });
    $all('input[name="progressionPreset"]').forEach(el => { el.checked = el.value === r.progressionPreset; });
    $("#customProgressionInput").hidden = r.progressionPreset !== "custom";
    $("#customProgressionInput").value = r.customProgression;
    $("#nestedSeCornerBlock").hidden = r.nestingType !== "corner";
    $("#nestedSeLat").value = r.seLat;
    $("#nestedSeLon").value = r.seLon;
    $("#nestedSeAlt").value = r.seAlt;
    $("#nestedSeAcc").value = r.seAcc;
    this._mapSe = this._mapSe || createLocationMap("nestedSeMap", "nestedSeMapWrap");
    this._mapSe.update(r.seLat, r.seLon, r.seAcc);
    $("#nestedDiagram").innerHTML = r.nestedEnabled ? nestedDiagramSvg(r.nestingType, activeProgression(r)) : "";
  },

  renderSpecies() {
    const r = this.current;
    $("#speciesCount").textContent = r.species.length ? r.species.length : "";
    const host = $("#speciesTable");
    if (!r.species.length) {
      host.innerHTML = `<div class="empty-note">No species added yet.</div>`;
      return;
    }
    const sortMode = $("#releveSortSelect")?.value || "added";
    const ordered = sortSpeciesForDisplay(r.species, sortMode, r.coverScale);
    const sizes = r.nestedEnabled ? activeProgression(r) : [];
    host.innerHTML = ordered.map(({ s, i }) => `
      <div class="species-row" data-i="${i}">
        <div class="sp-info">
          <div class="sp-name">${s.cf ? `<span class="cf-prefix">cf.</span> ` : ""}<button type="button" class="sp-name-btn" title="Tap to correct this species">${esc(s.taxon)}</button>${s.voiceUnconfirmed ? ` <button type="button" class="sp-unconfirmed-badge" title="Voice match — tap to confirm it's correct">unconfirmed</button>` : ""}${s.notInChecklist ? ` <span class="sp-freetext-tag" title="Typed as free text — not in the species database">not in checklist</span>` : ""}</div>
          <div class="sp-fam">${esc(s.family || "")}${nativeTagHtml(s.native)}</div>
        </div>
        <select class="input small sp-layer">
          ${["herb", "shrub", "tree", "moss"].map(l => `<option value="${l}" ${l === s.layer ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        ${r.nestedEnabled ? `<select class="input small sp-grain" title="Smallest grain size found in">
          ${sizes.map(sz => `<option value="${sz}" ${String(sz) === String(s.grain) ? "selected" : ""}>${areaEdgeLabel(sz)}</option>`).join("")}
        </select>` : ""}
        ${r.nestedEnabled && r.nestingType === "corner" ? `<select class="input small sp-corner" title="Which corner">
          <option value="nw" ${s.corner === "nw" ? "selected" : ""}>NW</option>
          <option value="se" ${s.corner === "se" ? "selected" : ""}>SE</option>
        </select>` : ""}
        ${coverInputHtml(r.coverScale, s.cover)}
        <button type="button" class="cf-toggle ${s.cf ? "active" : ""}" title="Mark as uncertain determination (cf.)">cf.</button>
        <button type="button" class="rm-btn" title="Remove">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>`).join("");

    $all(".species-row", host).forEach(row => {
      const i = Number(row.dataset.i);
      $(".sp-layer", row).addEventListener("change", e => { r.species[i].layer = e.target.value; });
      $(".sp-cover", row).addEventListener("change", e => { r.species[i].cover = e.target.value; this.renderSpecies(); });
      $(".rm-btn", row).addEventListener("click", () => { r.species.splice(i, 1); this.renderSpecies(); });
      $(".cf-toggle", row).addEventListener("click", () => { r.species[i].cf = !r.species[i].cf; this.renderSpecies(); });
      $(".sp-name-btn", row).addEventListener("click", () => {
        SpeciesCorrector.open(RELEVE_CORRECTOR_IDS, r.species[i].taxon, sp => this.replaceSpeciesAt(i, sp));
      });
      const badge = $(".sp-unconfirmed-badge", row);
      if (badge) badge.addEventListener("click", () => { r.species[i].voiceUnconfirmed = false; this.renderSpecies(); });
      const grainSel = $(".sp-grain", row);
      if (grainSel) grainSel.addEventListener("change", e => { r.species[i].grain = e.target.value; });
      const cornerSel = $(".sp-corner", row);
      if (cornerSel) cornerSel.addEventListener("change", e => { r.species[i].corner = e.target.value; });
    });
    // Habitat suggestions follow the species list as it changes.
    if ($("#releveHabitatFold") && !$("#releveHabitatFold").hidden) this.renderHabitat();
    // Keep the running % total in step with edited cover values.
    this.renderCoverSummary();
  },

  replaceSpeciesAt(i, sp) {
    const r = this.current;
    const old = r.species[i];
    if (!old) return;
    r.species[i] = { ...old, taxon: sp.t, family: sp.f || "", native: sp.n || "", notInChecklist: !!sp.freeText, voiceUnconfirmed: false };
    this.renderSpecies();
    toast(`Updated to ${sp.t}`, "ok");
  },

  addSpecies(sp, opts) {
    opts = opts || {};
    const r = this.current;
    if (r.species.some(s => s.taxon === sp.t)) {
      if (!opts.silent) toast("Already in the list");
      return { added: false };
    }
    const sizes = r.nestedEnabled ? activeProgression(r) : [];
    r.species.push({
      taxon: sp.t, family: sp.f || "", native: sp.n || "", layer: "herb", cover: "",
      cf: false, voiceUnconfirmed: !!opts.unconfirmed, notInChecklist: !!sp.freeText,
      loggedAt: Date.now(),
      grain: sizes.length ? String(sizes[0]) : "", corner: "nw",
    });
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
    r.seLat = $("#nestedSeLat").value;
    r.seLon = $("#nestedSeLon").value;
    r.seAlt = $("#nestedSeAlt").value;
    r.seAcc = $("#nestedSeAcc").value;
  },

  async save() {
    this.readForm();
    await Store.saveRecord(this.current);
    toast("Relevé saved", "ok");
    popView();
    Home.refresh();
  },

  // Clone plot structure + species list for fast repeat monitoring;
  // GPS, date/time and photos reset since those are specific to this
  // visit, not the plot description. Loads as an unsaved draft — the
  // original record on disk is untouched until you hit Save.
  async duplicate() {
    this.readForm();
    const src = this.current;
    const copy = this.blank();
    copy.coverScale = src.coverScale;
    copy.coverPctMode = src.coverPctMode;
    copy.typoId = src.typoId; copy.typoCode = src.typoCode; copy.typoName = src.typoName;
    copy.assessmentMethod = src.assessmentMethod;
    copy.nestedEnabled = src.nestedEnabled;
    copy.nestingType = src.nestingType;
    copy.progressionPreset = src.progressionPreset;
    copy.customProgression = src.customProgression;
    copy.area = src.area; copy.slope = src.slope; copy.aspect = src.aspect; copy.habitat = src.habitat;
    copy.coverTree = src.coverTree; copy.coverShrub = src.coverShrub; copy.coverHerb = src.coverHerb; copy.coverMoss = src.coverMoss;
    copy.species = src.species.map(s => ({ ...s }));
    copy.notes = src.notes;
    this.current = copy;
    await this.render();
    toast("Duplicated as a new draft — GPS and photos reset", "ok");
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
      taxon: "", family: "", native: "", cf: false, notInChecklist: false,
      date: todayDate(), time: nowTime(),
      lat: "", lon: "",
      photoIds: [], notes: "",
    };
  },

  openNew() {
    this.current = this.blank();
    this.render();
    pushView("observation");
    this._gps.start();
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
    this._map = this._map || createLocationMap("observationMap", "observationMapWrap");
    this._map.update(s.lat, s.lon);
    ContextPriors.setLocation(s.lat, s.lon);
    this.renderTaxonChip();
    await renderPhotoGrid(s.photoIds, $("#observationPhotos"));
  },

  renderTaxonChip() {
    const s = this.current;
    const host = $("#observationTaxonChip");
    if (!s.taxon) { host.innerHTML = ""; return; }
    host.innerHTML = `
      <span class="chip">${s.cf ? "cf. " : ""}<button type="button" class="chip-name-btn" title="Tap to correct this species">${esc(s.taxon)}</button><button type="button" id="clearTaxonBtn">×</button></span>
      ${s.notInChecklist ? `<span class="sp-freetext-tag" title="Typed as free text — not in the species database">not in checklist</span>` : ""}
      <label class="check"><input type="checkbox" id="observationCfBox" ${s.cf ? "checked" : ""}><span>Uncertain determination (cf.)</span></label>`;
    $("#clearTaxonBtn").addEventListener("click", () => { s.taxon = ""; s.family = ""; s.native = ""; s.notInChecklist = false; s.cf = false; this.renderTaxonChip(); });
    $("#observationCfBox").addEventListener("change", e => { s.cf = e.target.checked; this.renderTaxonChip(); });
    $(".chip-name-btn", host).addEventListener("click", () => {
      SpeciesCorrector.open(OBSERVATION_CORRECTOR_IDS, s.taxon, sp => this.setTaxon(sp));
    });
  },

  setTaxon(sp) {
    this.current.taxon = sp.t;
    this.current.family = sp.f || "";
    this.current.native = sp.n || "";
    this.current.notInChecklist = !!sp.freeText;
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
    // A species ID isn't required if there's a photo to identify from
    // later — matches the "photograph now, determine later" workflow.
    if (!this.current.taxon && !this.current.photoIds.length) {
      toast("Pick a species or add a photo first", "err");
      return;
    }
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

/* Display-only sorting for species lists — the underlying stored
   array order (= order added / recorded time) never changes, so
   switching sort mode is non-destructive and CSV/JSON export always
   reflects the real recording order regardless of what's on screen. */
const BB_COVER_ORDER = ["r", "+", "1", "2", "3", "4", "5"];
const BB_EXT_COVER_ORDER = ["r", "+", "1", "2m", "2a", "2b", "3", "4", "5"];
const SPECIES_LAYER_ORDER = { tree: 0, shrub: 1, herb: 2, moss: 3 };

function coverRank(cover, scale) {
  if (scale === "pct") { const n = Number(cover); return isNaN(n) ? -1 : n; }
  const order = scale === "bb-ext" ? BB_EXT_COVER_ORDER : BB_COVER_ORDER;
  const idx = order.indexOf(cover);
  return idx === -1 ? -1 : idx;
}

function sortSpeciesForDisplay(species, mode, coverScale) {
  const withIdx = species.map((s, i) => ({ s, i }));
  switch (mode) {
    case "alpha":
      withIdx.sort((a, b) => a.s.taxon.localeCompare(b.s.taxon));
      break;
    case "family":
      withIdx.sort((a, b) => (a.s.family || "").localeCompare(b.s.family || "") || a.s.taxon.localeCompare(b.s.taxon));
      break;
    case "cover":
      withIdx.sort((a, b) => coverRank(b.s.cover, coverScale) - coverRank(a.s.cover, coverScale));
      break;
    case "layer":
      withIdx.sort((a, b) => (SPECIES_LAYER_ORDER[a.s.layer] ?? 9) - (SPECIES_LAYER_ORDER[b.s.layer] ?? 9) || a.s.taxon.localeCompare(b.s.taxon));
      break;
    case "certainty":
      withIdx.sort((a, b) => (a.s.certainty ?? 1) - (b.s.certainty ?? 1));
      break;
    default:
      break; // "added" — keep original (recorded) order
  }
  return withIdx;
}

function nativeTagHtml(native) {
  if (!native) return "";
  const label = native.replace(/^CH_/, "").replace(/_/g, " ").toLowerCase();
  return ` <span class="native-tag">· ${esc(label)}</span>`;
}

/* ---------------------------------------------------------- */
/* tap-to-correct species picker — shared by relevé rows,      */
/* transect rows, and the observation chip. Tapping a species   */
/* name reuses the phonetic/fuzzy matcher (treating the current  */
/* — possibly wrong — name as a "transcript") to suggest close    */
/* matches, plus a normal type-to-search fallback.               */
/* ---------------------------------------------------------- */

const SpeciesCorrector = {
  ids: null,
  replaceFn: null,
  wired: new Set(),

  ensureWired(ids) {
    if (this.wired.has(ids.box)) return;
    this.wired.add(ids.box);
    wireAutocomplete($(ids.input), $(ids.menu), sp => this.pick(sp));
    $(ids.cancel).addEventListener("click", () => this.close());
  },

  open(ids, currentName, onReplace) {
    this.ensureWired(ids);
    this.ids = ids;
    this.replaceFn = onReplace;
    $(ids.label).textContent = `Correcting: ${currentName}`;
    $(ids.input).value = "";
    $(ids.menu).classList.remove("show");
    const matches = fuzzyMatchTranscripts([currentName], 5);
    const host = $(ids.suggestions);
    host.innerHTML = matches.length
      ? matches.map((m, i) => `<button type="button" class="btn btn-ghost full corrector-sugg" data-i="${i}"><span style="font-style:italic">${esc(m.sp.t)}</span><span class="hint">${Math.round(m.score * 100)}%</span></button>`).join("")
      : `<div class="hint">No close matches — type to search.</div>`;
    $all(".corrector-sugg", host).forEach(btn => {
      btn.addEventListener("click", () => this.pick(matches[Number(btn.dataset.i)].sp));
    });
    $(ids.box).hidden = false;
    $(ids.input).focus();
  },

  pick(sp) {
    if (this.replaceFn) this.replaceFn(sp);
    this.close();
  },

  close() {
    if (this.ids) $(this.ids.box).hidden = true;
    this.ids = null;
    this.replaceFn = null;
  },
};

const RELEVE_CORRECTOR_IDS = { box: "#speciesCorrectorBox", label: "#speciesCorrectorLabel", suggestions: "#speciesCorrectorSuggestions", input: "#speciesCorrectorInput", menu: "#speciesCorrectorMenu", cancel: "#speciesCorrectorCancelBtn" };
const TRANSECT_CORRECTOR_IDS = { box: "#transectCorrectorBox", label: "#transectCorrectorLabel", suggestions: "#transectCorrectorSuggestions", input: "#transectCorrectorInput", menu: "#transectCorrectorMenu", cancel: "#transectCorrectorCancelBtn" };
const OBSERVATION_CORRECTOR_IDS = { box: "#observationCorrectorBox", label: "#observationCorrectorLabel", suggestions: "#observationCorrectorSuggestions", input: "#observationCorrectorInput", menu: "#observationCorrectorMenu", cancel: "#observationCorrectorCancelBtn" };
const REVIEW_CORRECTOR_IDS = { box: "#reviewReplaceBox", label: "#reviewReplaceLabel", suggestions: "#reviewReplaceSuggestions", input: "#reviewReplaceInput", menu: "#reviewReplaceMenu", cancel: "#reviewReplaceCancelBtn" };

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
    const locFold = $("#transectLocationFold");
    if (locFold) locFold.open = true;
    this._gps.start(() => { if (locFold) locFold.open = false; });
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
    this._map = this._map || createLocationMap("transectMap", "transectMapWrap");
    this._map.update(t.lat, t.lon, t.acc);
    ContextPriors.setLocation(t.lat, t.lon);
    this.renderSpecies();
  },

  renderSpecies() {
    const t = this.current;
    const unreviewed = t.species.filter(s => !s.reviewed).length;
    $("#transectSpeciesCount").textContent = t.species.length ? t.species.length : "";
    $("#transectListStatus").textContent = t.species.length
      ? `${t.species.length} logged · ${unreviewed} awaiting review`
      : "";
    // Update only the label span, not the button's whole textContent — the
    // latter would wipe the nested (i) info dot that lives inside the button.
    $("#transectReviewLabel").textContent = unreviewed ? `Review & approve (${unreviewed})` : "Review & approve";

    const host = $("#transectSpeciesTable");
    if (!t.species.length) {
      host.innerHTML = `<div class="empty-note">No species logged yet.</div>`;
      return;
    }
    const sortMode = $("#transectSortSelect")?.value || "added";
    const ordered = sortSpeciesForDisplay(t.species, sortMode, null);
    host.innerHTML = ordered.map(({ s, i }) => `
      <div class="species-row" data-i="${i}">
        <div class="sp-info">
          <div class="sp-name">${s.cf ? `<span class="cf-prefix">cf.</span> ` : ""}<button type="button" class="sp-name-btn" title="Tap to correct this species">${esc(s.taxon)}</button>${s.notInChecklist ? ` <span class="sp-freetext-tag" title="Typed as free text — not in the species database">not in checklist</span>` : ""}</div>
          <div class="sp-fam">${esc(s.family || "")}${nativeTagHtml(s.native)}</div>
        </div>
        ${certaintyPillHtml(s)}
        <button type="button" class="cf-toggle ${s.cf ? "active" : ""}" title="Mark as uncertain determination (cf.)">cf.</button>
        <button type="button" class="rm-btn" title="Remove">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>`).join("");

    $all(".species-row", host).forEach(row => {
      const i = Number(row.dataset.i);
      $(".rm-btn", row).addEventListener("click", () => { t.species.splice(i, 1); this.renderSpecies(); });
      $(".cf-toggle", row).addEventListener("click", () => { t.species[i].cf = !t.species[i].cf; this.renderSpecies(); });
      $(".sp-name-btn", row).addEventListener("click", () => {
        SpeciesCorrector.open(TRANSECT_CORRECTOR_IDS, t.species[i].taxon, sp => this.replaceSpeciesAt(i, sp));
      });
      const pill = $(".certainty-pill", row);
      if (pill) pill.addEventListener("click", () => { t.species[i].reviewed = true; this.renderSpecies(); });
    });
  },

  replaceSpeciesAt(i, sp) {
    const t = this.current;
    const old = t.species[i];
    if (!old) return;
    t.species[i] = { ...old, taxon: sp.t, family: sp.f || "", native: sp.n || "", notInChecklist: !!sp.freeText, certainty: 1, reviewed: true, source: "manual" };
    this.renderSpecies();
    toast(`Updated to ${sp.t}`, "ok");
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
      taxon: sp.t, family: sp.f || "", native: sp.n || "",
      certainty,
      reviewed: certainty >= VOICE_HIGH_CONF,
      source: opts.score != null ? "voice" : "manual",
      loggedAt: Date.now(),
      cf: false, notInChecklist: !!sp.freeText,
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

  // Clone the species list for fast repeat monitoring; GPS/date/time
  // reset since those are specific to this visit. Loads as an unsaved
  // draft — the original record on disk is untouched until Save.
  duplicate() {
    this.readForm();
    const src = this.current;
    const copy = this.blank();
    copy.species = src.species.map(s => ({ ...s }));
    copy.notes = src.notes;
    this.current = copy;
    this.render();
    toast("Duplicated as a new draft — GPS reset", "ok");
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
  open() {
    SpeciesCorrector.close();
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
          <div class="review-name">${s.cf ? `<span class="cf-prefix">cf.</span> ` : ""}<button type="button" class="sp-name-btn" title="Tap to correct this species">${esc(s.taxon)}</button></div>
          <div class="review-fam">${esc(s.family || "")}${nativeTagHtml(s.native)}</div>
        </div>
        <span class="certainty-pill ${cls}">${pct}%</span>
        <button type="button" class="btn btn-icon review-approve" title="Approve">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
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
      $(".sp-name-btn", row).addEventListener("click", () => {
        SpeciesCorrector.open(REVIEW_CORRECTOR_IDS, t.species[i].taxon, sp => this.replaceAt(i, sp));
      });
    });
  },

  replaceAt(i, sp) {
    const t = TransectEditor.current;
    const old = t.species[i];
    if (!old) return;
    t.species[i] = { ...old, taxon: sp.t, family: sp.f || "", native: sp.n || "", notInChecklist: !!sp.freeText, certainty: 1, reviewed: true, source: "manual" };
    this.render();
    TransectEditor.renderSpecies();
    toast(`Updated to ${sp.t}`, "ok");
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
   EDGG PLOT EDITOR — the standardised nested-plot methodology for
   grassland diversity (Dengler et al. 2016, Bull. EDGG 32: 13-30;
   + second amendment, Dengler, Biurrun & Dembicz 2021, Palaearctic
   Grasslands 49: 22-26). A 100 m² square with a full nested subplot
   series (0.0001-10 m²) in two opposite corners (NW, SE), species
   cover at 10 m², extensive structural/environmental variables per
   10 m² plot, plus the optional 1000 m² extension, 100/1000 m²
   cover spot-checks, and 4-fraction biomass sampling.
   ============================================================ */

const EDGG_GRAIN_SIZES = ["0.0001", "0.001", "0.01", "0.1", "1", "10"];
const EDGG_GRAIN_EDGE_LABEL = { "0.0001": "1 cm", "0.001": "3.2 cm", "0.01": "10 cm", "0.1": "32 cm", "1": "1 m", "10": "3.16 m" };

/* Schematic (not pixel-perfect to scale in the smallest insets — the
   real range spans four orders of magnitude, same simplification the
   original paper's own Fig. 1 uses) plot-design diagram. */
function edggDiagramSvg(include1000) {
  const pxPerM = 24;
  const inner = 10 * pxPerM; // 100 m² edge = 10 m
  if (!include1000) {
    const pad = 50;
    const size = inner + pad * 2;
    const x0 = pad, y0 = pad, x1 = pad + inner, y1 = pad + inner;
    return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:340px;display:block;margin:0 auto">
      <rect x="${x0}" y="${y0}" width="${inner}" height="${inner}" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y0}" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
      <text x="${(x0+x1)/2+6}" y="${(y0+y1)/2-4}" font-size="9" fill="currentColor" opacity="0.7">diag. 14.14 m</text>
      <rect x="${x0}" y="${y0}" width="50" height="50" fill="currentColor" opacity="0.12"/>
      <rect x="${x0}" y="${y0}" width="26" height="26" fill="currentColor" opacity="0.18"/>
      <rect x="${x0}" y="${y0}" width="10" height="10" fill="currentColor" opacity="0.28"/>
      <text x="${x0+2}" y="${y0-6}" font-size="10" font-weight="700" fill="currentColor">NW</text>
      <rect x="${x1-50}" y="${y1-50}" width="50" height="50" fill="currentColor" opacity="0.12"/>
      <rect x="${x1-26}" y="${y1-26}" width="26" height="26" fill="currentColor" opacity="0.18"/>
      <rect x="${x1-10}" y="${y1-10}" width="10" height="10" fill="currentColor" opacity="0.28"/>
      <text x="${x1-24}" y="${y1+16}" font-size="10" font-weight="700" fill="currentColor">SE</text>
      <text x="${x1-24}" y="${y0-6}" font-size="9" fill="currentColor" opacity="0.7">NE</text>
      <text x="${x0+2}" y="${y1+16}" font-size="9" fill="currentColor" opacity="0.7">SW</text>
    </svg>`;
  }
  const outer = 31.62 * pxPerM;
  const pad = 46;
  const size = outer + pad * 2;
  const cx = size / 2, cy = size / 2;
  const ox0 = cx - outer / 2, oy0 = cy - outer / 2;
  const ix0 = cx - inner / 2, iy0 = cy - inner / 2;
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:340px;display:block;margin:0 auto">
    <rect x="${ox0}" y="${oy0}" width="${outer}" height="${outer}" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="6 4" opacity="0.85"/>
    <text x="${cx}" y="${oy0-10}" font-size="10" fill="currentColor" text-anchor="middle">1000 m² (31.62 × 31.62 m), concentric</text>
    <rect x="${ix0}" y="${iy0}" width="${inner}" height="${inner}" fill="none" stroke="currentColor" stroke-width="2"/>
    <rect x="${ix0}" y="${iy0}" width="40" height="40" fill="currentColor" opacity="0.15"/>
    <rect x="${ix0}" y="${iy0}" width="18" height="18" fill="currentColor" opacity="0.25"/>
    <text x="${ix0+2}" y="${iy0-4}" font-size="9" font-weight="700" fill="currentColor">NW</text>
    <rect x="${ix0+inner-40}" y="${iy0+inner-40}" width="40" height="40" fill="currentColor" opacity="0.15"/>
    <rect x="${ix0+inner-18}" y="${iy0+inner-18}" width="18" height="18" fill="currentColor" opacity="0.25"/>
    <text x="${ix0+inner-22}" y="${iy0+inner+14}" font-size="9" font-weight="700" fill="currentColor">SE</text>
    <text x="${cx}" y="${oy0+outer+16}" font-size="9" fill="currentColor" text-anchor="middle" opacity="0.7">100 m² centred inside the 1000 m² extension</text>
  </svg>`;
}

const EDGG_STRUCT_FIELD_KEYS = [
  "CoverTree", "CoverShrub", "CoverHerb", "CoverCryptogam",
  "HerbPhaner", "HerbChamae", "HerbGraminoid", "HerbLegume", "HerbOtherForb",
  "MaxHeightTree", "MaxHeightShrub", "MaxHeightHerb",
  "LitterCover",
  "SoilStones", "SoilGravel", "SoilFine",
  "Aspect", "Inclination", "Microrelief",
  "SoilSkeleton", "SoilTexture", "SoilPh", "SoilHumus", "SoilC", "SoilN",
  "LandUse", "Burned", "LandUseNotes",
];
function edggStructKeyToObjKey(k) { return k.charAt(0).toLowerCase() + k.slice(1); }

function edggReadStructForm(Corner) {
  const obj = {};
  EDGG_STRUCT_FIELD_KEYS.forEach(k => {
    const el = $("#edgg" + Corner + k);
    if (!el) return;
    obj[edggStructKeyToObjKey(k)] = el.type === "checkbox" ? el.checked : el.value;
  });
  obj.stdHeight = [1, 2, 3, 4, 5].map(i => $("#edgg" + Corner + "StdHeight" + i)?.value || "");
  obj.soilDepth = [1, 2, 3, 4, 5].map(i => $("#edgg" + Corner + "SoilDepth" + i)?.value || "");
  return obj;
}
function edggRenderStructForm(Corner, obj) {
  obj = obj || {};
  EDGG_STRUCT_FIELD_KEYS.forEach(k => {
    const el = $("#edgg" + Corner + k);
    if (!el) return;
    const v = obj[edggStructKeyToObjKey(k)];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v || "";
  });
  [1, 2, 3, 4, 5].forEach(i => {
    const hEl = $("#edgg" + Corner + "StdHeight" + i); if (hEl) hEl.value = (obj.stdHeight && obj.stdHeight[i - 1]) || "";
    const dEl = $("#edgg" + Corner + "SoilDepth" + i); if (dEl) dEl.value = (obj.soilDepth && obj.soilDepth[i - 1]) || "";
  });
}
function edggReadBiomass(Corner) {
  return {
    necromass: $("#edgg" + Corner + "BiomassNecromass").value,
    bryo: $("#edgg" + Corner + "BiomassBryo").value,
    herb: $("#edgg" + Corner + "BiomassHerb").value,
    woody: $("#edgg" + Corner + "BiomassWoody").value,
  };
}
function edggRenderBiomass(Corner, obj) {
  obj = obj || {};
  $("#edgg" + Corner + "BiomassNecromass").value = obj.necromass || "";
  $("#edgg" + Corner + "BiomassBryo").value = obj.bryo || "";
  $("#edgg" + Corner + "BiomassHerb").value = obj.herb || "";
  $("#edgg" + Corner + "BiomassWoody").value = obj.woody || "";
}

const EDGG_NW_CORRECTOR_IDS = { box: "#edggNwCorrectorBox", label: "#edggNwCorrectorLabel", suggestions: "#edggNwCorrectorSuggestions", input: "#edggNwCorrectorInput", menu: "#edggNwCorrectorMenu", cancel: "#edggNwCorrectorCancelBtn" };
const EDGG_SE_CORRECTOR_IDS = { box: "#edggSeCorrectorBox", label: "#edggSeCorrectorLabel", suggestions: "#edggSeCorrectorSuggestions", input: "#edggSeCorrectorInput", menu: "#edggSeCorrectorMenu", cancel: "#edggSeCorrectorCancelBtn" };

const EdggEditor = {
  current: null,

  blank() {
    return {
      id: uid(), type: "edgg", createdAt: Date.now(), updatedAt: Date.now(),
      name: "EDGG-" + todayDate().replace(/-/g, "") + "-" + Math.floor(Math.random() * 90 + 10),
      date: todayDate(), time: nowTime(),
      include1000: false, orientationDev: "",
      nwLat: "", nwLon: "", nwAlt: "", nwAcc: "",
      seLat: "", seLon: "", seAlt: "", seAcc: "",
      nwSpecies: [], seSpecies: [],
      cover100: [], cover1000: [],
      struct: { nw: {}, se: {} },
      biomassEnable: false, biomassCorner: "both",
      biomass: { nw: {}, se: {} },
      photoIds: [], notes: "",
    };
  },

  openNew() {
    this.current = this.blank();
    this.render();
    pushView("edgg");
    this._gpsNw.start();
    this._gpsSe.start();
  },

  async openExisting(id) {
    const rec = await Store.getRecord(id);
    if (!rec) return;
    this.current = rec;
    await this.render();
    pushView("edgg");
  },

  async render() {
    const e = this.current;
    $("#edggName").value = e.name;
    $("#edggDate").value = e.date;
    $("#edggTime").value = e.time;
    $("#edggOrientationDev").value = e.orientationDev;
    $("#edgg1000Toggle").checked = !!e.include1000;
    $("#edgg1000Instructions").hidden = !e.include1000;
    $("#edggCover1000Section").hidden = !e.include1000;
    $("#edggDiagram").innerHTML = edggDiagramSvg(!!e.include1000);

    $("#edggNwLat").value = e.nwLat; $("#edggNwLon").value = e.nwLon; $("#edggNwAlt").value = e.nwAlt; $("#edggNwAcc").value = e.nwAcc;
    $("#edggSeLat").value = e.seLat; $("#edggSeLon").value = e.seLon; $("#edggSeAlt").value = e.seAlt; $("#edggSeAcc").value = e.seAcc;
    $("#edggNwGpsStatus").textContent = ""; $("#edggSeGpsStatus").textContent = "";
    this._mapNw = this._mapNw || createLocationMap("edggNwMap", "edggNwMapWrap");
    this._mapNw.update(e.nwLat, e.nwLon, e.nwAcc);
    ContextPriors.setLocation(e.nwLat, e.nwLon);
    this._mapSe = this._mapSe || createLocationMap("edggSeMap", "edggSeMapWrap");
    this._mapSe.update(e.seLat, e.seLon, e.seAcc);

    edggRenderStructForm("Nw", e.struct.nw);
    edggRenderStructForm("Se", e.struct.se);

    $("#edggBiomassEnable").checked = !!e.biomassEnable;
    $("#edggBiomassFields").hidden = !e.biomassEnable;
    $("#edggBiomassCorner").value = e.biomassCorner || "both";
    $("#edggBiomassNw").hidden = e.biomassCorner === "se";
    $("#edggBiomassSe").hidden = e.biomassCorner === "nw";
    edggRenderBiomass("Nw", e.biomass.nw);
    edggRenderBiomass("Se", e.biomass.se);

    $("#edggNotes").value = e.notes;
    this.renderSpecies("nw");
    this.renderSpecies("se");
    this.renderCoverList("cover100");
    this.renderCoverList("cover1000");
    await renderPhotoGrid(e.photoIds, $("#edggPhotos"));
  },

  renderSpecies(corner) {
    const e = this.current;
    const Corner = corner === "nw" ? "Nw" : "Se";
    const arr = corner === "nw" ? e.nwSpecies : e.seSpecies;
    const ids = corner === "nw" ? EDGG_NW_CORRECTOR_IDS : EDGG_SE_CORRECTOR_IDS;
    $("#edgg" + Corner + "SpeciesCount").textContent = arr.length ? arr.length : "";
    const host = $("#edgg" + Corner + "SpeciesTable");
    if (!arr.length) { host.innerHTML = `<div class="empty-note">No species recorded yet.</div>`; return; }

    const sortMode = $("#edgg" + Corner + "SortSelect")?.value || "added";
    const ordered = sortMode === "grain"
      ? arr.map((s, i) => ({ s, i })).sort((a, b) => EDGG_GRAIN_SIZES.indexOf(a.s.grain) - EDGG_GRAIN_SIZES.indexOf(b.s.grain))
      : sortSpeciesForDisplay(arr, sortMode, null);

    host.innerHTML = ordered.map(({ s, i }) => `
      <div class="species-row" data-i="${i}">
        <div class="sp-info">
          <div class="sp-name">${s.cf ? `<span class="cf-prefix">cf.</span> ` : ""}<button type="button" class="sp-name-btn" title="Tap to correct this species">${esc(s.taxon)}</button>${s.voiceUnconfirmed ? ` <button type="button" class="sp-unconfirmed-badge" title="Voice match — tap to confirm it's correct">unconfirmed</button>` : ""}${s.notInChecklist ? ` <span class="sp-freetext-tag">not in checklist</span>` : ""}</div>
          <div class="sp-fam">${esc(s.family || "")}${nativeTagHtml(s.native)}</div>
        </div>
        <select class="input small sp-grain" title="Smallest grain size found">
          ${EDGG_GRAIN_SIZES.map(g => `<option value="${g}" ${g === s.grain ? "selected" : ""}>${g} m²</option>`).join("")}
        </select>
        <input type="number" class="input small sp-cover10" min="0" max="100" step="0.1" placeholder="cov.%" value="${esc(s.cover ?? "")}">
        <button type="button" class="cf-toggle ${s.cf ? "active" : ""}" title="Mark as uncertain determination (cf.)">cf.</button>
        <button type="button" class="rm-btn" title="Remove">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>`).join("");

    $all(".species-row", host).forEach(row => {
      const i = Number(row.dataset.i);
      $(".sp-grain", row).addEventListener("change", ev => { arr[i].grain = ev.target.value; });
      $(".sp-cover10", row).addEventListener("change", ev => { arr[i].cover = ev.target.value; });
      $(".rm-btn", row).addEventListener("click", () => { arr.splice(i, 1); this.renderSpecies(corner); });
      $(".cf-toggle", row).addEventListener("click", () => { arr[i].cf = !arr[i].cf; this.renderSpecies(corner); });
      $(".sp-name-btn", row).addEventListener("click", () => {
        SpeciesCorrector.open(ids, arr[i].taxon, sp => this.replaceSpeciesAt(corner, i, sp));
      });
      const badge = $(".sp-unconfirmed-badge", row);
      if (badge) badge.addEventListener("click", () => { arr[i].voiceUnconfirmed = false; this.renderSpecies(corner); });
    });
  },

  async addSpecies(corner, sp, opts) {
    opts = opts || {};
    const e = this.current;
    const arr = corner === "nw" ? e.nwSpecies : e.seSpecies;
    if (arr.some(s => s.taxon === sp.t)) {
      if (!opts.silent) toast("Already in the list");
      return { added: false };
    }
    arr.push({
      taxon: sp.t, family: sp.f || "", native: sp.n || "", grain: "10", cover: "",
      cf: false, voiceUnconfirmed: !!opts.unconfirmed, notInChecklist: !!sp.freeText, loggedAt: Date.now(),
    });
    this.renderSpecies(corner);
    return { added: true };
  },

  replaceSpeciesAt(corner, i, sp) {
    const e = this.current;
    const arr = corner === "nw" ? e.nwSpecies : e.seSpecies;
    const old = arr[i];
    if (!old) return;
    arr[i] = { ...old, taxon: sp.t, family: sp.f || "", native: sp.n || "", notInChecklist: !!sp.freeText, voiceUnconfirmed: false };
    this.renderSpecies(corner);
    toast(`Updated to ${sp.t}`, "ok");
  },

  renderCoverList(key) {
    const e = this.current;
    const arr = e[key];
    const host = $("#edgg" + (key === "cover100" ? "Cover100List" : "Cover1000List"));
    if (key === "cover100") $("#edgg100CoverCount").textContent = arr.length ? arr.length : "";
    if (!arr.length) { host.innerHTML = `<div class="empty-note">No spot-check entries yet.</div>`; return; }
    host.innerHTML = arr.map((s, i) => `
      <div class="species-row" data-i="${i}">
        <div class="sp-info">
          <div class="sp-name">${esc(s.taxon)}</div>
          <div class="sp-fam">${esc(s.family || "")}${nativeTagHtml(s.native)}</div>
        </div>
        <input type="number" class="input small sp-cover10" min="0" max="100" step="0.001" placeholder="cov.%" value="${esc(s.cover ?? "")}">
        <button type="button" class="rm-btn" title="Remove">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>`).join("");
    $all(".species-row", host).forEach(row => {
      const i = Number(row.dataset.i);
      $(".sp-cover10", row).addEventListener("change", ev => { arr[i].cover = ev.target.value; });
      $(".rm-btn", row).addEventListener("click", () => { arr.splice(i, 1); this.renderCoverList(key); });
    });
  },

  addCoverEntry(key, sp) {
    const arr = this.current[key];
    if (arr.some(s => s.taxon === sp.t)) { toast("Already in the list"); return; }
    arr.push({ taxon: sp.t, family: sp.f || "", native: sp.n || "", cover: "" });
    this.renderCoverList(key);
  },

  readForm() {
    const e = this.current;
    e.name = $("#edggName").value.trim() || e.name;
    e.date = $("#edggDate").value;
    e.time = $("#edggTime").value;
    e.orientationDev = $("#edggOrientationDev").value;
    e.include1000 = $("#edgg1000Toggle").checked;
    e.nwLat = $("#edggNwLat").value; e.nwLon = $("#edggNwLon").value; e.nwAlt = $("#edggNwAlt").value; e.nwAcc = $("#edggNwAcc").value;
    e.seLat = $("#edggSeLat").value; e.seLon = $("#edggSeLon").value; e.seAlt = $("#edggSeAlt").value; e.seAcc = $("#edggSeAcc").value;
    e.struct.nw = edggReadStructForm("Nw");
    e.struct.se = edggReadStructForm("Se");
    e.biomassEnable = $("#edggBiomassEnable").checked;
    e.biomassCorner = $("#edggBiomassCorner").value;
    if (e.biomassCorner !== "se") e.biomass.nw = edggReadBiomass("Nw");
    if (e.biomassCorner !== "nw") e.biomass.se = edggReadBiomass("Se");
    e.notes = $("#edggNotes").value;
  },

  async save() {
    this.readForm();
    await Store.saveRecord(this.current);
    toast("EDGG plot saved", "ok");
    popView();
    Home.refresh();
  },

  async duplicate() {
    this.readForm();
    const src = this.current;
    const copy = this.blank();
    copy.include1000 = src.include1000;
    copy.orientationDev = src.orientationDev;
    copy.nwSpecies = src.nwSpecies.map(s => ({ ...s }));
    copy.seSpecies = src.seSpecies.map(s => ({ ...s }));
    copy.cover100 = src.cover100.map(s => ({ ...s }));
    copy.cover1000 = src.cover1000.map(s => ({ ...s }));
    copy.struct = { nw: { ...src.struct.nw }, se: { ...src.struct.se } };
    copy.biomassEnable = src.biomassEnable;
    copy.biomassCorner = src.biomassCorner;
    copy.notes = src.notes;
    this.current = copy;
    await this.render();
    toast("Duplicated as a new draft — GPS and photos reset", "ok");
  },

  async remove() {
    if (!confirm("Delete this EDGG plot? This cannot be undone.")) return;
    for (const id of this.current.photoIds) await Store.deletePhoto(id);
    await Store.deleteRecord(this.current.id);
    toast("EDGG plot deleted");
    popView();
    Home.refresh();
  },
};

/* ============================================================
   RECORD LIST RENDERING (shared by Home + Records views)
   ============================================================ */

// An EDGG plot is a relevé recorded with the EDGG protocol, so it groups,
// counts and filters as a relevé throughout the app (its editor stays separate).
function isReleveType(type) { return type === "releve" || type === "edgg"; }

function recordIcon(type) {
  if (type === "releve") return `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 9h10M7 13h10M7 17h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  if (type === "transect") return `<svg viewBox="0 0 24 24"><path d="M3 18c4-8 6 6 10-2 2-4 4-4 8-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="12.2" r="1.4" fill="currentColor"/><circle cx="13.3" cy="14.8" r="1.4" fill="currentColor"/><circle cx="19" cy="11.5" r="1.4" fill="currentColor"/></svg>`;
  if (type === "edgg") return `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="3" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="14" y="14" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;
  return `<svg viewBox="0 0 24 24"><path d="M12 21s-7-5.2-7-10.5C5 6.9 8.1 4 12 4s7 2.9 7 6.5C19 15.8 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="10.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
}

function recordTitle(rec) {
  if (rec.type === "releve" || rec.type === "transect" || rec.type === "edgg") {
    return rec.name || (rec.type === "releve" ? "Relevé" : rec.type === "edgg" ? "EDGG plot" : "Transect");
  }
  return rec.taxon || "Unidentified";
}
function recordSub(rec) {
  const bits = [rec.date];
  if (rec.type === "releve") bits.push(`${rec.species.length} spp.`);
  else if (rec.type === "transect") {
    const unreviewed = rec.species.filter(s => !s.reviewed).length;
    bits.push(`${rec.species.length} spp.${unreviewed ? `, ${unreviewed} to review` : ""}`);
  } else if (rec.type === "edgg") {
    const n = new Set([...rec.nwSpecies.map(s => s.taxon), ...rec.seSpecies.map(s => s.taxon)]).size;
    bits.push("EDGG", `${n} spp.`, rec.include1000 ? "100+1000 m²" : "100 m²");
  } else if (rec.family) bits.push(rec.family);
  if ((rec.lat && rec.lon) || (rec.nwLat && rec.nwLon)) bits.push("GPS");
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
      else if (type === "edgg") EdggEditor.openExisting(id);
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
    // EDGG plots are a kind of relevé, so they're counted as relevés.
    const releveCount = records.filter(r => isReleveType(r.type)).length;
    const observationCount = records.filter(r => r.type === "observation").length;
    const transectCount = records.filter(r => r.type === "transect").length;
    const edggCount = records.filter(r => r.type === "edgg").length;
    const speciesSet = new Set();
    records.forEach(r => {
      if (r.type === "releve" || r.type === "transect") r.species.forEach(s => speciesSet.add(s.taxon));
      else if (r.type === "edgg") { r.nwSpecies.forEach(s => speciesSet.add(s.taxon)); r.seSpecies.forEach(s => speciesSet.add(s.taxon)); }
      else if (r.taxon) speciesSet.add(r.taxon);
    });

    $("#homeStats").innerHTML = `
      <div class="stat-card"><div class="n">${releveCount}</div><div class="l">Relevés${edggCount ? ` <span class="stat-sub">${edggCount} EDGG</span>` : ""}</div></div>
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
      // EDGG plots are relevés, so the "Relevés" filter includes them.
      const bucket = isReleveType(r.type) ? "releve" : r.type;
      if (!activeTypes.includes(bucket)) return false;
      if (!q) return true;
      const hay = r.type === "releve"
        ? [r.name, r.habitat, ...r.species.map(s => s.taxon)].join(" ").toLowerCase()
        : r.type === "transect"
        ? [r.name, r.notes, ...r.species.map(s => s.taxon)].join(" ").toLowerCase()
        : r.type === "edgg"
        ? [r.name, r.notes, ...r.nwSpecies.map(s => s.taxon), ...r.seSpecies.map(s => s.taxon)].join(" ").toLowerCase()
        : [r.taxon, r.family, r.notes].join(" ").toLowerCase();
      return hay.includes(q);
    });
    renderRecordList(filtered, $("#recordsListFull"));
  },
};

/* ============================================================
   SETTINGS VIEW
   ============================================================ */

/* ============================================================
   AI-ENHANCED VOICE MATCHING (experimental, on-device Whisper)
   Lazily imports whisper.js (which itself imports the vendored
   transformers.js + fetches model weights from the HF Hub CDN on
   first use) only once the user opts in — nothing here downloads
   or runs at normal page load. See whisper.js for the actual
   audio-conditioned scoring implementation.
   ============================================================ */

const AiVoice = {
  mod: null,       // window.WhisperVoice, once whisper.js has been imported
  loading: false,
  error: null,

  setStatus(text) { const el = $("#aiVoiceStatus"); if (el) el.textContent = text || ""; },

  async ensureModuleImported() {
    if (this.mod) return this.mod;
    await import("./whisper.js");
    this.mod = window.WhisperVoice;
    return this.mod;
  },

  async ensureLoaded() {
    if (this.mod && this.mod.isLoaded()) return true;
    if (this.loading) return false;
    this.loading = true;
    this.error = null;
    $("#aiVoiceDownloadBtn").hidden = true;
    try {
      const mod = await this.ensureModuleImported();
      if (!mod.isSupported()) {
        this.error = "Not supported in this browser (needs WebAssembly + microphone access).";
        this.setStatus(this.error);
        return false;
      }
      const settings = await Store.getSettings();
      mod.setQuality(settings.aiVoiceQuality || "accurate");
      mod.setLanguage(settings.aiVoiceLang || "multi");
      this.setStatus("Preparing…");
      await mod.loadModel(p => {
        if (p && p.status === "progress" && p.total) {
          const pct = Math.round((p.loaded / p.total) * 100);
          this.setStatus(`Downloading model — ${p.file || ""} ${pct}%`);
        } else if (p && p.status === "ready") {
          this.setStatus("Ready.");
        }
      });
      this.setStatus("Ready — on-device voice matching is active.");
      return true;
    } catch (e) {
      console.error(e);
      this.error = "Couldn't load the model: " + (e.message || e);
      this.setStatus(this.error);
      $("#aiVoiceDownloadBtn").hidden = false;
      return false;
    } finally {
      this.loading = false;
    }
  },

  async refreshStatus() {
    const settings = await Store.getSettings();
    $("#aiVoiceEnabled").checked = !!settings.aiVoiceEnabled;
    if ($("#aiVoiceQuality")) $("#aiVoiceQuality").value = settings.aiVoiceQuality || "accurate";
    if ($("#aiVoiceLang")) $("#aiVoiceLang").value = settings.aiVoiceLang || "multi";
    if (!settings.aiVoiceEnabled) { this.setStatus(""); $("#aiVoiceDownloadBtn").hidden = true; return; }
    if (this.mod && this.mod.isLoaded()) { this.setStatus("Ready — on-device voice matching is active."); return; }
    if (this.error) { this.setStatus(this.error); $("#aiVoiceDownloadBtn").hidden = false; return; }
    this.ensureLoaded();
  },
};

const Settings = {
  async refresh() {
    $("#appVersion").textContent = APP_VERSION;
    const settings = await Store.getSettings();
    $("#defaultScaleSelect").value = settings.defaultScale || "bb";
    $("#gpsThresholdInput").value = settings.gpsThreshold || 10;
    $("#voiceSpeakFeedback").checked = settings.voiceSpeakFeedback !== false;
    $("#contextPriors").checked = settings.contextPriors !== false;
    $("#voiceReviewCheckpointInput").value = settings.voiceReviewCheckpoint || 30;
    await AiVoice.refreshStatus();

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

  const releveRows = [["id", "name", "date", "time", "lat", "lon", "alt", "accuracy_m", "area_m2", "slope_deg", "aspect", "habitat", "typoch_code", "typoch_id", "typoch_name", "cover_tree_pct", "cover_shrub_pct", "cover_herb_pct", "cover_moss_pct", "cover_scale", "cover_pct_mode", "assessment_method", "nested_enabled", "nesting_type", "progression_preset", "area_progression_m2", "se_lat", "se_lon", "species_count", "notes"]];
  const speciesRows = [["releve_id", "releve_name", "taxon", "family", "native", "cf", "not_in_checklist", "layer", "cover", "grain_m2", "corner", "logged_at"]];
  releves.forEach(r => {
    releveRows.push([r.id, r.name, r.date, r.time, r.lat, r.lon, r.alt, r.acc, r.area, r.slope, r.aspect, r.habitat, r.typoCode || "", r.typoId || "", r.typoName || "", r.coverTree, r.coverShrub, r.coverHerb, r.coverMoss, r.coverScale, r.coverScale === "pct" ? coverPctMode(r) : "", r.assessmentMethod || "", r.nestedEnabled ? "yes" : "no", r.nestedEnabled ? r.nestingType : "", r.nestedEnabled ? r.progressionPreset : "", r.nestedEnabled ? activeProgression(r).join("/") : "", r.nestedEnabled && r.nestingType === "corner" ? r.seLat : "", r.nestedEnabled && r.nestingType === "corner" ? r.seLon : "", r.species.length, r.notes]);
    r.species.forEach(s => speciesRows.push([r.id, r.name, s.taxon, s.family, s.native || "", s.cf ? "yes" : "no", s.notInChecklist ? "yes" : "no", s.layer, s.cover, r.nestedEnabled ? (s.grain || "") : "", r.nestedEnabled && r.nestingType === "corner" ? (s.corner || "") : "", s.loggedAt ? new Date(s.loggedAt).toISOString() : ""]));
  });

  const observationRows = [["id", "taxon", "family", "native", "cf", "not_in_checklist", "date", "time", "lat", "lon", "notes"]];
  observations.forEach(s => observationRows.push([s.id, s.taxon, s.family, s.native || "", s.cf ? "yes" : "no", s.notInChecklist ? "yes" : "no", s.date, s.time, s.lat, s.lon, s.notes]));

  const transectRows = [["id", "name", "date", "time", "lat", "lon", "alt", "accuracy_m", "species_count", "notes"]];
  const transectSpeciesRows = [["transect_id", "transect_name", "taxon", "family", "native", "cf", "not_in_checklist", "certainty", "reviewed", "source", "logged_at"]];
  transects.forEach(t => {
    transectRows.push([t.id, t.name, t.date, t.time, t.lat, t.lon, t.alt, t.acc, t.species.length, t.notes]);
    t.species.forEach(s => transectSpeciesRows.push([t.id, t.name, s.taxon, s.family, s.native || "", s.cf ? "yes" : "no", s.notInChecklist ? "yes" : "no", (s.certainty ?? 1).toFixed(2), s.reviewed ? "yes" : "no", s.source || "", s.loggedAt ? new Date(s.loggedAt).toISOString() : ""]));
  });

  const edggPlots = records.filter(r => r.type === "edgg");
  const edggRows = [["id", "name", "date", "time", "include_1000m2", "orientation_deviation_deg", "nw_lat", "nw_lon", "nw_alt", "nw_accuracy_m", "se_lat", "se_lon", "se_alt", "se_accuracy_m", "nw_species_count", "se_species_count", "biomass_sampled", "biomass_corner", "notes"]];
  const edggSpeciesRows = [["plot_id", "plot_name", "corner", "taxon", "family", "native", "cf", "not_in_checklist", "smallest_grain_m2", "cover_10m2_pct", "logged_at"]];
  const edggCoverRows = [["plot_id", "plot_name", "plot_size", "taxon", "family", "native", "cover_pct"]];
  const structKeys = EDGG_STRUCT_FIELD_KEYS.map(edggStructKeyToObjKey);
  const edggStructRows = [["plot_id", "plot_name", "corner", ...structKeys, "std_height_1_5_cm", "soil_depth_1_5_cm"]];
  const edggBiomassRows = [["plot_id", "plot_name", "corner", "necromass_g_per_m2", "bryophytes_lichens_g_per_m2", "herbs_g_per_m2", "woody_g_per_m2"]];
  edggPlots.forEach(e => {
    edggRows.push([e.id, e.name, e.date, e.time, e.include1000 ? "yes" : "no", e.orientationDev, e.nwLat, e.nwLon, e.nwAlt, e.nwAcc, e.seLat, e.seLon, e.seAlt, e.seAcc, e.nwSpecies.length, e.seSpecies.length, e.biomassEnable ? "yes" : "no", e.biomassEnable ? e.biomassCorner : "", e.notes]);
    [["NW", e.nwSpecies], ["SE", e.seSpecies]].forEach(([corner, arr]) => {
      arr.forEach(s => edggSpeciesRows.push([e.id, e.name, corner, s.taxon, s.family, s.native || "", s.cf ? "yes" : "no", s.notInChecklist ? "yes" : "no", s.grain, s.cover, s.loggedAt ? new Date(s.loggedAt).toISOString() : ""]));
    });
    e.cover100.forEach(s => edggCoverRows.push([e.id, e.name, "100", s.taxon, s.family, s.native || "", s.cover]));
    e.cover1000.forEach(s => edggCoverRows.push([e.id, e.name, "1000", s.taxon, s.family, s.native || "", s.cover]));
    [["NW", e.struct.nw], ["SE", e.struct.se]].forEach(([corner, st]) => {
      st = st || {};
      edggStructRows.push([e.id, e.name, corner, ...structKeys.map(k => st[k] ?? ""), (st.stdHeight || []).join("/"), (st.soilDepth || []).join("/")]);
    });
    if (e.biomassEnable) {
      [["NW", e.biomass.nw], ["SE", e.biomass.se]].forEach(([corner, b]) => {
        if (e.biomassCorner !== "both" && e.biomassCorner.toUpperCase() !== corner) return;
        b = b || {};
        const perM2 = v => v === "" || v == null || isNaN(Number(v)) ? "" : (Number(v) / 0.08).toFixed(1);
        edggBiomassRows.push([e.id, e.name, corner, perM2(b.necromass), perM2(b.bryo), perM2(b.herb), perM2(b.woody)]);
      });
    }
  });

  const zipLike = [
    "# releves.csv\n" + toCsv(releveRows),
    "# releves_species.csv\n" + toCsv(speciesRows),
    "# observations.csv\n" + toCsv(observationRows),
    "# transects.csv\n" + toCsv(transectRows),
    "# transects_species.csv\n" + toCsv(transectSpeciesRows),
    "# edgg_plots.csv\n" + toCsv(edggRows),
    "# edgg_species.csv\n" + toCsv(edggSpeciesRows),
    "# edgg_cover_spotcheck.csv\n" + toCsv(edggCoverRows),
    "# edgg_structural.csv\n" + toCsv(edggStructRows),
    "# edgg_biomass.csv\n" + toCsv(edggBiomassRows),
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
  // A relevé is either free-form or follows the EDGG protocol (a particular
  // kind of relevé), so "New relevé" asks which before opening the editor.
  const closeProtocol = () => { $("#protocolModal").hidden = true; };
  $("#newReleveBtn").addEventListener("click", () => { $("#protocolModal").hidden = false; });
  $("#protocolModalClose").addEventListener("click", closeProtocol);
  $("#protocolModal").addEventListener("click", e => { if (e.target.id === "protocolModal") closeProtocol(); });
  $("#protocolStandardBtn").addEventListener("click", () => { closeProtocol(); ReleveEditor.openNew(); });
  $("#protocolEdggBtn").addEventListener("click", () => { closeProtocol(); EdggEditor.openNew(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#protocolModal").hidden) closeProtocol(); });
  $("#newObservationBtn").addEventListener("click", () => ObservationEditor.openNew());
  $("#newTransectBtn").addEventListener("click", () => TransectEditor.openNew());
  $("#seeAllBtn").addEventListener("click", () => { resetToTab("records"); pushView("records"); Records.refresh(); });
}

/* Keep a location map in sync with its lat/lon fields (typed edits
   and GPS-capture updates alike), and fix Leaflet's sizing when its
   <details> fold is opened after being hidden. */
function wireLiveMapUpdates(latEl, lonEl, getMap, accEl) {
  const update = () => {
    const m = getMap(); if (m) m.update(latEl.value, lonEl.value, accEl ? accEl.value : null);
    // Refresh the nearby-species prior for this location (fires on GPS capture,
    // which dispatches input events, and on manual coordinate edits).
    ContextPriors.setLocation(latEl.value, lonEl.value);
  };
  latEl.addEventListener("input", update);
  lonEl.addEventListener("input", update);
  if (accEl) accEl.addEventListener("input", update);
  const fold = latEl.closest("details.fold");
  if (fold) fold.addEventListener("toggle", () => { if (fold.open) { const m = getMap(); if (m) m.invalidate(); } });
}

function wireTransectEditor() {
  TransectEditor._gps = wireGpsButton($("#transectGpsBtn"), $("#transectGpsStatus"), $("#transectLat"), $("#transectLon"), $("#transectAlt"), $("#transectAcc"), "transect");
  wireLiveMapUpdates($("#transectLat"), $("#transectLon"), () => TransectEditor._map, $("#transectAcc"));
  wireAutocomplete($("#transectSearchInput"), $("#transectAcMenu"), sp => TransectEditor.addSpecies(sp));
  wireVoiceLogging($("#transectVoiceLogBtn"), $("#transectVoiceLogStatus"), "transect", (sp, opts) => TransectEditor.addSpecies(sp, opts));
  $("#transectReviewBtn").addEventListener("click", () => TransectReview.open());
  $("#transectSortSelect").addEventListener("change", () => TransectEditor.renderSpecies());
  $("#transectSaveBtn").addEventListener("click", () => TransectEditor.save());
  $("#transectDuplicateBtn").addEventListener("click", () => TransectEditor.duplicate());
  $("#transectDeleteBtn").addEventListener("click", () => TransectEditor.remove());
}

function wireTransectReview() {
  $("#reviewApproveAllBtn").addEventListener("click", () => TransectReview.approveAllAbove(0.9));
}

// Free-text search over the whole TypoCH habitat typology (by name in any
// language, phytosociological alliance, or code) — the manual alternative to
// the species-based suggestions.
function wireHabitatSearch() {
  const input = $("#habitatSearchInput"), menu = $("#habitatAcMenu");
  if (!input) return;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    if (!q || !TypoCH.available()) { menu.classList.remove("show"); return; }
    const scored = [];
    for (const h of TypoCH.habitats) {
      const fields = [h.code, h.de, h.fr, h.it, h.sci].filter(Boolean).map(x => x.toLowerCase());
      let best = 0;
      for (const f of fields) {
        if (f === q) { best = Math.max(best, 4); }
        else if (f.startsWith(q)) best = Math.max(best, 3);
        else if (f.includes(q)) best = Math.max(best, 2);
      }
      if (h.code.replace(/[.\-]/g, "").startsWith(q.replace(/[.\-]/g, ""))) best = Math.max(best, 3);
      if (best) scored.push({ h, best });
    }
    scored.sort((a, b) => b.best - a.best || a.h.code.localeCompare(b.h.code));
    const top = scored.slice(0, 12);
    if (!top.length) { menu.innerHTML = `<div class="ac-empty">No habitat matches.</div>`; menu.classList.add("show"); return; }
    menu.innerHTML = top.map(({ h }) => `
      <div class="ac-item" data-id="${h.id}">
        <div class="sp-name">${esc(TypoCH.name(h))}</div>
        <div class="fam">${esc(h.code)}${h.sci ? " · " + esc(h.sci) : ""}</div>
      </div>`).join("");
    menu.classList.add("show");
    $all(".ac-item", menu).forEach(el => el.addEventListener("mousedown", ev => {
      ev.preventDefault();
      ReleveEditor.selectHabitat(el.dataset.id);
      input.value = ""; menu.classList.remove("show");
    }));
  };
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("blur", () => setTimeout(() => menu.classList.remove("show"), 150));
}

function wireReleveEditor() {
  ReleveEditor._gps = wireGpsButton($("#releveGpsBtn"), $("#releveGpsStatus"), $("#releveLat"), $("#releveLon"), $("#releveAlt"), $("#releveAcc"), "releve");
  wireLiveMapUpdates($("#releveLat"), $("#releveLon"), () => ReleveEditor._map, $("#releveAcc"));
  wireAutocomplete($("#speciesSearchInput"), $("#speciesAcMenu"), sp => ReleveEditor.addSpecies(sp));
  wireVoiceLogging($("#voiceLogBtn"), $("#voiceLogStatus"), "releve", (sp, opts) => ReleveEditor.addSpecies(sp, opts));
  $("#coverScaleSelect").addEventListener("change", () => {
    ReleveEditor.current.coverScale = $("#coverScaleSelect").value;
    ReleveEditor.renderCoverPctMode();
    ReleveEditor.renderSpecies();
  });
  $all('input[name="coverPctMode"]').forEach(el => el.addEventListener("change", () => {
    ReleveEditor.current.coverPctMode = el.value;
    ReleveEditor.renderCoverSummary();
  }));
  $("#releveSortSelect").addEventListener("change", () => ReleveEditor.renderSpecies());
  wireHabitatSearch();
  $("#relevePhotoInput").addEventListener("change", e => addPhotosFromInput(e.target, ReleveEditor.current.photoIds, $("#relevePhotos")));
  $("#releveSaveBtn").addEventListener("click", () => ReleveEditor.save());
  $("#releveDuplicateBtn").addEventListener("click", () => ReleveEditor.duplicate());
  $("#releveDeleteBtn").addEventListener("click", () => ReleveEditor.remove());

  ReleveEditor._gpsSeNested = wireGpsButton($("#nestedSeGpsBtn"), $("#nestedSeGpsStatus"), $("#nestedSeLat"), $("#nestedSeLon"), $("#nestedSeAlt"), $("#nestedSeAcc"), "releve");
  wireLiveMapUpdates($("#nestedSeLat"), $("#nestedSeLon"), () => ReleveEditor._mapSe, $("#nestedSeAcc"));

  $("#nestedEnableBox").addEventListener("change", () => {
    ReleveEditor.current.nestedEnabled = $("#nestedEnableBox").checked;
    ReleveEditor.renderNested();
    ReleveEditor.renderSpecies();
  });
  $all('input[name="nestingType"]').forEach(el => el.addEventListener("change", () => {
    if (!el.checked) return;
    ReleveEditor.current.nestingType = el.value;
    ReleveEditor.renderNested();
    ReleveEditor.renderSpecies();
  }));
  $all('input[name="progressionPreset"]').forEach(el => el.addEventListener("change", () => {
    if (!el.checked) return;
    ReleveEditor.current.progressionPreset = el.value;
    ReleveEditor.renderNested();
    ReleveEditor.renderSpecies();
  }));
  $("#customProgressionInput").addEventListener("change", () => {
    ReleveEditor.current.customProgression = $("#customProgressionInput").value;
    ReleveEditor.renderNested();
    ReleveEditor.renderSpecies();
  });
}

function wireObservationEditor() {
  ObservationEditor._gps = wireGpsButton($("#observationGpsBtn"), $("#observationGpsStatus"), $("#observationLat"), $("#observationLon"), null, null, "observation");
  wireLiveMapUpdates($("#observationLat"), $("#observationLon"), () => ObservationEditor._map);
  wireAutocomplete($("#observationTaxonInput"), $("#observationAcMenu"), sp => ObservationEditor.setTaxon(sp));
  wireDictation($("#observationDictateBtn"), $("#observationTaxonInput"), $("#observationAcMenu"), $("#observationDictateStatus"), sp => ObservationEditor.setTaxon(sp));
  // Two-step guided dictation (genus → species) — only where the device
  // recognizer exists, since it drives the guided flow.
  if (window.SpeechRecognition || window.webkitSpeechRecognition) {
    const tsBtn = $("#observationTwoStepBtn");
    tsBtn.hidden = false;
    tsBtn.addEventListener("click", () => twoStepDictation(
      $("#observationTaxonInput"), $("#observationAcMenu"), t => { $("#observationDictateStatus").textContent = t || ""; },
      sp => ObservationEditor.setTaxon(sp), tsBtn));
  }
  $("#observationPhotoInput").addEventListener("change", e => addPhotosFromInput(e.target, ObservationEditor.current.photoIds, $("#observationPhotos")));
  $("#observationSaveBtn").addEventListener("click", () => ObservationEditor.save());
  $("#observationDeleteBtn").addEventListener("click", () => ObservationEditor.remove());
}

function wireEdggEditor() {
  EdggEditor._gpsNw = wireGpsButton($("#edggNwGpsBtn"), $("#edggNwGpsStatus"), $("#edggNwLat"), $("#edggNwLon"), $("#edggNwAlt"), $("#edggNwAcc"), "edgg");
  EdggEditor._gpsSe = wireGpsButton($("#edggSeGpsBtn"), $("#edggSeGpsStatus"), $("#edggSeLat"), $("#edggSeLon"), $("#edggSeAlt"), $("#edggSeAcc"), "edgg");
  wireLiveMapUpdates($("#edggNwLat"), $("#edggNwLon"), () => EdggEditor._mapNw, $("#edggNwAcc"));
  wireLiveMapUpdates($("#edggSeLat"), $("#edggSeLon"), () => EdggEditor._mapSe, $("#edggSeAcc"));

  wireAutocomplete($("#edggNwSearchInput"), $("#edggNwAcMenu"), sp => EdggEditor.addSpecies("nw", sp));
  wireAutocomplete($("#edggSeSearchInput"), $("#edggSeAcMenu"), sp => EdggEditor.addSpecies("se", sp));
  wireVoiceLogging($("#edggNwVoiceLogBtn"), $("#edggNwVoiceLogStatus"), "edgg", (sp, opts) => EdggEditor.addSpecies("nw", sp, opts));
  wireVoiceLogging($("#edggSeVoiceLogBtn"), $("#edggSeVoiceLogStatus"), "edgg", (sp, opts) => EdggEditor.addSpecies("se", sp, opts));
  $("#edggNwSortSelect").addEventListener("change", () => EdggEditor.renderSpecies("nw"));
  $("#edggSeSortSelect").addEventListener("change", () => EdggEditor.renderSpecies("se"));

  wireAutocomplete($("#edggCover100SearchInput"), $("#edggCover100AcMenu"), sp => EdggEditor.addCoverEntry("cover100", sp));
  wireAutocomplete($("#edggCover1000SearchInput"), $("#edggCover1000AcMenu"), sp => EdggEditor.addCoverEntry("cover1000", sp));

  $("#edgg1000Toggle").addEventListener("change", () => {
    EdggEditor.current.include1000 = $("#edgg1000Toggle").checked;
    $("#edgg1000Instructions").hidden = !EdggEditor.current.include1000;
    $("#edggCover1000Section").hidden = !EdggEditor.current.include1000;
    $("#edggDiagram").innerHTML = edggDiagramSvg(EdggEditor.current.include1000);
  });

  $("#edggBiomassEnable").addEventListener("change", () => {
    $("#edggBiomassFields").hidden = !$("#edggBiomassEnable").checked;
  });
  $("#edggBiomassCorner").addEventListener("change", () => {
    const v = $("#edggBiomassCorner").value;
    $("#edggBiomassNw").hidden = v === "se";
    $("#edggBiomassSe").hidden = v === "nw";
  });

  $("#edggPhotoInput").addEventListener("change", e => addPhotosFromInput(e.target, EdggEditor.current.photoIds, $("#edggPhotos")));
  $("#edggSaveBtn").addEventListener("click", () => EdggEditor.save());
  $("#edggDuplicateBtn").addEventListener("click", () => EdggEditor.duplicate());
  $("#edggDeleteBtn").addEventListener("click", () => EdggEditor.remove());
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
  $("#contextPriors").addEventListener("change", async () => {
    const s = await Store.getSettings();
    s.contextPriors = $("#contextPriors").checked;
    await Store.saveSettings(s);
    ContextPriors.enabled = s.contextPriors;
    if (s.contextPriors && !ContextPriors.freq) ContextPriors.loadFreq();
  });
  $("#voiceReviewCheckpointInput").addEventListener("change", async () => {
    const s = await Store.getSettings();
    s.voiceReviewCheckpoint = Math.max(5, Number($("#voiceReviewCheckpointInput").value) || 30);
    $("#voiceReviewCheckpointInput").value = s.voiceReviewCheckpoint;
    await Store.saveSettings(s);
  });
  $("#aiVoiceEnabled").addEventListener("change", async () => {
    const s = await Store.getSettings();
    s.aiVoiceEnabled = $("#aiVoiceEnabled").checked;
    await Store.saveSettings(s);
    await AiVoice.refreshStatus();
  });
  $("#aiVoiceDownloadBtn").addEventListener("click", () => AiVoice.ensureLoaded());
  $("#aiVoiceLang").addEventListener("change", async () => {
    const s = await Store.getSettings();
    s.aiVoiceLang = $("#aiVoiceLang").value;
    await Store.saveSettings(s);
    // No reload needed — language only changes which decoder prompt is used.
    if (AiVoice.mod && AiVoice.mod.setLanguage) AiVoice.mod.setLanguage(s.aiVoiceLang);
  });
  $("#aiVoiceQuality").addEventListener("change", async () => {
    const s = await Store.getSettings();
    s.aiVoiceQuality = $("#aiVoiceQuality").value;
    await Store.saveSettings(s);
    if (AiVoice.mod && AiVoice.mod.isLoaded()) {
      AiVoice.setStatus("Model size changes take effect after you reload the app.");
    }
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
  wireNav(); wireHome(); wireInfoModal(); wireReleveEditor(); wireObservationEditor(); wireTransectEditor(); wireTransectReview(); wireEdggEditor(); wireRecords(); wireSettings(); wireNetStatus();
  showView("home");
  try {
    await Species.loadAll();
  } catch (e) {
    toast("Could not load species database", "err");
    console.error(e);
  }
  await Home.refresh();
  const settings = await Store.getSettings();
  // Context priors: load the bundled national frequency table (always on if
  // present) so common-species ranking works from the first dictation.
  ContextPriors.enabled = settings.contextPriors !== false;
  if (ContextPriors.enabled) ContextPriors.loadFreq();
  // Load the Swiss habitat typology if a Swiss checklist is active (enables
  // habitat analysis from species lists in the relevé editor).
  if (Species.packs.some(p => (p.region || "").toLowerCase().includes("switzerland"))) TypoCH.load();
  // If AI-enhanced voice matching was already enabled in a previous session,
  // start warming it up now (from browser cache — no re-download) instead of
  // only on the next Settings visit, so it's ready by the time it's needed.
  if (settings.aiVoiceEnabled) AiVoice.ensureLoaded();
}

document.addEventListener("DOMContentLoaded", init);
