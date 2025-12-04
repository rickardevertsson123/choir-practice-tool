export type VoiceId = "Soprano" | "Alto" | "Tenor" | "Bass" | string;

export interface NoteEvent {
  id: string;                 // unik ID per note event (t.ex. `${voice}-${index}`)
  voice: VoiceId;             // stämma, t.ex. "Soprano", "Alto", etc.
  startTimeSeconds: number;   // när tonen börjar, i sekunder från styckets start
  durationSeconds: number;    // tonens längd i sekunder
  midiPitch: number;          // t.ex. 60 = C4
  startWhole: number;         // musikalisk tid i whole notes (för OSMD-synk)
  endWhole: number;           // sluttid i whole notes
}

export interface ScoreTimeline {
  notes: NoteEvent[];
  totalDurationSeconds: number;
  tempoBpm: number;
}