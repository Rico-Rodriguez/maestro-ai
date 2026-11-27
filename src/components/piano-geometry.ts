import { midiToPitchName } from '../music/pitch';

export type PianoRangeMode = 'auto' | 'compact' | '61' | '88';

export interface KeyGeom {
  midi: number;
  isBlack: boolean;
  x: number;
  width: number;
  label: string;
  isC: boolean;
}

export interface PianoLayout {
  minMidi: number;
  maxMidi: number;
  whiteKeys: KeyGeom[];
  blackKeys: KeyGeom[];
  allKeys: KeyGeom[];
  byMidi: Map<number, KeyGeom>;
  whiteCount: number;
}

const PIANO_MIN = 21;
const PIANO_MAX = 108;
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

// Left-edge offsets as fractions of whiteWidth for acoustic key asymmetry.
const BLACK_KEY_OFFSETS: Record<number, number> = {
  1: 0.6,
  3: 0.72,
  6: 0.58,
  8: 0.66,
  10: 0.74,
};

function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

function snapDownToWhite(midi: number): number {
  let m = Math.max(PIANO_MIN, Math.min(PIANO_MAX, Math.floor(midi)));
  while (m > PIANO_MIN && isBlackKey(m)) m -= 1;
  return m;
}

function snapUpToWhite(midi: number): number {
  let m = Math.max(PIANO_MIN, Math.min(PIANO_MAX, Math.ceil(midi)));
  while (m < PIANO_MAX && isBlackKey(m)) m += 1;
  return m;
}

export function computePianoRange(
  mode: PianoRangeMode,
  scoreMin?: number,
  scoreMax?: number,
  octaveShift = 0,
): { minMidi: number; maxMidi: number } {
  if (mode === '88') {
    return { minMidi: 21, maxMidi: 108 };
  }
  if (mode === '61') {
    return { minMidi: 36, maxMidi: 96 };
  }
  if (mode === 'compact') {
    const clampedBase = Math.max(24, Math.min(84, 48 + octaveShift * 12));
    return {
      minMidi: snapDownToWhite(clampedBase),
      maxMidi: snapUpToWhite(clampedBase + 24),
    };
  }

  const rawLo = Number.isFinite(scoreMin) ? (scoreMin as number) : 48;
  const rawHi = Number.isFinite(scoreMax) ? (scoreMax as number) : 72;
  const orderedLo = Math.min(rawLo, rawHi);
  const orderedHi = Math.max(rawLo, rawHi);

  let lo = Math.max(PIANO_MIN, Math.floor(orderedLo) - 2);
  let hi = Math.min(PIANO_MAX, Math.ceil(orderedHi) + 2);

  if (hi - lo < 25) {
    const needed = 25 - (hi - lo);
    const padLow = Math.floor(needed / 2);
    const padHigh = needed - padLow;
    lo = Math.max(PIANO_MIN, lo - padLow);
    hi = Math.min(PIANO_MAX, hi + padHigh);
    if (hi - lo < 25) {
      if (lo === PIANO_MIN) {
        hi = Math.min(PIANO_MAX, lo + 25);
      } else if (hi === PIANO_MAX) {
        lo = Math.max(PIANO_MIN, hi - 25);
      }
    }
  }

  return {
    minMidi: snapDownToWhite(lo),
    maxMidi: snapUpToWhite(hi),
  };
}

export function buildPianoLayout(minMidi: number, maxMidi: number): PianoLayout {
  const lo = Math.min(minMidi, maxMidi);
  const hi = Math.max(minMidi, maxMidi);

  const whiteMidis: number[] = [];
  const whiteIndexByMidi = new Map<number, number>();
  for (let m = lo; m <= hi; m += 1) {
    if (!isBlackKey(m)) {
      whiteIndexByMidi.set(m, whiteMidis.length);
      whiteMidis.push(m);
    }
  }

  const whiteCount = whiteMidis.length;
  const whiteWidth = whiteCount > 0 ? 1 / whiteCount : 1;

  const whiteKeys: KeyGeom[] = [];
  const blackKeys: KeyGeom[] = [];
  const allKeys: KeyGeom[] = [];
  const byMidi = new Map<number, KeyGeom>();

  for (let m = lo; m <= hi; m += 1) {
    const black = isBlackKey(m);
    if (!black) {
      const idx = whiteIndexByMidi.get(m) ?? 0;
      const geom: KeyGeom = {
        midi: m,
        isBlack: false,
        x: idx * whiteWidth,
        width: whiteWidth,
        label: midiToPitchName(m),
        isC: ((m % 12) + 12) % 12 === 0,
      };
      whiteKeys.push(geom);
      allKeys.push(geom);
      byMidi.set(m, geom);
    } else {
      const pc = ((m % 12) + 12) % 12;
      const lowerWhiteIdx = whiteIndexByMidi.get(m - 1) ?? -1;
      const offset = BLACK_KEY_OFFSETS[pc] ?? 0.65;
      const rawWidth = 0.6 * whiteWidth;
      const rawX = (lowerWhiteIdx + offset) * whiteWidth;
      const x = Math.max(0, Math.min(1, rawX));
      const width = Math.max(0, Math.min(rawWidth, 1 - x));
      const geom: KeyGeom = {
        midi: m,
        isBlack: true,
        x,
        width,
        label: midiToPitchName(m),
        isC: false,
      };
      blackKeys.push(geom);
      allKeys.push(geom);
      byMidi.set(m, geom);
    }
  }

  return {
    minMidi: lo,
    maxMidi: hi,
    whiteKeys,
    blackKeys,
    allKeys,
    byMidi,
    whiteCount,
  };
}
