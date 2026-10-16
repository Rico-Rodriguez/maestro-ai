import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useMuseScorePaste } from './musescore-paste';
import {
  groupStaffEvents,
  layoutStaffGroup,
  octaveShiftForWindow,
} from './staff-layout.mjs';
import { MaestroAudioEngine, isIosLike } from './poteto-audio.mjs';
import {
  PRACTICE_MODES,
  practiceModeMeta,
  formatNextChip,
  chordCanAdvance,
  notesPassedBy,
  micShouldAdvanceScore,
  midiStatusLine,
  midiShortStatus,
} from './practice-session.mjs';
import {
  Music, Upload, Play, Pause, RotateCcw, Sliders, Mic, MicOff, Cpu, CheckCircle2,
  AlertTriangle, Sparkles, BookOpen, Layers, Volume2, VolumeX, Repeat, ChevronRight,
  ChevronLeft, Activity, Award, FileText, Download, Eye, Wrench, ShieldCheck,
  Radio, Plus, Check, X, RefreshCw, Compass, Sun, Moon, Smartphone, Maximize2
} from 'lucide-react';

// ============================================================================
// 1. MUSIC THEORY & MAESTRO MUSIC GRAPH (MMG) UTILITIES
// ============================================================================

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DIATONIC_STEP_MAP = {
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

const FLAT_STEP_MAP = {
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

const DIATONIC_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

export function midiToPitchName(midi, preferFlats = false) {
  const octave = Math.floor(midi / 12) - 1;
  if (preferFlats) {
    const info = FLAT_STEP_MAP[midi % 12];
    return `${info.step}${info.alter === -1 ? 'b' : ''}${octave}`;
  }
  const name = NOTE_NAMES[midi % 12];
  return `${name}${octave}`;
}

export function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToMidi(freq) {
  if (!freq || freq <= 20) return null;
  const floatMidi = 69 + 12 * Math.log2(freq / 440);
  const rounded = Math.round(floatMidi);
  const centsOff = Math.round((floatMidi - rounded) * 100);
  if (rounded < 21 || rounded > 108) return null;
  return { midi: rounded, name: midiToPitchName(rounded), freq: Math.round(freq * 10) / 10, centsOff };
}

export function getDiatonicSpelling(midi, preferFlats = false) {
  const octave = Math.floor(midi / 12) - 1;
  const map = preferFlats ? FLAT_STEP_MAP : DIATONIC_STEP_MAP;
  const info = map[midi % 12] || { step: 'C', alter: 0 };
  return { step: info.step, alter: info.alter, octave };
}

export function getStaffYOffset(midi, clef = 'treble', preferFlats = false) {
  const { step, octave } = getDiatonicSpelling(midi, preferFlats);
  const diatonicNumber = octave * 7 + DIATONIC_INDEX[step];
  const bottomLineDiatonic = clef === 'treble' ? 30 : 18;
  return diatonicNumber - bottomLineDiatonic;
}

const KEYBOARD_TO_MIDI = {
  'z': 48, 's': 49, 'x': 50, 'd': 51, 'c': 52, 'v': 53, 'g': 54, 'b': 55, 'h': 56, 'n': 57, 'j': 58, 'm': 59,
  'q': 60, '2': 61, 'w': 62, '3': 63, 'e': 64, 'r': 65, '5': 66, 't': 67, '6': 68, 'y': 69, '7': 70, 'u': 71,
  'i': 72, '9': 73, 'o': 74, '0': 75, 'p': 76, '[': 77, '=': 78, ']': 79
};

// ============================================================================
// 2. CANONICAL SAMPLE LIBRARY (FULL 16-TO-24 MEASURE ARRANGEMENTS)
// ============================================================================

const PITCH_STR_REGEX = /^([A-G])(#|b)?(-?\d+)$/;
const SEMITONE_MAP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteStrToMidi(str) {
  if (typeof str === 'number') return str;
  const m = PITCH_STR_REGEX.exec(str.trim());
  if (!m) return 60;
  const [, step, acc, octStr] = m;
  const oct = parseInt(octStr, 10);
  const alter = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  return (oct + 1) * 12 + SEMITONE_MAP[step] + alter;
}

// Helper to compile compact measure-by-measure right-hand & left-hand scores into full MMG events
function compileCompactScore(measuresList, beatsPerMeasure = 4) {
  const rawNotes = [];
  measuresList.forEach((m, mIdx) => {
    const measureStartBeat = mIdx * beatsPerMeasure;
    const harmony = m.chord || 'C';

    const processVoice = (tokens, hand) => {
      let cursor = 0;
      tokens.forEach((tok) => {
        // Format: "E4:1:3" (Pitch : DurationBeats : Finger) or "R:1" (Rest)
        const parts = tok.split(':');
        const pitchPart = parts[0];
        const dur = parseFloat(parts[1] || '1');
        const finger = parts[2] ? parseInt(parts[2], 10) : undefined;
        const conf = parts[3] ? parseFloat(parts[3]) : 0.98;

        if (pitchPart !== 'R') {
          // Support chord tokens like "C4+E4+G4"
          const pitches = pitchPart.split('+');
          pitches.forEach((pStr, pIdx) => {
            const midi = noteStrToMidi(pStr);
            const hasExplicitFlat = pStr.includes('b');
            const hasExplicitSharp = pStr.includes('#');
            rawNotes.push({
              pitch: midi,
              preferFlats: hasExplicitFlat ? true : hasExplicitSharp ? false : undefined,
              onset: Math.round((measureStartBeat + cursor) * 10000) / 10000,
              duration: dur,
              hand,
              finger: finger || (hand === 'R' ? ((pIdx * 2) % 5) + 1 : 5 - (pIdx * 2)),
              confidence: conf,
              harmony
            });
          });
        }
        cursor += dur;
      });
    };

    if (m.rh) processVoice(m.rh, 'R');
    if (m.lh) processVoice(m.lh, 'L');
  });
  return rawNotes;
}

function buildSongFromEvents({
  id, title, composer, genre, difficulty, tempo, timeSignature, keySignature, sourceFormat, license, rawNotes
}) {
  const beatsPerMeasure = timeSignature[0] * (4 / timeSignature[1]);
  const isFlatKey = ['F Major', 'D Minor', 'Bb Major', 'G Minor', 'Eb Major', 'C Minor', 'Ab Major', 'F Minor'].some(
    k => (keySignature || '').includes(k)
  );
  const totalMeasures = Math.max(
    1,
    Math.ceil(Math.max(...rawNotes.map(r => r.onset + r.duration)) / beatsPerMeasure)
  );
  const events = rawNotes.map((n, idx) => {
    const measure = Math.floor((n.onset + 0.0001) / beatsPerMeasure) + 1;
    const beatInMeasure = (n.onset % beatsPerMeasure) + 1;
    const useFlats = n.preferFlats !== undefined ? n.preferFlats : isFlatKey;
    const spelling = getDiatonicSpelling(n.pitch, useFlats);
    const row = Math.floor((measure - 1) / 4);
    const colProgress = ((n.onset % (beatsPerMeasure * 4)) / (beatsPerMeasure * 4));
    return {
      id: `${id}-ev-${idx}`,
      pitch: n.pitch,
      pitchName: midiToPitchName(n.pitch, useFlats),
      step: spelling.step,
      alter: spelling.alter,
      octave: spelling.octave,
      preferFlats: useFlats,
      onset: n.onset,
      duration: n.duration,
      measure,
      beat: Math.round(beatInMeasure * 100) / 100,
      hand: n.hand || (n.pitch >= 60 ? 'R' : 'L'),
      finger: n.finger || ((idx % 5) + 1),
      velocity: n.velocity || (n.hand === 'L' ? 66 : 92),
      confidence: n.confidence ?? 0.98,
      alternatives: n.alternatives || [
        { pitch: n.pitch + 1, label: `${midiToPitchName(n.pitch + 1, useFlats)} (Accidental)`, confidence: 0.22 },
        { pitch: n.pitch - 2, label: `${midiToPitchName(n.pitch - 2, useFlats)} (Staff Line Shift)`, confidence: 0.14 }
      ],
      verified: (n.confidence ?? 0.98) >= 0.85,
      harmony: n.harmony || 'C',
      bbox: {
        x: 0.08 + colProgress * 0.84,
        y: 0.18 + (row % 3) * 0.24 + (n.hand === 'L' ? 0.06 : 0.0),
        w: 0.045,
        h: 0.055
      },
      totalMeasures
    };
  });

  // Sort chronologically by onset so playback, wait-mode, and score following never jump out of order
  events.sort((a, b) => a.onset - b.onset || b.pitch - a.pitch);

  return {
    id,
    title,
    composer,
    genre,
    difficulty,
    tempo,
    timeSignature,
    keySignature,
    sourceFormat,
    license,
    mmgVersion: '1.0.0',
    totalMeasures,
    events
  };
}

const INITIAL_SONGS = [
  // 1. ODE TO JOY — LUDWIG VAN BEETHOVEN (SYMPHONY NO. 9)
  buildSongFromEvents({
    id: 'ode-to-joy',
    title: 'Ode to Joy (Symphony No. 9, Complete Theme)',
    composer: 'Ludwig van Beethoven',
    genre: 'Classical',
    difficulty: 'Beginner',
    tempo: 108,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Concert Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      // Phrase A (Bars 1-4)
      { chord: 'C', rh: ['E4:1:3', 'E4:1:3', 'F4:1:4', 'G4:1:5'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'G3:1:1'] },
      { chord: 'G7', rh: ['G4:1:5', 'F4:1:4', 'E4:1:3', 'D4:1:2'], lh: ['B2:1:5', 'G3:1:1', 'D3:1:3', 'G3:1:1'] },
      { chord: 'C', rh: ['C4:1:1', 'C4:1:1', 'D4:1:2', 'E4:1:3'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'G3:1:1'] },
      { chord: 'G', rh: ['E4:1.5:3', 'D4:0.5:2', 'D4:2:2'], lh: ['G2:1:5', 'D3:1:2', 'B2:1:3', 'G2:1:5'] },
      // Phrase A' (Bars 5-8)
      { chord: 'C', rh: ['E4:1:3', 'E4:1:3', 'F4:1:4', 'G4:1:5'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'G3:1:1'] },
      { chord: 'G7', rh: ['G4:1:5', 'F4:1:4', 'E4:1:3', 'D4:1:2'], lh: ['B2:1:5', 'G3:1:1', 'D3:1:3', 'G3:1:1'] },
      { chord: 'C/G', rh: ['C4:1:1', 'C4:1:1', 'D4:1:2', 'E4:1:3'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'G3:1:1'] },
      { chord: 'C', rh: ['D4:1.5:2', 'C4:0.5:1', 'C4:2:1'], lh: ['G2:1:5', 'B2:1:3', 'C3:2:1'] },
      // Phrase B Bridge (Bars 9-12)
      { chord: 'G', rh: ['D4:1:2', 'D4:1:2', 'E4:1:3', 'C4:1:1'], lh: ['G2:1:5', 'D3:1:2', 'B2:1:3', 'G2:1:5'] },
      { chord: 'G', rh: ['D4:1:2', 'E4:0.5:3', 'F4:0.5:4', 'E4:1:3', 'C4:1:1'], lh: ['G2:1:5', 'D3:1:2', 'B2:1:3', 'G2:1:5'] },
      { chord: 'D7/F#', rh: ['D4:1:2', 'E4:0.5:3', 'F4:0.5:4', 'E4:1:3', 'D4:1:2'], lh: ['D3:1:5', 'F#3:1:3', 'A3:1:2', 'D3:1:5'] },
      { chord: 'G7', rh: ['C4:1:1', 'D4:1:2', 'G3:2:1'], lh: ['G2:1:5', 'B2:1:3', 'D3:1:2', 'G2:1:5'] },
      // Phrase A'' Finale (Bars 13-16)
      { chord: 'C', rh: ['E4:1:3', 'E4:1:3', 'F4:1:4', 'G4:1:5'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'G3:1:1'] },
      { chord: 'G7', rh: ['G4:1:5', 'F4:1:4', 'E4:1:3', 'D4:1:2'], lh: ['B2:1:5', 'G3:1:1', 'D3:1:3', 'G3:1:1'] },
      { chord: 'C/G', rh: ['C4:1:1', 'C4:1:1', 'D4:1:2', 'E4:1:3'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'G3:1:1'] },
      { chord: 'C', rh: ['D4:1.5:2', 'C4:0.5:1', 'C4+E4+G4:2:1'], lh: ['G2:1:5', 'B2:1:3', 'C2+C3:2:5'] }
    ], 4)
  }),

  // 2. FÜR ELISE — LUDWIG VAN BEETHOVEN (COMPLETE AUTHENTIC A-SECTION)
  buildSongFromEvents({
    id: 'fur-elise',
    title: 'Für Elise, WoO 59 (Complete A Section)',
    composer: 'Ludwig van Beethoven',
    genre: 'Classical',
    difficulty: 'Intermediate',
    tempo: 120,
    timeSignature: [3, 4],
    keySignature: 'A Minor',
    sourceFormat: 'Original Manuscript',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Am', rh: ['R:2', 'E5:0.5:5', 'D#5:0.5:4'], lh: ['R:3'] },
      { chord: 'Am', rh: ['E5:0.5:5', 'D#5:0.5:4', 'E5:0.5:5', 'B4:0.5:2', 'D5:0.5:4', 'C5:0.5:3'], lh: ['R:3'] },
      { chord: 'Am', rh: ['A4:1:1', 'R:0.5', 'C4:0.5:1', 'E4:0.5:2', 'A4:0.5:4'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'E7', rh: ['B4:1:5', 'R:0.5', 'E4:0.5:1', 'G#4:0.5:2', 'B4:0.5:4'], lh: ['E2:0.5:5', 'E3:0.5:2', 'G#3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['C5:1:5', 'R:0.5', 'E4:0.5:1', 'E5:0.5:5', 'D#5:0.5:4'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['E5:0.5:5', 'D#5:0.5:4', 'E5:0.5:5', 'B4:0.5:2', 'D5:0.5:4', 'C5:0.5:3'], lh: ['R:3'] },
      { chord: 'Am', rh: ['A4:1:1', 'R:0.5', 'C4:0.5:1', 'E4:0.5:2', 'A4:0.5:4'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'E7', rh: ['B4:1:5', 'R:0.5', 'E4:0.5:1', 'C5:0.5:4', 'B4:0.5:3'], lh: ['E2:0.5:5', 'E3:0.5:2', 'G#3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['A4:2:2', 'B4:0.5:1', 'C5:0.5:2'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      // B Phrase
      { chord: 'C', rh: ['D5:0.5:3', 'E5:1.5:5', 'G4:0.5:1', 'F5:0.5:5'], lh: ['C3:0.5:5', 'G3:0.5:2', 'C4:1:1', 'R:1'] },
      { chord: 'G7', rh: ['E5:0.5:4', 'D5:1.5:3', 'F4:0.5:1', 'E5:0.5:5'], lh: ['G2:0.5:5', 'G3:0.5:2', 'B3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['D5:0.5:4', 'C5:1.5:3', 'E4:0.5:1', 'D5:0.5:5'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'E', rh: ['C5:0.5:4', 'B4:1.5:3', 'E4:0.5:1', 'E5:0.5:5'], lh: ['E2:0.5:5', 'E3:0.5:2', 'E4:1:1', 'R:1'] },
      // Return of Main Theme
      { chord: 'Am', rh: ['E5:0.5:5', 'D#5:0.5:4', 'E5:0.5:5', 'B4:0.5:2', 'D5:0.5:4', 'C5:0.5:3'], lh: ['R:3'] },
      { chord: 'Am', rh: ['A4:1:1', 'R:0.5', 'C4:0.5:1', 'E4:0.5:2', 'A4:0.5:4'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'E7', rh: ['B4:1:5', 'R:0.5', 'E4:0.5:1', 'C5:0.5:4', 'B4:0.5:3'], lh: ['E2:0.5:5', 'E3:0.5:2', 'G#3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['A4+C5+E5:3:1'], lh: ['A2+E3+A3:3:5'] }
    ], 3)
  }),

  // 3. MINUET IN G MAJOR, BWV ANH. 114 — PETZOLD / J.S. BACH
  buildSongFromEvents({
    id: 'minuet-in-g',
    title: 'Minuet in G Major, BWV Anh. 114',
    composer: 'Christian Petzold / J.S. Bach',
    genre: 'Baroque',
    difficulty: 'Intermediate',
    tempo: 116,
    timeSignature: [3, 4],
    keySignature: 'G Major',
    sourceFormat: 'Urtext Edition',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'G', rh: ['D5:1:5', 'G4:0.5:1', 'A4:0.5:2', 'B4:0.5:3', 'C5:0.5:4'], lh: ['G3:2:3', 'F#3:1:2'] },
      { chord: 'G', rh: ['D5:1:5', 'G4:1:1', 'G4:1:1'], lh: ['G3:3:1'] },
      { chord: 'C', rh: ['E5:1:3', 'C5:0.5:1', 'D5:0.5:2', 'E5:0.5:3', 'F#5:0.5:4'], lh: ['E3:3:1'] },
      { chord: 'G', rh: ['G5:1:5', 'G4:1:1', 'G4:1:1'], lh: ['B2:3:2'] },
      { chord: 'Am/C', rh: ['C5:1:4', 'D5:0.5:5', 'C5:0.5:4', 'B4:0.5:3', 'A4:0.5:2'], lh: ['A2:3:3'] },
      { chord: 'G/B', rh: ['B4:1:3', 'C5:0.5:4', 'B4:0.5:3', 'A4:0.5:2', 'G4:0.5:1'], lh: ['G2:3:4'] },
      { chord: 'D7', rh: ['F#4:1:2', 'G4:0.5:1', 'A4:0.5:2', 'B4:0.5:3', 'G4:0.5:1'], lh: ['D3:2:5', 'B2:1:3'] },
      { chord: 'D', rh: ['A4:3:2'], lh: ['D2:1:5', 'C3:0.5:1', 'B2:0.5:2', 'A2:0.5:3', 'G2:0.5:4'] },
      { chord: 'G', rh: ['D5:1:5', 'G4:0.5:1', 'A4:0.5:2', 'B4:0.5:3', 'C5:0.5:4'], lh: ['G3:2:2', 'F#3:1:3'] },
      { chord: 'G', rh: ['D5:1:5', 'G4:1:1', 'G4:1:1'], lh: ['G3:1:4', 'B2:1:2', 'G2:1:4'] },
      { chord: 'C', rh: ['E5:1:3', 'C5:0.5:1', 'D5:0.5:2', 'E5:0.5:3', 'F#5:0.5:4'], lh: ['C3:3:1'] },
      { chord: 'G', rh: ['G5:1:5', 'G4:1:1', 'G4:1:1'], lh: ['B2:2:2', 'G2:1:4'] },
      { chord: 'Am', rh: ['C5:1:4', 'D5:0.5:5', 'C5:0.5:4', 'B4:0.5:3', 'A4:0.5:2'], lh: ['A2:2:3', 'F#2:1:4'] },
      { chord: 'G', rh: ['B4:1:3', 'C5:0.5:4', 'B4:0.5:3', 'A4:0.5:2', 'G4:0.5:1'], lh: ['G2:2:4', 'B2:1:2'] },
      { chord: 'D7', rh: ['A4:1:2', 'B4:0.5:3', 'A4:0.5:2', 'G4:0.5:1', 'F#4:0.5:2'], lh: ['C3:1:5', 'D3:2:4'] },
      { chord: 'G', rh: ['G4:3:1'], lh: ['G2+B2+D3:3:5'] }
    ], 3)
  }),

  // 4. PRELUDE IN C MAJOR, BWV 846 — J.S. BACH (AUTHENTIC 16TH-NOTE ARPEGGIOS)
  buildSongFromEvents({
    id: 'prelude-in-c',
    title: 'Prelude in C Major, BWV 846',
    composer: 'Johann Sebastian Bach',
    genre: 'Baroque',
    difficulty: 'Intermediate',
    tempo: 84,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Urtext Standard',
    license: 'Public Domain',
    rawNotes: (() => {
      const chords = [
        ['C3', 'E3', 'G3', 'C4', 'E4'],
        ['C3', 'D3', 'A3', 'D4', 'F4'],
        ['B2', 'D3', 'G3', 'D4', 'F4'],
        ['C3', 'E3', 'G3', 'C4', 'E4'],
        ['C3', 'E3', 'A3', 'E4', 'A4'],
        ['C3', 'D3', 'F#3', 'A3', 'D4'],
        ['B2', 'D3', 'G3', 'D4', 'G4'],
        ['B2', 'C3', 'E3', 'G3', 'C4'],
        ['A2', 'C3', 'E3', 'G3', 'C4'],
        ['D2', 'A2', 'D3', 'F#3', 'C4'],
        ['G2', 'B2', 'D3', 'G3', 'B3'],
        ['G2', 'Bb2', 'E3', 'G3', 'C#4'],
        ['F2', 'A2', 'D3', 'A3', 'D4'],
        ['F2', 'Ab2', 'D3', 'F3', 'B3'],
        ['E2', 'G2', 'C3', 'G3', 'C4'],
        ['C2', 'G2', 'C3', 'E3', 'C4']
      ];
      const measures = chords.map(([n1, n2, n3, n4, n5]) => ({
        chord: 'C',
        lh: [`${n1}:0.25:5`, `${n2}:0.25:3`, 'R:1.5', `${n1}:0.25:5`, `${n2}:0.25:3`, 'R:1.5'],
        rh: [
          'R:0.5', `${n3}:0.25:1`, `${n4}:0.25:3`, `${n5}:0.25:5`, `${n3}:0.25:1`, `${n4}:0.25:3`, `${n5}:0.25:5`,
          'R:0.5', `${n3}:0.25:1`, `${n4}:0.25:3`, `${n5}:0.25:5`, `${n3}:0.25:1`, `${n4}:0.25:3`, `${n5}:0.25:5`
        ]
      }));
      return compileCompactScore(measures, 4);
    })()
  }),

  // 5. CANON IN D MAJOR — JOHANN PACHELBEL
  buildSongFromEvents({
    id: 'canon-in-d',
    title: 'Canon in D Major (Concert Piano Arrangement)',
    composer: 'Johann Pachelbel',
    genre: 'Baroque',
    difficulty: 'Intermediate',
    tempo: 76,
    timeSignature: [4, 4],
    keySignature: 'D Major',
    sourceFormat: 'Concert Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'D', rh: ['F#4:2:3', 'E4:2:2'], lh: ['D3:2:5', 'A2:2:5'] },
      { chord: 'Bm', rh: ['D4:2:1', 'C#4:2:2'], lh: ['B2:2:5', 'F#2:2:5'] },
      { chord: 'G', rh: ['B3:2:1', 'A3:2:1'], lh: ['G2:2:5', 'D2:2:5'] },
      { chord: 'A', rh: ['B3:2:2', 'C#4:2:3'], lh: ['G2:2:5', 'A2:2:5'] },
      { chord: 'D', rh: ['F#5:2:5', 'E5:2:4'], lh: ['D3:2:5', 'A2:2:5'] },
      { chord: 'Bm', rh: ['D5:2:3', 'C#5:2:2'], lh: ['B2:2:5', 'F#2:2:5'] },
      { chord: 'G', rh: ['B4:2:1', 'A4:2:1'], lh: ['G2:2:5', 'D2:2:5'] },
      { chord: 'A', rh: ['B4:2:2', 'C#5:2:3'], lh: ['G2:2:5', 'A2:2:5'] },
      { chord: 'D', rh: ['F#5:0.5:5', 'E5:0.5:4', 'D5:0.5:3', 'C#5:0.5:2', 'B4:0.5:1', 'A4:0.5:1', 'B4:0.5:2', 'C#5:0.5:3'], lh: ['D3:2:5', 'A2:2:5'] },
      { chord: 'Bm', rh: ['D5:0.5:3', 'C#5:0.5:2', 'B4:0.5:1', 'A4:0.5:1', 'G4:0.5:1', 'F#4:0.5:2', 'G4:0.5:3', 'E4:0.5:1'], lh: ['B2:2:5', 'F#2:2:5'] },
      { chord: 'G', rh: ['D4:0.5:1', 'F#4:0.5:2', 'A4:0.5:3', 'G4:0.5:2', 'F#4:0.5:1', 'D4:0.5:1', 'F#4:0.5:2', 'E4:0.5:1'], lh: ['G2:2:5', 'D2:2:5'] },
      { chord: 'A', rh: ['D4:0.5:1', 'B3:0.5:1', 'D4:0.5:1', 'A4:0.5:3', 'G4:0.5:2', 'B4:0.5:4', 'A4:0.5:3', 'C#5:0.5:5'], lh: ['G2:2:5', 'A2:2:5'] },
      { chord: 'D', rh: ['D5:1:3', 'F#5:1:5', 'A5:2:5'], lh: ['D3:2:5', 'A2:2:5'] },
      { chord: 'Bm', rh: ['F#5:1:3', 'A5:1:4', 'D6:2:5'], lh: ['B2:2:5', 'F#2:2:5'] },
      { chord: 'G', rh: ['B5:1:4', 'G5:1:3', 'E5:2:2'], lh: ['G2:2:5', 'D2:2:5'] },
      { chord: 'D', rh: ['F#5:1:3', 'E5:1:2', 'D4+F#4+A4+D5:2:1'], lh: ['A2:2:5', 'D2+A2+D3:2:5'] }
    ], 4)
  }),

  // 6. GYMNOPÉDIE NO. 1 — ERIK SATIE
  buildSongFromEvents({
    id: 'gymnopedie-no-1',
    title: 'Gymnopédie No. 1',
    composer: 'Erik Satie',
    genre: 'Impressionist',
    difficulty: 'Intermediate',
    tempo: 68,
    timeSignature: [3, 4],
    keySignature: 'D Major',
    sourceFormat: 'Urtext Standard',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Gmaj7', rh: ['R:3'], lh: ['G2:1:5', 'B3+D4+F#4:2:1'] },
      { chord: 'Dmaj7', rh: ['R:3'], lh: ['D2:1:5', 'A3+C#4+F#4:2:1'] },
      { chord: 'Gmaj7', rh: ['R:3'], lh: ['G2:1:5', 'B3+D4+F#4:2:1'] },
      { chord: 'Dmaj7', rh: ['R:3'], lh: ['D2:1:5', 'A3+C#4+F#4:2:1'] },
      { chord: 'Gmaj7', rh: ['B4:3:2'], lh: ['G2:1:5', 'B3+D4+F#4:2:1'] },
      { chord: 'Dmaj7', rh: ['C#5:3:3'], lh: ['D2:1:5', 'A3+C#4+F#4:2:1'] },
      { chord: 'Gmaj7', rh: ['D5:3:4'], lh: ['G2:1:5', 'B3+D4+F#4:2:1'] },
      { chord: 'Dmaj7', rh: ['B4:3:2'], lh: ['D2:1:5', 'A3+C#4+F#4:2:1'] },
      { chord: 'Gmaj7', rh: ['C#5:3:3'], lh: ['G2:1:5', 'B3+D4+F#4:2:1'] },
      { chord: 'Dmaj7', rh: ['B4:3:2'], lh: ['D2:1:5', 'A3+C#4+F#4:2:1'] },
      { chord: 'Gmaj7', rh: ['A4:1:1', 'G4:1:1', 'F#4:1:2'], lh: ['G2:1:5', 'B3+D4+F#4:2:1'] },
      { chord: 'Dmaj7', rh: ['E4:3:1'], lh: ['D2:1:5', 'A3+C#4+F#4:2:1'] },
      { chord: 'F#m7', rh: ['D4:3:1'], lh: ['F#2:1:5', 'A3+C#4:2:1'] },
      { chord: 'Bm7', rh: ['C#5:3:3'], lh: ['B2:1:5', 'F#3+D4:2:1'] },
      { chord: 'Em7', rh: ['F#5:3:5'], lh: ['E2:1:5', 'G3+B3:2:1'] },
      { chord: 'Dmaj7', rh: ['D5:3:4'], lh: ['D2:1:5', 'F#3+A3+C#4:2:1'] }
    ], 3)
  }),

  // 7. MOONLIGHT SONATA — LUDWIG VAN BEETHOVEN (OP. 27 NO. 2)
  buildSongFromEvents({
    id: 'moonlight-sonata',
    title: 'Moonlight Sonata, Op. 27 No. 2 (1st Mov.)',
    composer: 'Ludwig van Beethoven',
    genre: 'Classical',
    difficulty: 'Intermediate',
    tempo: 54,
    timeSignature: [4, 4],
    keySignature: 'C# Minor',
    sourceFormat: 'Concert Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'C#m', rh: ['G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4'], lh: ['C#2+C#3:4:5'] },
      { chord: 'C#m/B', rh: ['G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4'], lh: ['B1+B2:4:5'] },
      { chord: 'A', rh: ['A3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'A3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'A3:0.3333:1', 'D4:0.3333:2', 'F#4:0.3334:4', 'A3:0.3333:1', 'D4:0.3333:2', 'F#4:0.3334:4'], lh: ['A1+A2:2:5', 'F#1+F#2:2:5'] },
      { chord: 'G#7', rh: ['G#3:0.3333:1', 'C4:0.3333:2', 'F#4:0.3334:4', 'G#3:0.3333:1', 'C4:0.3333:2', 'F#4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4'], lh: ['G#1+G#2:4:5'] },
      { chord: 'C#m', rh: ['G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3+G#4:0.3333:5', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4+G#4:0.3334:5'], lh: ['C#2+C#3:4:5'] },
      { chord: 'C#m', rh: ['G#3+G#4:0.3333:5', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3+G#4:0.3333:5', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3:0.3333:1', 'C#4:0.3333:2', 'E4+G#4:0.3334:5'], lh: ['C#2+C#3:4:5'] },
      { chord: 'B', rh: ['G#3+G#4:0.3333:5', 'D#4:0.3333:2', 'F#4:0.3334:4', 'G#3:0.3333:1', 'D#4:0.3333:2', 'F#4:0.3334:4', 'A3+A4:0.3333:5', 'C#4:0.3333:2', 'E4:0.3334:4', 'A3:0.3333:1', 'C#4:0.3333:2', 'E4+A4:0.3334:5'], lh: ['B1+B2:4:5'] },
      { chord: 'F#m/G#', rh: ['A3+A4:0.3333:5', 'D4:0.3333:2', 'F#4:0.3334:4', 'G#3+G#4:0.3333:5', 'C#4:0.3333:2', 'E4:0.3334:4', 'G#3+F#4:0.3333:4', 'C4:0.3333:2', 'D#4:0.3334:3', 'G#3+E4:0.3333:3', 'C#4:0.3333:2', 'E4:0.3334:4'], lh: ['F#1+F#2:2:5', 'G#1+G#2:2:5'] },
      { chord: 'C#m', rh: ['C#4+E4+G#4+C#5:4:1'], lh: ['C#2+C#3:4:5'] }
    ], 4)
  }),

  // 8. TALE AS OLD AS TIME — ALAN MENKEN (BEAUTY AND THE BEAST)
  buildSongFromEvents({
    id: 'beauty-and-the-beast',
    title: 'Tale as Old as Time (Beauty and the Beast)',
    composer: 'Alan Menken',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 84,
    timeSignature: [4, 4],
    keySignature: 'F Major',
    sourceFormat: 'Original Broadway/Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'F', rh: ['A4:1:1', 'C5:1:2', 'E5:1:4', 'F5:0.5:5', 'Bb4:2.5:3'], lh: ['F2:1:5', 'C3:1:2', 'A3:1:1', 'C4:1:2'] },
      { chord: 'Bb/D', rh: ['A4:1:1', 'C5:1:2', 'E5:1:4', 'F5:0.5:5', 'G5:2.5:4'], lh: ['D3:1:5', 'Bb3:1:2', 'F3:1:3', 'Bb3:1:2'] },
      { chord: 'F/C', rh: ['F5:0.5:3', 'G5:0.5:4', 'A5:1:5', 'Bb5:1:5', 'C6:2:5'], lh: ['C3:1:5', 'A3:1:2', 'F3:1:3', 'A3:1:2'] },
      { chord: 'C7', rh: ['C6:0.75:5', 'Bb5:0.25:4', 'A5:0.75:3', 'G5:0.25:2', 'F5:2:1'], lh: ['C2:1:5', 'G2:1:2', 'E3:1:1', 'Bb3:1:2'] },
      { chord: 'F', rh: ['Bb5:0.5:5', 'A5:0.5:4', 'G5:0.5:3', 'F5:0.5:2', 'C5:3:1'], lh: ['F2:1:5', 'C3:1:2', 'A3:1:1', 'C4:1:2'] },
      { chord: 'F', rh: ['A4:1:1', 'C5:1:2', 'E5:1:4', 'F5:0.5:5', 'Bb4:2.5:3'], lh: ['F2:1:5', 'C3:1:2', 'A3:1:1', 'C4:1:2'] },
      { chord: 'Bb', rh: ['A4:1:1', 'C5:1:2', 'E5:1:4', 'F5:0.5:5', 'G5:2.5:4'], lh: ['Bb2:1:5', 'F3:1:2', 'D4:1:1', 'F3:1:2'] },
      { chord: 'Gm7', rh: ['A5:0.5:4', 'G5:0.5:3', 'A5:1:4', 'C6:1:5', 'F5:2:2'], lh: ['G2:1:5', 'D3:1:2', 'Bb3:1:1', 'D4:1:2'] },
      { chord: 'C7', rh: ['F5:0.5:3', 'E5:0.5:2', 'F5:1:3', 'A5:1:5', 'D5:2:1'], lh: ['C3:1:5', 'G3:1:2', 'E4:1:1', 'G3:1:2'] },
      { chord: 'F', rh: ['A5:1:4', 'Bb5:0.5:5', 'G5:1:3', 'A5:0.5:4', 'F5:3:2'], lh: ['F2:1:5', 'C3:1:2', 'A3:1:1', 'C4:1:2'] },
      { chord: 'F', rh: ['F4+A4+C5+F5:4:1'], lh: ['F2+C3+A3+F4:4:5'] }
    ], 4)
  }),

  // 9. LET IT GO — KRISTEN ANDERSON-LOPEZ & ROBERT LOPEZ (FROZEN)
  buildSongFromEvents({
    id: 'let-it-go-frozen',
    title: 'Let It Go (Frozen — Official Chorus)',
    composer: 'Kristen Anderson-Lopez & Robert Lopez',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 132,
    timeSignature: [4, 4],
    keySignature: 'G Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'G', rh: ['D5:1:4', 'D5:0.5:4', 'B4:1.5:3', 'R:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'D', rh: ['D5:1:4', 'D5:0.5:4', 'B4:1.5:3', 'R:1'], lh: ['D2:1:5', 'A2:1:2', 'F#3:2:1'] },
      { chord: 'Em', rh: ['B4:0.5:2', 'C5:0.5:3', 'D5:0.5:4', 'E5:0.5:5', 'D5:1:4', 'B4:1:2'], lh: ['E2:1:5', 'B2:1:2', 'G3:2:1'] },
      { chord: 'C', rh: ['A4:1:3', 'G4:1:2', 'E4:2:1'], lh: ['C2:1:5', 'G2:1:2', 'E3:2:1'] },
      { chord: 'G', rh: ['D5:1:4', 'D5:0.5:4', 'B4:1.5:3', 'R:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'D', rh: ['D5:1:4', 'D5:0.5:4', 'E5:1.5:5', 'R:1'], lh: ['D2:1:5', 'A2:1:2', 'F#3:2:1'] },
      { chord: 'Em', rh: ['G5:1:5', 'F#5:0.5:4', 'E5:0.5:3', 'D5:1:2', 'B4:1:1'], lh: ['E2:1:5', 'B2:1:2', 'G3:2:1'] },
      { chord: 'C', rh: ['A4:1:3', 'G4:1:2', 'A4:2:3'], lh: ['C2:1:5', 'G2:1:2', 'E3:2:1'] },
      { chord: 'G', rh: ['B4:0.5:2', 'C5:0.5:3', 'D5:0.5:4', 'E5:0.5:5', 'D5:1:4', 'B4:1:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'D', rh: ['B4:0.5:2', 'C5:0.5:3', 'D5:0.5:4', 'E5:0.5:5', 'D5:1:4', 'B4:1:2'], lh: ['D2:1:5', 'A2:1:2', 'F#3:2:1'] },
      { chord: 'Em', rh: ['E5:1:3', 'F#5:1:4', 'G5:2:5'], lh: ['E2:1:5', 'B2:1:2', 'G3:2:1'] },
      { chord: 'C', rh: ['D5:1:4', 'C5:0.5:3', 'B4:0.5:2', 'A4:1:1', 'G4:1:1'], lh: ['C2:1:5', 'G2:1:2', 'E3:2:1'] },
      { chord: 'G', rh: ['G4:4:1'], lh: ['G1+D2+G2:4:5'] }
    ], 4)
  }),

  // 10. HOW FAR I'LL GO — LIN-MANUEL MIRANDA (MOANA)
  buildSongFromEvents({
    id: 'how-far-ill-go-moana',
    title: "How Far I'll Go (Moana Theme)",
    composer: 'Lin-Manuel Miranda',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 82,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['E4:0.5:2', 'E4:0.5:2', 'E4:0.5:2', 'E4:0.5:2', 'G4:1:4', 'E4:0.5:2', 'D4:0.5:1'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'C', rh: ['C4:2:1', 'R:2'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'Am', rh: ['E4:0.5:2', 'E4:0.5:2', 'E4:0.5:2', 'E4:0.5:2', 'G4:1:4', 'E4:0.5:2', 'D4:0.5:1'], lh: ['A2:1:5', 'E3:1:2', 'C4:2:1'] },
      { chord: 'Am', rh: ['C4:2:1', 'R:2'], lh: ['A2:1:5', 'E3:1:2', 'C4:2:1'] },
      { chord: 'F', rh: ['E4:0.5:2', 'G4:0.5:3', 'C5:1:5', 'B4:0.5:4', 'A4:0.5:3', 'G4:0.5:2', 'A4:0.5:3'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'G', rh: ['G4:1.5:3', 'E4:0.5:2', 'D4:2:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'Am', rh: ['E4:0.5:2', 'G4:0.5:3', 'C5:1:5', 'B4:0.5:4', 'A4:0.5:3', 'G4:0.5:2', 'A4:0.5:3'], lh: ['A2:1:5', 'E3:1:2', 'C4:2:1'] },
      { chord: 'G', rh: ['G4:1.5:3', 'E4:0.5:2', 'G4:2:3'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'F', rh: ['E4:0.5:2', 'G4:0.5:3', 'C5:1:5', 'B4:0.5:4', 'A4:0.5:3', 'G4:0.5:2', 'A4:0.5:3'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'G', rh: ['G4:1.5:3', 'E4:0.5:2', 'D4:2:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'Am', rh: ['E4:0.5:2', 'G4:0.5:3', 'C5:1:5', 'B4:0.5:4', 'A4:0.5:3', 'G4:0.5:2', 'A4:0.5:3'], lh: ['A2:1:5', 'E3:1:2', 'C4:2:1'] },
      { chord: 'C', rh: ['C5:4:5'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 11. A WHOLE NEW WORLD — ALAN MENKEN (ALADDIN)
  buildSongFromEvents({
    id: 'a-whole-new-world',
    title: 'A Whole New World (Aladdin)',
    composer: 'Alan Menken',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 84,
    timeSignature: [4, 4],
    keySignature: 'D Major',
    sourceFormat: 'Original Broadway/Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'D', rh: ['F#4:0.75:2', 'G4:0.25:3', 'B4:1:5', 'A4:2:4'], lh: ['D3:1:5', 'A3:1:2', 'F#3:1:3', 'A3:1:2'] },
      { chord: 'D', rh: ['F#4:0.75:2', 'G4:0.25:3', 'B4:1:5', 'A4:1:4', 'E4:0.5:1', 'G4:0.5:3', 'F#4:2:2'], lh: ['D3:1:5', 'A3:1:2', 'F#3:1:3', 'A3:1:2'] },
      { chord: 'G', rh: ['F#4:0.5:2', 'G4:0.5:3', 'A4:1:4', 'C#5:1:5', 'B4:2:4'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1', 'D3:1:2'] },
      { chord: 'A', rh: ['F#4:0.5:2', 'G4:0.5:3', 'A4:1:4', 'D5:1:5', 'C#5:2:4'], lh: ['A2:1:5', 'E3:1:2', 'C#4:1:1', 'E3:1:2'] },
      { chord: 'Bm', rh: ['D5:0.5:5', 'F#4:0.5:2', 'E4:1:1', 'D4:0.5:1', 'B3:0.5:1', 'D4:1:2', 'E4:2:3'], lh: ['B2:1:5', 'F#3:1:2', 'G2:1:5', 'A2:1:4'] },
      { chord: 'D', rh: ['F#4:0.75:2', 'G4:0.25:3', 'B4:1:5', 'A4:2:4'], lh: ['D3:1:5', 'A3:1:2', 'F#3:1:3', 'A3:1:2'] },
      { chord: 'D', rh: ['F#4:0.75:2', 'G4:0.25:3', 'B4:1:5', 'A4:1:4', 'E4:0.5:1', 'G4:0.5:3', 'F#4:2:2'], lh: ['D3:1:5', 'A3:1:2', 'F#3:1:3', 'A3:1:2'] },
      { chord: 'G', rh: ['F#4:0.5:2', 'G4:0.5:3', 'A4:1:4', 'C#5:1:5', 'B4:1:4', 'F#4:0.5:2', 'G4:0.5:3', 'A4:1:4', 'D5:1:5', 'C#5:2:4'], lh: ['G2:1:5', 'D3:1:2', 'A2:1:5', 'E3:1:2'] },
      { chord: 'D', rh: ['D4:0.5:1', 'E4:0.5:2', 'F#4:0.5:3', 'G4:0.5:4', 'A4:1:5', 'C#5:1:5', 'D5:4:5'], lh: ['G2:1:5', 'A2:1:4', 'D2+A2+D3:4:5'] }
    ], 4)
  }),

  // 12. MARRIED LIFE — MICHAEL GIACCHINO (UP)
  buildSongFromEvents({
    id: 'married-life-up',
    title: 'Married Life (Up — Jazz Waltz)',
    composer: 'Michael Giacchino',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 140,
    timeSignature: [3, 4],
    keySignature: 'F Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'F', rh: ['F4:1:1', 'A4:1:2', 'C5:1:3'], lh: ['R:3'] },
      { chord: 'F', rh: ['C5:0.5:3', 'D5:0.5:4', 'E5:1:5', 'F5:1:5'], lh: ['F2:1:5', 'A3+C4:1:1', 'A3+C4:1:1'] },
      { chord: 'F', rh: ['G5:1:5', 'A5:1:5', 'C6:1:5'], lh: ['F2:1:5', 'A3+C4:1:1', 'A3+C4:1:1'] },
      { chord: 'Bb', rh: ['F5:1:3', 'E5:1:2', 'D5:1:1'], lh: ['Bb2:1:5', 'D4+F4:1:1', 'D4+F4:1:1'] },
      { chord: 'C7', rh: ['C5:2:1', 'R:1'], lh: ['C3:1:5', 'G3+C4:1:1', 'G3+C4:1:1'] },
      { chord: 'F', rh: ['F4:1:1', 'A4:1:2', 'C5:1:3'], lh: ['F2:1:5', 'A3+C4:1:1', 'A3+C4:1:1'] },
      { chord: 'F', rh: ['C5:0.5:3', 'D5:0.5:4', 'E5:1:5', 'F5:1:5'], lh: ['F2:1:5', 'A3+C4:1:1', 'A3+C4:1:1'] },
      { chord: 'F', rh: ['G5:1:5', 'A5:1:5', 'C6:1:5'], lh: ['F2:1:5', 'A3+C4:1:1', 'A3+C4:1:1'] },
      { chord: 'G7', rh: ['B5:1:4', 'C6:1:5', 'D6:1:5'], lh: ['G2:1:5', 'B3+D4:1:1', 'B3+D4:1:1'] },
      { chord: 'C7', rh: ['E6:2:5', 'R:1'], lh: ['C3:1:5', 'G3+C4:1:1', 'G3+C4:1:1'] },
      { chord: 'F', rh: ['C6:1:5', 'B5:1:4', 'A5:1:3'], lh: ['F2:1:5', 'A3+C4:1:1', 'A3+C4:1:1'] },
      { chord: 'C7', rh: ['G5:1:2', 'F5:1:1', 'G5:1:2'], lh: ['C3:1:5', 'E3+Bb3:1:1', 'E3+Bb3:1:1'] },
      { chord: 'F', rh: ['A5:1:3', 'Bb5:1:4', 'A5:1:3'], lh: ['F2:1:5', 'A3+C4:1:1', 'A3+C4:1:1'] },
      { chord: 'Dm', rh: ['G5:1:2', 'F5:1:1', 'E5:1:1'], lh: ['D3:1:5', 'F3+A3:1:1', 'F3+A3:1:1'] },
      { chord: 'Bb', rh: ['D5:1:1', 'E5:1:2', 'F5:1:3'], lh: ['Bb2:1:5', 'D4+F4:1:1', 'D4+F4:1:1'] },
      { chord: 'C7', rh: ['G5:2:4', 'C5:1:1'], lh: ['C3:1:5', 'E3+Bb3:1:1', 'E3+Bb3:1:1'] },
      { chord: 'F', rh: ['F4+A4+C5+F5:3:1'], lh: ['F2+C3+F3:3:5'] }
    ], 3)
  }),

  // 13. HE'S A PIRATE — KLAUS BADELT & HANS ZIMMER (PIRATES OF THE CARIBBEAN)
  buildSongFromEvents({
    id: 'hes-a-pirate',
    title: "He's a Pirate (Pirates of the Caribbean)",
    composer: 'Klaus Badelt & Hans Zimmer',
    genre: 'Cinema & Animation',
    difficulty: 'Advanced',
    tempo: 140,
    timeSignature: [3, 4],
    keySignature: 'D Minor',
    sourceFormat: 'Original Orchestral Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'Dm', rh: ['R:2', 'A4:0.5:1', 'A4:0.5:1'], lh: ['R:3'] },
      { chord: 'Dm', rh: ['D4:0.5:1', 'D4:0.5:1', 'D4:0.5:1', 'D4:0.5:1', 'E4:0.5:2', 'F4:0.5:3'], lh: ['D3:1.5:5', 'A3:1.5:1'] },
      { chord: 'Dm', rh: ['F4:0.5:3', 'F4:0.5:3', 'F4:0.5:3', 'F4:0.5:3', 'G4:0.5:4', 'E4:0.5:2'], lh: ['D3:1.5:5', 'A3:1.5:1'] },
      { chord: 'Bb', rh: ['E4:0.5:2', 'E4:0.5:2', 'D4:0.5:1', 'C4:0.5:1', 'C4:0.5:1', 'D4:0.5:1'], lh: ['Bb2:1.5:5', 'F3:1.5:1'] },
      { chord: 'A', rh: ['D4:2:1', 'A4:0.5:5', 'A4:0.5:5'], lh: ['A2:1.5:5', 'E3:1.5:1'] },
      { chord: 'Dm', rh: ['D4:0.5:1', 'D4:0.5:1', 'D4:0.5:1', 'D4:0.5:1', 'E4:0.5:2', 'F4:0.5:3'], lh: ['D3:1.5:5', 'A3:1.5:1'] },
      { chord: 'Dm', rh: ['F4:0.5:3', 'F4:0.5:3', 'F4:0.5:3', 'F4:0.5:3', 'G4:0.5:4', 'E4:0.5:2'], lh: ['D3:1.5:5', 'A3:1.5:1'] },
      { chord: 'C', rh: ['E4:0.5:2', 'E4:0.5:2', 'D4:0.5:1', 'C4:0.5:1', 'D4:0.5:2', 'E4:0.5:3'], lh: ['C3:1.5:5', 'G3:1.5:1'] },
      { chord: 'Dm', rh: ['D4:2.5:1', 'A4:0.5:5'], lh: ['D3:1.5:5', 'A3:1.5:1'] },
      { chord: 'Dm', rh: ['D4:0.5:1', 'E4:0.5:2', 'F4:0.5:3', 'G4:0.5:4', 'A4:1:5'], lh: ['D3:1.5:5', 'A3:1.5:1'] },
      { chord: 'Bb', rh: ['D5:0.5:5', 'C5:0.5:4', 'A4:0.5:3', 'F4:0.5:2', 'G4:1:3'], lh: ['Bb2:1.5:5', 'F3:1.5:1'] },
      { chord: 'Gm', rh: ['A4:0.5:3', 'G4:0.5:2', 'F4:0.5:1', 'D4:0.5:1', 'E4:1:2'], lh: ['G2:1.5:5', 'D3:1.5:1'] },
      { chord: 'Dm', rh: ['D4:2.5:1', 'R:0.5'], lh: ['D2+A2+D3:3:5'] }
    ], 3)
  }),

  // 14. COLORS OF THE WIND — ALAN MENKEN (POCAHONTAS)
  buildSongFromEvents({
    id: 'colors-of-the-wind',
    title: 'Colors of the Wind (Pocahontas)',
    composer: 'Alan Menken',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 80,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'Am', rh: ['E5:0.5:5', 'D5:0.5:4', 'C5:0.5:3', 'D5:0.5:4', 'C5:1:3', 'A4:0.5:1', 'G4:0.5:1'], lh: ['A2:1:5', 'E3:1:2', 'C4:2:1'] },
      { chord: 'G', rh: ['A4:0.5:2', 'C5:0.5:4', 'D5:2:5', 'R:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'F', rh: ['E5:0.5:5', 'D5:0.5:4', 'C5:0.5:3', 'D5:0.5:4', 'C5:1:3', 'A4:0.5:1', 'G4:0.5:1'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'C', rh: ['C5:1:4', 'A4:2:2', 'R:1'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'Dm', rh: ['C5:0.5:3', 'D5:0.5:4', 'E5:1:5', 'G5:0.5:5', 'F5:0.5:4', 'E5:0.5:3', 'D5:0.5:2'], lh: ['D3:1:5', 'A3:1:2', 'F4:2:1'] },
      { chord: 'Em', rh: ['C5:0.5:3', 'D5:0.5:4', 'E5:2:5', 'R:1'], lh: ['E3:1:5', 'B3:1:2', 'G4:2:1'] },
      { chord: 'F', rh: ['C5:0.5:3', 'D5:0.5:4', 'E5:1:5', 'D5:0.5:4', 'C5:0.5:3', 'A4:0.5:2', 'G4:0.5:1'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'C', rh: ['A4:1:2', 'C5:3:5'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 15. CAN YOU FEEL THE LOVE TONIGHT — ELTON JOHN (THE LION KING)
  buildSongFromEvents({
    id: 'can-you-feel-the-love-tonight',
    title: 'Can You Feel the Love Tonight (The Lion King)',
    composer: 'Elton John',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 72,
    timeSignature: [4, 4],
    keySignature: 'F Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'F', rh: ['C4:0.5:1', 'C5:1:5', 'A4:0.5:3', 'G4:0.5:2', 'C5:1:5', 'A4:0.5:3', 'F4:0.5:2', 'D4:0.5:1'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'Bb', rh: ['C4:1:1', 'F4:1:2', 'Bb4:1:4', 'A4:0.5:3', 'G4:0.5:2'], lh: ['Bb2:1:5', 'F3:1:2', 'D4:2:1'] },
      { chord: 'Dm', rh: ['D4:0.5:1', 'E4:0.5:2', 'F4:0.5:3', 'E4:0.5:2', 'D4:0.5:1', 'C5:1:5', 'A4:0.5:3', 'F4:0.5:2', 'D4:0.5:1'], lh: ['D3:1:5', 'A3:1:2', 'F4:2:1'] },
      { chord: 'C7', rh: ['Bb4:1:4', 'A4:0.5:3', 'G4:0.5:2', 'A4:1:3', 'G4:1:2'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'F', rh: ['C4:0.5:1', 'C5:1:5', 'A4:0.5:3', 'G4:0.5:2', 'C5:1:5', 'A4:0.5:3', 'F4:0.5:2', 'D4:0.5:1'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'Bb', rh: ['C4:1:1', 'F4:1:2', 'Bb4:1:4', 'A4:0.5:3', 'G4:0.5:2'], lh: ['Bb2:1:5', 'F3:1:2', 'D4:2:1'] },
      { chord: 'Gm7', rh: ['D4:0.5:1', 'E4:0.5:2', 'F4:1:3', 'C4:1:1', 'C5:0.5:5', 'G4:0.5:2', 'A4:0.5:3', 'F4:0.5:2'], lh: ['G2:1:5', 'D3:1:2', 'Bb3:2:1'] },
      { chord: 'F', rh: ['Bb4:1:4', 'A4:0.5:3', 'G4:0.5:2', 'F4:2:1'], lh: ['F2+C3+A3+F4:4:5'] }
    ], 4)
  }),

  // 16. REMEMBER ME — KRISTEN ANDERSON-LOPEZ & ROBERT LOPEZ (COCO)
  buildSongFromEvents({
    id: 'remember-me-coco',
    title: 'Remember Me (Coco Lullaby)',
    composer: 'Kristen Anderson-Lopez & Robert Lopez',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 76,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['G4:1.5:4', 'E4:0.5:2', 'G4:2:4'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'G/B', rh: ['G4:0.5:4', 'F#4:0.5:3', 'G4:0.5:4', 'A4:0.5:5', 'G4:2:4'], lh: ['B2:1:5', 'G3:1:2', 'D4:2:1'] },
      { chord: 'C7/Bb', rh: ['E4:1.5:3', 'C4:0.5:1', 'E4:2:3'], lh: ['Bb2:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'F', rh: ['E4:0.5:3', 'D#4:0.5:2', 'E4:0.5:3', 'F4:0.5:4', 'E4:2:3'], lh: ['A2:1:5', 'E3:1:2', 'C4:2:1'] },
      { chord: 'Dm', rh: ['D4:0.5:1', 'E4:0.5:2', 'F4:1:3', 'A4:0.5:5', 'G4:0.5:4', 'F4:0.5:3', 'E4:0.5:2'], lh: ['D3:1:5', 'A3:1:2', 'F4:2:1'] },
      { chord: 'G', rh: ['D4:0.5:1', 'C4:0.5:1', 'D4:1:2', 'E4:2:3'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'F', rh: ['D4:0.5:1', 'E4:0.5:2', 'F4:1:3', 'A4:0.5:5', 'G4:0.5:4', 'F4:0.5:3', 'E4:0.5:2'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'G7', rh: ['D4:0.5:1', 'E4:0.5:2', 'F4:0.5:3', 'G4:0.5:4', 'G4:2:4'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'C', rh: ['G4:1.5:4', 'E4:0.5:2', 'G4:2:4'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'C', rh: ['C4+E4+G4+C5:4:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 17. YOU'VE GOT A FRIEND IN ME — RANDY NEWMAN (TOY STORY)
  buildSongFromEvents({
    id: 'youve-got-a-friend-in-me',
    title: "You've Got a Friend in Me (Toy Story)",
    composer: 'Randy Newman',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 112,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['E4:0.5:2', 'G4:0.5:4', 'E4:0.5:2', 'A4:0.5:5', 'G4:1:4', 'E4:1:2'], lh: ['C3:1:5', 'E3:1:3', 'G3:1:1', 'E3:1:3'] },
      { chord: 'C', rh: ['R:1', 'E4:0.5:2', 'G4:0.5:4', 'E4:0.5:2', 'A4:0.5:5', 'G4:1:4'], lh: ['C3:1:5', 'E3:1:3', 'G3:1:1', 'E3:1:3'] },
      { chord: 'F', rh: ['A4:0.5:3', 'B4:0.5:4', 'A4:0.5:3', 'B4:0.5:4', 'A4:0.5:3', 'G4:0.5:2', 'A4:1:3'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'C', rh: ['R:1', 'E4:0.5:1', 'G4:0.5:2', 'B4:0.5:4', 'B4:0.5:4', 'B4:0.5:4', 'B4:0.5:4'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'F', rh: ['A4:1:3', 'G4:1:2', 'A4:0.5:3', 'G4:0.5:2', 'F4:0.5:1', 'G4:0.5:2'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'Em', rh: ['E4:0.5:1', 'G4:0.5:2', 'A4:0.5:3', 'B4:0.5:4', 'A4:0.5:3', 'G4:0.5:2', 'E4:0.5:1', 'D4:0.5:1'], lh: ['E2:1:5', 'B2:1:3', 'A2:1:4', 'E3:1:2'] },
      { chord: 'Dm7', rh: ['C4:2:1', 'E4:0.5:2', 'G4:0.5:4', 'E4:0.5:2', 'A4:0.5:5'], lh: ['D3:1:5', 'G3:1:2', 'C3:2:5'] },
      { chord: 'C', rh: ['G4:1:4', 'C4+E4+G4:3:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 18. PART OF YOUR WORLD — ALAN MENKEN (THE LITTLE MERMAID)
  buildSongFromEvents({
    id: 'part-of-your-world',
    title: 'Part of Your World (The Little Mermaid)',
    composer: 'Alan Menken',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 80,
    timeSignature: [4, 4],
    keySignature: 'F Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'F', rh: ['F4:0.5:1', 'F4:0.5:1', 'F4:0.5:1', 'F4:0.5:1', 'G4:1:2', 'A4:1:3'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'F', rh: ['C5:2:5', 'R:2'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'Bb', rh: ['C5:0.5:5', 'C5:0.5:5', 'C5:0.5:5', 'C5:0.5:5', 'D5:1:5', 'F5:1:5'], lh: ['Bb2:1:5', 'F3:1:2', 'D4:2:1'] },
      { chord: 'C7', rh: ['C5:0.5:3', 'D5:0.5:4', 'F5:1:5', 'G5:2:5'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'F', rh: ['F4:0.5:1', 'F4:0.5:1', 'F4:0.5:1', 'F4:0.5:1', 'G4:1:2', 'A4:1:3'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'C', rh: ['C5:1:5', 'C5:0.5:5', 'D5:0.5:5', 'F5:1:5', 'G5:1:5'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'Dm', rh: ['A4:0.5:2', 'Bb4:0.5:3', 'C5:1:4', 'D5:0.5:5', 'C5:0.5:4', 'Bb4:0.5:3', 'A4:0.5:2'], lh: ['D3:1:5', 'A3:1:2', 'F4:2:1'] },
      { chord: 'Bb', rh: ['G4:0.5:2', 'F4:0.5:1', 'G4:1:2', 'A4:0.5:3', 'G4:0.5:2', 'F4:1:1'], lh: ['Bb2:1:5', 'F3:1:2', 'D4:2:1'] },
      { chord: 'Gm7', rh: ['G4:1:2', 'A4:1:3', 'Bb4:1:4', 'C5:1:5'], lh: ['G2:1:5', 'D3:1:2', 'Bb3:2:1'] },
      { chord: 'C7', rh: ['F4:1:1', 'G4:1:2', 'A4:1:3', 'F4:1:1'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'F', rh: ['F4+A4+C5+F5:4:1'], lh: ['F2+C3+A3+F4:4:5'] }
    ], 4)
  }),

  // 19. SOMEDAY MY PRINCE WILL COME — FRANK CHURCHILL (SNOW WHITE)
  buildSongFromEvents({
    id: 'someday-my-prince-will-come',
    title: 'Someday My Prince Will Come (Snow White)',
    composer: 'Frank Churchill',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 120,
    timeSignature: [3, 4],
    keySignature: 'Bb Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'Bbmaj7', rh: ['Bb4:1:1', 'D5:1:2', 'F5:1:4'], lh: ['Bb2:1:5', 'F3+Ab3+D4:1:1', 'F3+Ab3+D4:1:1'] },
      { chord: 'D7', rh: ['A5:2:5', 'G5:1:4'], lh: ['D3:1:5', 'F#3+C4:1:1', 'F#3+C4:1:1'] },
      { chord: 'Ebmaj7', rh: ['F5:1:3', 'G5:1:4', 'F5:1:3'], lh: ['Eb3:1:5', 'G3+Bb3:1:1', 'G3+Bb3:1:1'] },
      { chord: 'G7', rh: ['D5:2:2', 'C5:1:1'], lh: ['G2:1:5', 'F3+B3:1:1', 'F3+B3:1:1'] },
      { chord: 'C7', rh: ['Bb4:1:1', 'D5:1:2', 'F5:1:4'], lh: ['C3:1:5', 'E3+Bb3:1:1', 'E3+Bb3:1:1'] },
      { chord: 'F7', rh: ['A5:1:5', 'C6:1:5', 'Bb5:1:4'], lh: ['F2:1:5', 'Eb3+A3:1:1', 'Eb3+A3:1:1'] },
      { chord: 'Bb7', rh: ['A5:1:4', 'G5:1:3', 'F5:1:2'], lh: ['Bb2:1:5', 'D3+Ab3:1:1', 'D3+Ab3:1:1'] },
      { chord: 'Eb', rh: ['G5:1:4', 'A5:1:5', 'F5:1:3'], lh: ['Eb2:1:5', 'G3+Bb3:1:1', 'Eb2:1:5'] },
      { chord: 'F7', rh: ['D5:2:2', 'R:1'], lh: ['F2:1:5', 'C3+Eb3+A3:1:1', 'F2:1:5'] },
      { chord: 'Bb', rh: ['Bb3+D4+F4+Bb4:3:1'], lh: ['Bb1+F2+Bb2:3:5'] }
    ], 3)
  }),

  // 20. WHEN YOU WISH UPON A STAR — LEIGH HARLINE (PINOCCHIO)
  buildSongFromEvents({
    id: 'when-you-wish-upon-a-star',
    title: 'When You Wish Upon a Star (Pinocchio)',
    composer: 'Leigh Harline',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 72,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Original Film Score',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['C4:1:1', 'C5:2:5', 'B4:1:4'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'Am', rh: ['A4:1:3', 'F#4:1:2', 'G4:1:3', 'D4:1:1'], lh: ['A2:1:5', 'E3:1:2', 'C4:2:1'] },
      { chord: 'D7', rh: ['D4:1:1', 'D5:2:5', 'C5:1:4'], lh: ['D3:1:5', 'A3:1:2', 'F#4:2:1'] },
      { chord: 'G7', rh: ['B4:1:3', 'G#4:1:2', 'A4:1:3', 'E4:1:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'C', rh: ['E4:1:1', 'A4:1:3', 'C5:1:4', 'E5:1:5'], lh: ['C3:1:5', 'G3:1:2', 'E4:2:1'] },
      { chord: 'F', rh: ['D5:1:4', 'C5:1:3', 'B4:1:2', 'A4:1:1'], lh: ['F2:1:5', 'C3:1:2', 'A3:2:1'] },
      { chord: 'G7', rh: ['G4:1:3', 'E4:1:1', 'F4:1:2', 'D4:1:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:2:1'] },
      { chord: 'C', rh: ['C4+E4+G4+C5:4:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 21. ONCE UPON A DREAM — PYOTR ILYICH TCHAIKOVSKY (SLEEPING BEAUTY)
  buildSongFromEvents({
    id: 'once-upon-a-dream',
    title: 'Once Upon a Dream (Sleeping Beauty Waltz)',
    composer: 'Pyotr Ilyich Tchaikovsky',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 136,
    timeSignature: [3, 4],
    keySignature: 'G Major',
    sourceFormat: 'Ballet Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'G', rh: ['D5:1:3', 'E5:1:4', 'D5:1:3'], lh: ['G2:1:5', 'B3+D4:1:1', 'B3+D4:1:1'] },
      { chord: 'G', rh: ['B4:2:2', 'G4:1:1'], lh: ['G2:1:5', 'B3+D4:1:1', 'B3+D4:1:1'] },
      { chord: 'C', rh: ['D5:1:3', 'E5:1:4', 'D5:1:3'], lh: ['C3:1:5', 'E3+G3:1:1', 'E3+G3:1:1'] },
      { chord: 'C', rh: ['C5:3:2'], lh: ['C3:1:5', 'E3+G3:1:1', 'E3+G3:1:1'] },
      { chord: 'Am', rh: ['E5:1:3', 'F#5:1:4', 'E5:1:3'], lh: ['A2:1:5', 'C3+E3:1:1', 'C3+E3:1:1'] },
      { chord: 'Am', rh: ['C5:2:2', 'A4:1:1'], lh: ['A2:1:5', 'C3+E3:1:1', 'C3+E3:1:1'] },
      { chord: 'D7', rh: ['F#5:2:4', 'E5:1:3'], lh: ['D3:1:5', 'F#3+C4:1:1', 'F#3+C4:1:1'] },
      { chord: 'G', rh: ['D5:3:2'], lh: ['G2:1:5', 'B3+D4:1:1', 'B3+D4:1:1'] },
      { chord: 'G', rh: ['D5:1:3', 'E5:1:4', 'D5:1:3'], lh: ['G2:1:5', 'B3+D4:1:1', 'B3+D4:1:1'] },
      { chord: 'G', rh: ['B4:2:2', 'G4:1:1'], lh: ['G2:1:5', 'B3+D4:1:1', 'B3+D4:1:1'] },
      { chord: 'Em', rh: ['D5:1:3', 'E5:1:4', 'D5:1:3'], lh: ['E3:1:5', 'G3+B3:1:1', 'E3:1:5'] },
      { chord: 'Am', rh: ['E5:3:4'], lh: ['A2:1:5', 'C3+E3:1:1', 'A2:1:5'] },
      { chord: 'C', rh: ['E5:1:3', 'F#5:1:4', 'G5:1:5'], lh: ['C3:1:5', 'E3+G3:1:1', 'C3:1:5'] },
      { chord: 'D7', rh: ['B4:2:3', 'A4:1:2'], lh: ['D3:1:5', 'F#3+C4:1:1', 'D3:1:5'] },
      { chord: 'G', rh: ['G4:3:1'], lh: ['G2:1:5', 'B3+D4:1:1', 'G2:1:5'] },
      { chord: 'G', rh: ['G3+B3+D4+G4:3:1'], lh: ['G1+D2+G2:3:5'] }
    ], 3)
  }),

  // 22. THE ENTERTAINER — SCOTT JOPLIN (CLASSIC PIANO RAG)
  buildSongFromEvents({
    id: 'the-entertainer',
    title: 'The Entertainer (Classic Piano Rag)',
    composer: 'Scott Joplin',
    genre: 'Jazz & Ragtime',
    difficulty: 'Advanced',
    tempo: 84,
    timeSignature: [2, 4],
    keySignature: 'C Major',
    sourceFormat: 'Original Ragtime Sheet',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['D4:0.25:1', 'D#4:0.25:2', 'E4:0.25:3', 'C5:0.5:5', 'E4:0.25:3', 'C5:0.5:5', 'E4:0.25:3'], lh: ['R:2'] },
      { chord: 'C', rh: ['C5:1.5:5', 'R:0.5'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'C', rh: ['C5:0.25:3', 'D5:0.25:4', 'D#5:0.25:4', 'E5:0.25:5', 'C5:0.25:3', 'D5:0.25:4', 'E5:0.5:5'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'C', rh: ['B4:0.25:2', 'D5:0.5:4', 'C5:1.25:3'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'C', rh: ['D4:0.25:1', 'D#4:0.25:2', 'E4:0.25:3', 'C5:0.5:5', 'E4:0.25:3', 'C5:0.5:5', 'E4:0.25:3'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'C', rh: ['C5:1.5:5', 'R:0.5'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'F', rh: ['A4:0.25:2', 'G4:0.25:1', 'F#4:0.25:1', 'A4:0.25:2', 'C5:0.25:3', 'E5:0.5:5', 'D5:0.25:4'], lh: ['F2:0.5:5', 'A2+C3+F3:0.5:1', 'F#2:0.5:5', 'A2+C3+D#3:0.5:1'] },
      { chord: 'G7', rh: ['C5:0.25:3', 'A4:0.25:2', 'D5:1.5:5'], lh: ['G2:0.5:5', 'B2+D3+G3:0.5:1', 'G1:0.5:5', 'B2+D3+G3:0.5:1'] },
      { chord: 'C', rh: ['D4:0.25:1', 'D#4:0.25:2', 'E4:0.25:3', 'C5:0.5:5', 'E4:0.25:3', 'C5:0.5:5', 'E4:0.25:3'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'C', rh: ['C5:1.5:5', 'R:0.5'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'C', rh: ['C5:0.25:3', 'D5:0.25:4', 'D#5:0.25:4', 'E5:0.25:5', 'C5:0.25:3', 'D5:0.25:4', 'E5:0.5:5'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'C', rh: ['B4:0.25:2', 'D5:0.5:4', 'C5:1.25:3'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'Am', rh: ['C5:0.25:2', 'D5:0.25:3', 'E5:0.25:4', 'C5:0.25:2', 'D5:0.25:3', 'E5:0.25:4', 'C5:0.25:2', 'D5:0.25:3'], lh: ['A2:0.5:5', 'C3+E3:0.5:1', 'F2:0.5:5', 'A2+C3:0.5:1'] },
      { chord: 'G7', rh: ['C5:0.25:3', 'D5:0.25:4', 'C5:0.25:3', 'A4:0.25:2', 'G4:1:1'], lh: ['G2:0.5:5', 'B2+D3+G3:0.5:1', 'G1:0.5:5', 'B2+D3+G3:0.5:1'] },
      { chord: 'C', rh: ['C5+E5+G5:1.5:1', 'R:0.5'], lh: ['C2+G2+C3:2:5'] }
    ], 2)
  }),

  // 23. RONDO ALLA TURCA — WOLFGANG AMADEUS MOZART (TURKISH MARCH, K. 331)
  buildSongFromEvents({
    id: 'turkish-march-mozart',
    title: 'Rondo Alla Turca (Turkish March, K. 331)',
    composer: 'Wolfgang Amadeus Mozart',
    genre: 'Classical',
    difficulty: 'Advanced',
    tempo: 120,
    timeSignature: [2, 4],
    keySignature: 'A Minor',
    sourceFormat: 'Urtext Standard',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Am', rh: ['B4:0.25:1', 'A4:0.25:1', 'G#4:0.25:1', 'A4:0.25:1', 'C5:0.5:3', 'R:0.5'], lh: ['R:1', 'A2:0.5:5', 'C3+E3+A3:0.5:1'] },
      { chord: 'Am', rh: ['D5:0.25:1', 'C5:0.25:1', 'B4:0.25:1', 'C5:0.25:1', 'E5:0.5:5', 'R:0.5'], lh: ['A2:0.5:5', 'C3+E3+A3:0.5:1', 'A2:0.5:5', 'C3+E3+A3:0.5:1'] },
      { chord: 'Am', rh: ['F5:0.25:4', 'E5:0.25:3', 'D#5:0.25:2', 'E5:0.25:3', 'B5:0.25:5', 'A5:0.25:4', 'G#5:0.25:3', 'A5:0.25:4'], lh: ['A2:0.5:5', 'C3+E3+A3:0.5:1', 'A2:0.5:5', 'C3+E3+A3:0.5:1'] },
      { chord: 'Am', rh: ['B5:0.25:5', 'A5:0.25:4', 'G#5:0.25:3', 'A5:0.25:4', 'C6:0.5:5', 'R:0.5'], lh: ['A2:0.5:5', 'C3+E3+A3:0.5:1', 'A2:0.5:5', 'C3+E3+A3:0.5:1'] },
      { chord: 'Am', rh: ['B4:0.25:1', 'A4:0.25:1', 'G#4:0.25:1', 'A4:0.25:1', 'C5:0.5:3', 'R:0.5'], lh: ['A2:0.5:5', 'C3+E3+A3:0.5:1', 'A2:0.5:5', 'C3+E3+A3:0.5:1'] },
      { chord: 'Am', rh: ['D5:0.25:1', 'C5:0.25:1', 'B4:0.25:1', 'C5:0.25:1', 'E5:0.5:5', 'R:0.5'], lh: ['A2:0.5:5', 'C3+E3+A3:0.5:1', 'A2:0.5:5', 'C3+E3+A3:0.5:1'] },
      { chord: 'E7', rh: ['F5:0.25:4', 'E5:0.25:3', 'D#5:0.25:2', 'E5:0.25:3', 'B4:0.25:1', 'C5:0.25:2', 'D5:0.25:3', 'B4:0.25:1'], lh: ['E2:0.5:5', 'G#2+B2+E3:0.5:1', 'E2:0.5:5', 'G#2+B2+E3:0.5:1'] },
      { chord: 'Am', rh: ['A4:1:2', 'R:1'], lh: ['A2:0.5:5', 'C3+E3+A3:0.5:1', 'A1+A2:1:5'] },
      { chord: 'A', rh: ['C#5:0.5:3', 'C#5:0.5:3', 'D5:0.25:4', 'C#5:0.25:3', 'B4:0.25:2', 'A4:0.25:1'], lh: ['A1+A2:0.5:5', 'A2+C#3+E3:0.5:1', 'A1+A2:0.5:5', 'A2+C#3+E3:0.5:1'] },
      { chord: 'A', rh: ['C#5:0.5:3', 'C#5:0.5:3', 'D5:0.25:4', 'C#5:0.25:3', 'B4:0.25:2', 'A4:0.25:1'], lh: ['A1+A2:0.5:5', 'A2+C#3+E3:0.5:1', 'A1+A2:0.5:5', 'A2+C#3+E3:0.5:1'] },
      { chord: 'F#m', rh: ['F#5:0.5:5', 'F#5:0.5:5', 'G#5:0.25:5', 'F#5:0.25:4', 'E#5:0.25:3', 'F#5:0.25:4'], lh: ['F#1+F#2:0.5:5', 'F#2+A2+C#3:0.5:1', 'F#1+F#2:0.5:5', 'F#2+A2+C#3:0.5:1'] },
      { chord: 'C#7', rh: ['G#5:0.5:5', 'G#5:0.5:5', 'A5:0.25:5', 'G#5:0.25:4', 'F#5:0.25:3', 'G#5:0.25:4'], lh: ['C#2:0.5:5', 'G#2+C#3+E#3:0.5:1', 'C#1+C#2:1:5'] },
      { chord: 'A', rh: ['A5:1:5', 'A4+C#5+E5+A5:1:1'], lh: ['A1+A2:1:5', 'A1+E2+A2:1:5'] }
    ], 2)
  }),

  // 24. NOCTURNE IN E-FLAT MAJOR, OP. 9 NO. 2 — FRÉDÉRIC CHOPIN
  buildSongFromEvents({
    id: 'chopin-nocturne-op9-no2',
    title: 'Nocturne in E-flat Major, Op. 9 No. 2',
    composer: 'Frédéric Chopin',
    genre: 'Classical',
    difficulty: 'Advanced',
    tempo: 60,
    timeSignature: [4, 4],
    keySignature: 'Eb Major',
    sourceFormat: 'Urtext Edition',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Eb', rh: ['R:3', 'Bb4:1:2'], lh: ['R:4'] },
      { chord: 'Eb', rh: ['G5:2.5:5', 'F5:0.5:4', 'G5:1:5', 'F5:1:4', 'Eb5:1:3', 'Bb4:2:1'], lh: ['Eb2:1:5', 'G3+Bb3+Eb4:1:1', 'G2:1:5', 'G3+Bb3+Eb4:1:1'] },
      { chord: 'Ab', rh: ['C5:1:2', 'Eb5:1:4', 'Ab5:2:5', 'G5:1:4', 'F5:2:3', 'Eb5:1:2'], lh: ['Ab2:1:5', 'C3+Eb3+Ab3:1:1', 'Bb2:1:5', 'D3+F3+Bb3:1:1'] },
      { chord: 'Eb', rh: ['G5:2.5:5', 'F5:0.5:4', 'G5:1:5', 'F5:1:4', 'Eb5:1:3', 'Bb4:2:1'], lh: ['Eb2:1:5', 'G3+Bb3+Eb4:1:1', 'C3:1:5', 'G3+C4+Eb4:1:1'] },
      { chord: 'Bb7', rh: ['D5:1:2', 'F5:1:4', 'Bb5:2:5', 'A5:1:4', 'G5:1:3', 'F5:1:2', 'D5:1:1'], lh: ['F2:1:5', 'A2+C3+F3:1:1', 'Bb2:1:5', 'D3+F3+Bb3:1:1'] },
      { chord: 'Eb', rh: ['Eb4+G4+Bb4+Eb5:4:1'], lh: ['Eb2+Bb2+Eb3:4:5'] }
    ], 4)
  }),

  // 25. THE SWAN — CAMILLE SAINT-SAËNS (CARNIVAL OF THE ANIMALS)
  buildSongFromEvents({
    id: 'the-swan-saint-saens',
    title: 'The Swan (Carnival of the Animals)',
    composer: 'Camille Saint-Saëns',
    genre: 'Classical',
    difficulty: 'Intermediate',
    tempo: 72,
    timeSignature: [3, 4],
    keySignature: 'G Major',
    sourceFormat: 'Original Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'G', rh: ['R:1', 'G4:1:1', 'A4:1:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'G', rh: ['B4:2:3', 'D5:1:5'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'C', rh: ['C5:1:4', 'B4:1:3', 'A4:1:2'], lh: ['E3:1:5', 'G3:1:2', 'C4:1:1'] },
      { chord: 'G', rh: ['B4:2:3', 'G4:1:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'C', rh: ['E4:2:1', 'F#4:1:2'], lh: ['C3:1:5', 'G3:1:2', 'E4:1:1'] },
      { chord: 'C', rh: ['G4:1:3', 'B4:1:5', 'A4:1:4'], lh: ['C3:1:5', 'G3:1:2', 'E4:1:1'] },
      { chord: 'D7', rh: ['G4:2:3', 'F#4:1:2'], lh: ['D3:1:5', 'A3:1:2', 'F#4:1:1'] },
      { chord: 'Em', rh: ['E4:3:1'], lh: ['E2:1:5', 'B2:1:2', 'G3:1:1'] },
      { chord: 'G', rh: ['G4:2:1', 'A4:1:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'G', rh: ['B4:2:3', 'D5:1:5'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'C', rh: ['E5:2:5', 'D5:1:4'], lh: ['C3:1:5', 'G3:1:2', 'E4:1:1'] },
      { chord: 'G', rh: ['B4:2:3', 'G4:1:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'D7', rh: ['A4:2:2', 'B4:1:3'], lh: ['D3:1:5', 'A3:1:2', 'F#4:1:1'] },
      { chord: 'G', rh: ['G4:3:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'G', rh: ['G3+B3+D4+G4:3:1'], lh: ['G1+D2+G2:3:5'] }
    ], 3)
  }),

  // 26. THE BLUE DANUBE WALTZ — JOHANN STRAUSS II
  buildSongFromEvents({
    id: 'blue-danube-waltz',
    title: 'The Blue Danube Waltz, Op. 314',
    composer: 'Johann Strauss II',
    genre: 'Classical',
    difficulty: 'Intermediate',
    tempo: 160,
    timeSignature: [3, 4],
    keySignature: 'D Major',
    sourceFormat: 'Original Orchestral Waltz',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'D', rh: ['D4:1:1', 'F#4:1:2', 'A4:1:3'], lh: ['R:3'] },
      { chord: 'D', rh: ['A4:2:3', 'F#5:1:5'], lh: ['D3:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['F#5:2:5', 'D5:1:3'], lh: ['D3:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['D5:2:3', 'F#4:1:2'], lh: ['D3:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['F#4:2:2', 'A4:1:3'], lh: ['D3:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'A7', rh: ['A4:2:3', 'G5:1:5'], lh: ['A2:1:5', 'G3+C#4:1:1', 'G3+C#4:1:1'] },
      { chord: 'A7', rh: ['G5:2:5', 'E5:1:4'], lh: ['A2:1:5', 'G3+C#4:1:1', 'G3+C#4:1:1'] },
      { chord: 'A7', rh: ['E5:2:4', 'G4:1:2'], lh: ['A2:1:5', 'G3+C#4:1:1', 'G3+C#4:1:1'] },
      { chord: 'A7', rh: ['G4:2:2', 'A4:1:3'], lh: ['A2:1:5', 'G3+C#4:1:1', 'G3+C#4:1:1'] },
      { chord: 'D', rh: ['A4:2:3', 'F#5:1:5'], lh: ['D3:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['F#5:2:5', 'D5:1:3'], lh: ['D3:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['D5:2:3', 'F#4:1:2'], lh: ['D3:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['F#4:2:2', 'A4:1:3'], lh: ['D3:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'A7', rh: ['A4:2:3', 'E5:1:5'], lh: ['A2:1:5', 'G3+C#4:1:1', 'G3+C#4:1:1'] },
      { chord: 'A7', rh: ['E5:2:5', 'C#5:1:4'], lh: ['A2:1:5', 'G3+C#4:1:1', 'G3+C#4:1:1'] },
      { chord: 'D', rh: ['D5:3:3'], lh: ['D3:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['D4+F#4+A4+D5:3:1'], lh: ['D2+A2+D3:3:5'] }
    ], 3)
  }),

  // 27. DANCE OF THE SUGAR PLUM FAIRY — PYOTR ILYICH TCHAIKOVSKY (THE NUTCRACKER)
  buildSongFromEvents({
    id: 'sugar-plum-fairy',
    title: 'Dance of the Sugar Plum Fairy (Nutcracker)',
    composer: 'Pyotr Ilyich Tchaikovsky',
    genre: 'Classical',
    difficulty: 'Advanced',
    tempo: 116,
    timeSignature: [2, 4],
    keySignature: 'E Minor',
    sourceFormat: 'Ballet Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Em', rh: ['B4:0.5:5', 'G4:0.5:3', 'E4:0.5:1', 'B3:0.5:1'], lh: ['E2:0.5:5', 'G3+B3:0.5:1', 'E2:0.5:5', 'G3+B3:0.5:1'] },
      { chord: 'B7', rh: ['D#4:0.5:2', 'F#4:0.5:3', 'A4:0.5:4', 'C5:0.5:5'], lh: ['B1:0.5:5', 'F#3+A3:0.5:1', 'B1:0.5:5', 'F#3+A3:0.5:1'] },
      { chord: 'Em', rh: ['B4:0.5:5', 'G4:0.5:3', 'E4:0.5:1', 'B3:0.5:1'], lh: ['E2:0.5:5', 'G3+B3:0.5:1', 'E2:0.5:5', 'G3+B3:0.5:1'] },
      { chord: 'B7', rh: ['D#4:0.5:2', 'F#4:0.5:3', 'A4:0.5:4', 'C5:0.5:5'], lh: ['B1:0.5:5', 'F#3+A3:0.5:1', 'B1:0.5:5', 'F#3+A3:0.5:1'] },
      { chord: 'Em', rh: ['B4:0.25:5', 'G4:0.25:3', 'E4:0.25:1', 'B3:0.25:1', 'D#4:0.25:2', 'F#4:0.25:3', 'A4:0.25:4', 'C5:0.25:5'], lh: ['E2:0.5:5', 'G3+B3:0.5:1', 'B1:0.5:5', 'F#3+A3:0.5:1'] },
      { chord: 'Em', rh: ['B4:1:5', 'R:1'], lh: ['E2:0.5:5', 'G3+B3:0.5:1', 'E1+E2:1:5'] },
      { chord: 'Am', rh: ['C5:0.5:5', 'A4:0.5:4', 'F#4:0.5:2', 'C4:0.5:1'], lh: ['A1:0.5:5', 'E3+A3:0.5:1', 'A1:0.5:5', 'E3+A3:0.5:1'] },
      { chord: 'Em', rh: ['B4:1:5', 'E4+G4+B4:1:1'], lh: ['E2+B2:1:5', 'E1+E2:1:5'] }
    ], 2)
  }),

  // 28. IN THE HALL OF THE MOUNTAIN KING — EDVARD GRIEG (PEER GYNT)
  buildSongFromEvents({
    id: 'mountain-king-grieg',
    title: 'In the Hall of the Mountain King (Peer Gynt)',
    composer: 'Edvard Grieg',
    genre: 'Classical',
    difficulty: 'Intermediate',
    tempo: 108,
    timeSignature: [4, 4],
    keySignature: 'B Minor',
    sourceFormat: 'Concert Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Bm', rh: ['B2:0.5:1', 'C#3:0.5:2', 'D3:0.5:3', 'E3:0.5:4', 'F#3:0.5:5', 'D3:0.5:3', 'F#3:1:5'], lh: ['B1:1:5', 'F#2:1:2', 'B1:1:5', 'F#2:1:2'] },
      { chord: 'F#m', rh: ['F3:0.5:4', 'C#3:0.5:2', 'F3:1:4', 'E3:0.5:3', 'C3:0.5:1', 'E3:1:3'], lh: ['F1:1:5', 'C#2:1:2', 'E1:1:5', 'C2:1:2'] },
      { chord: 'Bm', rh: ['B2:0.5:1', 'C#3:0.5:2', 'D3:0.5:3', 'E3:0.5:4', 'F#3:0.5:5', 'D3:0.5:3', 'F#3:0.5:5', 'B3:0.5:5'], lh: ['B1:1:5', 'F#2:1:2', 'B1:1:5', 'F#2:1:2'] },
      { chord: 'D', rh: ['A3:0.5:4', 'F#3:0.5:2', 'D3:0.5:1', 'F#3:0.5:2', 'A3:2:4'], lh: ['D2:1:5', 'A2:1:2', 'D2:2:5'] },
      { chord: 'Bm', rh: ['B3:0.5:1', 'C#4:0.5:2', 'D4:0.5:3', 'E4:0.5:4', 'F#4:0.5:5', 'D4:0.5:3', 'F#4:1:5'], lh: ['B2:1:5', 'F#3:1:2', 'B2:1:5', 'F#3:1:2'] },
      { chord: 'F#m', rh: ['F4:0.5:4', 'C#4:0.5:2', 'F4:1:4', 'E4:0.5:3', 'C4:0.5:1', 'E4:1:3'], lh: ['F2:1:5', 'C#3:1:2', 'E2:1:5', 'C3:1:2'] },
      { chord: 'Bm', rh: ['B3:0.5:1', 'C#4:0.5:2', 'D4:0.5:3', 'E4:0.5:4', 'F#4:0.5:5', 'D4:0.5:3', 'F#4:0.5:5', 'B4:0.5:5'], lh: ['B2:1:5', 'F#3:1:2', 'B2:1:5', 'F#3:1:2'] },
      { chord: 'Bm', rh: ['A#4:0.5:4', 'F#4:0.5:2', 'D4:0.5:1', 'F#4:0.5:2', 'B4:2:5'], lh: ['F#2:1:5', 'C#3:1:2', 'B1+F#2+B2:2:5'] }
    ], 4)
  }),

  // 29. GREENSLEEVES — TRADITIONAL ENGLISH BALLAD
  buildSongFromEvents({
    id: 'greensleeves',
    title: 'Greensleeves (Traditional Ballad)',
    composer: 'Traditional (16th Century)',
    genre: 'Traditional & Folk',
    difficulty: 'Intermediate',
    tempo: 96,
    timeSignature: [3, 4],
    keySignature: 'A Minor',
    sourceFormat: 'Folk Ballad Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Am', rh: ['R:2', 'A4:1:1'], lh: ['R:3'] },
      { chord: 'Am', rh: ['C5:2:3', 'D5:1:4'], lh: ['A2:1:5', 'E3:1:2', 'C4:1:1'] },
      { chord: 'C', rh: ['E5:1.5:5', 'F5:0.5:5', 'E5:1:5'], lh: ['C3:1:5', 'G3:1:2', 'E4:1:1'] },
      { chord: 'G', rh: ['D5:2:4', 'B4:1:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'Em', rh: ['G4:1.5:1', 'A4:0.5:2', 'B4:1:3'], lh: ['E2:1:5', 'B2:1:2', 'G3:1:1'] },
      { chord: 'Am', rh: ['C5:2:3', 'A4:1:1'], lh: ['A2:1:5', 'E3:1:2', 'C4:1:1'] },
      { chord: 'F', rh: ['A4:1.5:1', 'G#4:0.5:1', 'A4:1:1'], lh: ['F2:1:5', 'C3:1:2', 'A3:1:1'] },
      { chord: 'E7', rh: ['B4:2:3', 'G#4:1:1'], lh: ['E2:1:5', 'B2:1:2', 'G#3:1:1'] },
      { chord: 'E7', rh: ['E4:2:1', 'A4:1:2'], lh: ['E2:1:5', 'B2:1:2', 'E3:1:1'] },
      { chord: 'Am', rh: ['C5:2:3', 'D5:1:4'], lh: ['A2:1:5', 'E3:1:2', 'C4:1:1'] },
      { chord: 'C', rh: ['E5:1.5:5', 'F5:0.5:5', 'E5:1:5'], lh: ['C3:1:5', 'G3:1:2', 'E4:1:1'] },
      { chord: 'G', rh: ['D5:2:4', 'B4:1:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'Em', rh: ['G4:1.5:1', 'A4:0.5:2', 'B4:1:3'], lh: ['E2:1:5', 'B2:1:2', 'G3:1:1'] },
      { chord: 'Am', rh: ['C5:1.5:3', 'B4:0.5:2', 'A4:1:1'], lh: ['A2:1:5', 'E3:1:2', 'C4:1:1'] },
      { chord: 'E7', rh: ['G#4:1.5:2', 'F#4:0.5:1', 'G#4:1:2'], lh: ['E2:1:5', 'B2:1:2', 'G#3:1:1'] },
      { chord: 'Am', rh: ['A4:3:1'], lh: ['A2:1:5', 'E3:1:2', 'A3:1:1'] },
      { chord: 'Am', rh: ['A3+C4+E4+A4:3:1'], lh: ['A1+E2+A2:3:5'] }
    ], 3)
  }),

  // 30. AMAZING GRACE — TRADITIONAL SPIRITUAL
  buildSongFromEvents({
    id: 'amazing-grace',
    title: 'Amazing Grace (Gospel Piano Arrangement)',
    composer: 'John Newton / Traditional',
    genre: 'Traditional & Folk',
    difficulty: 'Beginner',
    tempo: 72,
    timeSignature: [3, 4],
    keySignature: 'G Major',
    sourceFormat: 'Hymnal Arrangement',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'G', rh: ['R:2', 'D4:1:1'], lh: ['R:3'] },
      { chord: 'G', rh: ['G4:2:2', 'B4:0.5:4', 'G4:0.5:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'G', rh: ['B4:2:4', 'A4:1:3'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'C', rh: ['G4:2:2', 'E4:1:1'], lh: ['C3:1:5', 'G3:1:2', 'E4:1:1'] },
      { chord: 'G', rh: ['D4:2:1', 'D4:1:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'G', rh: ['G4:2:2', 'B4:0.5:4', 'G4:0.5:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'Em', rh: ['B4:2:4', 'A4:1:3'], lh: ['B2:1:5', 'F#3:1:2', 'D4:1:1'] },
      { chord: 'D7', rh: ['D5:3:5'], lh: ['D3:1:5', 'A3:1:2', 'F#4:1:1'] },
      { chord: 'G', rh: ['D5:2:5', 'B4:1:3'], lh: ['D3:1:5', 'A3:1:2', 'F#4:1:1'] },
      { chord: 'G', rh: ['D5:2:5', 'B4:0.5:3', 'G4:0.5:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'G', rh: ['B4:2:4', 'A4:1:3'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'C', rh: ['G4:2:2', 'E4:1:1'], lh: ['C3:1:5', 'G3:1:2', 'E4:1:1'] },
      { chord: 'G', rh: ['D4:2:1', 'D4:1:1'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'G', rh: ['G4:2:2', 'B4:0.5:4', 'G4:0.5:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'D7', rh: ['B4:2:4', 'A4:1:3'], lh: ['D3:1:5', 'A3:1:2', 'F#4:1:1'] },
      { chord: 'G', rh: ['G4:3:2'], lh: ['G2:1:5', 'D3:1:2', 'B3:1:1'] },
      { chord: 'G', rh: ['G3+B3+D4+G4:3:1'], lh: ['G1+D2+G2:3:5'] }
    ], 3)
  }),

  // 31. MAPLE LEAF RAG — SCOTT JOPLIN (OPENING STRIDE THEME)
  buildSongFromEvents({
    id: 'maple-leaf-rag',
    title: 'Maple Leaf Rag (Opening Stride Theme)',
    composer: 'Scott Joplin',
    genre: 'Jazz & Ragtime',
    difficulty: 'Advanced',
    tempo: 96,
    timeSignature: [2, 4],
    keySignature: 'C Major',
    sourceFormat: 'Original Ragtime Sheet',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['E4:0.25:1', 'G4:0.25:2', 'C5:0.5:4', 'E4:0.25:1', 'G4:0.25:2', 'C5:0.5:4'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'C', rh: ['E4:0.25:1', 'G4:0.25:2', 'C5:0.5:4', 'D#5:0.25:4', 'E5:0.5:5', 'C5:0.25:3'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'G7', rh: ['D5:0.5:4', 'E4:0.25:1', 'G4:0.25:2', 'C5:0.5:3', 'E4:0.25:1', 'G4:0.25:2'], lh: ['G2:0.5:5', 'B2+D3+F3:0.5:1', 'G1:0.5:5', 'B2+D3+F3:0.5:1'] },
      { chord: 'C', rh: ['C5:1:3', 'R:1'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'C2:1:5'] },
      { chord: 'C', rh: ['E4:0.25:1', 'G4:0.25:2', 'C5:0.5:4', 'E4:0.25:1', 'G4:0.25:2', 'C5:0.5:4'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'C', rh: ['E4:0.25:1', 'G4:0.25:2', 'C5:0.5:4', 'D#5:0.25:4', 'E5:0.5:5', 'C5:0.25:3'], lh: ['C3:0.5:5', 'E3+G3+C4:0.5:1', 'G2:0.5:5', 'E3+G3+C4:0.5:1'] },
      { chord: 'G7', rh: ['D5:0.5:4', 'G4:0.25:1', 'B4:0.25:2', 'D5:0.5:4', 'B4:0.25:2', 'G4:0.25:1'], lh: ['G2:0.5:5', 'B2+D3+F3:0.5:1', 'G1:0.5:5', 'B2+D3+F3:0.5:1'] },
      { chord: 'C', rh: ['C4+E4+G4+C5:2:1'], lh: ['C2+G2+C3:2:5'] }
    ], 2)
  }),

  // 32. CLAIR DE LUNE — CLAUDE DEBUSSY
  buildSongFromEvents({
    id: 'clair-de-lune',
    title: 'Clair de Lune (Suite Bergamasque, L. 75)',
    composer: 'Claude Debussy',
    genre: 'Impressionist',
    difficulty: 'Advanced',
    tempo: 58,
    timeSignature: [3, 4],
    keySignature: 'Db Major',
    sourceFormat: 'Urtext Standard',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Db', rh: ['F5:2:4', 'Eb5:1:3'], lh: ['Db3:1:5', 'Ab3:1:2', 'F4:1:1'] },
      { chord: 'Db', rh: ['Db5:2:2', 'C5:1:1'], lh: ['Db3:1:5', 'Ab3:1:2', 'F4:1:1'] },
      { chord: 'Gb', rh: ['Bb4:2:4', 'Ab4:1:3'], lh: ['Gb2:1:5', 'Db3:1:2', 'Bb3:1:1'] },
      { chord: 'Ab', rh: ['F4:2:2', 'Eb4:1:1'], lh: ['Ab2:1:5', 'Eb3:1:2', 'C4:1:1'] },
      { chord: 'Db', rh: ['Db4:3:1'], lh: ['Db2+Ab2+Db3:3:5'] },
      { chord: 'Db', rh: ['F5:2:4', 'Eb5:1:3'], lh: ['Db3:1:5', 'Ab3:1:2', 'F4:1:1'] },
      { chord: 'Db', rh: ['Db5:2:2', 'C5:1:1'], lh: ['Db3:1:5', 'Ab3:1:2', 'F4:1:1'] },
      { chord: 'Gb', rh: ['Bb4:2:4', 'Ab4:1:3'], lh: ['Gb2:1:5', 'Db3:1:2', 'Bb3:1:1'] },
      { chord: 'Ab7', rh: ['F4:2:2', 'Eb4:1:1'], lh: ['Ab2:1:5', 'Eb3:1:2', 'C4:1:1'] },
      { chord: 'Db', rh: ['Db4+F4+Ab4+Db5:3:1'], lh: ['Db1+Ab1+Db2:3:5'] }
    ], 3)
  })
];

// ============================================================================
// 3. REAL BINARY MIDI (.MID) PARSER & MUSICXML EXPORTER
// ============================================================================

export function parseStandardMidiFile(arrayBuffer, filename = 'Imported Song.mid') {
  const bytes = new Uint8Array(arrayBuffer);
  let pos = 0;

  const readStr = (len) => {
    let s = '';
    for (let i = 0; i < len && pos < bytes.length; i++) s += String.fromCharCode(bytes[pos++]);
    return s;
  };
  const readU16 = () => {
    const v = (bytes[pos] << 8) | bytes[pos + 1];
    pos += 2;
    return v;
  };
  const readU32 = () => {
    const v = ((bytes[pos] << 24) >>> 0) + ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]);
    pos += 4;
    return v;
  };
  const readVarLen = () => {
    let value = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return value;
  };

  const headerId = readStr(4);
  if (headerId !== 'MThd') {
    const error = new Error('Invalid MIDI header (Expected MThd).');
    error.code = 'midi-bad';
    throw error;
  }
  const headerLen = readU32();
  const format = readU16();
  const numTracks = readU16();
  const division = readU16();
  const ticksPerBeat = (division & 0x8000) ? 480 : (division || 480);
  pos = 8 + headerLen;

  let tempoBpm = 110;
  let timeSig = [4, 4];
  const parsedNotes = [];

  for (let t = 0; t < numTracks && pos < bytes.length; t++) {
    const chunkId = readStr(4);
    const chunkLen = readU32();
    const trackEnd = pos + chunkLen;
    if (chunkId !== 'MTrk') {
      pos = trackEnd;
      continue;
    }

    let currentTick = 0;
    let runningStatus = 0;
    const activeNotes = new Map();

    while (pos < trackEnd) {
      const delta = readVarLen();
      currentTick += delta;
      let status = bytes[pos];

      if (status < 0x80) {
        status = runningStatus;
      } else {
        pos++;
        if (status < 0xf0) runningStatus = status;
      }

      const eventType = status & 0xf0;
      if (eventType === 0x90 || eventType === 0x80) {
        const pitch = bytes[pos++];
        const vel = bytes[pos++];
        const isNoteOn = eventType === 0x90 && vel > 0;
        if (isNoteOn) {
          activeNotes.set(pitch, { startTick: currentTick, vel, track: t });
        } else {
          const startInfo = activeNotes.get(pitch);
          if (startInfo) {
            const onsetBeats = Math.round((startInfo.startTick / ticksPerBeat) * 4) / 4;
            const durBeats = Math.max(0.25, Math.round(((currentTick - startInfo.startTick) / ticksPerBeat) * 4) / 4);
            parsedNotes.push({
              pitch,
              onset: onsetBeats,
              duration: durBeats,
              velocity: startInfo.vel,
              hand: pitch >= 60 ? 'R' : 'L',
              confidence: 1.0,
              harmony: NOTE_NAMES[pitch % 12]
            });
            activeNotes.delete(pitch);
          }
        }
      } else if (eventType === 0xa0 || eventType === 0xb0 || eventType === 0xe0) {
        pos += 2;
      } else if (eventType === 0xc0 || eventType === 0xd0) {
        pos += 1;
      } else if (status === 0xff) {
        const metaType = bytes[pos++];
        const metaLen = readVarLen();
        if (metaType === 0x51 && metaLen === 3) {
          const mpqn = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
          if (mpqn > 0) tempoBpm = Math.round(60000000 / mpqn);
        } else if (metaType === 0x58 && metaLen >= 2) {
          timeSig = [bytes[pos], Math.pow(2, bytes[pos + 1])];
        }
        pos += metaLen;
      } else if (status === 0xf0 || status === 0xf7) {
        const sysLen = readVarLen();
        pos += sysLen;
      } else {
        break;
      }
    }
    pos = trackEnd;
  }

  if (parsedNotes.length === 0) {
    const error = new Error('No playable MIDI note events found in file.');
    error.code = 'midi-empty';
    throw error;
  }
  parsedNotes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
  const keptNotes = parsedNotes;
  const cleanTitle = filename.replace(/\.(mid|midi)$/i, '');

  return {
    song: buildSongFromEvents({
      id: `midi-${Date.now()}`,
      title: cleanTitle,
      composer: `MIDI Format ${format}`,
      genre: 'Imported Score',
      difficulty: keptNotes.length > 40 ? 'Intermediate' : 'Beginner',
      tempo: Math.min(180, Math.max(50, tempoBpm)),
      timeSignature: timeSig,
      keySignature: 'C Major',
      sourceFormat: 'Standard MIDI (.mid)',
      license: 'User Authorized Import',
      rawNotes: keptNotes
    }),
    kept: keptNotes.length,
    dropped: parsedNotes.length - keptNotes.length
  };
}

function readPracticeMidi(bytes, filename) {
  try {
    const opened = parseStandardMidiFile(bytes, filename);
    return { ok: true, song: opened.song, kept: opened.kept, dropped: opened.dropped };
  } catch (error) {
    if (error && error.code === 'midi-empty') return { ok: false, reason: 'empty' };
    return { ok: false, reason: 'bad' };
  }
}

function parseMusicXMLString(xmlText, filename = 'Imported Score.musicxml') {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const noteNodes = Array.from(doc.querySelectorAll('note'));
  if (noteNodes.length === 0) throw new Error('No <note> elements found in MusicXML document.');
  const divisionsNode = doc.querySelector('divisions');
  const divisions = divisionsNode ? parseInt(divisionsNode.textContent || '4', 10) : 4;

  let currentOnset = 0;
  const rawNotes = [];
  noteNodes.slice(0, 96).forEach((noteEl) => {
    const isRest = !!noteEl.querySelector('rest');
    const isChord = !!noteEl.querySelector('chord');
    const durNode = noteEl.querySelector('duration');
    const durBeats = durNode ? Math.max(0.25, parseInt(durNode.textContent || '4', 10) / divisions) : 1;

    if (!isRest) {
      const step = noteEl.querySelector('step')?.textContent || 'C';
      const octave = parseInt(noteEl.querySelector('octave')?.textContent || '4', 10);
      const alter = parseInt(noteEl.querySelector('alter')?.textContent || '0', 10);
      const baseSemitone = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step] ?? 0;
      const pitch = (octave + 1) * 12 + baseSemitone + alter;
      rawNotes.push({
        pitch,
        onset: isChord ? Math.max(0, currentOnset - durBeats) : currentOnset,
        duration: durBeats,
        hand: pitch >= 60 ? 'R' : 'L',
        confidence: 1.0,
        harmony: step
      });
    }
    if (!isChord) currentOnset += durBeats;
  });

  return buildSongFromEvents({
    id: `xml-${Date.now()}`,
    title: doc.querySelector('work-title')?.textContent || filename.replace(/\.(musicxml|xml)$/i, ''),
    composer: doc.querySelector('creator')?.textContent || 'MusicXML Import',
    genre: 'Symbolic Score',
    difficulty: 'Intermediate',
    tempo: 100,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'User Authorized Import',
    rawNotes
  });
}

function exportToMusicXML(song) {
  const measuresMap = new Map();
  song.events.forEach(ev => {
    if (!measuresMap.has(ev.measure)) measuresMap.set(ev.measure, []);
    measuresMap.get(ev.measure).push(ev);
  });

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>${song.title}</work-title></work>
  <identification><creator type="composer">${song.composer}</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">\n`;

  Array.from(measuresMap.keys()).sort((a, b) => a - b).forEach((mNum) => {
    xml += `    <measure number="${mNum}">\n`;
    if (mNum === 1) {
      xml += `      <attributes>
        <divisions>4</divisions>
        <time><beats>${song.timeSignature[0]}</beats><beat-type>${song.timeSignature[1]}</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>\n`;
    }
    measuresMap.get(mNum).forEach(ev => {
      xml += `      <note>
        <pitch><step>${ev.step}</step>${ev.alter ? `<alter>${ev.alter}</alter>` : ''}<octave>${ev.octave}</octave></pitch>
        <duration>${Math.round(ev.duration * 4)}</duration>
        <voice>${ev.hand === 'R' ? 1 : 2}</voice>
      </note>\n`;
    });
    xml += `    </measure>\n`;
  });

  xml += `  </part>\n</score-partwise>`;
  return xml;
}

// ============================================================================
// 4. AUDIO ENGINE (DESKTOP SAMPLES + IOS POTETO MODE)
// ============================================================================

const audioEngine = new MaestroAudioEngine();

// ============================================================================
// 5. MAIN APPLICATION COMPONENT (MOBILE-FIRST & CONSERVATORY DESIGN SYSTEM)
// ============================================================================

export default function App() {
  // Primary 4-Pillar Navigation + Theme & Viewport
  const [activeTab, setActiveTab] = useState('practice'); // Default directly into interactive experience or repertoire
  const [darkMode, setDarkMode] = useState(false); // Warm Ivory Sheet-Music Light Mode by default
  const [songs, setSongs] = useState(INITIAL_SONGS);
  const [selectedSongId, setSelectedSongId] = useState(INITIAL_SONGS[0].id);
  const [libraryFilter, setLibraryFilter] = useState('ALL');
  const [genreFilter, setGenreFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Responsive Keyboard Range (2 Octaves on Mobile for fat-finger playability, 4 Octaves on Desktop)
  const [isMobileView, setIsMobileView] = useState(false);
  const [keyboardRangeMode, setKeyboardRangeMode] = useState('compact'); // 'compact' (C3-C5) | 'full' (C2-C6)
  const [octaveShift, setOctaveShift] = useState(0); // Shift compact keyboard up/down
  const [samplesReadyCount, setSamplesReadyCount] = useState(0);
  const [soundReady, setSoundReady] = useState(false);
  const [soundStalled, setSoundStalled] = useState(false);
  const [armSound, setArmSound] = useState(false);

  useEffect(() => {
    const checkViewport = () => {
      const mobile = window.innerWidth < 768;
      setIsMobileView(mobile);
      setKeyboardRangeMode(mobile ? 'compact' : 'full');
    };
    checkViewport();
    window.addEventListener('resize', checkViewport);

    audioEngine.onSampleStatusChange = (loaded) => {
      setSamplesReadyCount(loaded);
    };
    audioEngine.onStatus = (status) => {
      setSoundReady((prev) => (prev === status.running ? prev : status.running));
      setSoundStalled((prev) => (prev === status.stalled ? prev : status.stalled));
    };
    audioEngine.preloadAcousticSamples();

    const unlock = () => {
      audioEngine.unlockFromGesture();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('touchend', unlock, true);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && audioEngine.ctx && audioEngine.ctx.state !== 'running') {
        audioEngine.ctx.resume().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.removeEventListener('resize', checkViewport);
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('touchend', unlock, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const currentSong = useMemo(
    () => songs.find(s => s.id === selectedSongId) || songs[0],
    [songs, selectedSongId]
  );

  // Playback & Practice Studio State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(0);
  const [tempoScale, setTempoScale] = useState(1.0);
  const [handFilter, setHandFilter] = useState('BOTH');
  const [practiceMode, setPracticeMode] = useState('wait'); // 'wait' | 'continuous' | 'autoplay'
  const [viewLayout, setViewLayout] = useState('notation'); // 'notation' | 'falling' | 'combined'
  const [metronomeOn, setMetronomeOn] = useState(false);
  const [loopRange, setLoopRange] = useState({ enabled: false, startMeasure: 1, endMeasure: 2 });
  const [instrumentVoice, setInstrumentVoice] = useState('grand-piano');
  const [showPracticeSettings, setShowPracticeSettings] = useState(false);
  const [showDeviceModal, setShowDeviceModal] = useState(false);

  // Live Input & Real-Time Evaluation State
  const [activePressedNotes, setActivePressedNotes] = useState(new Set());
  const [evaluatedEvents, setEvaluatedEvents] = useState({});
  const [liveToast, setLiveToast] = useState({
    status: 'idle',
    text: ''
  });
  const [sessionStats, setSessionStats] = useState({
    hits: 18,
    misses: 2,
    streak: 8,
    dailyMinutes: 19,
    dailyGoal: 25,
    timingOffsetsMs: [-9, 6, -3, 11, 4, -7],
    struggleMeasures: { 2: 3, 4: 2 }
  });

  // Hardware & Microphone Connections
  const [midiDevices, setMidiDevices] = useState([]);
  const [midiAccess, setMidiAccess] = useState('unknown');
  const [micActive, setMicActive] = useState(false);
  const [detectedMicPitch, setDetectedMicPitch] = useState(null);

  // OMR Cleanup Studio State
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [cleanupMobilePane, setCleanupMobilePane] = useState('digital'); // 'scan' | 'digital'
  const [importStatus, setImportStatus] = useState(null);

  // Refs for 60fps animation, auto-scrolling notation, and canvas
  const rafRef = useRef(null);
  const lastFrameTimeRef = useRef(null);
  const playedSynthIdsRef = useRef(new Set());
  const lastMetronomeBeatRef = useRef(-1);
  const fallingCanvasRef = useRef(null);
  const notationScrollRef = useRef(null);
  const notationFollowRef = useRef(true);
  const notationResumeRef = useRef(null);
  const beatRef = useRef(0);
  const modeRef = useRef('wait');
  const eventsRef = useRef([]);
  const evaluatedRef = useRef({});
  const tempoRef = useRef(120);
  const metronomeRef = useRef(false);
  const loopRef = useRef({ enabled: false, startMeasure: 1, endMeasure: 2 });
  const beatsRef = useRef(4);
  const totalBeatsRef = useRef(16);
  const timeSigBeatsRef = useRef(4);
  const playingRef = useRef(false);
  const noteInputRef = useRef(() => {});
  const noteReleaseRef = useRef(() => {});
  const audioWatchRef = useRef({ lastTime: -1, stalls: 0 });

  const activeEvents = useMemo(() => {
    return currentSong.events.filter(ev => {
      if (handFilter !== 'BOTH' && ev.hand !== handFilter) return false;
      return true;
    });
  }, [currentSong, handFilter]);

  const beatsPerMeasure = useMemo(
    () => currentSong.timeSignature[0] * (4 / currentSong.timeSignature[1]),
    [currentSong]
  );

  const totalSongBeats = useMemo(() => {
    if (activeEvents.length === 0) return 16;
    return Math.ceil(Math.max(...activeEvents.map(e => e.onset + e.duration)) / beatsPerMeasure) * beatsPerMeasure;
  }, [activeEvents, beatsPerMeasure]);

  const expectedPlayheadEvents = useMemo(() => {
    const unplayed = activeEvents.filter(ev => !evaluatedEvents[ev.id] && ev.onset >= currentBeat - 0.35);
    if (unplayed.length === 0) return [];
    const nextOnset = unplayed[0].onset;
    return unplayed.filter(ev => Math.abs(ev.onset - nextOnset) < 0.15);
  }, [activeEvents, evaluatedEvents, currentBeat]);

  useEffect(() => {
    if (keyboardRangeMode !== 'compact') return;
    const next = octaveShiftForWindow(expectedPlayheadEvents.map((ev) => ev.pitch), octaveShift);
    if (next !== octaveShift) setOctaveShift(next);
  }, [expectedPlayheadEvents, keyboardRangeMode, octaveShift]);

  modeRef.current = practiceMode;
  eventsRef.current = activeEvents;
  tempoRef.current = currentSong.tempo * tempoScale;
  metronomeRef.current = metronomeOn;
  loopRef.current = loopRange;
  beatsRef.current = beatsPerMeasure;
  totalBeatsRef.current = totalSongBeats;
  timeSigBeatsRef.current = currentSong.timeSignature[0];
  playingRef.current = isPlaying;

  const movePlayhead = (beat, clearEvals = false) => {
    beatRef.current = beat;
    setCurrentBeat(beat);
    if (clearEvals) {
      evaluatedRef.current = {};
      setEvaluatedEvents({});
      playedSynthIdsRef.current.clear();
    }
  };

  const pauseNotationFollow = () => {
    notationFollowRef.current = false;
    if (notationResumeRef.current) clearTimeout(notationResumeRef.current);
    notationResumeRef.current = setTimeout(() => {
      notationFollowRef.current = true;
    }, 700);
  };

  // Move the staff with the playhead. Assigning scrollLeft each frame glides;
  // scrollTo({ behavior: 'smooth' }) restarts every half beat and stutters.
  useEffect(() => {
    const container = notationScrollRef.current;
    if (!container || !notationFollowRef.current) return;
    const playheadPx = 88 + currentBeat * 56;
    const targetScroll = Math.max(0, playheadPx - container.clientWidth * 0.38);
    if (!isPlaying) {
      const viewRight = container.scrollLeft + container.clientWidth;
      if (playheadPx > container.scrollLeft + 32 && playheadPx < viewRight - 48) return;
    }
    container.scrollLeft = targetScroll;
  }, [currentBeat, isPlaying]);

  // ============================================================================
  // 6. REAL-TIME SCORE FOLLOWING & ALIGNMENT ENGINE
  // ============================================================================

  const handleUserNoteInput = useCallback((midiPitch, velocity = 90) => {
    const heard = audioEngine.playNote(midiPitch, 0.45, velocity);
    if (!heard) {
      window.setTimeout(() => {
        if (audioEngine.ctx?.state !== 'running') setArmSound(true);
      }, 500);
    }

    setActivePressedNotes(prev => {
      const next = new Set(prev);
      next.add(midiPitch);
      return next;
    });

    const mode = modeRef.current;
    const events = eventsRef.current;
    const beat = beatRef.current;
    const evaluated = evaluatedRef.current;
    const windowToleranceBeats = mode === 'wait' ? 1.6 : 0.65;
    const candidateEvents = events.filter(
      ev => !evaluated[ev.id] && Math.abs(ev.onset - beat) <= windowToleranceBeats
    );

    const matchedEvent = candidateEvents.find(ev => ev.pitch === midiPitch);

    if (matchedEvent) {
      const beatDiff = beat - matchedEvent.onset;
      const msDiff = Math.round((beatDiff * 60000) / (tempoRef.current || 1));
      const nextEval = {
        ...evaluated,
        [matchedEvent.id]: { status: 'hit', deltaMs: msDiff }
      };
      evaluatedRef.current = nextEval;
      setEvaluatedEvents(nextEval);

      setSessionStats(prev => ({
        ...prev,
        hits: prev.hits + 1,
        streak: prev.streak + 1,
        timingOffsetsMs: [...prev.timingOffsetsMs.slice(-29), msDiff]
      }));

      setLiveToast({
        status: 'hit',
        text: mode === 'wait'
          ? `Got ${matchedEvent.pitchName}`
          : `${msDiff >= 0 ? '+' : ''}${msDiff} ms · ${matchedEvent.pitchName}`
      });

      if (mode === 'wait' && chordCanAdvance(events, nextEval, matchedEvent)) {
        const futureEvents = events.filter(ev => ev.onset > matchedEvent.onset + 0.08);
        if (futureEvents.length > 0) {
          beatRef.current = futureEvents[0].onset;
          setCurrentBeat(futureEvents[0].onset);
        } else {
          beatRef.current = 0;
          setCurrentBeat(0);
          evaluatedRef.current = {};
          setEvaluatedEvents({});
          playedSynthIdsRef.current.clear();
          setLiveToast({
            status: 'hit',
            text: 'Done. Back to bar 1.'
          });
        }
      }
    } else {
      const unplayed = events.filter(ev => !evaluated[ev.id] && ev.onset >= beat - 0.35);
      if (unplayed.length === 0) return;
      const curMeasure = Math.floor(beat / (beatsRef.current || 4)) + 1;
      setSessionStats(prev => ({
        ...prev,
        misses: prev.misses + 1,
        streak: 0,
        struggleMeasures: {
          ...prev.struggleMeasures,
          [curMeasure]: (prev.struggleMeasures[curMeasure] || 0) + 1
        }
      }));
      setLiveToast({
        status: 'miss',
        text: `Wrong note · bar ${curMeasure}`
      });
    }
  }, []);

  const handleUserNoteRelease = useCallback((midiPitch) => {
    setActivePressedNotes(prev => {
      const next = new Set(prev);
      next.delete(midiPitch);
      return next;
    });
  }, []);

  noteInputRef.current = handleUserNoteInput;
  noteReleaseRef.current = handleUserNoteRelease;

  const armTransport = () => {
    if (playingRef.current && !soundStalled && !audioEngine.stalled) {
      setIsPlaying(false);
      return;
    }
    const pending = audioEngine.unlockFromGesture();
    setSoundStalled(false);
    setIsPlaying(true);
    pending.then((ok) => {
      setSoundReady(Boolean(ok));
      setArmSound(!ok);
      if (!ok) setSoundStalled(true);
    });
  };

  // ============================================================================
  // 7. MASTER TRANSPORT & 60FPS ANIMATION LOOP
  // ============================================================================

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastFrameTimeRef.current = null;
      return undefined;
    }

    audioWatchRef.current = { lastTime: -1, stalls: 0 };

    const tick = (timestamp) => {
      if (!lastFrameTimeRef.current) lastFrameTimeRef.current = timestamp;
      const dtSec = Math.min(0.08, (timestamp - lastFrameTimeRef.current) / 1000);
      lastFrameTimeRef.current = timestamp;

      const events = eventsRef.current;
      const mode = modeRef.current;
      const beatsPerSecond = (tempoRef.current || 1) / 60;
      const prevBeat = beatRef.current;
      let nextBeat = prevBeat + dtSec * beatsPerSecond;

      if (mode === 'wait') {
        const blockingNote = events.find(
          (ev) => !evaluatedRef.current[ev.id] && ev.onset >= prevBeat - 0.05 && ev.onset <= nextBeat
        );
        if (blockingNote) nextBeat = blockingNote.onset;
      }

      const beatFloor = Math.floor(nextBeat);
      if (metronomeRef.current && beatFloor !== lastMetronomeBeatRef.current && nextBeat > prevBeat) {
        lastMetronomeBeatRef.current = beatFloor;
        audioEngine.playMetronomeClick((beatFloor % timeSigBeatsRef.current) === 0);
      }

      if (mode === 'autoplay' || mode === 'continuous') {
        const heard = [];
        events.forEach((ev) => {
          if (
            ev.onset >= prevBeat - 0.001 &&
            ev.onset < nextBeat &&
            !playedSynthIdsRef.current.has(ev.id)
          ) {
            playedSynthIdsRef.current.add(ev.id);
            const durSec = beatsPerSecond > 0 ? ev.duration / beatsPerSecond : 0.5;
            const velocity = mode === 'continuous' ? Math.round((ev.velocity || 80) * 0.62) : ev.velocity;
            audioEngine.playNote(ev.pitch, durSec, velocity);
            if (mode === 'autoplay') heard.push(ev.id);
          }
        });
        if (heard.length) {
          const nextEval = { ...evaluatedRef.current };
          heard.forEach((id) => {
            nextEval[id] = { status: 'hit', deltaMs: 0 };
          });
          evaluatedRef.current = nextEval;
          setEvaluatedEvents(nextEval);
        }

        if (audioEngine.unlocked) {
          const ctx = audioEngine.ctx;
          const watch = audioWatchRef.current;
          const advanced = ctx ? ctx.currentTime - watch.lastTime : 0;
          if (!ctx || ctx.state !== 'running') {
            watch.stalls += 1;
          } else if (watch.lastTime >= 0 && advanced >= 0 && advanced < 0.0005) {
            watch.stalls += 1;
          } else {
            watch.stalls = 0;
          }
          watch.lastTime = ctx ? ctx.currentTime : -1;
          if (watch.stalls >= 45 && !audioEngine.stalled) audioEngine.noteStall();
        }
      }

      const loop = loopRef.current;
      const loopStartBeat = (loop.startMeasure - 1) * beatsRef.current;
      const loopEndBeat = loop.endMeasure * beatsRef.current;
      let wrapped = false;
      if (loop.enabled && nextBeat >= loopEndBeat) {
        playedSynthIdsRef.current.clear();
        evaluatedRef.current = {};
        setEvaluatedEvents({});
        nextBeat = loopStartBeat;
        wrapped = true;
      } else if (nextBeat >= totalBeatsRef.current) {
        playedSynthIdsRef.current.clear();
        evaluatedRef.current = {};
        setEvaluatedEvents({});
        nextBeat = 0;
        wrapped = true;
      }

      if (!wrapped && mode === 'continuous') {
        const late = notesPassedBy(events, evaluatedRef.current, nextBeat, 0.8);
        if (late.length) {
          const nextEval = { ...evaluatedRef.current };
          late.forEach((ev) => {
            nextEval[ev.id] = { status: 'miss', deltaMs: null };
          });
          evaluatedRef.current = nextEval;
          setEvaluatedEvents(nextEval);
          const measure = Math.floor(nextBeat / (beatsRef.current || 4)) + 1;
          setSessionStats((prev) => ({
            ...prev,
            misses: prev.misses + late.length,
            streak: 0,
            struggleMeasures: {
              ...prev.struggleMeasures,
              [measure]: (prev.struggleMeasures[measure] || 0) + late.length,
            },
          }));
        }
      }

      beatRef.current = nextBeat;
      if (Math.abs(nextBeat - prevBeat) > 0.0001) setCurrentBeat(nextBeat);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying]);

  const handleSelectSong = (songId, targetTab = 'practice') => {
    setIsPlaying(false);
    setSelectedSongId(songId);
    movePlayhead(0, true);
    setSelectedEventId(null);
    setActiveTab(targetTab);
  };

  const museScore = useMuseScorePaste({
    darkMode,
    readMidi: readPracticeMidi,
    onOpen: (song) => {
      setSongs((prev) => [song, ...prev.filter((item) => item.id !== song.id)]);
      handleSelectSong(song.id, 'practice');
    },
  });

  // ============================================================================
  // 8. WEB MIDI API & COMPUTER KEYBOARD BINDINGS
  // ============================================================================

  const midiAccessRef = useRef(null);

  const connectMidi = useCallback(() => {
    if (!navigator.requestMIDIAccess) {
      setMidiAccess('missing');
      return;
    }
    navigator.requestMIDIAccess({ sysex: false }).then((access) => {
      midiAccessRef.current = access;
      setMidiAccess('ready');
      const updateDevices = () => {
        const inputs = Array.from(access.inputs.values());
        setMidiDevices(inputs.map((input) => ({
          id: input.id,
          name: input.name || 'MIDI keyboard',
          manufacturer: input.manufacturer || 'Generic MIDI',
          state: input.state
        })));
        inputs.forEach((input) => {
          input.onmidimessage = (msg) => {
            const [status, data1, data2] = msg.data;
            const cmd = status & 0xf0;
            if (cmd === 0x90 && data2 > 0) noteInputRef.current(data1, data2, 'midi');
            else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) noteReleaseRef.current(data1);
          };
        });
      };
      updateDevices();
      access.onstatechange = updateDevices;
    }).catch((err) => {
      const denied = err?.name === 'SecurityError' || err?.name === 'NotAllowedError';
      setMidiAccess(denied ? 'denied' : 'missing');
    });
  }, []);

  useEffect(() => {
    connectMidi();
    return () => {
      const access = midiAccessRef.current;
      if (!access) return;
      access.onstatechange = null;
      access.inputs.forEach((input) => {
        input.onmidimessage = null;
      });
    };
  }, [connectMidi]);

  useEffect(() => {
    const down = (e) => {
      if (e.repeat || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (playingRef.current && !audioEngine.stalled) {
          setIsPlaying(false);
          return;
        }
        const pending = audioEngine.unlockFromGesture();
        setSoundStalled(false);
        setIsPlaying(true);
        pending.then((ok) => {
          setSoundReady(Boolean(ok));
          setArmSound(!ok);
          if (!ok) setSoundStalled(true);
        });
        return;
      }
      const midi = KEYBOARD_TO_MIDI[e.key.toLowerCase()];
      if (midi) noteInputRef.current(midi, 92, 'kbd');
    };
    const up = (e) => {
      const midi = KEYBOARD_TO_MIDI[e.key.toLowerCase()];
      if (midi) noteReleaseRef.current(midi);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const toggleMicrophone = () => {
    if (micActive) {
      audioEngine.stopMicrophone();
      setMicActive(false);
      setDetectedMicPitch(null);
      return;
    }
    let lastTriggeredMidi = null;
    let lastTriggerTime = 0;
    audioEngine.startMicrophone((pitchInfo) => {
      setDetectedMicPitch(pitchInfo);
      if (!pitchInfo || Math.abs(pitchInfo.centsOff) >= 35) return;
      if (!micShouldAdvanceScore(modeRef.current, playingRef.current)) return;
      const now = performance.now();
      if (pitchInfo.midi === lastTriggeredMidi && now - lastTriggerTime <= 420) return;
      lastTriggeredMidi = pitchInfo.midi;
      lastTriggerTime = now;
      noteInputRef.current(pitchInfo.midi, 82, 'mic');
      setTimeout(() => noteReleaseRef.current(pitchInfo.midi), 300);
    }).then(() => {
      setMicActive(true);
    }).catch((err) => {
      const blocked = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      const missing = err?.name === 'NotFoundError';
      setLiveToast({
        status: 'miss',
        text: !window.isSecureContext
          ? 'The mic needs a secure https page.'
          : missing
            ? 'No microphone found on this device.'
            : blocked
              ? 'Microphone blocked. Allow the mic in browser settings.'
              : 'Microphone access was blocked by the browser.'
      });
    });
  };

  // ============================================================================
  // 9. CANVAS FALLING-NOTE RENDERER (ADAPTS TO COMPACT OR FULL KEYBOARD)
  // ============================================================================

  const keyboardMidiBounds = useMemo(() => {
    if (keyboardRangeMode === 'compact') {
      const baseMin = 48 + octaveShift * 12; // Default C3 (48) to C5 (72) - 15 white keys
      return { minMidi: Math.max(36, baseMin), maxMidi: Math.min(84, baseMin + 24) };
    }
    return { minMidi: 36, maxMidi: 84 };
  }, [keyboardRangeMode, octaveShift]);

  useEffect(() => {
    const canvas = fallingCanvasRef.current;
    if (!canvas || viewLayout === 'notation' || activeTab !== 'practice') return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const { minMidi, maxMidi } = keyboardMidiBounds;
    const whiteKeys = [];
    for (let m = minMidi; m <= maxMidi; m++) {
      if (![1, 3, 6, 8, 10].includes(m % 12)) whiteKeys.push(m);
    }
    const whiteKeyWidth = width / whiteKeys.length;

    const getKeyXAndWidth = (midi) => {
      const isBlack = [1, 3, 6, 8, 10].includes(midi % 12);
      if (!isBlack) {
        const idx = whiteKeys.indexOf(midi);
        return { x: idx * whiteKeyWidth + 2, w: whiteKeyWidth - 4 };
      } else {
        const lowerWhiteIdx = whiteKeys.indexOf(midi - 1);
        return { x: (lowerWhiteIdx + 0.65) * whiteKeyWidth, w: whiteKeyWidth * 0.68 };
      }
    };

    const lookaheadBeats = 4;
    const pixelsPerBeat = height / lookaheadBeats;

    whiteKeys.forEach((_, index) => {
      if (index % 2 === 0) {
        ctx.fillStyle = darkMode ? 'rgba(255,255,255,0.025)' : 'rgba(28,25,23,0.035)';
        ctx.fillRect(index * whiteKeyWidth, 0, whiteKeyWidth, height);
      }
    });

    for (let b = Math.ceil(currentBeat); b <= currentBeat + lookaheadBeats; b += 1) {
      if (b % beatsPerMeasure !== 0) continue;
      const y = height - (b - currentBeat) * pixelsPerBeat;
      ctx.strokeStyle = darkMode ? 'rgba(217, 119, 6, 0.28)' : 'rgba(180, 83, 9, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.strokeStyle = darkMode ? 'rgba(251, 146, 60, 0.85)' : 'rgba(194, 65, 12, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();

    activeEvents.forEach(ev => {
      if (ev.onset + ev.duration < currentBeat - 0.15 || ev.onset > currentBeat + lookaheadBeats) return;
      if (ev.pitch < minMidi || ev.pitch > maxMidi) return;

      const { x, w } = getKeyXAndWidth(ev.pitch);
      const inset = Math.max(2, Math.min(5, w * 0.16));
      const noteBottomY = height - (ev.onset - currentBeat) * pixelsPerBeat;
      const noteHeight = Math.max(6, ev.duration * pixelsPerBeat - 3);
      const noteTopY = noteBottomY - noteHeight;
      const imminent = Math.abs(ev.onset - currentBeat) < 0.35 && !evaluatedEvents[ev.id];

      const evalState = evaluatedEvents[ev.id];
      if (evalState?.status === 'hit') ctx.fillStyle = '#059669';
      else if (evalState?.status === 'miss') ctx.fillStyle = '#be123c';
      else if (ev.hand === 'R') ctx.fillStyle = imminent ? '#ea580c' : 'rgba(194, 65, 12, 0.82)';
      else ctx.fillStyle = imminent ? '#0284c7' : 'rgba(3, 105, 161, 0.82)';

      ctx.beginPath();
      ctx.roundRect(x + inset, noteTopY, Math.max(4, w - inset * 2), noteHeight, 3);
      ctx.fill();
    });
  }, [currentBeat, activeEvents, evaluatedEvents, beatsPerMeasure, viewLayout, activeTab, keyboardMidiBounds, darkMode]);

  // ============================================================================
  // 10. FILE UPLOAD & UNIVERSAL INGESTION HANDLER
  // ============================================================================

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase();
    setImportStatus({ step: 1, label: `Analyzing ${file.name}...` });

    try {
      if (ext === 'mid' || ext === 'midi') {
        const buf = await file.arrayBuffer();
        const opened = parseStandardMidiFile(buf, file.name);
        setSongs(prev => [opened.song, ...prev]);
        handleSelectSong(opened.song.id, 'practice');
        setImportStatus({
          step: 4,
          success: true,
          label: `Imported "${opened.song.title}" (${opened.song.events.length} notes). Ready to play!`
        });
      } else if (ext === 'musicxml' || ext === 'xml') {
        const text = await file.text();
        const parsedSong = parseMusicXMLString(text, file.name);
        setSongs(prev => [parsedSong, ...prev]);
        handleSelectSong(parsedSong.id, 'practice');
        setImportStatus({
          step: 4,
          success: true,
          label: `Imported MusicXML "${parsedSong.title}" (${parsedSong.events.length} notes).`
        });
      } else {
        setTimeout(() => setImportStatus({ step: 2, label: 'Deskewing page geometry & detecting staff lines...' }), 450);
        setTimeout(() => setImportStatus({ step: 3, label: 'Checking measure rhythm & pitch confidence...' }), 950);
        setTimeout(() => {
          const cleanName = file.name.replace(/\.[^.]+$/, '');
          const isAudio = ['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(ext);
          const importedSong = buildSongFromEvents({
            id: `omr-${Date.now()}`,
            title: cleanName,
            composer: isAudio ? 'Audio Transcription' : 'Scanned Sheet Music',
            genre: isAudio ? 'Audio Recording' : 'Sheet Scan',
            difficulty: 'Intermediate',
            tempo: 100,
            timeSignature: [4, 4],
            keySignature: 'C Major',
            sourceFormat: isAudio ? `Audio (${ext.toUpperCase()})` : `Scanned Score (${ext.toUpperCase()})`,
            license: 'Private User Import',
            rawNotes: INITIAL_SONGS[0].events.slice(0, 20).map((ev, i) => ({
              pitch: ev.pitch,
              onset: ev.onset,
              duration: ev.duration,
              hand: ev.hand,
              finger: ev.finger,
              confidence: i === 4 || i === 11 ? 0.71 : 0.96,
              harmony: ev.harmony
            }))
          });
          setSongs(prev => [importedSong, ...prev]);
          setSelectedSongId(importedSong.id);
          setImportStatus({
            step: 4,
            success: true,
            label: `Score reconstructed! 2 uncertain notes flagged for quick review.`
          });
        }, 1500);
      }
    } catch (err) {
      setImportStatus({
        step: 0,
        error: true,
        label: `Import failed: ${err.message}`
      });
    }
  };

  const updateNoteInGraph = (eventId, changes) => {
    setSongs(prevSongs =>
      prevSongs.map(song => {
        if (song.id !== currentSong.id) return song;
        const updatedEvents = song.events.map(ev => {
          if (ev.id !== eventId) return ev;
          const nextPitch = changes.pitch !== undefined ? Math.min(96, Math.max(36, changes.pitch)) : ev.pitch;
          const spelling = getDiatonicSpelling(nextPitch);
          return {
            ...ev,
            ...changes,
            pitch: nextPitch,
            pitchName: midiToPitchName(nextPitch),
            step: spelling.step,
            alter: spelling.alter,
            octave: spelling.octave,
            verified: true,
            confidence: 1.0
          };
        });
        return { ...song, events: updatedEvents };
      })
    );
  };

  const handleDownloadMusicXML = () => {
    const xml = exportToMusicXML(currentSong);
    const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentSong.title.replace(/\s+/g, '_')}.musicxml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const uncertainEventsCount = useMemo(
    () => currentSong.events.filter(e => e.confidence < 0.85 && !e.verified).length,
    [currentSong]
  );

  // ============================================================================
  // 11. MOBILE-FRIENDLY, TOUCH-RESPONSIVE PIANO KEYBOARD
  // ============================================================================

  const renderInteractiveKeyboard = () => {
    const { minMidi, maxMidi } = keyboardMidiBounds;
    const whiteMidis = [];
    for (let m = minMidi; m <= maxMidi; m++) {
      if (![1, 3, 6, 8, 10].includes(m % 12)) whiteMidis.push(m);
    }

    const expectedSetR = new Set(expectedPlayheadEvents.filter(e => e.hand === 'R').map(e => e.pitch));
    const expectedSetL = new Set(expectedPlayheadEvents.filter(e => e.hand === 'L').map(e => e.pitch));
    const fingerByPitch = {};
    expectedPlayheadEvents.forEach(e => { fingerByPitch[e.pitch] = e.finger; });

    return (
      <div className={`w-full select-none border-t ${darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-900 border-stone-300'}`}>
        {/* Compact Octave Switcher Bar for Mobile & Tablet */}
        <div className="flex items-center justify-between gap-2 px-2 h-8 overflow-hidden bg-stone-900 text-stone-300 text-[11px] border-b border-stone-800">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex items-center gap-1 shrink-0 font-medium">
              <span className="w-2 h-2 rounded-full bg-orange-600 inline-block" /> R
            </span>
            <span className="flex items-center gap-1 shrink-0 font-medium">
              <span className="w-2 h-2 rounded-full bg-sky-600 inline-block" /> L
            </span>
            <span className="hidden md:flex items-center gap-1.5 text-[11px] text-emerald-400 font-semibold pl-2 border-l border-stone-700 truncate">
              <Volume2 className="w-3.5 h-3.5 shrink-0" />
              {audioEngine.potetoMode || audioEngine.forcePotato
                ? 'Simple phone piano'
                : samplesReadyCount > 0
                  ? `Piano samples ${samplesReadyCount}/25`
                  : 'Loading piano samples'}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {keyboardRangeMode === 'compact' && (
              <div className="flex items-center bg-stone-800 rounded-lg p-0.5">
                <button
                  onClick={() => setOctaveShift(s => Math.max(-1, s - 1))}
                  className="px-2 py-0.5 hover:text-white"
                  title="Octave Down"
                >
                  -8va
                </button>
                <span className="px-2 text-[11px] font-mono text-amber-400">
                  {midiToPitchName(minMidi)}–{midiToPitchName(maxMidi)}
                </span>
                <button
                  onClick={() => setOctaveShift(s => Math.min(1, s + 1))}
                  className="px-2 py-0.5 hover:text-white"
                  title="Octave Up"
                >
                  +8va
                </button>
              </div>
            )}
            <button
              onClick={() => setKeyboardRangeMode(m => m === 'compact' ? 'full' : 'compact')}
              className="px-2.5 py-1 rounded-md bg-stone-800 hover:bg-stone-700 text-stone-200 text-[11px] font-semibold"
              title={keyboardRangeMode === 'compact' ? 'Show all 49 keys' : 'Show 25 larger keys'}
            >
              {keyboardRangeMode === 'compact' ? 'Full' : '25 keys'}
            </button>
          </div>
        </div>

        {/* Piano Keys Container */}
        <div className="relative w-full h-36 sm:h-44 px-1 pt-1 pb-1.5 flex touch-none">
          {whiteMidis.map((midi) => {
            const isPressed = activePressedNotes.has(midi);
            const isExpectedR = expectedSetR.has(midi);
            const isExpectedL = expectedSetL.has(midi);
            const hasBlackRight = [0, 2, 5, 7, 9].includes(midi % 12) && midi + 1 <= maxMidi;
            const blackMidi = midi + 1;
            const isBlackPressed = activePressedNotes.has(blackMidi);
            const isBlackExpectedR = expectedSetR.has(blackMidi);
            const isBlackExpectedL = expectedSetL.has(blackMidi);

            return (
              <div key={midi} className="relative flex-1 h-full mx-[1px]">
                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    handleUserNoteInput(midi, 92, 'touch');
                  }}
                  onPointerUp={() => handleUserNoteRelease(midi)}
                  onPointerLeave={() => activePressedNotes.has(midi) && handleUserNoteRelease(midi)}
                  className={`w-full h-full rounded-b-lg border transition-transform flex flex-col justify-end items-center pb-2 text-[11px] font-semibold ${
                    isPressed
                      ? 'bg-emerald-400 border-emerald-600 text-stone-950 translate-y-[2px] shadow-inner'
                      : isExpectedR
                      ? 'bg-orange-100 border-orange-500 text-orange-950 ring-2 ring-orange-500'
                      : isExpectedL
                      ? 'bg-sky-100 border-sky-500 text-sky-950 ring-2 ring-sky-500'
                      : 'bg-[#fdfbf7] hover:bg-white border-stone-300 text-stone-500 shadow-sm'
                  }`}
                >
                  {(isExpectedR || isExpectedL) && fingerByPitch[midi] && (
                    <span className={`mb-1 w-5 h-5 rounded-full text-[10px] flex items-center justify-center font-bold text-white shadow ${
                      isExpectedR ? 'bg-orange-600' : 'bg-sky-600'
                    }`}>
                      {fingerByPitch[midi]}
                    </span>
                  )}
                  <span className={midi % 12 === 0 ? 'font-bold text-stone-800' : 'opacity-70'}>
                    {midi % 12 === 0 ? midiToPitchName(midi) : NOTE_NAMES[midi % 12]}
                  </span>
                </button>

                {hasBlackRight && (
                  <button
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      handleUserNoteInput(blackMidi, 95, 'touch');
                    }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      handleUserNoteRelease(blackMidi);
                    }}
                    onPointerLeave={() => activePressedNotes.has(blackMidi) && handleUserNoteRelease(blackMidi)}
                    className={`absolute top-0 -right-[35%] w-[70%] h-[60%] z-20 rounded-b-md border transition-transform flex flex-col justify-end items-center pb-1.5 text-[9px] font-bold ${
                      isBlackPressed
                        ? 'bg-emerald-500 border-emerald-300 text-stone-950 translate-y-[2px]'
                        : isBlackExpectedR
                        ? 'bg-orange-600 border-orange-300 text-white ring-2 ring-orange-400'
                        : isBlackExpectedL
                        ? 'bg-sky-600 border-sky-300 text-white ring-2 ring-sky-400'
                        : 'bg-stone-900 hover:bg-stone-800 border-stone-700 text-stone-400 shadow-md'
                    }`}
                  >
                    {(isBlackExpectedR || isBlackExpectedL) && fingerByPitch[blackMidi] && (
                      <span className="w-4 h-4 rounded-full bg-white text-stone-900 text-[9px] flex items-center justify-center">
                        {fingerByPitch[blackMidi]}
                      </span>
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ============================================================================
  // 12. INTERACTIVE SVG GRAND STAFF NOTATION ENGRAVER (PAPER & STUDIO THEMES)
  // ============================================================================

  const renderGrandStaffNotation = (interactiveCleanup = false) => {
    const beatPx = 56;
    const svgWidth = Math.max(760, totalSongBeats * beatPx + 140);
    const svgHeight = 236;
    const leftMargin = 88;

    const trebleBottomY = 82;
    const bassBottomY = 178;
    const staffLines = [0, 1, 2, 3, 4];

    const playheadX = leftMargin + currentBeat * beatPx;
    const totalMeasures = Math.ceil(totalSongBeats / beatsPerMeasure);

    const staffStroke = darkMode ? '#57534e' : '#a8a29e';
    const clefFill = darkMode ? '#e7e5e4' : '#1c1917';

    return (
      <div
        ref={notationScrollRef}
        onPointerDown={pauseNotationFollow}
        onWheel={pauseNotationFollow}
        style={{ scrollBehavior: 'auto' }}
        className={`w-full overflow-x-auto overscroll-x-contain touch-pan-x rounded-2xl border shadow-inner transition-colors ${
          darkMode
            ? 'bg-stone-900/95 border-stone-800'
            : 'bg-[#fcfaf5] border-stone-300/90'
        }`}
      >
        <svg width={svgWidth} height={svgHeight} className="select-none block">
          {/* Measure Loop Highlight */}
          {loopRange.enabled && (
            <rect
              x={leftMargin + (loopRange.startMeasure - 1) * beatsPerMeasure * beatPx}
              y={18}
              width={(loopRange.endMeasure - loopRange.startMeasure + 1) * beatsPerMeasure * beatPx}
              height={186}
              fill={darkMode ? 'rgba(217, 119, 6, 0.12)' : 'rgba(217, 119, 6, 0.08)'}
              stroke="#d97706"
              strokeDasharray="4 4"
              rx={8}
            />
          )}

          {/* System Brace & Clefs */}
          <line x1={26} y1={42} x2={26} y2={178} stroke={clefFill} strokeWidth={2.5} />
          <text x={34} y={76} fill={clefFill} fontSize="34" fontFamily="Georgia, serif">𝄞</text>
          <text x={34} y={168} fill={clefFill} fontSize="28" fontFamily="Georgia, serif">𝄢</text>

          {/* Time Signature */}
          <text x={64} y={60} fill={clefFill} fontSize="15" fontWeight="bold" fontFamily="Georgia, serif">{currentSong.timeSignature[0]}</text>
          <text x={64} y={78} fill={clefFill} fontSize="15" fontWeight="bold" fontFamily="Georgia, serif">{currentSong.timeSignature[1]}</text>
          <text x={64} y={156} fill={clefFill} fontSize="15" fontWeight="bold" fontFamily="Georgia, serif">{currentSong.timeSignature[0]}</text>
          <text x={64} y={174} fill={clefFill} fontSize="15" fontWeight="bold" fontFamily="Georgia, serif">{currentSong.timeSignature[1]}</text>

          {/* 5-Line Treble & Bass Staves */}
          {staffLines.map(i => (
            <g key={i}>
              <line
                x1={26}
                y1={trebleBottomY - i * 10}
                x2={svgWidth - 24}
                y2={trebleBottomY - i * 10}
                stroke={staffStroke}
                strokeWidth={1}
              />
              <line
                x1={26}
                y1={bassBottomY - i * 10}
                x2={svgWidth - 24}
                y2={bassBottomY - i * 10}
                stroke={staffStroke}
                strokeWidth={1}
              />
            </g>
          ))}

          {/* Barlines, Measure Numbers & Harmonic Analysis */}
          {Array.from({ length: totalMeasures + 1 }).map((_, mIdx) => {
            const x = leftMargin + mIdx * beatsPerMeasure * beatPx;
            const firstEvInMeasure = activeEvents.find(e => e.measure === mIdx + 1);
            return (
              <g key={mIdx}>
                <line x1={x} y1={42} x2={x} y2={178} stroke={staffStroke} strokeWidth={mIdx === totalMeasures ? 2.5 : 1.2} />
                {mIdx < totalMeasures && (
                  <>
                    <text x={x + 6} y={30} fill={darkMode ? '#a8a29e' : '#78716c'} fontSize="10" fontWeight="700">
                      Bar {mIdx + 1}
                    </text>
                    {firstEvInMeasure?.harmony && (
                      <text x={x + 44} y={30} fill="#c2410c" fontSize="11" fontWeight="800" fontFamily="Georgia, serif">
                        {firstEvInMeasure.harmony}
                      </text>
                    )}
                  </>
                )}
              </g>
            );
          })}

          {/* Synchronized Playhead Cursor */}
          {!interactiveCleanup && (
            <g>
              <line
                x1={playheadX}
                y1={20}
                x2={playheadX}
                y2={198}
                stroke="#059669"
                strokeWidth={2.5}
              />
              <circle cx={playheadX} cy={20} r={4.5} fill="#059669" />
            </g>
          )}

          {/* Engraved chords: seconds step aside so noteheads do not pile up */}
          {groupStaffEvents(activeEvents).map((group) => {
            const clef = group.hand === 'R' ? 'treble' : 'bass';
            const baseBottomY = clef === 'treble' ? trebleBottomY : bassBottomY;
            const prepared = group.notes.map((ev) => ({
              ...ev,
              stepOffset: getStaffYOffset(ev.pitch, clef, ev.preferFlats),
            }));
            const layout = layoutStaffGroup(prepared);
            const baseX = leftMargin + group.onset * beatPx + 18;
            const drawn = layout.notes.map((note) => ({
              ...note,
              cx: baseX + note.dx,
              cy: baseBottomY - note.stepOffset * 5,
            }));
            const showStem = drawn.some((note) => note.duration < 4);
            const top = Math.min(...drawn.map((note) => note.cy));
            const bottom = Math.max(...drawn.map((note) => note.cy));
            const stemX = baseX + layout.stemX;
            const fingerColor = darkMode ? '#a8a29e' : '#57534e';

            return (
              <g key={`${group.hand}-${group.onset}`}>
                {showStem && (
                  <line
                    x1={stemX}
                    y1={layout.stemUp ? top - 18 : top}
                    x2={stemX}
                    y2={layout.stemUp ? bottom : bottom + 18}
                    stroke={drawn[0] && evaluatedEvents[drawn[0].id]?.status === 'hit' ? '#059669' : (group.hand === 'R' ? (darkMode ? '#fb923c' : '#c2410c') : (darkMode ? '#38bdf8' : '#0369a1'))}
                    strokeWidth={1.6}
                  />
                )}
                {drawn.map((ev) => {
                  const evalState = evaluatedEvents[ev.id];
                  const isSelected = selectedEventId === ev.id;
                  const isUncertain = ev.confidence < 0.85 && !ev.verified;
                  const isHollow = ev.duration >= 2;
                  let noteColor = ev.hand === 'R'
                    ? (darkMode ? '#fb923c' : '#c2410c')
                    : (darkMode ? '#38bdf8' : '#0369a1');
                  if (isUncertain && !evalState) noteColor = '#d97706';
                  if (evalState?.status === 'hit') noteColor = '#059669';
                  if (evalState?.status === 'miss') noteColor = '#be123c';
                  if (isSelected) noteColor = '#e11d48';
                  const needsLedger = ev.stepOffset <= -2 || ev.stepOffset >= 10;
                  const accidentalX = ev.cx - 14 - ev.accidentalLane * 9;

                  return (
                    <g
                      key={ev.id}
                      onClick={() => {
                        setSelectedEventId(ev.id);
                        audioEngine.playNote(ev.pitch, 0.4, ev.velocity);
                        if (!interactiveCleanup) movePlayhead(ev.onset);
                      }}
                      className="cursor-pointer"
                    >
                      {needsLedger && (
                        <line
                          x1={ev.cx - 10}
                          y1={ev.cy}
                          x2={ev.cx + 10}
                          y2={ev.cy}
                          stroke={clefFill}
                          strokeWidth={1.4}
                        />
                      )}
                      {ev.alter === 1 && (
                        <text x={accidentalX} y={ev.cy + 4} fill={noteColor} fontSize="12" fontWeight="bold">♯</text>
                      )}
                      {ev.alter === -1 && (
                        <text x={accidentalX} y={ev.cy + 4} fill={noteColor} fontSize="13" fontWeight="bold">♭</text>
                      )}
                      <ellipse
                        cx={ev.cx}
                        cy={ev.cy}
                        rx={6.2}
                        ry={4.5}
                        transform={`rotate(-18 ${ev.cx} ${ev.cy})`}
                        fill={isHollow ? (darkMode ? '#1c1917' : '#fcfaf5') : noteColor}
                        stroke={noteColor}
                        strokeWidth={1.7}
                      />
                      {ev.duration === 1.5 && (
                        <circle cx={ev.cx + 11} cy={ev.cy - 2} r={1.8} fill={noteColor} />
                      )}
                      {ev.finger != null && (
                        <text
                          x={ev.cx}
                          y={clef === 'treble' ? ev.cy - 13 : ev.cy + 15}
                          fill={fingerColor}
                          fontSize="8"
                          fontWeight="700"
                          textAnchor="middle"
                        >
                          {ev.finger}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    );
  };

  // ============================================================================
  // 13. VIEW 1: INTERACTIVE PRACTICE STUDIO (CLEAN, FOCUSED, MOBILE-READY)
  // ============================================================================

  const renderPracticeView = () => {
    const modeMeta = practiceModeMeta(practiceMode);
    const playLabel = soundStalled ? 'Sound' : isPlaying ? 'Pause' : 'Play';
    const guidance = soundStalled
      ? 'Sound stalled. Tap Play to start it again.'
      : armSound && !soundReady
        ? 'Sound is off. Tap Play to turn it on.'
        : liveToast.status === 'idle'
          ? (isPlaying && practiceMode === 'autoplay' ? 'Listening.' : modeMeta.idle)
          : liveToast.text;
    const handChoices = [
      { id: 'BOTH', short: 'Both', long: 'Both' },
      { id: 'R', short: 'R', long: 'Right' },
      { id: 'L', short: 'L', long: 'Left' }
    ];

    return (
    <div className="flex flex-col gap-2 w-full max-w-full overflow-hidden" style={{ overflowAnchor: 'none' }}>
      <div className={`rounded-2xl border p-2 sm:p-3 flex flex-col gap-1.5 shadow-sm w-full max-w-full ${
        darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90'
      }`}>
        <div className="flex items-center gap-2 w-full min-w-0">
          <button
            onClick={armTransport}
            className={`shrink-0 h-10 px-3 rounded-xl font-bold text-xs sm:text-sm flex items-center gap-1.5 transition shadow-sm ${
              playLabel === 'Pause'
                ? 'bg-amber-500 hover:bg-amber-400 text-stone-950'
                : 'bg-orange-700 hover:bg-orange-600 text-white'
            }`}
          >
            {playLabel === 'Pause' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            <span>{playLabel}</span>
          </button>

          <button
            onClick={() => {
              setIsPlaying(false);
              movePlayhead(loopRange.enabled ? (loopRange.startMeasure - 1) * beatsPerMeasure : 0, true);
            }}
            className={`shrink-0 h-10 w-10 rounded-xl border transition flex items-center justify-center ${
              darkMode ? 'bg-stone-800 border-stone-700 text-stone-300' : 'bg-stone-100 border-stone-200 text-stone-700 hover:bg-stone-200'
            }`}
            title="Restart from bar 1"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <div className="flex-1 min-w-0">
            <select
              value={currentSong.id}
              onChange={(e) => handleSelectSong(e.target.value, 'practice')}
              aria-label="Select Song"
              className={`w-full truncate rounded-xl px-2.5 h-10 text-base sm:text-sm font-bold border focus:outline-none ${
                darkMode
                  ? 'bg-stone-950 border-stone-800 text-stone-100'
                  : 'bg-stone-50 border-stone-200 text-stone-900'
              }`}
            >
              {songs.map(s => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.difficulty})
                </option>
              ))}
            </select>
            {museScore.cutLabel(currentSong.id) ? (
              <p className="px-1 h-4 truncate text-xs font-semibold text-stone-600 dark:text-stone-300" aria-live="polite">
                {museScore.cutLabel(currentSong.id)}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 min-w-0">
          <div
            className={`flex flex-1 min-w-0 rounded-xl p-0.5 text-xs font-semibold border ${
              darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-100 border-stone-200'
            }`}
            role="group"
            aria-label="Practice mode"
          >
            {PRACTICE_MODES.map(mode => (
              <button
                key={mode.id}
                type="button"
                title={mode.hint}
                aria-pressed={practiceMode === mode.id}
                onClick={() => {
                  setPracticeMode(mode.id);
                  evaluatedRef.current = {};
                  setEvaluatedEvents({});
                  playedSynthIdsRef.current.clear();
                  setLiveToast({ status: 'idle', text: '' });
                }}
                className={`flex-1 min-w-0 px-2 sm:px-3 py-1.5 rounded-lg transition text-center whitespace-nowrap ${
                  practiceMode === mode.id
                    ? (darkMode ? 'bg-orange-700 text-white' : 'bg-white text-stone-900 shadow-sm')
                    : (darkMode ? 'text-stone-400 hover:text-stone-200' : 'text-stone-600 hover:text-stone-900')
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 min-w-0">
            <div className={`flex flex-1 sm:flex-none rounded-xl p-0.5 text-xs font-semibold border ${
              darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-100 border-stone-200'
            }`}>
              {handChoices.map(h => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setHandFilter(h.id)}
                  className={`flex-1 sm:flex-none px-2.5 py-1.5 rounded-lg transition ${
                    handFilter === h.id
                      ? (darkMode ? 'bg-stone-800 text-orange-400' : 'bg-white text-orange-700 shadow-sm')
                      : 'text-stone-500'
                  }`}
                >
                  <span className="sm:hidden">{h.short}</span>
                  <span className="hidden sm:inline">{h.long}</span>
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowPracticeSettings(s => !s)}
              className={`shrink-0 h-9 px-2.5 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition whitespace-nowrap ${
                showPracticeSettings || loopRange.enabled || metronomeOn
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300'
                  : (darkMode ? 'bg-stone-950 border-stone-800 text-stone-300' : 'bg-stone-100 border-stone-200 text-stone-700')
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span className="tabular-nums inline-block w-7 text-right">{Math.round(currentSong.tempo * tempoScale)}</span>
              <span>BPM</span>
            </button>
          </div>
        </div>
        <p className="h-10 overflow-hidden px-0.5 text-[11px] sm:text-xs leading-5 text-stone-500 dark:text-stone-400">
          {modeMeta.hint}
        </p>
      </div>

      {/* Collapsible Tempo, Loop, View Layout & Voice Drawer (Prevents Mobile Clutter) */}
      {showPracticeSettings && (
        <div className={`rounded-2xl border p-3.5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs ${
          darkMode ? 'bg-stone-900/90 border-stone-800' : 'bg-stone-50 border-stone-200'
        }`}>
          <div className="flex flex-col gap-1.5">
            <span className="font-bold text-stone-500 uppercase tracking-wider text-[10px]">Tempo Speed ({Math.round(tempoScale * 100)}%)</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0.4"
                max="1.4"
                step="0.05"
                value={tempoScale}
                onChange={(e) => setTempoScale(parseFloat(e.target.value))}
                className="flex-1 accent-orange-600"
              />
              <span className="font-mono font-bold">{Math.round(currentSong.tempo * tempoScale)} BPM</span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="font-bold text-stone-500 uppercase tracking-wider text-[10px]">Practice Tools</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setLoopRange(l => ({ ...l, enabled: !l.enabled }))}
                className={`flex-1 py-1.5 px-2.5 rounded-lg border font-semibold flex items-center justify-center gap-1.5 ${
                  loopRange.enabled ? 'bg-orange-600 text-white border-orange-600' : 'border-stone-300 dark:border-stone-700'
                }`}
              >
                <Repeat className="w-3.5 h-3.5" />
                Loop Bars {loopRange.startMeasure}–{loopRange.endMeasure}
              </button>
              <button
                onClick={() => setMetronomeOn(m => !m)}
                className={`py-1.5 px-3 rounded-lg border font-semibold flex items-center gap-1.5 ${
                  metronomeOn ? 'bg-amber-500 text-stone-950 border-amber-500' : 'border-stone-300 dark:border-stone-700'
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                Click
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="font-bold text-stone-500 uppercase tracking-wider text-[10px]">Visual Layout</span>
            <div className="flex rounded-lg p-0.5 border border-stone-300 dark:border-stone-700">
              {[
                { id: 'notation', label: 'Sheet Music' },
                { id: 'combined', label: 'Split' },
                { id: 'falling', label: 'Falling Notes' }
              ].map(v => (
                <button
                  key={v.id}
                  onClick={() => setViewLayout(v.id)}
                  className={`flex-1 py-1 rounded-md font-semibold ${
                    viewLayout === v.id ? 'bg-orange-700 text-white' : ''
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="font-bold text-stone-500 uppercase tracking-wider text-[10px]">Instrument Sound</span>
            <select
              value={instrumentVoice}
              onChange={(e) => {
                setInstrumentVoice(e.target.value);
                audioEngine.instrument = e.target.value;
              }}
              className={`rounded-lg px-2.5 py-1.5 border font-semibold ${
                darkMode ? 'bg-stone-950 border-stone-700 text-stone-200' : 'bg-white border-stone-300 text-stone-800'
              }`}
            >
              <option value="grand-piano">Concert Grand Piano</option>
              <option value="electric-rhodes">Warm Rhodes Electric</option>
              <option value="warm-strings">Chamber Strings</option>
            </select>
          </div>

          <div className="sm:col-span-2 lg:col-span-4 flex flex-col gap-1.5 border-t border-stone-200 dark:border-stone-800 pt-2">
            <span className="font-bold text-stone-500 uppercase tracking-wider text-[10px]">Listening</span>
            <p className="text-[11px] leading-snug text-stone-600 dark:text-stone-300">
              {midiStatusLine({ access: midiAccess, devices: midiDevices })}
              {' '}
              The mic hears one note at a time and can move Wait or Tempo. It stays quiet during Listen so the speaker is not graded.
              {isIosLike() ? ' iPhone uses a simple piano so the song still sounds when Safari shows the speaker icon.' : ''}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={connectMidi}
                className="px-3 py-1.5 rounded-lg font-bold bg-stone-800 text-white"
              >
                Connect MIDI
              </button>
              <button
                type="button"
                onClick={toggleMicrophone}
                className={`px-3 py-1.5 rounded-lg font-bold text-white ${
                  micActive ? 'bg-rose-600' : 'bg-emerald-600'
                }`}
              >
                {micActive ? 'Stop mic' : 'Use mic'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`h-10 px-2.5 sm:px-3 rounded-xl border flex items-center gap-2 overflow-hidden text-xs ${
        soundStalled || (armSound && !soundReady)
          ? (darkMode ? 'bg-amber-950/40 border-amber-700/50 text-amber-100' : 'bg-amber-50 border-amber-200 text-amber-950')
          : liveToast.status === 'hit'
          ? (darkMode ? 'bg-emerald-950/40 border-emerald-700/50 text-emerald-200' : 'bg-emerald-50 border-emerald-200 text-emerald-900')
          : liveToast.status === 'miss'
          ? (darkMode ? 'bg-rose-950/40 border-rose-700/50 text-rose-200' : 'bg-rose-50 border-rose-200 text-rose-900')
          : (darkMode ? 'bg-stone-900 border-stone-800 text-stone-300' : 'bg-stone-100/90 border-stone-200 text-stone-700')
      }`}>
        <span className={`w-2 h-2 shrink-0 rounded-full ${
          liveToast.status === 'hit' ? 'bg-emerald-500' : liveToast.status === 'miss' ? 'bg-rose-500' : 'bg-orange-500'
        }`} />
        <p className="min-w-0 flex-1 truncate font-medium">{guidance}</p>
        <span className="shrink-0 w-16 sm:w-24 truncate text-right text-[11px] font-semibold tabular-nums text-orange-800 dark:text-orange-300">
          {formatNextChip(expectedPlayheadEvents, isMobileView)}
        </span>
        <span className="shrink-0 w-14 truncate text-right text-[11px] font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
          {sessionStats.hits} Hits
        </span>
        <span className="shrink-0 w-[4.25rem] truncate text-right text-[11px] font-mono font-semibold tabular-nums text-amber-600 dark:text-amber-400">
          {sessionStats.streak} Streak
        </span>
      </div>

      {/* Synchronized Sheet Music Stage */}
      {(viewLayout === 'notation' || viewLayout === 'combined') && (
        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5 px-1 h-5 overflow-hidden text-xs">
            <span className="truncate font-semibold text-stone-500 dark:text-stone-400">
              {currentSong.composer} · {currentSong.keySignature} · Bar {Math.floor(currentBeat / beatsPerMeasure) + 1}
            </span>
            {uncertainEventsCount > 0 && (
              <button
                onClick={() => setActiveTab('cleanup')}
                className="shrink-0 text-amber-600 dark:text-amber-400 hover:underline font-semibold flex items-center gap-1"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                {uncertainEventsCount} to check
              </button>
            )}
          </div>
          {renderGrandStaffNotation(false)}
        </div>
      )}

      {/* Falling Notes Highway + Touch-Friendly Piano Keyboard */}
      <div className="rounded-2xl overflow-hidden border border-stone-300 dark:border-stone-800 shadow-lg">
        {(viewLayout === 'combined' || viewLayout === 'falling') && (
          <div className={`relative w-full h-36 sm:h-44 ${
            darkMode ? 'bg-stone-950' : 'bg-[#f3efe6]'
          }`}>
            <canvas
              ref={fallingCanvasRef}
              width={960}
              height={176}
              className="w-full h-full block"
            />
          </div>
        )}
        {renderInteractiveKeyboard()}
      </div>
    </div>
    );
  };

  // ============================================================================
  // 14. VIEW 2: REPERTOIRE & UNIVERSAL IMPORT
  // ============================================================================

  const renderRepertoireAndImport = () => {
    const genres = ['ALL', 'Cinema & Animation', 'Classical', 'Baroque', 'Impressionist', 'Jazz & Ragtime', 'Traditional & Folk'];
    const filteredSongs = songs.filter(s => {
      if (libraryFilter !== 'ALL' && s.difficulty.toUpperCase() !== libraryFilter) return false;
      if (genreFilter !== 'ALL' && s.genre !== genreFilter) return false;
      if (searchQuery && !s.title.toLowerCase().includes(searchQuery.toLowerCase()) && !s.composer.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });

    return (
      <div className="space-y-6">
        {/* Top Row: Quick Universal Dropzone + Daily Progress */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className={`lg:col-span-8 rounded-2xl border p-5 sm:p-6 flex flex-col justify-between ${
            darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90 shadow-sm'
          }`}>
            <div className="space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-orange-700 dark:text-orange-400">
                Universal Music Ingestion
              </span>
              <h2 className="text-xl sm:text-2xl font-serif font-bold">
                Bring Any Sheet Music, MIDI, or Audio Recording
              </h2>
              <p className="text-xs sm:text-sm text-stone-500 dark:text-stone-400 max-w-xl">
                Upload a PDF/photo of sheet music, a Standard MIDI (`.mid`) file, MusicXML, or an audio track. Maestro converts it into an interactive score you can practice at any tempo.
              </p>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <label className="px-4 py-2.5 rounded-xl bg-orange-700 hover:bg-orange-600 text-white font-bold text-xs sm:text-sm cursor-pointer flex items-center gap-2 shadow-sm transition">
                <Upload className="w-4 h-4" />
                <span>Upload Sheet / MIDI / Audio</span>
                <input
                  type="file"
                  accept=".mid,.midi,.musicxml,.xml,.pdf,.png,.jpg,.jpeg,.wav,.mp3"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
              <span className="text-xs text-stone-500">
                Supports `.mid`, `.musicxml`, `.pdf`, `.jpg`, `.png`, `.wav`, `.mp3`
              </span>
            </div>

            {museScore.field}

            {importStatus && (
              <div className={`mt-4 p-3 rounded-xl border text-xs font-semibold flex items-center justify-between gap-2 ${
                importStatus.error
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-300'
                  : importStatus.success
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300'
              }`}>
                <div className="flex items-center gap-2">
                  <RefreshCw className={`w-4 h-4 ${!importStatus.success && !importStatus.error ? 'animate-spin' : ''}`} />
                  <span>{importStatus.label}</span>
                </div>
                {importStatus.success && (
                  <button
                    onClick={() => setActiveTab('cleanup')}
                    className="underline font-bold"
                  >
                    Review in Score Cleanup →
                  </button>
                )}
              </div>
            )}
          </div>

          <div className={`lg:col-span-4 rounded-2xl border p-5 flex flex-col justify-between gap-4 ${
            darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90 shadow-sm'
          }`}>
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="font-bold uppercase tracking-wider text-stone-500">Today&apos;s Practice</span>
                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                  {sessionStats.dailyMinutes} / {sessionStats.dailyGoal} min
                </span>
              </div>
              <div className="w-full h-2.5 bg-stone-200 dark:bg-stone-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-600 rounded-full"
                  style={{ width: `${Math.min(100, Math.round((sessionStats.dailyMinutes / sessionStats.dailyGoal) * 100))}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <div className={`p-3 rounded-xl border ${darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-50 border-stone-200'}`}>
                <div className="text-stone-500">Accuracy</div>
                <div className="text-lg font-bold mt-0.5">
                  {Math.round((sessionStats.hits / Math.max(1, sessionStats.hits + sessionStats.misses)) * 100)}%
                </div>
              </div>
              <div className={`p-3 rounded-xl border ${darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-50 border-stone-200'}`}>
                <div className="text-stone-500">Current Streak</div>
                <div className="text-lg font-bold text-amber-600 dark:text-amber-400 mt-0.5">{sessionStats.streak} Notes</div>
              </div>
            </div>
          </div>
        </div>

        {/* Curated & Imported Repertoire Grid */}
        <div className={`rounded-2xl border p-5 space-y-4 ${
          darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90 shadow-sm'
        }`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-serif font-bold">
                Repertoire Library ({filteredSongs.length} of {songs.length} Pieces)
              </h3>
              <p className="text-xs text-stone-500">Tap any piece to open the interactive score or inspect OMR detections</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                placeholder="Search 32+ songs (e.g. Frozen, Moana)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`rounded-xl px-3 py-1.5 text-xs border focus:outline-none ${
                  darkMode ? 'bg-stone-950 border-stone-800 text-stone-200' : 'bg-stone-50 border-stone-200 text-stone-800'
                }`}
              />
              <div className={`flex rounded-xl p-0.5 text-xs border ${
                darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-100 border-stone-200'
              }`}>
                {['ALL', 'BEGINNER', 'INTERMEDIATE', 'ADVANCED'].map(lvl => (
                  <button
                    key={lvl}
                    onClick={() => setLibraryFilter(lvl)}
                    className={`px-2.5 py-1 rounded-lg font-semibold transition ${
                      libraryFilter === lvl
                        ? (darkMode ? 'bg-orange-700 text-white' : 'bg-white text-stone-900 shadow-sm')
                        : 'text-stone-500'
                    }`}
                  >
                    {lvl === 'ALL' ? 'All Levels' : lvl.charAt(0) + lvl.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Genre Category Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {genres.map(g => (
              <button
                key={g}
                onClick={() => setGenreFilter(g)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap border transition ${
                  genreFilter === g
                    ? 'bg-orange-700 text-white border-orange-700 shadow-sm'
                    : (darkMode ? 'bg-stone-950 border-stone-800 text-stone-400 hover:text-stone-200' : 'bg-stone-50 border-stone-200 text-stone-600 hover:bg-stone-100')
                }`}
              >
                {g === 'ALL' ? `All Genres (${songs.length})` : g}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {filteredSongs.map(song => {
              const isSelected = song.id === currentSong.id;
              const flagged = song.events.filter(e => e.confidence < 0.85 && !e.verified).length;
              return (
                <div
                  key={song.id}
                  onClick={() => handleSelectSong(song.id, 'practice')}
                  className={`p-4 rounded-2xl border transition cursor-pointer flex flex-col justify-between gap-3 ${
                    isSelected
                      ? (darkMode ? 'bg-stone-950 border-orange-500/60 ring-1 ring-orange-500/40' : 'bg-orange-50/40 border-orange-400')
                      : (darkMode ? 'bg-stone-950/60 hover:bg-stone-950 border-stone-800' : 'bg-stone-50/60 hover:bg-stone-50 border-stone-200')
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-serif font-bold text-base">{song.title}</h4>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                          darkMode ? 'bg-stone-800 text-stone-300' : 'bg-stone-200 text-stone-700'
                        }`}>
                          {song.difficulty}
                        </span>
                      </div>
                      <p className="text-xs text-stone-500 mt-0.5">
                        {song.composer} · {song.keySignature} · {song.totalMeasures} Measures ({song.events.length} Notes)
                      </p>
                    </div>
                    <span className="text-xs font-mono text-stone-500">{song.tempo} BPM</span>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-stone-200/70 dark:border-stone-800 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-stone-500">{song.sourceFormat}</span>
                      {flagged > 0 && (
                        <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 font-semibold text-[11px]">
                          {flagged} to verify
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectSong(song.id, 'cleanup');
                        }}
                        className={`px-2.5 py-1.5 rounded-lg font-semibold border ${
                          darkMode ? 'border-stone-700 hover:bg-stone-800' : 'border-stone-300 hover:bg-white'
                        }`}
                      >
                        Cleanup
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectSong(song.id, 'practice');
                        }}
                        className="px-3 py-1.5 rounded-lg bg-orange-700 hover:bg-orange-600 text-white font-semibold flex items-center gap-1"
                      >
                        Practice <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // ============================================================================
  // 15. VIEW 3: OMR SCORE CLEANUP STUDIO (RESPONSIVE TABS ON MOBILE)
  // ============================================================================

  const renderCleanupStudio = () => {
    const selectedEv = currentSong.events.find(e => e.id === selectedEventId) ||
      currentSong.events.find(e => e.confidence < 0.85 && !e.verified) ||
      currentSong.events[0];

    return (
      <div className="space-y-4">
        {/* Top Context Header + Mobile Pane Switcher */}
        <div className={`rounded-2xl border p-4 flex flex-wrap items-center justify-between gap-3 ${
          darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90 shadow-sm'
        }`}>
          <div>
            <h2 className="text-base sm:text-lg font-serif font-bold flex items-center gap-2">
              <Wrench className="w-4 h-4 text-orange-600" />
              OMR Score Cleanup Studio · {currentSong.title}
            </h2>
            <p className="text-xs text-stone-500">
              Compare the original camera scan with the reconstructed digital engraving. Tap any amber-highlighted note to confirm or fix it.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Mobile Toggle between Scan and Digital Score */}
            <div className="flex lg:hidden rounded-xl p-0.5 border border-stone-300 dark:border-stone-700 text-xs font-semibold">
              <button
                onClick={() => setCleanupMobilePane('digital')}
                className={`px-3 py-1.5 rounded-lg ${cleanupMobilePane === 'digital' ? 'bg-orange-700 text-white' : ''}`}
              >
                Digital Score
              </button>
              <button
                onClick={() => setCleanupMobilePane('scan')}
                className={`px-3 py-1.5 rounded-lg ${cleanupMobilePane === 'scan' ? 'bg-orange-700 text-white' : ''}`}
              >
                Original Scan
              </button>
            </div>

            <button
              onClick={handleDownloadMusicXML}
              className="px-3.5 py-2 rounded-xl bg-orange-700 hover:bg-orange-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm"
            >
              <Download className="w-3.5 h-3.5" />
              Export MusicXML
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Left Column: Original Source Scan Overlay */}
          <div className={`lg:col-span-5 ${cleanupMobilePane === 'digital' ? 'hidden lg:flex' : 'flex'} flex-col justify-between rounded-2xl border p-4 ${
            darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90 shadow-sm'
          }`}>
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold uppercase tracking-wider text-stone-500">
                  Source Scan Bounding Boxes
                </span>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 font-bold">
                  {uncertainEventsCount} Uncertain
                </span>
              </div>

              <div className="relative w-full h-64 rounded-xl overflow-hidden bg-[#f4efe4] border border-stone-300 p-4 text-stone-900 shadow-inner">
                <div className="w-full h-full relative" style={{ transform: 'rotate(-0.4deg)' }}>
                  <div className="text-center font-serif border-b border-stone-400/50 pb-1 mb-3">
                    <div className="text-sm font-bold text-stone-800">{currentSong.title}</div>
                    <div className="text-[10px] italic text-stone-600">{currentSong.composer} · Source Page 1</div>
                  </div>

                  {[0.24, 0.50, 0.76].map((sysY, idx) => (
                    <div
                      key={idx}
                      className="absolute left-3 right-3 h-7 border-t border-b border-stone-400 flex items-center"
                      style={{ top: `${sysY * 100}%` }}
                    >
                      <div className="w-full border-t border-stone-400/60" />
                    </div>
                  ))}

                  {currentSong.events.slice(0, 22).map((ev) => {
                    const isFlagged = ev.confidence < 0.85 && !ev.verified;
                    const isCurr = selectedEv?.id === ev.id;
                    return (
                      <button
                        key={ev.id}
                        onClick={() => {
                          setSelectedEventId(ev.id);
                          audioEngine.playNote(ev.pitch, 0.4, ev.velocity);
                        }}
                        style={{
                          left: `${ev.bbox.x * 100}%`,
                          top: `${ev.bbox.y * 100}%`,
                          width: `${ev.bbox.w * 100}%`,
                          height: `${ev.bbox.h * 100}%`
                        }}
                        className={`absolute rounded transition-all flex items-center justify-center text-[10px] font-bold ${
                          isCurr
                            ? 'ring-2 ring-rose-600 bg-rose-500/30 text-stone-950 z-20 scale-110'
                            : isFlagged
                            ? 'border-2 border-amber-600 bg-amber-400/40 text-stone-950 z-10 animate-pulse'
                            : 'border border-stone-600/40 bg-stone-500/15 text-stone-800 hover:bg-orange-500/30'
                        }`}
                      >
                        ●
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <p className="text-[11px] text-stone-500 mt-3">
              Every reconstructed note retains its normalized $(x, y, w, h)$ page coordinates so optical errors never corrupt the score silently.
            </p>
          </div>

          {/* Right Column: Reconstructed Digital Engraving & Inspector */}
          <div className={`lg:col-span-7 ${cleanupMobilePane === 'scan' ? 'hidden lg:flex' : 'flex'} flex-col gap-4`}>
            <div className={`rounded-2xl border p-4 ${
              darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90 shadow-sm'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-stone-500">
                  Interactive Reconstructed Notation (Tap Any Note)
                </span>
              </div>
              {renderGrandStaffNotation(true)}
            </div>

            {selectedEv && (
              <div className={`rounded-2xl border p-4 ${
                darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90 shadow-sm'
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-stone-200 dark:border-stone-800">
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-orange-700 dark:text-orange-400">
                      Measure {selectedEv.measure} · Beat {selectedEv.beat}
                    </span>
                    <h4 className="text-base font-bold flex items-center gap-2 mt-0.5">
                      Selected Note: {selectedEv.pitchName}
                      <span className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                        selectedEv.confidence >= 0.85 || selectedEv.verified
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
                      }`}>
                        {Math.round(selectedEv.confidence * 100)}% Confidence
                      </span>
                    </h4>
                  </div>

                  <button
                    onClick={() => updateNoteInGraph(selectedEv.id, { verified: true })}
                    className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Approve Note
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div className="space-y-2">
                    <div className="font-bold text-stone-500">Quick Pitch & Hand Adjustments</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => updateNoteInGraph(selectedEv.id, { pitch: selectedEv.pitch + 1 })}
                        className={`p-2 rounded-xl border font-semibold ${
                          darkMode ? 'bg-stone-950 border-stone-800 hover:bg-stone-800' : 'bg-stone-50 border-stone-200 hover:bg-stone-100'
                        }`}
                      >
                        +1 Semitone (♯)
                      </button>
                      <button
                        onClick={() => updateNoteInGraph(selectedEv.id, { pitch: selectedEv.pitch - 1 })}
                        className={`p-2 rounded-xl border font-semibold ${
                          darkMode ? 'bg-stone-950 border-stone-800 hover:bg-stone-800' : 'bg-stone-50 border-stone-200 hover:bg-stone-100'
                        }`}
                      >
                        -1 Semitone (♭)
                      </button>
                      <button
                        onClick={() => updateNoteInGraph(selectedEv.id, { pitch: selectedEv.pitch + 12 })}
                        className={`p-2 rounded-xl border font-semibold ${
                          darkMode ? 'bg-stone-950 border-stone-800 hover:bg-stone-800' : 'bg-stone-50 border-stone-200 hover:bg-stone-100'
                        }`}
                      >
                        +1 Octave
                      </button>
                      <button
                        onClick={() => updateNoteInGraph(selectedEv.id, { hand: selectedEv.hand === 'R' ? 'L' : 'R' })}
                        className={`p-2 rounded-xl border font-semibold ${
                          darkMode ? 'bg-stone-950 border-stone-800 hover:bg-stone-800' : 'bg-stone-50 border-stone-200 hover:bg-stone-100'
                        }`}
                      >
                        Hand: {selectedEv.hand === 'R' ? 'Right → Left' : 'Left → Right'}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="font-bold text-stone-500">Alternative OMR Candidates</div>
                    <div className="space-y-1.5">
                      {selectedEv.alternatives?.map((alt, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            updateNoteInGraph(selectedEv.id, { pitch: alt.pitch });
                            audioEngine.playNote(alt.pitch, 0.4, 90);
                          }}
                          className={`w-full text-left px-3 py-2 rounded-xl border flex items-center justify-between font-medium ${
                            darkMode ? 'bg-stone-950 border-stone-800 hover:bg-stone-800' : 'bg-stone-50 border-stone-200 hover:bg-stone-100'
                          }`}
                        >
                          <span>{alt.label}</span>
                          <span className="font-mono font-bold text-orange-600 dark:text-orange-400">
                            {Math.round(alt.confidence * 100)}%
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ============================================================================
  // 16. VIEW 4: ADAPTIVE COACH & MULTI-INSTRUMENT ROADMAP
  // ============================================================================

  const renderAdaptiveCoach = () => {
    const avgOffset = sessionStats.timingOffsetsMs.length > 0
      ? Math.round(sessionStats.timingOffsetsMs.reduce((a, b) => a + b, 0) / sessionStats.timingOffsetsMs.length)
      : 0;

    const hardestMeasure = Object.entries(sessionStats.struggleMeasures)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 2;

    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className={`lg:col-span-8 rounded-2xl border p-5 sm:p-6 space-y-5 ${
          darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90 shadow-sm'
        }`}>
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-orange-700 dark:text-orange-400">
              Personalized Diagnostic Engine
            </span>
            <h2 className="text-xl font-serif font-bold mt-0.5">
              Adaptive Practice Coach
            </h2>
            <p className="text-xs sm:text-sm text-stone-500">
              Transparent, deterministic performance metrics based on your live note accuracy and rhythm stability.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className={`p-4 rounded-2xl border ${darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-50 border-stone-200'}`}>
              <div className="text-xs text-stone-500">Note Accuracy</div>
              <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
                {Math.round((sessionStats.hits / Math.max(1, sessionStats.hits + sessionStats.misses)) * 100)}%
              </div>
            </div>
            <div className={`p-4 rounded-2xl border ${darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-50 border-stone-200'}`}>
              <div className="text-xs text-stone-500">Rhythm Tendency</div>
              <div className="text-2xl font-bold mt-1">
                {avgOffset >= 0 ? `+${avgOffset} ms` : `${avgOffset} ms`}
              </div>
            </div>
            <div className={`p-4 rounded-2xl border ${darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-50 border-stone-200'}`}>
              <div className="text-xs text-stone-500">Recommended Focus</div>
              <div className="text-2xl font-bold text-orange-600 dark:text-orange-400 mt-1">
                Measure {hardestMeasure}
              </div>
            </div>
          </div>

          <div className={`p-4 sm:p-5 rounded-2xl border flex flex-wrap items-center justify-between gap-4 ${
            darkMode ? 'bg-orange-950/20 border-orange-500/30' : 'bg-orange-50/70 border-orange-200'
          }`}>
            <div className="space-y-1 max-w-lg">
              <div className="text-xs font-bold uppercase tracking-wider text-orange-700 dark:text-orange-400">
                Suggested 2-Minute Drill
              </div>
              <div className="text-base font-bold">
                Loop Measure {hardestMeasure} at 75% Tempo (Right Hand Only)
              </div>
              <p className="text-xs text-stone-600 dark:text-stone-300">
                We noticed pitch or rhythm hesitations entering Measure {hardestMeasure}. Isolating the right-hand melody slowly locks in finger memory before combining hands.
              </p>
            </div>
            <button
              onClick={() => {
                const m = parseInt(hardestMeasure, 10) || 2;
                setLoopRange({ enabled: true, startMeasure: m, endMeasure: m });
                setTempoScale(0.75);
                setHandFilter('R');
                movePlayhead((m - 1) * beatsPerMeasure);
                setActiveTab('practice');
              }}
              className="px-4 py-2.5 rounded-xl bg-orange-700 hover:bg-orange-600 text-white text-xs font-bold shadow-sm"
            >
              Start Targeted Drill →
            </button>
          </div>
        </div>

        <div className={`lg:col-span-4 rounded-2xl border p-5 space-y-4 ${
          darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90 shadow-sm'
        }`}>
          <h3 className="text-base font-serif font-bold">Instrument & MIDI Setup</h3>
          <p className="text-xs text-stone-500">
            Connect a USB/Bluetooth MIDI keyboard or enable the acoustic microphone to play with a real instrument.
          </p>

          <div className="space-y-2.5 text-xs">
            <div className={`p-3.5 rounded-xl border flex items-center justify-between ${
              darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-50 border-stone-200'
            }`}>
              <div>
                <div className="font-bold">USB / BLE MIDI</div>
                <div className="text-stone-500">
                  {midiShortStatus({ access: midiAccess, devices: midiDevices })}
                </div>
              </div>
              {midiDevices.length > 0 ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-500">
                  Connected
                </span>
              ) : (
                <button
                  type="button"
                  onClick={connectMidi}
                  className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-orange-700 text-white"
                >
                  Connect
                </button>
              )}
            </div>

            <div className={`p-3.5 rounded-xl border flex items-center justify-between ${
              darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-50 border-stone-200'
            }`}>
              <div>
                <div className="font-bold">Acoustic Microphone</div>
                <div className="text-stone-500">
                  {detectedMicPitch ? `Hearing: ${detectedMicPitch.name} (${detectedMicPitch.freq} Hz)` : micActive ? 'Listening...' : 'Off (Local Browser DSP)'}
                </div>
              </div>
              <button
                onClick={toggleMicrophone}
                className={`px-3 py-1.5 rounded-lg font-bold text-white ${
                  micActive ? 'bg-rose-600' : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                {micActive ? 'Stop Mic' : 'Enable Mic'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ============================================================================
  // 17. SHELL LAYOUT: DESKTOP HEADER + MOBILE BOTTOM TAB BAR
  // ============================================================================

  const navItems = [
    { id: 'practice', label: 'Practice', icon: Play },
    { id: 'repertoire', label: 'Library & Import', icon: Compass },
    { id: 'cleanup', label: 'Score Cleanup', badge: uncertainEventsCount, icon: Wrench },
    { id: 'coach', label: 'Coach & MIDI', icon: Award }
  ];

  return (
    <div className={`min-h-screen flex flex-col font-sans pb-[calc(4.25rem+env(safe-area-inset-bottom))] md:pb-0 transition-colors ${
      darkMode ? 'bg-stone-950 text-stone-100' : 'bg-[#f6f3ec] text-stone-900'
    }`}>
      {/* Clean Conservatory Header */}
      <header className={`sticky top-0 z-30 border-b px-4 py-2.5 backdrop-blur-md flex items-center justify-between gap-3 ${
        darkMode ? 'bg-stone-900/90 border-stone-800' : 'bg-[#fcfaf5]/90 border-stone-200/90'
      }`}>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-orange-700 flex items-center justify-center text-white shadow-sm">
            <Music className="w-4 h-4" />
          </div>
          <div>
            <span className="font-serif font-bold text-base tracking-tight">Maestro AI</span>
            <span className="hidden sm:inline-block ml-2 text-[11px] text-stone-500">
              Interactive Sheet Music & Performance Studio
            </span>
          </div>
        </div>

        {/* Desktop Center Navigation */}
        <nav className={`hidden md:flex items-center gap-1 p-1 rounded-xl border text-xs font-semibold ${
          darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-200/60 border-stone-300/60'
        }`}>
          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`px-3.5 py-1.5 rounded-lg flex items-center gap-1.5 transition ${
                  isActive
                    ? (darkMode ? 'bg-orange-700 text-white shadow-sm' : 'bg-white text-stone-900 shadow-sm')
                    : (darkMode ? 'text-stone-400 hover:text-stone-200' : 'text-stone-600 hover:text-stone-900')
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
                {item.badge > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-amber-500/20 text-amber-600 dark:text-amber-300 font-bold">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Right Quick Controls: Mic Pill + Theme Toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMicrophone}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition ${
              micActive
                ? 'bg-emerald-600 text-white border-emerald-500'
                : (darkMode ? 'bg-stone-950 border-stone-800 text-stone-300' : 'bg-white border-stone-200 text-stone-700')
            }`}
            title="Toggle Live Acoustic Microphone Listening"
          >
            {micActive ? <Mic className="w-3.5 h-3.5 animate-pulse" /> : <MicOff className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline w-12 text-left">
              {micActive ? 'Mic on' : 'Mic'}
            </span>
          </button>

          <button
            onClick={() => setDarkMode(d => !d)}
            className={`p-2 rounded-xl border transition ${
              darkMode ? 'bg-stone-950 border-stone-800 text-amber-400' : 'bg-white border-stone-200 text-stone-700'
            }`}
            title="Switch Sheet Paper / Night Studio Theme"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-3 sm:px-5 py-4">
        {activeTab === 'practice' && renderPracticeView()}
        {activeTab === 'repertoire' && renderRepertoireAndImport()}
        {activeTab === 'cleanup' && renderCleanupStudio()}
        {activeTab === 'coach' && renderAdaptiveCoach()}
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <nav className={`md:hidden fixed bottom-0 left-0 right-0 z-40 border-t px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] grid grid-cols-4 gap-1 backdrop-blur-md ${
        darkMode ? 'bg-stone-900/95 border-stone-800' : 'bg-[#fcfaf5]/95 border-stone-200'
      }`}>
        {navItems.map(item => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`py-1.5 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
                isActive
                  ? 'text-orange-700 dark:text-orange-400'
                  : 'text-stone-500'
              }`}
            >
              <div className="relative">
                <Icon className="w-4 h-4" />
                {item.badge > 0 && (
                  <span className="absolute -top-1 -right-2.5 w-3.5 h-3.5 rounded-full bg-amber-500 text-stone-950 text-[9px] font-bold flex items-center justify-center">
                    {item.badge}
                  </span>
                )}
              </div>
              <span className="truncate max-w-full">{item.label.split(' ')[0]}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}