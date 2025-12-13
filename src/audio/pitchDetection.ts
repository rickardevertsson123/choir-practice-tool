// Pitch detection using normalized autocorrelation (NACF) + parabolic interpolation
// Target-aware only for search range (±3 semitones), never "snaps" pitch to target.
// Includes an internal spike gate to suppress 1-frame pitch jumps (e.g. at note boundaries).

export interface PitchResult {
  frequency: number | null; // null if no stable pitch detected
  clarity: number;          // 0-1, confidence of detection
}

export interface TargetHint {
  targetMidi: number; // Expected MIDI note
}

export interface NoteInfo {
  noteName: string;   // e.g. "A4"
  midi: number;       // e.g. 69 (rounded)
  exactMidi: number;  // e.g. 69.15 (fractional)
  centsOff: number;   // e.g. -15 (below nearest tone)
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---------- Tunables ----------
const DEFAULT_MIN_FREQ = 80;      // Hz
const DEFAULT_MAX_FREQ = 1000;    // Hz
const TARGET_SEMITONE_SPAN = 3;   // ±3 semitones search window when targetHint exists

// Energy / clarity thresholds
const RMS_THRESHOLD = 0.001;      // you said you set this for testing; keep it here
const MIN_CLARITY = 0.35;         // lower than 0.4 to reduce "no pitch" cases, still strict-ish

// Spike gate: suppress short-lived pitch jumps (helps note transitions)
const SPIKE_GATE_CENTS = 80;      // jump must exceed this to be considered a spike
const SPIKE_GATE_CONFIRM_FRAMES = 2; // require 2 consecutive frames to accept large jump
// -----------------------------

// Internal singleton state (keeps behavior stable without changing ScorePlayerPage)
type DetectorState = {
  lastStableMidi: number | null;
  pendingJumpMidi: number | null;
  pendingJumpCount: number;
};

const state: DetectorState = {
  lastStableMidi: null,
  pendingJumpMidi: null,
  pendingJumpCount: 0,
};

// Helpers
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function freqToExactMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function removeDCAndWindow(src: Float32Array): Float32Array {
  // DC removal + Hann window (helps autocorr stability)
  const n = src.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += src[i];
  mean /= n;

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = src[i] - mean;
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))); // Hann
    out[i] = x * w;
  }
  return out;
}

function computeRms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

/**
 * Normalized autocorrelation for a given lag:
 *  r(lag) = sum(x[i]*x[i+lag]) / sqrt(sum(x[i]^2) * sum(x[i+lag]^2))
 * This keeps "clarity" more meaningful across levels and transitions.
 */
function findBestLagNacf(
  x: Float32Array,
  sampleRate: number,
  minFreq: number,
  maxFreq: number
): { bestLag: number; clarity: number; corrAtLag: (lag: number) => number } {
  const n = x.length;

  const minLag = Math.floor(sampleRate / maxFreq);
  const maxLag = Math.floor(sampleRate / minFreq);

  // Precompute prefix energy for fast segment energy
  const prefix = new Float64Array(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i] * x[i];

  const energy = (start: number, end: number) => prefix[end] - prefix[start];

  const corrAtLag = (lag: number): number => {
    const m = n - lag;
    if (m <= 0) return 0;

    let num = 0;
    for (let i = 0; i < m; i++) {
      num += x[i] * x[i + lag];
    }

    const e1 = energy(0, m);
    const e2 = energy(lag, lag + m);
    const den = Math.sqrt(e1 * e2);

    if (den <= 1e-12) return 0;
    return num / den; // in [-1..1]
  };

  let bestLag = -1;
  let best = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    const c = corrAtLag(lag);
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }

  return { bestLag, clarity: clamp(best, 0, 1), corrAtLag };
}

function parabolicInterpolatePeak(
  lag: number,
  corrAtLag: (lag: number) => number
): number {
  // refine lag using (lag-1, lag, lag+1)
  const c0 = corrAtLag(lag - 1);
  const c1 = corrAtLag(lag);
  const c2 = corrAtLag(lag + 1);

  const denom = (c0 - 2 * c1 + c2);
  if (Math.abs(denom) < 1e-12) return lag;

  const delta = 0.5 * (c0 - c2) / denom;
  if (Math.abs(delta) > 1) return lag;

  return lag + delta;
}

function applySpikeGate(exactMidi: number): number {
  // If we don't have a stable midi yet, accept immediately
  if (state.lastStableMidi == null) {
    state.lastStableMidi = exactMidi;
    state.pendingJumpMidi = null;
    state.pendingJumpCount = 0;
    return exactMidi;
  }

  const diffCents = (exactMidi - state.lastStableMidi) * 100;
  const abs = Math.abs(diffCents);

  // Small movement: accept and reset pending
  if (abs < SPIKE_GATE_CENTS) {
    state.lastStableMidi = exactMidi;
    state.pendingJumpMidi = null;
    state.pendingJumpCount = 0;
    return exactMidi;
  }

  // Large jump: require confirmation
  if (state.pendingJumpMidi == null) {
    state.pendingJumpMidi = exactMidi;
    state.pendingJumpCount = 1;
    return state.lastStableMidi; // hold stable for now
  }

  // If new reading agrees with pending jump (within 30 cents), confirm
  const agreeCents = Math.abs((exactMidi - state.pendingJumpMidi) * 100);
  if (agreeCents <= 30) {
    state.pendingJumpCount += 1;
  } else {
    // pending changed direction/target -> restart pending
    state.pendingJumpMidi = exactMidi;
    state.pendingJumpCount = 1;
    return state.lastStableMidi;
  }

  if (state.pendingJumpCount >= SPIKE_GATE_CONFIRM_FRAMES) {
    state.lastStableMidi = state.pendingJumpMidi;
    state.pendingJumpMidi = null;
    state.pendingJumpCount = 0;
    return state.lastStableMidi;
  }

  return state.lastStableMidi;
}

/**
 * Detect pitch from an audio buffer.
 * - If targetHint exists: narrows search to ±3 semitones around target
 * - Never "snaps" to target: it just constrains the lag range
 * - Returns frequency + clarity
 */
export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  targetHint?: TargetHint
): PitchResult {
  const rms = computeRms(buffer);
  if (rms < RMS_THRESHOLD) {
    // reset gating slowly? keep last stable to avoid flicker if you prefer:
    // state.pendingJumpMidi = null; state.pendingJumpCount = 0;
    return { frequency: null, clarity: 0 };
  }

  // Preprocess
  const x = removeDCAndWindow(buffer);

  // Choose search band
  let minFreq = DEFAULT_MIN_FREQ;
  let maxFreq = DEFAULT_MAX_FREQ;

  if (targetHint) {
    const targetFreq = midiToFreq(targetHint.targetMidi);
    const ratio = Math.pow(2, TARGET_SEMITONE_SPAN / 12); // ~1.189
    minFreq = Math.max(DEFAULT_MIN_FREQ, targetFreq / ratio);
    maxFreq = Math.min(DEFAULT_MAX_FREQ, targetFreq * ratio);
  }

  // Find best lag by NACF
  const { bestLag, clarity, corrAtLag } = findBestLagNacf(x, sampleRate, minFreq, maxFreq);

  if (bestLag === -1 || clarity < MIN_CLARITY) {
    return { frequency: null, clarity };
  }

  // Refine lag
  let refinedLag = bestLag;
  if (bestLag > 2) {
    refinedLag = parabolicInterpolatePeak(bestLag, corrAtLag);
  }

  let frequency = sampleRate / refinedLag;

  // Sanity clamp
  if (frequency < DEFAULT_MIN_FREQ || frequency > DEFAULT_MAX_FREQ) {
    return { frequency: null, clarity: 0 };
  }

  // Spike gate in MIDI domain (suppresses 1-frame jumps)
  const exactMidi = freqToExactMidi(frequency);
  const gatedMidi = applySpikeGate(exactMidi);
  const gatedFreq = midiToFreq(gatedMidi);

  return { frequency: gatedFreq, clarity };
}

/**
 * Convert frequency to note information (name, MIDI, cents offset)
 */
export function frequencyToNoteInfo(freq: number): NoteInfo | null {
  if (freq <= 0) return null;

  const exactMidi = 69 + 12 * Math.log2(freq / 440);
  const nearestMidi = Math.round(exactMidi);
  const centsOff = Math.round((exactMidi - nearestMidi) * 100);

  const noteIndex = ((nearestMidi % 12) + 12) % 12;
  const octave = Math.floor(nearestMidi / 12) - 1;
  const noteName = NOTE_NAMES[noteIndex] + octave;

  return {
    noteName,
    midi: nearestMidi,
    exactMidi,
    centsOff,
  };
}
