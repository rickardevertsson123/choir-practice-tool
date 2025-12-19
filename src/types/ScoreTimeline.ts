/*
 * Copyright (c) 2025 Rickard Evertsson
 */

export type VoiceId = "Soprano" | "Alto" | "Tenor" | "Bass" | string;

export interface NoteEvent {
  id: string;                 // unik ID per note event (t.ex. `${voice}-${index}`)
  voice: VoiceId;             // voice, e.g. "Soprano", "Alto", etc.
  startTimeSeconds: number;   // when the note starts, in seconds from piece start
  durationSeconds: number;    // note duration in seconds
  midiPitch: number;          // t.ex. 60 = C4
  startWhole: number;         // musical time in whole notes (for OSMD sync)
  endWhole: number;           // end time in whole notes
  noteId: string;             // stable ID for OSMD SVG mapping
  
  // OSMD GraphicalNote metadata for exact note matching
  measureIndex?: number;      // Measure index in OSMD
  staffIndex?: number;        // Staff index (0 = top staff)
  noteIndexInMeasure?: number; // Note index within the measure
}

export interface ScoreTimeline {
  notes: NoteEvent[];
  totalDurationSeconds: number;
  tempoBpm: number;
}