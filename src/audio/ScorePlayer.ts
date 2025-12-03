import { ScoreTimeline, NoteEvent, VoiceId, PartMetadata } from '../types/ScoreTimeline';

export interface VoiceMixerSettings {
  volume: number;  // 0.0–1.0
  muted: boolean;
  solo: boolean;
}

export interface ScorePlayerOptions {
  audioContext?: AudioContext;
  partMetadata?: PartMetadata[];
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

// Klassificerar om en voice är vocal (körstämma) eller instrument
function isVocalVoice(voiceId: VoiceId, partMetadata: PartMetadata[]): boolean {
  // Extrahera partId från voiceId (format: "P1-v1")
  const partId = voiceId.split('-')[0];
  const partName = partMetadata.find(p => p.partId === partId)?.partName || '';
  
  const searchText = (partName + ' ' + voiceId).toLowerCase();
  const vocalKeywords = ["soprano", "sopran", "alto", "alt", "tenor", "bass", "choir", "chorus", "chor", "voice", "vocal", "satb"];
  return vocalKeywords.some(k => searchText.includes(k));
}

export class ScorePlayer implements PlayerControls {
  private audioContext: AudioContext;
  private timeline: ScoreTimeline;
  private voiceGains = new Map<VoiceId, GainNode>();
  private voiceSettings = new Map<VoiceId, VoiceMixerSettings>();
  private masterGain: GainNode;
  private partMetadata: PartMetadata[];
  
  // VOCAL LEGATO: Persistent oscillators per vocal voice för flytande körljud
  // En oscillator per voice som lever genom hela uppspelningen, pitch glidas mellan toner
  private vocalOscillators = new Map<VoiceId, OscillatorNode>();
  private vocalEnvGains = new Map<VoiceId, GainNode>();
  private vocalFormantF1 = new Map<VoiceId, BiquadFilterNode>();
  private vocalFormantF2 = new Map<VoiceId, BiquadFilterNode>();
  private vocalLFOs = new Map<VoiceId, OscillatorNode>();
  
  private isPlayingState = false;
  private currentTimeSeconds = 0; // "cursor" i timeline
  private playStartTime = 0; // audioContext.currentTime när aktuell playback startade
  private timelineStartOffset = 0; // timeline-positionen där aktuell playback startade
  private activeNodes: AudioScheduledSourceNode[] = [];

  constructor(timeline: ScoreTimeline, options?: ScorePlayerOptions) {
    this.timeline = timeline;
    this.partMetadata = options?.partMetadata || [];
    
    try {
      this.audioContext = options?.audioContext || new AudioContext();
      
      // GAIN STAGING: Balanserade nivåer för vocal (med formant-dämpning) och instrument
      // masterGain: 0.5, voiceGain: 0.6, vocal envelope: 1.2, instrument envelope: 0.09
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 0.5;
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
    
    console.log('\n🎤 VOICE CLASSIFICATION:');
    for (const voice of voices) {
      const partId = voice.split('-')[0];
      const partName = this.partMetadata.find(p => p.partId === partId)?.partName || '(unknown)';
      const isVocal = isVocalVoice(voice, this.partMetadata);
      console.log(`  ${isVocal ? '🎤 VOCAL' : '🎹 INSTRUMENT'}: "${voice}" (${partName})`);
      
      // Skapa gain node för denna voice med default 0.6 för headroom
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 0.6;
      gainNode.connect(this.masterGain);
      this.voiceGains.set(voice, gainNode);
      
      // Initiera settings
      this.voiceSettings.set(voice, {
        volume: 1.0,
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

      const voiceGain = this.voiceGains.get(note.voice);
      if (voiceGain) {
        // Vocal/instrument-split: olika ljudgenerering för körstämmor vs instrument
        if (isVocalVoice(note.voice, this.partMetadata)) {
          this.playVocalNoteLegato(note, playAt, duration, voiceGain);
        } else {
          this.playInstrumentNote(note, playAt, duration, voiceGain);
        }
      }
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

  private playVocalNoteLegato(note: NoteEvent, startTime: number, duration: number, voiceGain: GainNode): void {
    const freq = midiToFrequency(note.midiPitch);
    const voice = note.voice;
    
    // Skapa persistent oscillator för denna voice om den inte finns
    if (!this.vocalOscillators.has(voice)) {
      const osc = this.audioContext.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      
      // FORMANT FILTERS: Enkel "AA"-vokal emulering för körklang
      // Signal chain: Osc → F1 → F2 → Envelope → VoiceGain
      const formantF1 = this.audioContext.createBiquadFilter();
      formantF1.type = "bandpass";
      formantF1.frequency.value = 700;  // F1 för "AA"
      formantF1.Q.value = 3;  // Lägre Q för mindre dämpning
      
      const formantF2 = this.audioContext.createBiquadFilter();
      formantF2.type = "bandpass";
      formantF2.frequency.value = 1200; // F2 för "AA"
      formantF2.Q.value = 3;  // Lägre Q för mindre dämpning
      
      const envGain = this.audioContext.createGain();
      envGain.gain.value = 0;
      
      const lfo = this.audioContext.createOscillator();
      lfo.frequency.value = 5.5;
      const lfoGain = this.audioContext.createGain();
      lfoGain.gain.value = 4;
      
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      
      osc.connect(formantF1);
      formantF1.connect(formantF2);
      formantF2.connect(envGain);
      envGain.connect(voiceGain);
      
      osc.start(this.audioContext.currentTime);
      lfo.start(this.audioContext.currentTime);
      
      this.vocalOscillators.set(voice, osc);
      this.vocalEnvGains.set(voice, envGain);
      this.vocalFormantF1.set(voice, formantF1);
      this.vocalFormantF2.set(voice, formantF2);
      this.vocalLFOs.set(voice, lfo);
    }
    
    // Använd befintlig oscillator och glida pitch
    const osc = this.vocalOscillators.get(voice)!;
    const envGain = this.vocalEnvGains.get(voice)!;
    
    // Pitch glide mellan toner för legato-effekt
    osc.frequency.setTargetAtTime(freq, startTime, 0.02);
    
    // Envelope för artikulation - högre nivåer för att kompensera formant-dämpning
    const peakLevel = 1.2;   // Högre peak för att kompensera bandpass-förlust
    const sustainLevel = 0.9; // Högre sustain
    const timeConstant = 0.04;
    
    // Attack
    envGain.gain.setTargetAtTime(peakLevel, startTime, timeConstant);
    
    // Sustain
    envGain.gain.setTargetAtTime(sustainLevel, startTime + 0.05, timeConstant);
    
    // Release med overlap
    envGain.gain.setTargetAtTime(0, startTime + duration, timeConstant * 1.5);
  }
  
  private playInstrumentNote(note: NoteEvent, startTime: number, duration: number, voiceGain: GainNode): void {
    const freq = midiToFrequency(note.midiPitch);
    
    const osc = this.audioContext.createOscillator();
    osc.frequency.value = freq;
    osc.type = "triangle";
    
    // Envelope med låg peak (0.09) för instrument - stödljud till vocal
    const envGain = this.audioContext.createGain();
    envGain.gain.value = 0;
    
    const attack = 0.01;
    const peakLevel = 0.09;  // 30% av tidigare nivå för diskret stöd
    const release = 0.05;
    
    const now = startTime;
    envGain.gain.setValueAtTime(0, now);
    envGain.gain.linearRampToValueAtTime(peakLevel, now + attack);
    envGain.gain.setValueAtTime(peakLevel, now + duration - release);
    envGain.gain.linearRampToValueAtTime(0, now + duration);
    
    osc.connect(envGain);
    envGain.connect(voiceGain);
    
    osc.start(now);
    osc.stop(now + duration);
    
    this.activeNodes.push(osc);
  }

  private stopActiveOscillators(): void {
    // Stoppa instrument-oscillators
    for (const node of this.activeNodes) {
      try {
        node.stop();
      } catch (e) {
        // Node kanske redan stoppats
      }
    }
    this.activeNodes = [];
    
    // Stoppa vocal oscillators
    for (const osc of this.vocalOscillators.values()) {
      try {
        osc.stop();
      } catch (e) {
        // Redan stoppad
      }
    }
    for (const lfo of this.vocalLFOs.values()) {
      try {
        lfo.stop();
      } catch (e) {
        // Redan stoppad
      }
    }
    
    this.vocalOscillators.clear();
    this.vocalEnvGains.clear();
    this.vocalFormantF1.clear();
    this.vocalFormantF2.clear();
    this.vocalLFOs.clear();
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
      
      let targetVolume = 0;
      
      if (hasSolo) {
        // Om solo finns, bara solo-voices ska höras
        targetVolume = settings.solo ? settings.volume : 0;
      } else {
        // Annars: muted ? 0 : volume
        targetVolume = settings.muted ? 0 : settings.volume;
      }
      
      // Applicera target volume på base gain (0.6)
      gainNode.gain.value = 0.6 * targetVolume;
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