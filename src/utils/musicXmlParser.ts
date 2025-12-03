import { ScoreTimeline, NoteEvent, VoiceId } from '../types/ScoreTimeline';

export async function buildScoreTimelineFromMusicXml(xml: string): Promise<ScoreTimeline> {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xml, "application/xml");

  const soundElement = xmlDoc.querySelector('sound[tempo]');
  const tempoBpm = soundElement ? parseInt(soundElement.getAttribute('tempo') || '120') : 120;
  
  const partToVoiceMap = buildPartToVoiceMapping(xmlDoc);
  const notes: NoteEvent[] = [];
  let noteIdCounter = 0;
  const partDurations: number[] = [];

  const parts = xmlDoc.querySelectorAll('part');
  
  for (const part of parts) {
    const partId = part.getAttribute('id') || '';
    const voice = partToVoiceMap[partId] || partId;
    
    // Per-voice tidsräknare - varje voice har egen oberoende tidslinje
    const currentTimeBeatsByVoice = new Map<string, number>();
    const prevStartBeatsByVoice = new Map<string, number>();
    let currentDivisions = 1;
    let measureStartBeats = 0;

    const measures = part.querySelectorAll('measure');
    
    for (const measure of measures) {
      const divisionsElement = measure.querySelector('attributes divisions');
      if (divisionsElement) {
        currentDivisions = parseInt(divisionsElement.textContent || '1');
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

        const pitchElement = noteElement.querySelector('pitch');
        if (pitchElement) {
          const midiPitch = convertPitchToMidi(pitchElement);
          
          const noteEvent: NoteEvent = {
            id: `${voice}-${xmlVoice}-${noteIdCounter++}`,
            voice,
            startTimeSeconds,
            durationSeconds,
            midiPitch
          };
          
          notes.push(noteEvent);
        }

        // Uppdatera voice-tid (endast om inte chord)
        if (!isChord) {
          const currentTime = currentTimeBeatsByVoice.get(voiceKey) || measureStartBeats;
          currentTimeBeatsByVoice.set(voiceKey, currentTime + durationBeats);
        }
      }
      
      // Nästa takt börjar efter denna takts längd (3 beats i 3/4-takt)
      measureStartBeats += 3; // 3/4 takt
    }
    
    const partNotes = notes.filter(note => note.voice === voice);
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

function buildPartToVoiceMapping(xmlDoc: Document): Record<string, VoiceId> {
  const mapping: Record<string, VoiceId> = {};
  
  const scoreParts = xmlDoc.querySelectorAll('score-part');
  
  for (const scorePart of scoreParts) {
    const partId = scorePart.getAttribute('id') || '';
    const partNameElement = scorePart.querySelector('part-name');
    const partName = partNameElement?.textContent?.toLowerCase() || '';
    
    let voice: VoiceId = partId; // fallback
    
    if (partName.includes('sop')) {
      voice = 'Soprano';
    } else if (partName.includes('alt')) {
      voice = 'Alto';
    } else if (partName.includes('ten')) {
      voice = 'Tenor';
    } else if (partName.includes('bas') || partName.includes('bass')) {
      voice = 'Bass';
    } else if (partName.includes('keyboard') || partName.includes('piano') || partName.includes('rehearsal')) {
      voice = 'Rehearsal keyboard';
    } else if (partNameElement?.textContent) {
      voice = partNameElement.textContent;
    }
    
    mapping[partId] = voice;
  }
  
  return mapping;
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