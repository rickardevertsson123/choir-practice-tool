/*
 * Copyright (c) 2025 Rickard Evertsson
 */

import { ScoreTimeline, NoteEvent, VoiceId } from '../types/ScoreTimeline';

export interface PartMetadata {
  partId: string;
  partName: string;
}

export function extractPartMetadata(xml: string): PartMetadata[] {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xml, "application/xml");
  const scoreParts = xmlDoc.querySelectorAll('score-part');
  
  const metadata: PartMetadata[] = [];
  
  for (const scorePart of scoreParts) {
    const partId = scorePart.getAttribute('id') || '';
    const partNameElement = scorePart.querySelector('part-name');
    const partName = partNameElement?.textContent?.trim() || partId;
    
    metadata.push({ partId, partName });
  }
  
  return metadata;
}

export async function buildScoreTimelineFromMusicXml(xml: string): Promise<ScoreTimeline> {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xml, "application/xml");

  const soundElement = xmlDoc.querySelector('sound[tempo]');
  const tempoBpm = soundElement ? parseInt(soundElement.getAttribute('tempo') || '120') : 120;
  
  const notes: NoteEvent[] = [];
  let noteIdCounter = 0;
  const partDurations: number[] = [];

  const parts = xmlDoc.querySelectorAll('part');
  
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    const staffIndex = partIndex;
    const partId = part.getAttribute('id') || '';
    
    console.log(`🎵 Processing part ${partId}`);
    
    // Per-voice time counter - each voice has its own independent timeline
    const currentTimeBeatsByVoice = new Map<string, number>();
    const prevStartBeatsByVoice = new Map<string, number>();
    let currentDivisions = 1;
    let measureStartBeats = 0;

    const measures = part.querySelectorAll('measure');
    let measureIndex = 0;
    
    for (const measure of measures) {
      const divisionsElement = measure.querySelector('attributes divisions');
      if (divisionsElement) {
        currentDivisions = parseInt(divisionsElement.textContent || '1');
      }

      // Save voice times at the start of the measure to calculate measure length later
      const measureStartTimesByVoice = new Map<string, number>();
      for (const [voiceKey, time] of currentTimeBeatsByVoice) {
        measureStartTimesByVoice.set(voiceKey, time);
      }
      
      // Reset all voices to the start of the measure
      for (const voiceKey of currentTimeBeatsByVoice.keys()) {
        currentTimeBeatsByVoice.set(voiceKey, measureStartBeats);
      }

      const measureChildren = Array.from(measure.children);
      
      for (const element of measureChildren) {
        // Ignore <backup> and <forward> - only for XML reading order
        if (element.tagName === 'backup' || element.tagName === 'forward') {
          continue;
        }
        
        if (element.tagName !== 'note') continue;
        
        const noteElement = element;
        const xmlVoice = noteElement.querySelector('voice')?.textContent || '1';
        const voiceKey = `${partId}-${xmlVoice}`;
        
        // Initialize voice at measure start if it does not exist
        if (!currentTimeBeatsByVoice.has(voiceKey)) {
          currentTimeBeatsByVoice.set(voiceKey, measureStartBeats);
          prevStartBeatsByVoice.set(voiceKey, measureStartBeats);
        }

        const duration = parseInt(noteElement.querySelector('duration')?.textContent || '0');
        const durationBeats = duration / currentDivisions;

        // Handle rests - advance the voice time
        if (noteElement.querySelector('rest')) {
          if (!noteElement.querySelector('chord')) {
            const currentTime = currentTimeBeatsByVoice.get(voiceKey) || measureStartBeats;
            currentTimeBeatsByVoice.set(voiceKey, currentTime + durationBeats);
          }
          continue;
        }

        // Handle chord - same start time as the previous note
        const isChord = noteElement.querySelector('chord') !== null;
        let startTimeBeats: number;
        
        if (isChord) {
          startTimeBeats = prevStartBeatsByVoice.get(voiceKey) || measureStartBeats;
        } else {
          startTimeBeats = currentTimeBeatsByVoice.get(voiceKey) || measureStartBeats;
          prevStartBeatsByVoice.set(voiceKey, startTimeBeats);
        }
        
        const startTimeSeconds = (startTimeBeats * 60) / tempoBpm;
        const durationSeconds = (durationBeats * 60) / tempoBpm;
        
        // Musical time in whole notes (1 beat = 1/4 whole note)
        const startWhole = startTimeBeats / 4;
        const durationWhole = durationBeats / 4;
        const endWhole = startWhole + durationWhole;

        const pitchElement = noteElement.querySelector('pitch');
        if (pitchElement) {
          const midiPitch = convertPitchToMidi(pitchElement);
          
          // NoteEvent.voice is technically (partId, xmlVoice)
          // UI labels are based on part-name + number of voices per part
          const voiceId: VoiceId = `${partId}-v${xmlVoice}`;
          
          // Generate stable noteId using integer tick
          const tick = Math.round(startWhole * 480);
          const noteId = `p${partIndex}-m${measureIndex}-s${staffIndex}-p${midiPitch}-t${tick}`;
          
          const noteEvent: NoteEvent = {
            id: `${voiceId}-${noteIdCounter++}`,
            voice: voiceId,
            startTimeSeconds,
            durationSeconds,
            midiPitch,
            startWhole,
            endWhole,
            noteId,
            measureIndex,
            staffIndex
          };
          
          notes.push(noteEvent);
        }

        // Update voice time (only if not a chord)
        if (!isChord) {
          const currentTime = currentTimeBeatsByVoice.get(voiceKey) || measureStartBeats;
          currentTimeBeatsByVoice.set(voiceKey, currentTime + durationBeats);
        }
      }
      
      // Compute the actual measure length based on the longest voice
      // This correctly handles incomplete measures (pickup/anacrusis)
      let maxVoiceTime = measureStartBeats;
      for (const time of currentTimeBeatsByVoice.values()) {
        maxVoiceTime = Math.max(maxVoiceTime, time);
      }
      
      measureStartBeats = maxVoiceTime;
      measureIndex++;
    }
    
    // Compute duration for all voices in this part
    const partNotes = notes.filter(note => note.id.includes(partId));
    const partDuration = partNotes.reduce((max, note) => 
      Math.max(max, note.startTimeSeconds + note.durationSeconds), 0
    );
    partDurations.push(partDuration);
  }

  const totalDurationSeconds = Math.max(...partDurations, 0);

  return {
    notes,
    totalDurationSeconds,
    tempoBpm
  };
}

export function buildVoiceDisplayLabel(voiceId: VoiceId, allVoices: VoiceId[], partMetadata: PartMetadata[]): string {
  // Parse voiceId format: "P1-v1"
  const match = voiceId.match(/^(.+)-v(\d+)$/);
  if (!match) return voiceId;
  
  const [, partId, xmlVoice] = match;
  
  // Find part-name
  const part = partMetadata.find(p => p.partId === partId);
  const baseName = part?.partName || partId;
  
  // Count number of voices for this part
  const voicesForPart = allVoices.filter(v => v.startsWith(`${partId}-v`));
  
  // If a generic name like "MusicXML Part", use partId instead
  const displayBase = (baseName === "MusicXML Part" || baseName.toLowerCase().includes("musicxml")) 
    ? partId 
    : baseName;
  
  // If only one voice in the part, show just the baseName
  if (voicesForPart.length === 1) {
    return displayBase;
  }
  
  // Otherwise show "baseName v1", "baseName v2", etc.
  return `${displayBase} v${xmlVoice}`;
}




function convertPitchToMidi(pitchElement: Element): number {
  const step = pitchElement.querySelector('step')?.textContent || 'C';
  const octave = parseInt(pitchElement.querySelector('octave')?.textContent || '4');
  const alter = parseInt(pitchElement.querySelector('alter')?.textContent || '0');
  
  // Semitone offset for each step
  const stepToSemitone: Record<string, number> = {
    'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11
  };
  
  const semitoneOffset = stepToSemitone[step] || 0;
  
  // MIDI-formel: 12 * (octave + 1) + semitoneOffset + alter
  return 12 * (octave + 1) + semitoneOffset + alter;
}