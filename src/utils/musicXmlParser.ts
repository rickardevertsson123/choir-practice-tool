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
    
    // Per-voice tidsräknare - varje voice har egen oberoende tidslinje
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

      // Spara voice-tider vid taktens början för att beräkna taktlängd senare
      const measureStartTimesByVoice = new Map<string, number>();
      for (const [voiceKey, time] of currentTimeBeatsByVoice) {
        measureStartTimesByVoice.set(voiceKey, time);
      }
      
      // Reset alla voices till taktens början
      for (const voiceKey of currentTimeBeatsByVoice.keys()) {
        currentTimeBeatsByVoice.set(voiceKey, measureStartBeats);
      }

      const measureChildren = Array.from(measure.children);
      
      for (const element of measureChildren) {
        // Ignorera backup och forward - endast för XML-läsordning
        if (element.tagName === 'backup' || element.tagName === 'forward') {
          continue;
        }
        
        if (element.tagName !== 'note') continue;
        
        const noteElement = element;
        const xmlVoice = noteElement.querySelector('voice')?.textContent || '1';
        const voiceKey = `${partId}-${xmlVoice}`;
        
        // Initiera voice vid taktens början om den inte finns
        if (!currentTimeBeatsByVoice.has(voiceKey)) {
          currentTimeBeatsByVoice.set(voiceKey, measureStartBeats);
          prevStartBeatsByVoice.set(voiceKey, measureStartBeats);
        }

        const duration = parseInt(noteElement.querySelector('duration')?.textContent || '0');
        const durationBeats = duration / currentDivisions;

        // Hantera pauser - flytta voice-tid framåt
        if (noteElement.querySelector('rest')) {
          if (!noteElement.querySelector('chord')) {
            const currentTime = currentTimeBeatsByVoice.get(voiceKey) || measureStartBeats;
            currentTimeBeatsByVoice.set(voiceKey, currentTime + durationBeats);
          }
          continue;
        }

        // Hantera chord - samma starttid som föregående not
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
        
        // Musikalisk tid i whole notes (1 beat = 1/4 whole note)
        const startWhole = startTimeBeats / 4;
        const durationWhole = durationBeats / 4;
        const endWhole = startWhole + durationWhole;

        const pitchElement = noteElement.querySelector('pitch');
        if (pitchElement) {
          const midiPitch = convertPitchToMidi(pitchElement);
          
          // NoteEvent.voice är tekniskt (partId, xmlVoice)
          // UI-labels baseras på part-name + antal voices per part
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

        // Uppdatera voice-tid (endast om inte chord)
        if (!isChord) {
          const currentTime = currentTimeBeatsByVoice.get(voiceKey) || measureStartBeats;
          currentTimeBeatsByVoice.set(voiceKey, currentTime + durationBeats);
        }
      }
      
      // Beräkna taktens faktiska längd baserat på längsta voice
      // Detta hanterar ofullständiga takter (pickup/anacrusis) korrekt
      let maxVoiceTime = measureStartBeats;
      for (const time of currentTimeBeatsByVoice.values()) {
        maxVoiceTime = Math.max(maxVoiceTime, time);
      }
      
      const measureLengthBeats = maxVoiceTime - measureStartBeats;
      measureStartBeats = maxVoiceTime;
      measureIndex++;
    }
    
    // Beräkna duration för alla voices i denna part
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
  
  // Hitta part-name
  const part = partMetadata.find(p => p.partId === partId);
  const baseName = part?.partName || partId;
  
  // Räkna antal voices för denna part
  const voicesForPart = allVoices.filter(v => v.startsWith(`${partId}-v`));
  
  // Om generiskt namn som "MusicXML Part", använd partId istället
  const displayBase = (baseName === "MusicXML Part" || baseName.toLowerCase().includes("musicxml")) 
    ? partId 
    : baseName;
  
  // Om bara en voice i parten, visa bara baseName
  if (voicesForPart.length === 1) {
    return displayBase;
  }
  
  // Annars visa "baseName v1", "baseName v2" etc
  return `${displayBase} v${xmlVoice}`;
}




function convertPitchToMidi(pitchElement: Element): number {
  const step = pitchElement.querySelector('step')?.textContent || 'C';
  const octave = parseInt(pitchElement.querySelector('octave')?.textContent || '4');
  const alter = parseInt(pitchElement.querySelector('alter')?.textContent || '0');
  
  // Semitone offset för varje step
  const stepToSemitone: Record<string, number> = {
    'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11
  };
  
  const semitoneOffset = stepToSemitone[step] || 0;
  
  // MIDI-formel: 12 * (octave + 1) + semitoneOffset + alter
  return 12 * (octave + 1) + semitoneOffset + alter;
}