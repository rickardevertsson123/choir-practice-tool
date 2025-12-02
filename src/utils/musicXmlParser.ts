import { ScoreTimeline, NoteEvent, VoiceId } from '../types/ScoreTimeline';

export async function buildScoreTimelineFromMusicXml(xml: string): Promise<ScoreTimeline> {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xml, "application/xml");

  // Hitta tempo från första <sound tempo="...">
  const soundElement = xmlDoc.querySelector('sound[tempo]');
  const tempoBpm = soundElement ? parseInt(soundElement.getAttribute('tempo') || '120') : 120;

  // Bygg part-id till voice-mapping
  const partToVoiceMap = buildPartToVoiceMapping(xmlDoc);

  const notes: NoteEvent[] = [];
  let noteIdCounter = 0;
  const partDurations: number[] = [];

  // Iterera genom alla parts
  const parts = xmlDoc.querySelectorAll('part');
  
  for (const part of parts) {
    const partId = part.getAttribute('id') || '';
    const voice = partToVoiceMap[partId] || partId;
    
    // Absolut tid från styckets början för varje voice
    const absoluteTimeBeatsByVoice = new Map<string, number>();
    const prevStartBeatsByVoice = new Map<string, number>();
    let currentDivisions = 1;

    // Iterera genom measures i denna part
    const measures = part.querySelectorAll('measure');
    let measureStartTimeBeats = 0; // Absolut tid för taktens början
    
    for (const measure of measures) {
      // Uppdatera divisions om det finns
      const divisionsElement = measure.querySelector('attributes divisions');
      if (divisionsElement) {
        currentDivisions = parseInt(divisionsElement.textContent || '1');
      }

      // Spara measure start-tid för varje voice
      const measureStartByVoice = new Map<string, number>();
      for (const [voiceKey, time] of absoluteTimeBeatsByVoice) {
        measureStartByVoice.set(voiceKey, time);
      }

      // Cursor för aktuell position i takten (används för backup)
      let measureCursorBeats = 0;
      let maxMeasureCursor = 0; // Spåra längsta positionen i takten

      // Iterera genom alla element i denna measure (noter och backup)
      const measureChildren = Array.from(measure.children);
      
      for (const element of measureChildren) {
        if (element.tagName === 'backup') {
          // Backa cursor med angiven duration
          const backupDuration = parseInt(element.querySelector('duration')?.textContent || '0');
          measureCursorBeats -= backupDuration / currentDivisions;
          continue;
        }
        
        if (element.tagName !== 'note') continue;
        
        const noteElement = element;
        // Hämta xmlVoice (fallback "1" om saknas)
        const xmlVoice = noteElement.querySelector('voice')?.textContent || '1';
        const voiceKey = `${partId}-${xmlVoice}`;
        
        // Initiera voice-specifika räknare om de inte finns
        if (!absoluteTimeBeatsByVoice.has(voiceKey)) {
          // Ny voice börjar vid taktens början (inte vid 0!)
          absoluteTimeBeatsByVoice.set(voiceKey, measureStartTimeBeats);
          prevStartBeatsByVoice.set(voiceKey, measureStartTimeBeats);
          measureStartByVoice.set(voiceKey, measureStartTimeBeats);
        }

        // Hämta duration
        const duration = parseInt(noteElement.querySelector('duration')?.textContent || '0');
        const durationBeats = duration / currentDivisions;

        // Skippa pauser men uppdatera timing
        if (noteElement.querySelector('rest')) {
          if (!noteElement.querySelector('chord')) {
            measureCursorBeats += durationBeats;
            maxMeasureCursor = Math.max(maxMeasureCursor, measureCursorBeats);
          }
          continue;
        }

        // Hantera chord - samma starttid som föregående not i samma voice
        const isChord = noteElement.querySelector('chord') !== null;
        let startTimeBeats: number;
        
        if (isChord) {
          // Använd samma starttid som föregående not i denna voice
          startTimeBeats = prevStartBeatsByVoice.get(voiceKey) || 0;
        } else {
          // Använd measure start + cursor position
          const measureStart = measureStartByVoice.get(voiceKey) || 0;
          startTimeBeats = measureStart + measureCursorBeats;
          prevStartBeatsByVoice.set(voiceKey, startTimeBeats);
        }
        
        // Konvertera till sekunder
        const startTimeSeconds = (startTimeBeats * 60) / tempoBpm;
        const durationSeconds = (durationBeats * 60) / tempoBpm;

        // Hämta pitch och konvertera till MIDI
        const pitchElement = noteElement.querySelector('pitch');
        if (pitchElement) {
          const midiPitch = convertPitchToMidi(pitchElement);
          
          const noteEvent: NoteEvent = {
            id: `${voice}-${noteIdCounter++}`,
            voice,
            startTimeSeconds,
            durationSeconds,
            midiPitch
          };
          
          notes.push(noteEvent);
        }

        // Uppdatera cursor (endast om det inte är en chord)
        if (!isChord) {
          measureCursorBeats += durationBeats;
          maxMeasureCursor = Math.max(maxMeasureCursor, measureCursorBeats);
        }
      }
      
      // Efter varje measure, uppdatera absolut tid för alla voices till längsta positionen
      for (const voiceKey of absoluteTimeBeatsByVoice.keys()) {
        const measureStart = measureStartByVoice.get(voiceKey) || 0;
        absoluteTimeBeatsByVoice.set(voiceKey, measureStart + maxMeasureCursor);
      }
      
      // Uppdatera measure start-tid för nästa takt
      measureStartTimeBeats += maxMeasureCursor;
    }
    
    // Beräkna duration för denna part
    const partNotes = notes.filter(note => note.voice === voice);
    const partDuration = partNotes.reduce((max, note) => 
      Math.max(max, note.startTimeSeconds + note.durationSeconds), 0
    );
    partDurations.push(partDuration);
  }

  // Total duration är max av alla part-durationer
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