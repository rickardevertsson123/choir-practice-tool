// Pitch detection using autocorrelation method
// Detects monophonic pitch from audio buffer

export interface PitchResult {
  frequency: number | null; // null if no stable pitch detected
  clarity: number;          // 0-1, confidence of detection
}

export interface NoteInfo {
  noteName: string;   // e.g. "A4"
  midi: number;       // e.g. 69 (rounded)
  exactMidi: number;  // e.g. 69.15 (fractional)
  centsOff: number;   // e.g. -15 (below nearest tone)
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Detect pitch using autocorrelation method
 * Optimized for human voice range (80-1000 Hz)
 */
export function detectPitch(
  buffer: Float32Array,
  sampleRate: number
): PitchResult {
  // Check if signal has enough energy
  const rms = Math.sqrt(buffer.reduce((sum, val) => sum + val * val, 0) / buffer.length);
  if (rms < 0.01) {
    return { frequency: null, clarity: 0 };
  }

  const minFreq = 80;   // Lowest human voice
  const maxFreq = 1000; // Highest we care about
  const minPeriod = Math.floor(sampleRate / maxFreq);
  const maxPeriod = Math.floor(sampleRate / minFreq);

  // Autocorrelation med parabolic interpolation
  let bestPeriod = -1;
  let bestCorrelation = 0;
  const correlations: number[] = [];

  for (let period = minPeriod; period <= maxPeriod; period++) {
    let correlation = 0;
    for (let i = 0; i < buffer.length - period; i++) {
      correlation += buffer[i] * buffer[i + period];
    }
    correlations.push(correlation);
    
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestPeriod = period;
    }
  }
  
  // Parabolic interpolation för sub-sample precision
  if (bestPeriod > minPeriod && bestPeriod < maxPeriod) {
    const idx = bestPeriod - minPeriod;
    const prev = correlations[idx - 1] || 0;
    const curr = correlations[idx];
    const next = correlations[idx + 1] || 0;
    
    const delta = 0.5 * (next - prev) / (2 * curr - next - prev);
    if (Math.abs(delta) < 1) {
      bestPeriod = bestPeriod + delta;
    }
  }

  // Normalize correlation to 0-1
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i++) {
    sumSquares += buffer[i] * buffer[i];
  }
  const clarity = sumSquares > 0 ? bestCorrelation / sumSquares : 0;

  // Require minimum clarity threshold
  if (clarity < 0.5 || bestPeriod === -1) {
    return { frequency: null, clarity };
  }

  const frequency = sampleRate / bestPeriod;
  
  // Sanity check frequency range
  if (frequency < minFreq || frequency > maxFreq) {
    return { frequency: null, clarity: 0 };
  }

  return { frequency, clarity };
}

/**
 * Convert frequency to note information (name, MIDI, cents offset)
 */
export function frequencyToNoteInfo(freq: number): NoteInfo | null {
  if (freq <= 0) return null;

  // MIDI = 69 + 12 * log2(freq / 440)
  const exactMidi = 69 + 12 * Math.log2(freq / 440);
  const nearestMidi = Math.round(exactMidi);
  const centsOff = Math.round((exactMidi - nearestMidi) * 100);

  // Get note name
  const noteIndex = nearestMidi % 12;
  const octave = Math.floor(nearestMidi / 12) - 1;
  const noteName = NOTE_NAMES[noteIndex] + octave;

  return {
    noteName,
    midi: nearestMidi,
    exactMidi,
    centsOff
  };
}
