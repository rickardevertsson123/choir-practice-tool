// Pitch detection using autocorrelation method
// Detects monophonic pitch from audio buffer

export interface PitchResult {
  frequency: number | null; // null if no stable pitch detected
  clarity: number;          // 0-1, confidence of detection
}

export interface TargetHint {
  targetMidi: number;  // Expected MIDI note
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
 * Can use target hint for improved accuracy
 */
export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  targetHint?: TargetHint
): PitchResult {
  // Check if signal has enough energy
  const rms = Math.sqrt(buffer.reduce((sum, val) => sum + val * val, 0) / buffer.length);
  
  if (rms < 0.01) {
    return { frequency: null, clarity: 0 };
  }

  // TARGET-AWARE: Use target hint to constrain search range
  let minFreq = 80;   // Default: Lowest human voice (bass E2)
  let maxFreq = 1000; // Default: Extended range
  let targetFreq: number | null = null;
  
  if (targetHint) {
    // Convert target MIDI to frequency
    targetFreq = 440 * Math.pow(2, (targetHint.targetMidi - 69) / 12);
    
    // Search ±3 semitones around target (3 semitones = 2^(3/12) ≈ 1.189)
    // This prevents octave errors and breathing noise detection
    minFreq = Math.max(80, targetFreq / 1.189);   // Don't go below 80 Hz
    maxFreq = Math.min(1000, targetFreq * 1.189); // Don't go above 1000 Hz
  }
  
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

  // Require minimum clarity threshold (optimized for headset singing)
  if (clarity < 0.4 || bestPeriod === -1) {
    return { frequency: null, clarity };
  }

  let frequency = sampleRate / bestPeriod;
  
  // TARGET-AWARE: If we have a target, find best candidate near it
  if (targetHint && targetFreq) {
    // Collect all significant peaks (>70% of best)
    const candidates: Array<{ freq: number; clarity: number; distance: number }> = [];
    const clarityThreshold = clarity * 0.7;
    
    for (let i = 0; i < correlations.length; i++) {
      const corr = correlations[i];
      const peakClarity = sumSquares > 0 ? corr / sumSquares : 0;
      
      if (peakClarity >= clarityThreshold) {
        const period = minPeriod + i;
        const freq = sampleRate / period;
        
        // Calculate distance to target in log space
        const distance = Math.abs(Math.log2(freq / targetFreq));
        
        candidates.push({ freq, clarity: peakClarity, distance });
      }
    }
    
    // Sort by clarity (highest first), NOT by distance to target
    // We want the actual sung pitch, not the closest to target
    candidates.sort((a, b) => b.clarity - a.clarity);
    
    if (candidates.length > 0) {
      frequency = candidates[0].freq;
    }
  } else {
    // FALLBACK: SUBHARMONIC CHECK for blind detection
    // Look for strong correlation at 2x period (half frequency)
    const doublePeriod = bestPeriod * 2;
    if (doublePeriod <= maxPeriod) {
      const idx = Math.round(doublePeriod - minPeriod);
      if (idx >= 0 && idx < correlations.length) {
        const subharmonicCorr = correlations[idx];
        const subharmonicClarity = sumSquares > 0 ? subharmonicCorr / sumSquares : 0;
        
        // If subharmonic has strong correlation (within 80% of main peak), use it
        if (subharmonicClarity > clarity * 0.8) {
          const subFreq = sampleRate / doublePeriod;
          
          // Use subharmonic if it's in valid range
          if (subFreq >= 80 && subFreq <= 500) {
            frequency = subFreq;
          }
        }
      }
    }
  }
  
  // Sanity check frequency range
  if (frequency < 80 || frequency > 1000) {
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
