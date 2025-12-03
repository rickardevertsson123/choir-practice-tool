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
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

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
    const tempoBpm = this.timeline.tempoBpm;
    const secondsPerBeat = 60 / tempoBpm;
    const measure7Start = (6 * 3) * secondsPerBeat; // takt 7 börjar vid beat 18
    const measure7End = measure7Start + 3 * secondsPerBeat; // takt 7 slutar vid beat 21

    // Sortera noter i tidsordning
    const notesToPlay = this.timeline.notes
      .filter(note => note.startTimeSeconds + note.durationSeconds > offset)
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    // Debug: kolla keyboard runt takt 7
    const keyboardMeasure7 = this.timeline.notes
      .filter(n => 
        n.voice === "Rehearsal keyboard" &&
        n.startTimeSeconds >= measure7Start - 0.1 &&
        n.startTimeSeconds <= measure7End + 0.1
      )
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
    
    console.log('\n🎹 SCHEDULER: Keyboard notes in measure 7 area:');
    console.log('Measure 7 time range:', measure7Start.toFixed(2), '-', measure7End.toFixed(2), 's');
    console.log('Beat 18 (rest):', measure7Start.toFixed(2), 's');
    console.log('Beat 19:', (measure7Start + secondsPerBeat).toFixed(2), 's');
    console.log('Beat 20:', (measure7Start + 2 * secondsPerBeat).toFixed(2), 's');
    keyboardMeasure7.forEach(n => {
      const beat = n.startTimeSeconds / secondsPerBeat;
      console.log(`  🎵 MIDI ${n.midiPitch} @ ${n.startTimeSeconds.toFixed(2)}s (beat ${beat.toFixed(1)}) dur=${n.durationSeconds.toFixed(2)}s`);
    });

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

      const playAt = this.audioContext.currentTime + relativeStart;
      
      // Debug keyboard i takt 7
      if (note.voice === "Rehearsal keyboard" && 
          note.startTimeSeconds >= measure7Start - 0.1 && 
          note.startTimeSeconds <= measure7End + 0.1) {
        console.log(`  ▶️ SCHEDULING: MIDI ${note.midiPitch} at ${playAt.toFixed(2)}s (timeline ${note.startTimeSeconds.toFixed(2)}s)`);
      }

      const osc = this.audioContext.createOscillator();
      osc.frequency.value = midiToFrequency(note.midiPitch);
      osc.type = "sine";

      const voiceGain = this.voiceGains.get(note.voice);
      if (voiceGain) {
        osc.connect(voiceGain);
      }

      osc.start(playAt);
      osc.stop(playAt + duration);

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
      return this.timelineStartOffset + elapsed;
    }
    return this.currentTimeSeconds;
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