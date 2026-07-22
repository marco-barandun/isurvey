// =============================================================================
// whisper.js — experimental on-device audio-conditioned species matching
//
// Bypasses the Web Speech API entirely: records raw microphone audio, runs it
// through an on-device Whisper model (transformers.js, vendored — no CDN),
// and instead of trusting Whisper's free-form transcript at face value, scores
// the AUDIO directly against every plausible candidate taxon name via
// teacher-forced decoding — "how well does this recording match THIS exact
// string" for each candidate, not "what did the model guess, then how close
// is that guess (as text) to a real name."
//
// This is a separate ES module (transformers.js is ESM-only) that exposes a
// small API on window.WhisperVoice for the classic-script app.js to call.
// Loaded lazily — nothing here downloads or runs until the user opts in via
// Settings, since the model is a real download (tens of MB) fetched from
// Hugging Face's CDN on first use, then cached by the browser for offline
// reuse afterward (same "needs network once" carve-out as the existing
// Web Speech API voice features — see README).
// =============================================================================

import {
  env, AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, Tensor,
} from "./vendor/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;

// Two model sizes, chosen in Settings. tiny is ~40 MB and fast; base is
// ~77 MB and markedly more accurate on the unusual (Latin) words this app
// lives on — the default, since near-perfect recognition is the point and
// the download happens once. Both work through the identical code path
// below because the decoder-cache tensor shapes are read from each model's
// config at load time rather than hard-coded.
const QUALITY_MODELS = { fast: "Xenova/whisper-tiny", accurate: "Xenova/whisper-base" };
let MODEL_ID = QUALITY_MODELS.accurate;

// Change the model size to load. Ignored once a model is already loaded for
// this session (takes effect on the next page load) — swapping a loaded ONNX
// session mid-session isn't worth the complexity here.
function setQuality(q) {
  if (state.loaded || state.loading) return;
  MODEL_ID = QUALITY_MODELS[q] || QUALITY_MODELS.accurate;
}

// Beam width used when transcribing under a SINGLE language (better quality
// than greedy for that one pass). In multilingual mode each language is
// decoded greedily instead — the diversity across languages already does the
// job of a beam, at a fraction of the cost.
const BEAM_WIDTH = 4;

// --- Recognition languages ------------------------------------------------
// The single biggest lever for accent robustness. A Latin binomial spoken by
// an Italian, German or French botanist is transcribed FAR more faithfully
// when Whisper decodes it under that speaker's own language than through an
// English lens — and the teacher-forced acoustic score is only meaningful
// when computed under the same language the utterance was produced in. So
// recognition can run under one chosen language, or "multilingual": decode
// the utterance under several languages at once, union all their transcripts
// into the shortlist (recall), and rescore every candidate under each
// language taking the best (the acoustic match then reflects whatever
// language the speaker's pronunciation is actually closest to).
const SUPPORTED_LANGS = ["en", "it", "de", "fr"];
const LANG_SETS = {
  multi: ["en", "it", "de", "fr"],
  en: ["en"], it: ["it"], de: ["de"], fr: ["fr"],
};
let LANG_PREF = "multi";

// Set which language(s) recognition runs under. Safe to call any time — it
// only changes which decoder prompt tokens are used, no model reload needed.
function setLanguage(pref) {
  LANG_PREF = LANG_SETS[pref] ? pref : "multi";
}
function activeLangs() { return LANG_SETS[LANG_PREF] || LANG_SETS.multi; }

const state = {
  loaded: false,
  loading: null,
  tokenizer: null,
  processor: null,
  model: null,
  promptIdsByLang: null, // { en:[sot,<|en|>,transcribe,notimestamps], it:[…], … }
  dims: null,            // { layers, heads, headDim } — from the loaded model's config
};

async function loadModel(onProgress) {
  if (state.loaded) return;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    const opts = { progress_callback: onProgress };
    state.tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, opts);
    state.processor = await AutoProcessor.from_pretrained(MODEL_ID, opts);
    // Pinned to transformers.js 3.1.0 specifically because it's the one
    // release pinning a stable (non-nightly) onnxruntime-web — every other
    // release (including all of 4.x) bundles an ORT dev build, and 1.25+
    // has a real regression (microsoft/onnxruntime#28306) that fails to
    // create a session for Whisper's merged decoder graph at all, quantized
    // or not. "quantized: true" is this older version's loading option.
    state.model = await WhisperForConditionalGeneration.from_pretrained(MODEL_ID, { ...opts, quantized: true });
    const tok = s => state.tokenizer.model.tokens_to_ids.get(s);
    // Precompute the decoder prompt for every supported language once, so both
    // transcription and teacher-forced scoring can switch language for free.
    state.promptIdsByLang = {};
    for (const lang of SUPPORTED_LANGS) {
      state.promptIdsByLang[lang] = [tok("<|startoftranscript|>"), tok(`<|${lang}|>`), tok("<|transcribe|>"), tok("<|notimestamps|>")];
    }
    // Decoder KV-cache placeholder tensors (below) must match THIS model's
    // shape, which differs by size (tiny: 4 layers / 6 heads; base: 6 / 8),
    // so read it from the config instead of hard-coding one model's numbers.
    const c = state.model.config;
    const layers = c.decoder_layers || c.num_hidden_layers;
    const heads = c.decoder_attention_heads;
    state.dims = { layers, heads, headDim: Math.round(c.d_model / heads) };
    state.loaded = true;
  })();
  try {
    await state.loading;
  } finally {
    state.loading = null;
  }
}

function isSupported() {
  return !!(window.WebAssembly && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

// ---- microphone capture: record to a Blob, decode + resample to 16kHz mono
// Float32Array PCM (what Whisper's feature extractor expects). MediaRecorder
// + decodeAudioData is used instead of ScriptProcessorNode/AudioWorklet — far
// less code, no feedback-loop footguns, and resampling is needed regardless
// of capture method since mic hardware is essentially never natively 16kHz.

let activeStream = null, activeRecorder = null;

async function startRecording() {
  activeStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const chunks = [];
  activeRecorder = new MediaRecorder(activeStream);
  activeRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve, reject) => {
    activeRecorder.onstop = () => resolve(new Blob(chunks, { type: activeRecorder.mimeType }));
    activeRecorder.onerror = reject;
  });
  activeRecorder.start();
  return stopped;
}

function stopRecording() {
  if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
  if (activeStream) activeStream.getTracks().forEach(t => t.stop());
}

async function blobToPCM16k(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await tempCtx.decodeAudioData(arrayBuf);
  } finally {
    tempCtx.close();
  }
  const targetLen = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offline = new OfflineAudioContext(1, targetLen, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// ---- continuous hands-free capture (voice activity detection) ------------
// Whisper has no built-in equivalent of the Web Speech API's continuous
// mode with auto-endpointing, so this builds the same idea directly: keep
// one mic stream open, watch its volume via an AnalyserNode, and treat a
// sustained rise as the start of an utterance and a sustained drop as its
// end — each utterance becomes its own MediaRecorder-captured Blob, handed
// to the caller one at a time. This naturally splits "species said one at a
// time while walking" the same way a pause between words splits Web Speech
// API results; it does NOT split two names said back-to-back with too
// short a pause (no equivalent of the text-based DP segmenter used for
// that case in the Web Speech path) — a known, accepted gap for now.
// Voice-activity thresholds are set RELATIVE to the measured ambient noise
// floor rather than a fixed value, so the same code works in a still room and
// in wind/traffic: at startup it samples the background for a moment to learn
// the floor, then keeps adapting it slowly whenever no one's talking. Speech
// has to rise clearly above that floor to start a segment (VAD_FLOOR_MARGIN),
// and only has to stay a bit above it to keep going (hysteresis), so a name
// isn't chopped mid-word by a brief dip.
const VAD_FLOOR_MARGIN = 2.6;   // speech must exceed noiseFloor × this to START
const VAD_HYSTERESIS = 0.55;    // ...and stay above START × this to CONTINUE
const VAD_MIN_THRESH = 0.014;   // floor on the start threshold (very quiet rooms)
const VAD_MAX_THRESH = 0.16;    // ceiling (so loud wind can't disable detection entirely)
const VAD_FLOOR_EMA = 0.05;     // how fast the noise floor tracks changing ambient
const VAD_CALIB_MS = 500;       // initial ambient-sampling window
const VAD_SILENCE_MS = 600;     // sustained silence (below stop threshold) to end an utterance
const VAD_MIN_SPEECH_MS = 200;  // shorter blips are discarded as noise
const VAD_MAX_SPEECH_MS = 8000; // force-cut a runaway segment (e.g. steady wind)
const VAD_POLL_MS = 100;

async function startContinuousCapture(onSegment) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const AC = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AC();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const timeData = new Uint8Array(analyser.fftSize);

  let recorder = null, chunks = [], speaking = false, speechStartAt = 0, silenceStartAt = 0;
  let noiseFloor = VAD_MIN_THRESH / VAD_FLOOR_MARGIN;
  const calibSamples = [];
  const calibStart = Date.now();
  let calibrated = false;

  function rmsLevel() {
    analyser.getByteTimeDomainData(timeData);
    let sumSq = 0;
    for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sumSq += v * v; }
    return Math.sqrt(sumSq / timeData.length);
  }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function beginSegment() {
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
    speaking = true;
    speechStartAt = Date.now();
    silenceStartAt = 0;
  }
  function endSegment() {
    if (!recorder) return;
    const rec = recorder, startedAt = speechStartAt;
    recorder = null;
    speaking = false;
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType });
      if (blob.size && Date.now() - startedAt >= VAD_MIN_SPEECH_MS) onSegment(blob);
    };
    try { rec.stop(); } catch { /* already inactive */ }
  }

  const intervalId = setInterval(() => {
    const level = rmsLevel(), now = Date.now();

    // Learn the ambient floor from the opening window (a low percentile, so a
    // stray sound during calibration doesn't inflate it), then keep tracking.
    if (!calibrated) {
      calibSamples.push(level);
      if (now - calibStart >= VAD_CALIB_MS) {
        const sorted = calibSamples.slice().sort((a, b) => a - b);
        noiseFloor = sorted[Math.floor(sorted.length * 0.3)] || noiseFloor;
        calibrated = true;
      }
      return; // don't detect speech until the floor is known
    }

    const startThresh = clamp(noiseFloor * VAD_FLOOR_MARGIN, VAD_MIN_THRESH, VAD_MAX_THRESH);
    const stopThresh = startThresh * VAD_HYSTERESIS;

    if (!speaking) {
      // Adapt the floor toward the current quiet level (only while it IS quiet,
      // so rising speech never drags the floor up with it).
      if (level < startThresh) noiseFloor = noiseFloor * (1 - VAD_FLOOR_EMA) + level * VAD_FLOOR_EMA;
      if (level > startThresh) beginSegment();
    } else {
      if (level > stopThresh) {
        silenceStartAt = 0;
        if (now - speechStartAt > VAD_MAX_SPEECH_MS) endSegment();
      } else if (!silenceStartAt) {
        silenceStartAt = now;
      } else if (now - silenceStartAt >= VAD_SILENCE_MS) {
        endSegment();
      }
    }
  }, VAD_POLL_MS);

  return function stopContinuousCapture() {
    clearInterval(intervalId);
    if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch { /* ignore */ } }
    stream.getTracks().forEach(t => t.stop());
    audioCtx.close();
  };
}

// ---- transcription + closed-set audio rescoring --------------------------
//
// The high-level model.forward()/generate() wrapper in this library version
// mishandles direct (non-generate) calls on Whisper's merged encoder-decoder
// graph (an input-name mismatch bug independent of the ONNX Runtime version
// issue worked around above). Teacher-forced scoring therefore calls the two
// underlying ONNX Runtime sessions directly — model.sessions.model (encoder)
// and model.sessions.decoder_model_merged (decoder) — which is the one path
// verified to work correctly end-to-end.

async function runEncoder(inputFeatures) {
  const out = await state.model.sessions.model.run({ input_features: inputFeatures });
  return out.last_hidden_state;
}

// Whisper reliably hallucinates the same handful of throwaway phrases on
// short, quiet or breath-only clips (exactly what a mic picks up between
// species in a field) — subtitle credits, "thank you", music/applause tags,
// bare punctuation. Left in the shortlist these either add a junk species or
// crowd out the real one, so they're dropped before matching. Kept
// deliberately tight so it can't swallow a real (short) genus.
const HALLUCINATION_RE = new RegExp(
  "^(you|thank you|thanks( for watching)?|bye|okay|ok|so|uh|um|hmm|mm|" +
  "music|applause|silence|laughter|noise|blank_audio|inaudible|" +
  "subtitles.*|amara\\.org|transcription.*|subscribe.*|the end|end)" +
  "[.!?…]*$", "i");
function isJunk(text) {
  const s = (text || "").trim();
  if (s.length < 2) return true;
  if (!/[a-zA-Z]/.test(s)) return true;                 // punctuation / music symbols only
  if (/^\[.*\]$/.test(s) || /^\(.*\)$/.test(s)) return true; // "[MUSIC]", "(wind)"
  if (HALLUCINATION_RE.test(s)) return true;
  return false;
}

// Decode the free transcript for one utterance under one language. Species
// names are short, so max_new_tokens stays tight (faster, can't run off into
// a sentence). `beams` = 1 (greedy) in multilingual mode where the diversity
// comes from the languages themselves; the single-language path uses a wider
// beam for a better one-shot transcript.
async function decodeUnder(inputFeatures, lang, beams) {
  const out = await state.model.generate({
    input_features: inputFeatures,
    language: lang,
    task: "transcribe",
    max_new_tokens: 28,
    num_beams: beams,
    num_return_sequences: 1,
  });
  return (state.tokenizer.batch_decode(out, { skip_special_tokens: true })[0] || "").trim();
}

// One decoder forward pass over prompt + candidate + <|endoftext|>, teacher-
// forced (the whole sequence is given up front, not generated token by
// token) — reuses the same encoder_hidden_states across every candidate for
// one utterance, so only this (cheap, short-sequence) call repeats per
// candidate, not the (expensive, fixed-length) encoder pass.
function decoderInputsFor(seq, encoderHidden) {
  const inputs = {
    input_ids: new Tensor("int64", BigInt64Array.from(seq.map(BigInt)), [1, seq.length]),
    encoder_hidden_states: encoderHidden,
    use_cache_branch: new Tensor("bool", [false], [1]),
  };
  // The merged decoder graph declares KV-cache inputs unconditionally (an
  // "If" node branches on use_cache_branch at runtime) — ORT still requires
  // every declared input to be supplied, so these are zero-length placeholders
  // for the not-taken "with cache" branch, not real cached state.
  const { layers, heads, headDim } = state.dims;
  for (let i = 0; i < layers; i++) {
    for (const who of ["decoder", "encoder"]) {
      for (const kv of ["key", "value"]) {
        inputs[`past_key_values.${i}.${who}.${kv}`] = new Tensor("float32", new Float32Array(0), [1, heads, 0, headDim]);
      }
    }
  }
  return inputs;
}

// Teacher-forced length-normalized log-likelihood of one candidate string
// given the audio, computed UNDER a specific language prompt — "how well does
// this recording match exactly this name, pronounced as this language would."
// The same name scores differently under <|it|> vs <|en|>, which is exactly
// how accent robustness falls out: the speaker's real language wins.
async function scoreCandidateUnder(encoderHidden, candidateText, lang) {
  const eot = state.tokenizer.model.tokens_to_ids.get("<|endoftext|>");
  const candidateIds = state.tokenizer.encode(candidateText, { add_special_tokens: false });
  const targets = [...candidateIds, eot];
  const promptIds = state.promptIdsByLang[lang];
  const seq = [...promptIds, ...targets];

  const { logits } = await state.model.sessions.decoder_model_merged.run(decoderInputsFor(seq, encoderHidden));
  const data = logits.data, vocab = logits.dims[logits.dims.length - 1];
  const startAt = promptIds.length - 1; // position predicting the first real token
  let logProb = 0;
  for (let k = 0; k < targets.length; k++) {
    const row = data.subarray((startAt + k) * vocab, (startAt + k + 1) * vocab);
    let max = -Infinity;
    for (let v = 0; v < vocab; v++) if (row[v] > max) max = row[v];
    let sumExp = 0;
    for (let v = 0; v < vocab; v++) sumExp += Math.exp(row[v] - max);
    logProb += (row[targets[k]] - max) - Math.log(sumExp);
  }
  return logProb / targets.length;
}

// Step 1: transcribe one utterance freely, and hand back a handle (the
// encoder's hidden states) the caller passes into rescore() below — this
// split lets the caller build its candidate shortlist FROM the transcript
// (via the existing text fuzzy-matcher) before audio-rescoring against it,
// without recomputing the (expensive, fixed-cost) encoder pass a second time.
async function transcribeAudio(pcm16k) {
  // The feature-extraction session (mel-spectrogram) and the encoder/decoder
  // sessions aren't safe to run concurrently against each other (ORT session
  // reentrancy) — processed once, then the two model passes run in sequence.
  const { input_features } = await state.processor(pcm16k);
  const encoderHidden = await runEncoder(input_features);
  // Decode under each active language and union the transcripts (de-duped,
  // junk dropped). Multiple languages → greedy per language (diversity comes
  // from the languages); a single language → one wider-beam pass.
  const langs = activeLangs();
  const beams = langs.length > 1 ? 1 : BEAM_WIDTH;
  const seen = new Set(), hypotheses = [];
  for (const lang of langs) {
    let text;
    try { text = await decodeUnder(input_features, lang, beams); }
    catch { continue; }
    if (isJunk(text)) continue;
    const key = text.toLowerCase();
    if (!seen.has(key)) { seen.add(key); hypotheses.push(text); }
  }
  // `transcript` is the display/status string (first surviving hypothesis, or
  // empty if everything was junk); `hypotheses` seeds the caller's shortlist.
  return { transcript: hypotheses[0] || "", hypotheses, encoderHandle: encoderHidden };
}

// Step 2: rescore a shortlist of candidate taxon names against the audio
// behind the given encoderHandle. Each candidate is scored under every active
// language and keeps its best (max) — so the acoustic match reflects whichever
// language the speaker's pronunciation is actually closest to. Returns the
// candidates ranked by that best audio-conditioned score.
async function rescoreCandidates(encoderHandle, candidateTexts) {
  const langs = activeLangs();
  const ranked = [];
  for (const text of candidateTexts) {
    let best = -Infinity;
    for (const lang of langs) {
      const s = await scoreCandidateUnder(encoderHandle, text, lang);
      if (s > best) best = s;
    }
    ranked.push({ text, score: best });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

window.WhisperVoice = {
  isSupported,
  isLoaded: () => state.loaded,
  setQuality,
  setLanguage,
  loadModel,
  startRecording,
  stopRecording,
  blobToPCM16k,
  transcribeAudio,
  rescoreCandidates,
  startContinuousCapture,
};
