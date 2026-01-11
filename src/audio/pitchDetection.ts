// Pitch detection using normalized autocorrelation (NACF) + parabolic interpolation.
// Target-aware only for NACF search range (±3 semitones), never "snaps" pitch to target.
// Includes an internal spike gate to suppress 1-frame pitch jumps (e.g. at note boundaries).
//
// Performance notes:
// - detectPitch is allocation-free per call by reusing internal buffers
//   (Hann window coefficients, windowed buffer, prefix energy buffer).

/*
 * Copyright (c) 2025 Rickard Evertsson
 */

import { PitchDetector } from 'pitchy';

export interface PitchResult {
  frequency: number | null; // null if no stable pitch detected
  clarity: number;          // 0-1, confidence of detection
  debugReason?: string | null; // optional UI/debug info
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
const TARGET_SEMITONE_SPAN = 3;   // ±3 semitones search window when targetHint exists (NACF path only)

// Energy / clarity thresholds
const RMS_THRESHOLD = 0.005;      // you said you set this for testing; keep it here
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

type Workspace = {
  n: number;
  hann: Float32Array;
  windowed: Float32Array;
  prefixEnergy: Float64Array; // length n+1
};

// Module-level reusable workspace. This avoids per-call allocations without
// forcing callers to manage buffers.
const ws: Workspace = {
  n: 0,
  hann: new Float32Array(0),
  windowed: new Float32Array(0),
  prefixEnergy: new Float64Array(0),
};

// Pitchy workspace: reuse one detector instance per buffer size.
let pitchyDetectorN = 0;
let pitchyDetector: PitchDetector<Float32Array> | null = null;
function getPitchyDetector(n: number): PitchDetector<Float32Array> {
  if (!pitchyDetector || pitchyDetectorN !== n) {
    pitchyDetector = PitchDetector.forFloat32Array(n);
    pitchyDetectorN = n;
  }
  return pitchyDetector;
}

export type DetectorKind = 'nacf' | 'pitchy';

// Exported for A/B testing / future re-enable (avoids TS noUnusedLocals in builds).
export function getDetectorKind(): DetectorKind {
  // Vite exposes env vars on import.meta.env (only keys with VITE_ prefix).
  // We read defensively so this module remains safe in AudioWorklet bundles too.
  const raw = String(((import.meta as any)?.env?.VITE_PITCH_DETECTOR ?? 'pitchy')).toLowerCase();
  return raw === 'nacf' ? 'nacf' : 'pitchy';
}

function ensureWorkspace(n: number): Workspace {
  if (ws.n === n) return ws;

  ws.n = n;
  ws.hann = new Float32Array(n);
  ws.windowed = new Float32Array(n);
  ws.prefixEnergy = new Float64Array(n + 1);

  if (n > 1) {
    const k = (2 * Math.PI) / (n - 1);
    for (let i = 0; i < n; i++) {
      // Hann window
      ws.hann[i] = 0.5 * (1 - Math.cos(k * i));
    }
  } else if (n === 1) {
    ws.hann[0] = 1;
  }

  return ws;
}

export function resetPitchDetectorState(opts?: { seedMidi?: number }) {
  // Optional: seed the detector with an expected MIDI so the very next frame
  // can't "accept" a wildly wrong pitch immediately after a reset (common at
  // note boundaries / attacks). When seeded, the spike-gate will hold until
  // a large jump is confirmed for multiple frames.
  state.lastStableMidi = typeof opts?.seedMidi === 'number' ? opts.seedMidi : null;
  state.pendingJumpMidi = null;
  state.pendingJumpCount = 0;
}

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

function dcRemoveAndApplyHann(
  src: Float32Array,
  dst: Float32Array,
  hann: Float32Array,
  mean: number
) {
  // DC removal + Hann window (helps autocorr stability)
  for (let i = 0; i < src.length; i++) {
    dst[i] = (src[i] - mean) * hann[i];
  }
}

/**
 * Normalized autocorrelation for a given lag:
 *  r(lag) = sum(x[i]*x[i+lag]) / sqrt(sum(x[i]^2) * sum(x[i+lag]^2))
 * This keeps "clarity" more meaningful across levels and transitions.
 */
function findBestLagNacf(
  x: Float32Array,
  prefixEnergy: Float64Array,
  sampleRate: number,
  minFreq: number,
  maxFreq: number
): { bestLag: number; clarity: number; corrAtLag: (lag: number) => number } {
  const n = x.length;

  const minLag = Math.floor(sampleRate / maxFreq);
  const maxLag = Math.floor(sampleRate / minFreq);

  // Precompute prefix energy for fast segment energy
  // prefixEnergy length must be n+1
  prefixEnergy[0] = 0;
  for (let i = 0; i < n; i++) prefixEnergy[i + 1] = prefixEnergy[i] + x[i] * x[i];

  const energy = (start: number, end: number) => prefixEnergy[end] - prefixEnergy[start];

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
  // If we don't have a stable midi yet, accept immediately.
  // (Callers can seed lastStableMidi via resetPitchDetectorState({ seedMidi }) to avoid
  // immediate acceptance of a wrong first frame at transitions.)
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
// Exported for A/B testing / future re-enable (avoids TS noUnusedLocals in builds).
export function detectPitchNacf(
  buffer: Float32Array,
  sampleRate: number,
  targetHint?: TargetHint
): PitchResult {
  const n = buffer.length;
  if (n === 0) return { frequency: null, clarity: 0 };

  // Compute DC mean and RMS in one pass (no allocations).
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = buffer[i];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const rms = Math.sqrt(sumSq / n);
  if (rms < RMS_THRESHOLD) {
    // reset gating slowly? keep last stable to avoid flicker if you prefer:
    // state.pendingJumpMidi = null; state.pendingJumpCount = 0;
    return { frequency: null, clarity: 0 };
  }

  // Preprocess
  const w = ensureWorkspace(n);
  dcRemoveAndApplyHann(buffer, w.windowed, w.hann, mean);

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
  const { bestLag, clarity, corrAtLag } = findBestLagNacf(w.windowed, w.prefixEnergy, sampleRate, minFreq, maxFreq);

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
  // If we have a target hint but no stable state yet (e.g. after silence),
  // anchor the gate to the target so we don't accept a random wrong pitch on
  // the very first frame.
  if (state.lastStableMidi == null && targetHint && typeof targetHint.targetMidi === 'number') {
    state.lastStableMidi = targetHint.targetMidi;
  }
  const gatedMidi = applySpikeGate(exactMidi);
  const gatedFreq = midiToFreq(gatedMidi);

  return { frequency: gatedFreq, clarity };
}

function detectPitchPitchy(
  buffer: Float32Array,
  sampleRate: number,
  _targetHint?: TargetHint
): PitchResult {
  const n = buffer.length;
  if (n === 0) return { frequency: null, clarity: 0 };

  // Keep our RMS gate to avoid nonsense output on near-silence.
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += buffer[i] * buffer[i];
  const rms = Math.sqrt(sumSq / n);
  if (rms < RMS_THRESHOLD) return { frequency: null, clarity: 0 };

  const detector = getPitchyDetector(n);
  const [pitch, c] = detector.findPitch(buffer, sampleRate);
  const clarity = clamp(typeof c === 'number' ? c : 0, 0, 1);

  let frequency =
    typeof pitch === 'number' && Number.isFinite(pitch) && pitch > 0 ? pitch : null;

  // Sanity clamp
  if (frequency != null && (frequency < DEFAULT_MIN_FREQ || frequency > DEFAULT_MAX_FREQ)) {
    frequency = null;
  }

  // NOTE: For "raw pitchy" evaluation we intentionally do NOT apply:
  // - target-based rejection
  // - spike gate / seeding
  // Callers can still gate on MIN_CLARITY and RMS_THRESHOLD externally.
  return { frequency, clarity };
}

export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  targetHint?: TargetHint
): PitchResult {

  //const kind = getDetectorKind();
  //return kind === 'pitchy'
  //  ? detectPitchPitchy(buffer, sampleRate, targetHint)
  //  : detectPitchNacf(buffer, sampleRate, targetHint);
  return detectPitchPitchy(buffer, sampleRate, targetHint);
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
