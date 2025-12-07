import { ScoreTimeline, NoteEvent, VoiceId } from '../types/ScoreTimeline';

export interface VoiceMixerSettings {
  volume: number;  // 0.0–1.0
  muted: boolean;
  solo: boolean;
}

export interface ScorePlayerOptions {
  audioContext?: AudioContext;
}

export interface PlayerControls {
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(timeSeconds: number): void;

  setVoiceSettings(voiceId: VoiceId, settings: Partial<VoiceMixerSettings>): void;
  getVoiceSettings(voiceId: VoiceId): VoiceMixerSettings;

  getCurrentTime(): number;
  getDuration(): number;
  isPlaying(): boolean;
  
  setTempoMultiplier(multiplier: number): void;
  getTempoMultiplier(): number;
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
0
export class ScorePlayer implements PlayerControls {
  private audioContext: AudioContext;
  private timeline: ScoreTimeline;
  private voiceGains = new Map<VoiceId, GainNode>();
  private voiceSettings = new Map<VoiceId, VoiceMixerSettings>();
  private masterGain: GainNode;
  
  private isPlayingState = false;
  private currentTimeSeconds = 0; // "cursor" i timeline
  private playStartTime = 0; // audioContext.currentTime när aktuell playback startade
  private timelineStartOffset = 0; // timeline-positionen där aktuell playback startade
  private activeOscillators: OscillatorNode[] = [];
  private tempoMultiplier = 1.0; // 1.0 = normalt tempo, 0.5 = halvt, 2.0 = dubbelt

  constructor(timeline: ScoreTimeline, options?: ScorePlayerOptions) {
    this.timeline = timeline;
    
    try {
      this.audioContext = options?.audioContext || new AudioContext();
      
      // Skapa master gain med låg nivå för att undvika distorsion
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 0.05; // Mycket låg master-nivå
      this.masterGain.connect(this.audioContext.destination);
      
      // Initiera voice gains och settings
      this.initializeVoices();
      
      console.log('ScorePlayer initialiserad med', timeline.notes.length, 'noter');
    } catch (err) {
      console.error('Fel vid ScorePlayer konstruktor:', err);
      throw err;
    }
  }

  private initializeVoices(): void {
    const voices = new Set(this.timeline.notes.map(note => note.voice));
    
    for (const voice of voices) {
      // Skapa gain node för denna voice
      const gainNode = this.audioContext.createGain();
      gainNode.connect(this.masterGain);
      this.voiceGains.set(voice, gainNode);
      
      // Initiera settings - nu kan vi använda högre värden eftersom master är låg
      this.voiceSettings.set(voice, {
        volume: 1.0,  // Full voice-volym inom låg master-nivå
        muted: false,
        solo: false
      });
    }
  }

  play(): void {
    if (this.isPlayingState) return;
    
    // Resume AudioContext om det behövs
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    
    this.isPlayingState = true;
    this.playStartTime = this.audioContext.currentTime;
    this.timelineStartOffset = this.currentTimeSeconds;
    
    this.scheduleNotes();
  }

  private scheduleNotes(): void {
    this.stopActiveOscillators();

    const offset = this.timelineStartOffset;

    // Sortera noter i tidsordning
    const notesToPlay = this.timeline.notes
      .filter(note => note.startTimeSeconds + note.durationSeconds > offset)
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    // Debug: kolla keyboard
    const keyboardNotes = notesToPlay
      .filter(n => n.voice === "Rehearsal keyboard")
      .slice(0, 10);
    console.log("Scheduling Rehearsal keyboard (first 10):", keyboardNotes);

    for (const note of notesToPlay) {
      const start = note.startTimeSeconds;
      const end = note.startTimeSeconds + note.durationSeconds;

      // Om noten redan delvis passerat vid offset, starta direkt och korta ned duration
      let relativeStart = start - offset;
      let duration = note.durationSeconds;

      if (relativeStart < 0) {
        duration = end - offset;
        relativeStart = 0;
      }

      if (duration <= 0) {
        continue;
      }

      // Applicera tempo multiplier
      const playAt = this.audioContext.currentTime + (relativeStart / this.tempoMultiplier);
      const adjustedDuration = duration / this.tempoMultiplier;

      const osc = this.audioContext.createOscillator();
      osc.frequency.value = midiToFrequency(note.midiPitch);
      osc.type = "sine";

      const voiceGain = this.voiceGains.get(note.voice);
      if (voiceGain) {
        osc.connect(voiceGain);
      }

      osc.start(playAt);
      osc.stop(playAt + adjustedDuration);

      this.activeOscillators.push(osc);
    }
  }

  pause(): void {
    if (!this.isPlayingState) return;
    
    // Spara aktuell tid i timeline
    this.currentTimeSeconds = this.getCurrentTime();
    
    this.isPlayingState = false;
    this.stopActiveOscillators();
  }

  stop(): void {
    this.isPlayingState = false;
    this.currentTimeSeconds = 0;
    this.timelineStartOffset = 0;
    this.stopActiveOscillators();
  }

  private stopActiveOscillators(): void {
    for (const osc of this.activeOscillators) {
      try {
        osc.stop();
      } catch (e) {
        // Oscillator kanske redan stoppats
      }
    }
    this.activeOscillators = [];
  }

  seekTo(timeSeconds: number): void {
    const clamped = Math.max(0, Math.min(timeSeconds, this.timeline.totalDurationSeconds));
    
    this.currentTimeSeconds = clamped;
    this.timelineStartOffset = clamped;
    
    if (this.isPlayingState) {
      // Hoppa direkt genom att stoppa och spela om från nya positionen
      this.stopActiveOscillators();
      this.playStartTime = this.audioContext.currentTime;
      this.scheduleNotes();
    }
  }

  setVoiceSettings(voiceId: VoiceId, settings: Partial<VoiceMixerSettings>): void {
    const current = this.voiceSettings.get(voiceId);
    if (!current) return;
    
    const updated = { ...current, ...settings };
    this.voiceSettings.set(voiceId, updated);
    
    this.updateAllVoiceGains();
  }

  getVoiceSettings(voiceId: VoiceId): VoiceMixerSettings {
    return this.voiceSettings.get(voiceId) || {
      volume: 1.0,
      muted: false,
      solo: false
    };
  }

  private updateAllVoiceGains(): void {
    // Kolla om någon voice har solo
    const hasSolo = Array.from(this.voiceSettings.values()).some(s => s.solo);
    
    for (const [voiceId, gainNode] of this.voiceGains) {
      const settings = this.voiceSettings.get(voiceId);
      if (!settings) continue;
      
      let gain = 0;
      
      if (hasSolo) {
        // Om solo finns, bara solo-voices ska höras
        gain = settings.solo ? settings.volume : 0;
      } else {
        // Annars: muted ? 0 : volume
        gain = settings.muted ? 0 : settings.volume;
      }
      
      gainNode.gain.value = gain;
    }
  }

  getCurrentTime(): number {
    if (this.isPlayingState) {
      const elapsed = this.audioContext.currentTime - this.playStartTime;
      return this.timelineStartOffset + (elapsed * this.tempoMultiplier);
    }
    return this.currentTimeSeconds;
  }
  
  setTempoMultiplier(multiplier: number): void {
    const wasPlaying = this.isPlayingState;
    const currentTime = this.getCurrentTime();
    
    if (wasPlaying) {
      this.pause();
    }
    
    this.tempoMultiplier = Math.max(0.25, Math.min(2.0, multiplier));
    this.currentTimeSeconds = currentTime;
    
    if (wasPlaying) {
      this.play();
    }
  }
  
  getTempoMultiplier(): number {
    return this.tempoMultiplier;
  }

  getDuration(): number {
    return this.timeline.totalDurationSeconds;
  }

  isPlaying(): boolean {
    return this.isPlayingState;
  }

  // Cleanup method
  dispose(): void {
    this.stop();
    this.audioContext.close();
  }
}