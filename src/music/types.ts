export type Hand = 'R' | 'L';

export interface NoteEvent {
  id: string;
  pitch: number;
  pitchName: string;
  step: string;
  alter: number;
  octave: number;
  preferFlats: boolean;
  onset: number;
  duration: number;
  timeSec: number;
  durationSec: number;
  measure: number;
  beat: number;
  hand: Hand;
  velocity: number;
  track: number;
}

export interface PedalEvent {
  timeSec: number;
  beat: number;
  value: number;
  down: boolean;
}

export interface TempoPoint {
  tick: number;
  beat: number;
  timeSec: number;
  bpm: number;
}

export interface TimeSigPoint {
  tick: number;
  beat: number;
  numerator: number;
  denominator: number;
}

export interface KeySigPoint {
  tick: number;
  beat: number;
  key: string;
  scale: 'major' | 'minor';
  sf: number;
  preferFlats: boolean;
}

export interface Score {
  id: string;
  title: string;
  composer: string;
  genre: string;
  tempo: number;
  timeSignature: [number, number];
  keySignature: string;
  sourceFormat: string;
  totalMeasures: number;
  totalBeats: number;
  totalSeconds: number;
  minPitch: number;
  maxPitch: number;
  events: NoteEvent[];
  pedals: PedalEvent[];
  tempos: TempoPoint[];
  timeSignatures: TimeSigPoint[];
  keySignatures: KeySigPoint[];
}
