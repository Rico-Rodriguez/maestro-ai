import { getDiatonicSpelling, midiToPitchName } from './pitch';
import type { NoteEvent, Score } from './types';

export interface ToddlerSongSpec {
  id: string;
  title: string;
  subtitle: string;
  emoji: string;
  accentBg: string;
  accentBorder: string;
  tempo: number;
  timeSignature: [number, number];
  melody: readonly (readonly [string, number])[];
}

const STEP_SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function parsePitchNameToMidi(pitchName: string): number {
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(pitchName.trim());
  if (!match) {
    throw new Error(`Invalid pitch name: ${pitchName}`);
  }
  const step = match[1].toUpperCase();
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  const octave = Number(match[3]);
  return (octave + 1) * 12 + STEP_SEMITONE[step] + accidental;
}

export const TODDLER_SONGS: readonly ToddlerSongSpec[] = [
  {
    id: 'toddler:twinkle',
    title: 'Twinkle, Twinkle, Little Star',
    subtitle: 'Gentle bedtime favorite',
    emoji: '⭐',
    accentBg: 'bg-amber-100/90',
    accentBorder: 'border-amber-300',
    tempo: 74,
    timeSignature: [4, 4],
    melody: [
      ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1],
      ['A4', 1], ['A4', 1], ['G4', 2],
      ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1],
      ['D4', 1], ['D4', 1], ['C4', 2],
      ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1],
      ['E4', 1], ['E4', 1], ['D4', 2],
      ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1],
      ['E4', 1], ['E4', 1], ['D4', 2],
      ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1],
      ['A4', 1], ['A4', 1], ['G4', 2],
      ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1],
      ['D4', 1], ['D4', 1], ['C4', 2],
    ],
  },
  {
    id: 'toddler:mary',
    title: 'Mary Had a Little Lamb',
    subtitle: 'Easy 4-note singalong',
    emoji: '🐑',
    accentBg: 'bg-sky-100/90',
    accentBorder: 'border-sky-300',
    tempo: 80,
    timeSignature: [4, 4],
    melody: [
      ['E4', 1], ['D4', 1], ['C4', 1], ['D4', 1],
      ['E4', 1], ['E4', 1], ['E4', 2],
      ['D4', 1], ['D4', 1], ['D4', 2],
      ['E4', 1], ['G4', 1], ['G4', 2],
      ['E4', 1], ['D4', 1], ['C4', 1], ['D4', 1],
      ['E4', 1], ['E4', 1], ['E4', 1], ['E4', 1],
      ['D4', 1], ['D4', 1], ['E4', 1], ['D4', 1],
      ['C4', 4],
    ],
  },
  {
    id: 'toddler:baby-shark',
    title: 'Baby Shark',
    subtitle: 'Bouncy doo-doo-doo riff',
    emoji: '🦈',
    accentBg: 'bg-cyan-100/90',
    accentBorder: 'border-cyan-300',
    tempo: 88,
    timeSignature: [4, 4],
    melody: [
      ['C4', 1], ['D4', 1], ['F4', 1], ['F4', 0.5], ['F4', 0.5],
      ['F4', 0.5], ['F4', 0.5], ['F4', 1], ['F4', 2],
      ['C4', 1], ['D4', 1], ['F4', 1], ['F4', 0.5], ['F4', 0.5],
      ['F4', 0.5], ['F4', 0.5], ['F4', 1], ['F4', 2],
      ['C4', 1], ['D4', 1], ['F4', 1], ['F4', 1],
      ['F4', 1], ['E4', 3],
    ],
  },
  {
    id: 'toddler:row-boat',
    title: 'Row, Row, Row Your Boat',
    subtitle: 'Swaying 3/4 river song',
    emoji: '⛵',
    accentBg: 'bg-teal-100/90',
    accentBorder: 'border-teal-300',
    tempo: 80,
    timeSignature: [3, 4],
    melody: [
      ['C4', 1.5], ['C4', 1.5],
      ['C4', 1], ['D4', 0.5], ['E4', 1.5],
      ['E4', 1], ['D4', 0.5], ['E4', 1], ['F4', 0.5],
      ['G4', 3],
      ['C5', 0.5], ['C5', 0.5], ['C5', 0.5], ['G4', 0.5], ['G4', 0.5], ['G4', 0.5],
      ['E4', 0.5], ['E4', 0.5], ['E4', 0.5], ['C4', 0.5], ['C4', 0.5], ['C4', 0.5],
      ['G4', 1], ['F4', 0.5], ['E4', 1], ['D4', 0.5],
      ['C4', 3],
    ],
  },
  {
    id: 'toddler:london-bridge',
    title: 'London Bridge',
    subtitle: 'Cheerful stepping melody',
    emoji: '🌉',
    accentBg: 'bg-rose-100/90',
    accentBorder: 'border-rose-300',
    tempo: 82,
    timeSignature: [4, 4],
    melody: [
      ['G4', 1.5], ['A4', 0.5], ['G4', 1], ['F4', 1],
      ['E4', 1], ['F4', 1], ['G4', 2],
      ['D4', 1], ['E4', 1], ['F4', 2],
      ['E4', 1], ['F4', 1], ['G4', 2],
      ['G4', 1.5], ['A4', 0.5], ['G4', 1], ['F4', 1],
      ['E4', 1], ['F4', 1], ['G4', 2],
      ['D4', 2], ['G4', 2],
      ['E4', 1], ['C4', 3],
    ],
  },
  {
    id: 'toddler:ode-to-joy',
    title: 'Ode to Joy',
    subtitle: 'Beethoven for little hands',
    emoji: '🌈',
    accentBg: 'bg-purple-100/90',
    accentBorder: 'border-purple-300',
    tempo: 80,
    timeSignature: [4, 4],
    melody: [
      ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1],
      ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
      ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1],
      ['E4', 1.5], ['D4', 0.5], ['D4', 2],
      ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1],
      ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
      ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1],
      ['D4', 1.5], ['C4', 0.5], ['C4', 2],
    ],
  },
];

export function buildToddlerScore(spec: ToddlerSongSpec): Score {
  const [num, den] = spec.timeSignature;
  const beatsPerMeasure = Math.max(1, num * (4 / Math.max(1, den)));
  const secPerBeat = 60 / spec.tempo;

  let cursorBeat = 0;
  let minPitch = 127;
  let maxPitch = 0;
  const events: NoteEvent[] = [];

  for (let i = 0; i < spec.melody.length; i += 1) {
    const [rawName, duration] = spec.melody[i];
    const pitch = parsePitchNameToMidi(rawName);
    const spelling = getDiatonicSpelling(pitch, false);
    const onset = cursorBeat;
    const measure = Math.floor(onset / beatsPerMeasure + 1e-6) + 1;
    const beatInMeasure = onset - (measure - 1) * beatsPerMeasure + 1;

    if (pitch < minPitch) minPitch = pitch;
    if (pitch > maxPitch) maxPitch = pitch;

    events.push({
      id: `${spec.id}:${i}`,
      pitch,
      pitchName: midiToPitchName(pitch, false),
      step: spelling.step,
      alter: spelling.alter,
      octave: spelling.octave,
      preferFlats: false,
      onset,
      duration,
      timeSec: onset * secPerBeat,
      durationSec: duration * secPerBeat,
      measure,
      beat: beatInMeasure,
      hand: 'R',
      velocity: 92,
      track: 0,
    });

    cursorBeat += duration;
  }

  const totalBeats = cursorBeat;
  const totalMeasures = Math.max(1, Math.ceil((totalBeats - 1e-6) / beatsPerMeasure));
  const totalSeconds = totalBeats * secPerBeat;

  return {
    id: spec.id,
    title: spec.title,
    composer: 'Little Maestro',
    genre: 'Toddler Starter',
    tempo: spec.tempo,
    timeSignature: [num, den],
    keySignature: 'C Major',
    sourceFormat: 'toddler-builtin',
    totalMeasures,
    totalBeats,
    totalSeconds,
    minPitch: events.length > 0 ? minPitch : 60,
    maxPitch: events.length > 0 ? maxPitch : 72,
    events,
    pedals: [],
    tempos: [{ tick: 0, beat: 0, timeSec: 0, bpm: spec.tempo }],
    timeSignatures: [{ tick: 0, beat: 0, numerator: num, denominator: den }],
    keySignatures: [{ tick: 0, beat: 0, key: 'C', scale: 'major', sf: 0, preferFlats: false }],
  };
}

export const DEFAULT_TODDLER_SCORE: Score = buildToddlerScore(TODDLER_SONGS[0]);

export function findToddlerSongSpec(id: string | null): ToddlerSongSpec | undefined {
  if (!id) return undefined;
  return TODDLER_SONGS.find((song) => song.id === id);
}
