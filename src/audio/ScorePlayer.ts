import { ScoreTimeline, VoiceId } from '../types/ScoreTimeline';

export interface VoiceMixerSettings {
  volume: number;  // 0.0–1.0
  muted: boolean;
  solo: boolean;
}

export interface ScorePlayerOptions {
  audioContext?: AudioContext;
  masterVolume?: number; // 0..1
}

export interface PlayerControls {
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(timeSeconds: number): void;

  setVoiceSettings(voiceId: VoiceId, settings: Partial<VoiceMixerSettings>): void;
  getVoiceSettings(voiceId: VoiceId): VoiceMixerSettings;

  getCurrentTime(): number;
  /**
   * Map an AudioContext time (seconds) to timeline time (seconds).
   * Useful when aligning external analysis (e.g. AudioWorklet pitch frames)
   * with playback time.
   */
  getTimeAtAudioContextTime(audioContextTimeSeconds: number): number;
  /**
   * Expose the underlying AudioContext used by this player.
   * (Needed to keep mic/worklet and playback on the same clock.)
   */
  getAudioContext(): AudioContext;
  getDuration(): number;
  isPlaying(): boolean;

  setTempoMultiplier(multiplier: number): void;
  getTempoMultiplier(): number;
}

/*
 * Copyright (c) 2025 Rickard Evertsson
 */

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// --- Click-free synth constants ---
const ATTACK_SEC = 0.030;      // 30ms (noticeably smooth vs "on/off")
const RELEASE_SEC = 0.045;     // 45ms
const PORTAMENTO_SEC = 0.018;  // 18ms freq glide at note transitions
const REST_GATE_FLOOR = 0.0001;

type MonoNote = {
  midiPitch: number;
  startTimeSeconds: number;
  durationSeconds: number;
};

class VoiceSynth {
  osc: OscillatorNode;
  amp: GainNode;            // per-voice synth envelope (not mixer)
  started = false;

  constructor(ctx: AudioContext, connectTo: AudioNode) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';

    this.amp = ctx.createGain();
    this.amp.gain.value = 0; // start silent

    this.osc.connect(this.amp);
    this.amp.connect(connectTo);
  }

  start(atTime: number) {
    if (this.started) return;
    // Set a safe initial freq so the node is valid before ramps
    this.osc.frequency.setValueAtTime(220, atTime);
    this.osc.start(atTime);
    this.started = true;
  }

  stop(atTime: number) {
    if (!this.started) return;
    try { this.osc.stop(atTime); } catch {}
    this.started = false;
  }

  scheduleNote(start: number, end: number, freq: number) {
    const a = this.amp.gain;
    const f = this.osc.frequency;

    // Frequency glide into the note (prevents discontinuity clicks)
    f.cancelScheduledValues(start);
    // If we don’t know current scheduled value, setTargetAtTime is forgiving
    f.setTargetAtTime(freq, start, PORTAMENTO_SEC / 3);

    // Envelope: ramp up at start
    a.cancelScheduledValues(start);
    a.setValueAtTime(Math.max(a.value, REST_GATE_FLOOR), start);
    a.setTargetAtTime(1.0, start, ATTACK_SEC / 3);

    // Envelope: ramp down near end
    const relStart = Math.max(start, end - RELEASE_SEC);
    a.setValueAtTime(1.0, relStart);
    a.setTargetAtTime(REST_GATE_FLOOR, relStart, RELEASE_SEC / 3);
  }

  scheduleRest(start: number) {
    const a = this.amp.gain;
    a.cancelScheduledValues(start);
    a.setValueAtTime(Math.max(a.value, REST_GATE_FLOOR), start);
    a.setTargetAtTime(REST_GATE_FLOOR, start, RELEASE_SEC / 3);
  }

  dispose() {
    try { this.osc.disconnect(); } catch {}
    try { this.amp.disconnect(); } catch {}
  }
}

export class ScorePlayer implements PlayerControls {
  private audioContext: AudioContext;
  public timeline: ScoreTimeline;

  private masterGain: GainNode;
  private voiceGains = new Map<VoiceId, GainNode>();         // mixer per voice
  private voiceSettings = new Map<VoiceId, VoiceMixerSettings>();
  private voiceSynths = new Map<VoiceId, VoiceSynth>();

  private isPlayingState = false;
  private currentTimeSeconds = 0;
  private playStartTime = 0;
  private timelineStartOffset = 0;
  private tempoMultiplier = 1.0;

  constructor(timeline: ScoreTimeline, options?: ScorePlayerOptions) {
    this.timeline = timeline;
    // Use provided AudioContext when available to keep timing / inputs in sync
    // and avoid creating multiple audio contexts when the mic is in use.
    if (options?.audioContext) {
      this.audioContext = options.audioContext;
      this._ownsAudioContext = false;
    } else {
      this.audioContext = new AudioContext();
      this._ownsAudioContext = true;
    }

    this.masterGain = this.audioContext.createGain();
    // Default master volume reduced to avoid output distortion on some setups
    const masterVol = typeof options?.masterVolume === 'number' ? options.masterVolume : 0.15;
    this.masterGain.gain.value = Math.max(0, Math.min(1, masterVol));
    this.masterGain.connect(this.audioContext.destination);

    this.initializeVoices();

    console.log('ScorePlayer initialiserad med', timeline.notes.length, 'noter');
  }

  // internal flag: true if this instance created the AudioContext and therefore
  // should close it on dispose. If an external AudioContext was provided we
  // must not close it.
  private _ownsAudioContext = true;

  private initializeVoices(): void {
    const voices = new Set(this.timeline.notes.map(note => note.voice));

    for (const voice of voices) {
      const mixGain = this.audioContext.createGain();
      mixGain.connect(this.masterGain);
      this.voiceGains.set(voice, mixGain);

      this.voiceSettings.set(voice, { volume: 1.0, muted: false, solo: false });

      // One continuous synth per voice
      const synth = new VoiceSynth(this.audioContext, mixGain);
      this.voiceSynths.set(voice, synth);
    }

    this.updateAllVoiceGains(true);
  }

  play(): void {
    if (this.isPlayingState) return;

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    this.isPlayingState = true;
    this.playStartTime = this.audioContext.currentTime;
    this.timelineStartOffset = this.currentTimeSeconds;

    this.scheduleFromOffset();
  }

  pause(): void {
    if (!this.isPlayingState) return;
    this.currentTimeSeconds = this.getCurrentTime();
    this.isPlayingState = false;

    // Fade all voices quickly to silence (no click)
    const t = this.audioContext.currentTime;
    for (const synth of this.voiceSynths.values()) synth.scheduleRest(t);
  }

  stop(): void {
    this.isPlayingState = false;
    this.currentTimeSeconds = 0;
    this.timelineStartOffset = 0;

    const t = this.audioContext.currentTime;
    for (const synth of this.voiceSynths.values()) synth.scheduleRest(t);
  }

  seekTo(timeSeconds: number): void {
    const clamped = Math.max(0, Math.min(timeSeconds, this.timeline.totalDurationSeconds));
    this.currentTimeSeconds = clamped;
    this.timelineStartOffset = clamped;

    if (this.isPlayingState) {
      this.playStartTime = this.audioContext.currentTime;
      this.scheduleFromOffset();
    }
  }

  setTempoMultiplier(multiplier: number): void {
    const wasPlaying = this.isPlayingState;
    const current = this.getCurrentTime();
    if (wasPlaying) this.pause();

    this.tempoMultiplier = Math.max(0.25, Math.min(2.0, multiplier));
    this.currentTimeSeconds = current;

    if (wasPlaying) this.play();
  }

  getTempoMultiplier(): number {
    return this.tempoMultiplier;
  }

  setVoiceSettings(voiceId: VoiceId, settings: Partial<VoiceMixerSettings>): void {
    const current = this.voiceSettings.get(voiceId);
    if (!current) return;
    this.voiceSettings.set(voiceId, { ...current, ...settings });
    this.updateAllVoiceGains(false);
  }

  getVoiceSettings(voiceId: VoiceId): VoiceMixerSettings {
    return this.voiceSettings.get(voiceId) || { volume: 1.0, muted: false, solo: false };
  }

  getDuration(): number {
    return this.timeline.totalDurationSeconds;
  }

  isPlaying(): boolean {
    return this.isPlayingState;
  }

  // Clamp time to duration so UI logic can loop safely
  getCurrentTime(): number {
    const dur = this.timeline.totalDurationSeconds;
    if (this.isPlayingState) {
      const elapsed = this.audioContext.currentTime - this.playStartTime;
      const t = this.timelineStartOffset + (elapsed * this.tempoMultiplier);
      return Math.max(0, Math.min(dur, t));
    }
    return Math.max(0, Math.min(dur, this.currentTimeSeconds));
  }

  getTimeAtAudioContextTime(audioContextTimeSeconds: number): number {
    const dur = this.timeline.totalDurationSeconds;
    if (this.isPlayingState) {
      const elapsed = audioContextTimeSeconds - this.playStartTime;
      const t = this.timelineStartOffset + (elapsed * this.tempoMultiplier);
      return Math.max(0, Math.min(dur, t));
    }
    return Math.max(0, Math.min(dur, this.currentTimeSeconds));
  }

  getAudioContext(): AudioContext {
    return this.audioContext;
  }

  private updateAllVoiceGains(isInit = false): void {
    const hasSolo = Array.from(this.voiceSettings.values()).some(s => s.solo);
    const t = this.audioContext.currentTime;
    const ramp = isInit ? 0 : 0.015; // 15ms

    for (const [voiceId, gainNode] of this.voiceGains) {
      const settings = this.voiceSettings.get(voiceId);
      if (!settings) continue;

      let g = 0;
      if (hasSolo) g = settings.solo ? settings.volume : 0;
      else g = settings.muted ? 0 : settings.volume;

      g = Math.max(0, Math.min(1, g));

      if (ramp > 0) {
        gainNode.gain.cancelScheduledValues(t);
        gainNode.gain.setValueAtTime(gainNode.gain.value, t);
        gainNode.gain.linearRampToValueAtTime(g, t + ramp);
      } else {
        gainNode.gain.value = g;
      }
    }
  }

  private getNotesForVoice(voice: VoiceId, offset: number): MonoNote[] {
    // Sort per voice
    const notes = this.timeline.notes
      .filter(n => n.voice === voice)
      .filter(n => n.startTimeSeconds + n.durationSeconds > offset)
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    // Merge same-pitch contiguous notes to avoid unnecessary envelope drops
    const merged: MonoNote[] = [];
    for (const n of notes) {
      const last = merged[merged.length - 1];
      if (!last) {
        merged.push({ midiPitch: n.midiPitch, startTimeSeconds: n.startTimeSeconds, durationSeconds: n.durationSeconds });
        continue;
      }

      const lastEnd = last.startTimeSeconds + last.durationSeconds;
      const gap = n.startTimeSeconds - lastEnd;

      const samePitch = n.midiPitch === last.midiPitch;
      const close = gap >= -0.010 && gap <= 0.010; // within 10ms

      if (samePitch && close) {
        const newEnd = Math.max(lastEnd, n.startTimeSeconds + n.durationSeconds);
        last.durationSeconds = newEnd - last.startTimeSeconds;
      } else {
        merged.push({ midiPitch: n.midiPitch, startTimeSeconds: n.startTimeSeconds, durationSeconds: n.durationSeconds });
      }
    }

    return merged;
  }

  private scheduleFromOffset(): void {
    const offset = this.timelineStartOffset;
    const now = this.audioContext.currentTime;

    // Start all synth oscillators once (continuous)
    for (const synth of this.voiceSynths.values()) synth.start(now);

    for (const [voice, synth] of this.voiceSynths.entries()) {
      const notes = this.getNotesForVoice(voice, offset);

      // If there are no notes left, just stay silent
      if (notes.length === 0) {
        synth.scheduleRest(now);
        continue;
      }

      for (const note of notes) {
        const start = note.startTimeSeconds;
        const end = note.startTimeSeconds + note.durationSeconds;

        // map timeline -> audio time with tempo multiplier
        let relativeStart = start - offset;
        let dur = note.durationSeconds;

        if (relativeStart < 0) {
          dur = end - offset;
          relativeStart = 0;
        }
        if (dur <= 0) continue;

        const playAt = now + (relativeStart / this.tempoMultiplier);
        const playEnd = playAt + (dur / this.tempoMultiplier);

        const freq = midiToFrequency(note.midiPitch);
        synth.scheduleNote(playAt, playEnd, freq);
      }
    }
  }

  dispose(): void {
    this.stop();
    const t = this.audioContext.currentTime;
    for (const synth of this.voiceSynths.values()) {
      synth.scheduleRest(t);
      synth.dispose();
    }
    this.voiceSynths.clear();
    
    // Only close the audio context if we created it.
    if (this._ownsAudioContext) {
      try { this.audioContext.close(); } catch (e) {}
    }
  }
}
