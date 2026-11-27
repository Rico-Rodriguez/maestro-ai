export interface DiatonicSpelling {
  step: string;
  alter: number;
  octave: number;
}

export interface DetectedFrequencyNote {
  midi: number;
  name: string;
  freq: number;
  centsOff: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

const DIATONIC_STEP_MAP: Record<number, { step: string; alter: number }> = {
  0: { step: 'C', alter: 0 },
  1: { step: 'C', alter: 1 },
  2: { step: 'D', alter: 0 },
  3: { step: 'D', alter: 1 },
  4: { step: 'E', alter: 0 },
  5: { step: 'F', alter: 0 },
  6: { step: 'F', alter: 1 },
  7: { step: 'G', alter: 0 },
  8: { step: 'G', alter: 1 },
  9: { step: 'A', alter: 0 },
  10: { step: 'A', alter: 1 },
  11: { step: 'B', alter: 0 },
};

const FLAT_STEP_MAP: Record<number, { step: string; alter: number }> = {
  0: { step: 'C', alter: 0 },
  1: { step: 'D', alter: -1 },
  2: { step: 'D', alter: 0 },
  3: { step: 'E', alter: -1 },
  4: { step: 'E', alter: 0 },
  5: { step: 'F', alter: 0 },
  6: { step: 'G', alter: -1 },
  7: { step: 'G', alter: 0 },
  8: { step: 'A', alter: -1 },
  9: { step: 'A', alter: 0 },
  10: { step: 'B', alter: -1 },
  11: { step: 'B', alter: 0 },
};

const DIATONIC_INDEX: Record<string, number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
};

const MAJOR_KEY_SF: Record<string, number> = {
  Cb: -7,
  Gb: -6,
  Db: -5,
  Ab: -4,
  Eb: -3,
  Bb: -2,
  F: -1,
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  'F#': 6,
  'C#': 7,
};

const MINOR_KEY_SF: Record<string, number> = {
  Ab: -7,
  Eb: -6,
  Bb: -5,
  F: -4,
  C: -3,
  G: -2,
  D: -1,
  A: 0,
  E: 1,
  B: 2,
  'F#': 3,
  'C#': 4,
  'G#': 5,
  'D#': 6,
  'A#': 7,
};

function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

function normalizeKeyRoot(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return 'C';
  const token = trimmed.split(/\s+/)[0] ?? 'C';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function midiToPitchName(midi: number, preferFlats = false): string {
  const octave = Math.floor(midi / 12) - 1;
  const pc = pitchClass(midi);
  if (preferFlats) {
    const info = FLAT_STEP_MAP[pc];
    return `${info.step}${info.alter === -1 ? 'b' : ''}${octave}`;
  }
  return `${NOTE_NAMES[pc]}${octave}`;
}

export function getDiatonicSpelling(midi: number, preferFlats = false): DiatonicSpelling {
  const octave = Math.floor(midi / 12) - 1;
  const map = preferFlats ? FLAT_STEP_MAP : DIATONIC_STEP_MAP;
  const info = map[pitchClass(midi)] ?? { step: 'C', alter: 0 };
  return { step: info.step, alter: info.alter, octave };
}

export function getStaffYOffset(
  midi: number,
  clef: 'treble' | 'bass' = 'treble',
  preferFlats = false,
): number {
  const { step, octave } = getDiatonicSpelling(midi, preferFlats);
  const diatonicNumber = octave * 7 + (DIATONIC_INDEX[step] ?? 0);
  const bottomLineDiatonic = clef === 'treble' ? 30 : 18;
  return diatonicNumber - bottomLineDiatonic;
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToNote(freq: number): DetectedFrequencyNote | null {
  if (!freq || freq <= 20) return null;
  const floatMidi = 69 + 12 * Math.log2(freq / 440);
  const rounded = Math.round(floatMidi);
  const centsOff = Math.round((floatMidi - rounded) * 100);
  if (rounded < 21 || rounded > 108) return null;
  return {
    midi: rounded,
    name: midiToPitchName(rounded),
    freq: Math.round(freq * 10) / 10,
    centsOff,
  };
}

export function keySignatureSf(key: string, scale = 'major'): number {
  const root = normalizeKeyRoot(key);
  const isMinor = scale.toLowerCase() === 'minor';
  const table = isMinor ? MINOR_KEY_SF : MAJOR_KEY_SF;
  return table[root] ?? 0;
}

export function prefersFlatsForKey(key: string, scale = 'major'): boolean {
  return keySignatureSf(key, scale) < 0;
}

export function keySignatureLabel(key: string, scale = 'major'): string {
  const root = normalizeKeyRoot(key);
  const scaleLabel = scale.toLowerCase() === 'minor' ? 'Minor' : 'Major';
  return `${root} ${scaleLabel}`;
}
