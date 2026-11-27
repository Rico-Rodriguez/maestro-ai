export type NoteSource = 'midi' | 'kbd' | 'touch' | 'mic';

export type NoteInput =
  | { kind: 'on'; pitch: number; velocity: number; source: NoteSource; timeMs: number }
  | { kind: 'off'; pitch: number; source: NoteSource; timeMs: number }
  | { kind: 'sustain'; down: boolean; source: NoteSource; timeMs: number };

export type MidiDeviceInfo = {
  id: string;
  name: string;
  manufacturer: string;
  state: string;
};

export type MidiAccessState = 'unknown' | 'ready' | 'denied' | 'unsupported';

export type MicPitchReading = {
  midi: number;
  name: string;
  freq: number;
  centsOff: number;
  clarity: number;
};
