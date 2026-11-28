import type { Hand, NoteEvent, TimeSigPoint } from '../music/types';
import type { PracticeGrade } from '../practice/engine';

export type ColorMode = 'rainbow' | 'hands';

export interface RainbowNoteStyle {
  name: string;
  top: string;
  bottom: string;
  border: string;
  glow: string;
  stickerBg: string;
  stickerText: string;
  keyBgFrom: string;
  keyBgVia: string;
  keyBgTo: string;
}

export interface NotePalette {
  top: string;
  bottom: string;
  border: string;
  glow: string;
  stickerBg: string;
  stickerText: string;
}

const SHORT_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

const RAINBOW_BY_PC: Record<number, RainbowNoteStyle> = {
  0: {
    name: 'Red',
    top: '#f87171',
    bottom: '#dc2626',
    border: 'rgba(254, 226, 226, 0.72)',
    glow: 'rgba(239, 68, 68, 0.78)',
    stickerBg: '#ef4444',
    stickerText: '#ffffff',
    keyBgFrom: '#fecaca',
    keyBgVia: '#f87171',
    keyBgTo: '#dc2626',
  },
  1: {
    name: 'Ruby',
    top: '#e11d48',
    bottom: '#881337',
    border: '#fef3c7',
    glow: 'rgba(225, 29, 72, 0.85)',
    stickerBg: '#be123c',
    stickerText: '#fff1f2',
    keyBgFrom: '#fb7185',
    keyBgVia: '#e11d48',
    keyBgTo: '#881337',
  },
  2: {
    name: 'Orange',
    top: '#fb923c',
    bottom: '#ea580c',
    border: 'rgba(255, 237, 213, 0.72)',
    glow: 'rgba(249, 115, 22, 0.78)',
    stickerBg: '#f97316',
    stickerText: '#ffffff',
    keyBgFrom: '#fed7aa',
    keyBgVia: '#fb923c',
    keyBgTo: '#ea580c',
  },
  3: {
    name: 'Amber',
    top: '#d97706',
    bottom: '#78350f',
    border: '#fef3c7',
    glow: 'rgba(217, 119, 6, 0.85)',
    stickerBg: '#b45309',
    stickerText: '#fffbeb',
    keyBgFrom: '#fbbf24',
    keyBgVia: '#d97706',
    keyBgTo: '#78350f',
  },
  4: {
    name: 'Yellow',
    top: '#fde047',
    bottom: '#ca8a04',
    border: 'rgba(254, 249, 195, 0.82)',
    glow: 'rgba(234, 179, 8, 0.78)',
    stickerBg: '#eab308',
    stickerText: '#422006',
    keyBgFrom: '#fef08a',
    keyBgVia: '#fde047',
    keyBgTo: '#ca8a04',
  },
  5: {
    name: 'Green',
    top: '#4ade80',
    bottom: '#16a34a',
    border: 'rgba(220, 252, 231, 0.72)',
    glow: 'rgba(34, 197, 94, 0.78)',
    stickerBg: '#22c55e',
    stickerText: '#ffffff',
    keyBgFrom: '#bbf7d0',
    keyBgVia: '#4ade80',
    keyBgTo: '#16a34a',
  },
  6: {
    name: 'Emerald',
    top: '#15803d',
    bottom: '#14532d',
    border: '#fef3c7',
    glow: 'rgba(21, 128, 61, 0.85)',
    stickerBg: '#166534',
    stickerText: '#f0fdf4',
    keyBgFrom: '#4ade80',
    keyBgVia: '#15803d',
    keyBgTo: '#14532d',
  },
  7: {
    name: 'Teal',
    top: '#2dd4bf',
    bottom: '#0d9488',
    border: 'rgba(204, 251, 241, 0.72)',
    glow: 'rgba(6, 182, 212, 0.78)',
    stickerBg: '#06b6d4',
    stickerText: '#ffffff',
    keyBgFrom: '#99f6e4',
    keyBgVia: '#2dd4bf',
    keyBgTo: '#0d9488',
  },
  8: {
    name: 'Deep Cyan',
    top: '#0891b2',
    bottom: '#164e63',
    border: '#f5f3ff',
    glow: 'rgba(8, 145, 178, 0.85)',
    stickerBg: '#0e7490',
    stickerText: '#ecfeff',
    keyBgFrom: '#22d3ee',
    keyBgVia: '#0891b2',
    keyBgTo: '#164e63',
  },
  9: {
    name: 'Royal Blue',
    top: '#60a5fa',
    bottom: '#2563eb',
    border: 'rgba(219, 234, 254, 0.72)',
    glow: 'rgba(59, 130, 246, 0.78)',
    stickerBg: '#3b82f6',
    stickerText: '#ffffff',
    keyBgFrom: '#bfdbfe',
    keyBgVia: '#60a5fa',
    keyBgTo: '#2563eb',
  },
  10: {
    name: 'Indigo',
    top: '#4f46e5',
    bottom: '#1e1b4b',
    border: '#f5f3ff',
    glow: 'rgba(79, 70, 229, 0.85)',
    stickerBg: '#4338ca',
    stickerText: '#eef2ff',
    keyBgFrom: '#818cf8',
    keyBgVia: '#4f46e5',
    keyBgTo: '#1e1b4b',
  },
  11: {
    name: 'Purple',
    top: '#c084fc',
    bottom: '#7e22ce',
    border: 'rgba(243, 232, 255, 0.72)',
    glow: 'rgba(168, 85, 247, 0.78)',
    stickerBg: '#a855f7',
    stickerText: '#ffffff',
    keyBgFrom: '#e9d5ff',
    keyBgVia: '#c084fc',
    keyBgTo: '#7e22ce',
  },
};

const HANDS_PALETTE_R_WHITE: NotePalette = {
  top: '#fbbf24',
  bottom: '#d97706',
  border: 'rgba(254, 243, 199, 0.5)',
  glow: 'rgba(245, 158, 11, 0.72)',
  stickerBg: '#f59e0b',
  stickerText: '#451a03',
};

const HANDS_PALETTE_L_WHITE: NotePalette = {
  top: '#7dd3fc',
  bottom: '#0284c7',
  border: 'rgba(224, 242, 254, 0.5)',
  glow: 'rgba(56, 189, 248, 0.72)',
  stickerBg: '#0ea5e9',
  stickerText: '#ffffff',
};

const HANDS_PALETTE_R_BLACK: NotePalette = {
  top: '#fb923c',
  bottom: '#9a3412',
  border: '#fed7aa',
  glow: 'rgba(251, 146, 60, 0.78)',
  stickerBg: '#ea580c',
  stickerText: '#fff7ed',
};

const HANDS_PALETTE_L_BLACK: NotePalette = {
  top: '#60a5fa',
  bottom: '#1e40af',
  border: '#bfdbfe',
  glow: 'rgba(96, 165, 250, 0.78)',
  stickerBg: '#2563eb',
  stickerText: '#eff6ff',
};

function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

export function getRainbowNoteStyle(pitch: number): RainbowNoteStyle {
  return RAINBOW_BY_PC[pitchClass(pitch)] ?? RAINBOW_BY_PC[0];
}

export function getNotePalette(
  pitch: number,
  hand: Hand,
  colorMode: ColorMode,
): NotePalette {
  if (colorMode === 'rainbow') {
    const s = getRainbowNoteStyle(pitch);
    return {
      top: s.top,
      bottom: s.bottom,
      border: s.border,
      glow: s.glow,
      stickerBg: s.stickerBg,
      stickerText: s.stickerText,
    };
  }
  const isBlack = BLACK_PITCH_CLASSES.has(pitchClass(pitch));
  if (isBlack) {
    return hand === 'R' ? HANDS_PALETTE_R_BLACK : HANDS_PALETTE_L_BLACK;
  }
  return hand === 'R' ? HANDS_PALETTE_R_WHITE : HANDS_PALETTE_L_WHITE;
}

export function getKeyStickerColor(pitch: number): {
  bg: string;
  text: string;
  shortLabel: string;
} {
  const pc = pitchClass(pitch);
  const style = RAINBOW_BY_PC[pc] ?? RAINBOW_BY_PC[0];
  return {
    bg: style.stickerBg,
    text: style.stickerText,
    shortLabel: SHORT_LABELS[pc] ?? 'C',
  };
}

const KID_HINT_BY_PC: Record<number, { colorName: string; laneTint: string }> = {
  0: { colorName: 'Red', laneTint: 'rgba(248, 113, 113, 0.08)' },
  1: { colorName: 'Ruby', laneTint: 'rgba(225, 29, 72, 0.08)' },
  2: { colorName: 'Orange', laneTint: 'rgba(251, 146, 60, 0.08)' },
  3: { colorName: 'Amber', laneTint: 'rgba(217, 119, 6, 0.08)' },
  4: { colorName: 'Yellow', laneTint: 'rgba(250, 204, 21, 0.08)' },
  5: { colorName: 'Green', laneTint: 'rgba(74, 222, 128, 0.08)' },
  6: { colorName: 'Emerald', laneTint: 'rgba(21, 128, 61, 0.08)' },
  7: { colorName: 'Teal', laneTint: 'rgba(45, 212, 191, 0.08)' },
  8: { colorName: 'Cyan', laneTint: 'rgba(8, 145, 178, 0.08)' },
  9: { colorName: 'Blue', laneTint: 'rgba(96, 165, 250, 0.08)' },
  10: { colorName: 'Indigo', laneTint: 'rgba(79, 70, 229, 0.08)' },
  11: { colorName: 'Purple', laneTint: 'rgba(192, 132, 252, 0.08)' },
};

export function getKidNoteHint(pitch: number): {
  letter: string;
  colorName: string;
  bg: string;
  text: string;
  laneTint: string;
} {
  const pc = pitchClass(pitch);
  const style = RAINBOW_BY_PC[pc] ?? RAINBOW_BY_PC[0];
  const hint = KID_HINT_BY_PC[pc] ?? KID_HINT_BY_PC[0];
  return {
    letter: SHORT_LABELS[pc] ?? 'C',
    colorName: hint.colorName,
    bg: style.stickerBg,
    text: style.stickerText,
    laneTint: hint.laneTint,
  };
}

export function measureAtBeat(
  timeSignatures: readonly TimeSigPoint[],
  defaultBeatsPerMeasure: number,
  beat: number,
): number {
  const safeDefault = Math.max(0.25, defaultBeatsPerMeasure || 4);
  const targetBeat = Math.max(0, Number.isFinite(beat) ? beat : 0);
  const sorted = [...timeSignatures].sort((a, b) => a.beat - b.beat);

  if (sorted.length === 0) {
    return Math.max(1, Math.floor((targetBeat + 1e-4) / safeDefault) + 1);
  }

  let measure = 1;
  let cursorBeat = 0;

  if (sorted[0].beat > 1e-4) {
    const firstEnd = sorted[0].beat;
    if (targetBeat < firstEnd - 1e-4) {
      return Math.max(1, Math.floor((targetBeat + 1e-4) / safeDefault) + 1);
    }
    measure += Math.ceil(Math.max(0, firstEnd - 1e-4) / safeDefault);
    cursorBeat = firstEnd;
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const ts = sorted[i];
    const bpb = Math.max(0.25, ts.numerator * (4 / Math.max(1, ts.denominator)));
    const segStart = Math.max(cursorBeat, ts.beat);
    const segEnd = i + 1 < sorted.length ? sorted[i + 1].beat : Infinity;

    if (targetBeat < segEnd - 1e-4 || i + 1 === sorted.length) {
      const offset = Math.max(0, targetBeat - segStart);
      return measure + Math.floor((offset + 1e-4) / bpb);
    }

    const span = Math.max(0, segEnd - segStart);
    measure += Math.ceil(Math.max(0, span - 1e-4) / bpb);
    cursorBeat = segEnd;
  }

  return measure;
}

export function gardenFromGrades(
  events: readonly NoteEvent[],
  grades: Record<string, PracticeGrade>,
): { id: string; pitch: number; color: string }[] {
  return [...events]
    .filter((ev) => grades[ev.id]?.status === 'hit')
    .sort((a, b) => a.onset - b.onset || a.pitch - b.pitch)
    .map((ev) => ({
      id: ev.id,
      pitch: ev.pitch,
      color: getKeyStickerColor(ev.pitch).bg,
    }));
}
