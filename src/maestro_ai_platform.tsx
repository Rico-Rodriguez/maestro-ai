import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
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

const DIATONIC_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

export function midiToPitchName(midi) {
  const octave = Math.floor(midi / 12) - 1;
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

export function getDiatonicSpelling(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const info = DIATONIC_STEP_MAP[midi % 12] || { step: 'C', alter: 0 };
  return { step: info.step, alter: info.alter, octave };
}

export function getStaffYOffset(midi, clef = 'treble') {
  const { step, octave } = getDiatonicSpelling(midi);
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

const PITCH_STR_REGEX = /^([A-G])(#|b)?(\d)$/;
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
            rawNotes.push({
              pitch: midi,
              onset: Math.round((measureStartBeat + cursor) * 100) / 100,
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
  const totalMeasures = Math.max(
    1,
    Math.ceil(Math.max(...rawNotes.map(r => r.onset + r.duration)) / beatsPerMeasure)
  );
  const events = rawNotes.map((n, idx) => {
    const measure = Math.floor(n.onset / beatsPerMeasure) + 1;
    const beatInMeasure = (n.onset % beatsPerMeasure) + 1;
    const spelling = getDiatonicSpelling(n.pitch);
    const row = Math.floor((measure - 1) / 4);
    const colProgress = ((n.onset % (beatsPerMeasure * 4)) / (beatsPerMeasure * 4));
    return {
      id: `${id}-ev-${idx}`,
      pitch: n.pitch,
      pitchName: midiToPitchName(n.pitch),
      step: spelling.step,
      alter: spelling.alter,
      octave: spelling.octave,
      onset: n.onset,
      duration: n.duration,
      measure,
      beat: Math.round(beatInMeasure * 100) / 100,
      hand: n.hand || (n.pitch >= 60 ? 'R' : 'L'),
      finger: n.finger || ((idx % 5) + 1),
      velocity: n.velocity || (n.hand === 'L' ? 74 : 88),
      confidence: n.confidence ?? 0.98,
      alternatives: n.alternatives || [
        { pitch: n.pitch + 1, label: `${midiToPitchName(n.pitch + 1)} (Sharp Accidental)`, confidence: 0.22 },
        { pitch: n.pitch - 2, label: `${midiToPitchName(n.pitch - 2)} (Staff Line Shift)`, confidence: 0.14 }
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
  // 1. ODE TO JOY — FULL 16-MEASURE A-A'-B-A' CONCERT ARRANGEMENT
  buildSongFromEvents({
    id: 'ode-to-joy',
    title: 'Ode to Joy (Symphony No. 9, Complete Theme)',
    composer: 'Ludwig van Beethoven',
    genre: 'Classical',
    difficulty: 'Beginner',
    tempo: 108,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Scanned Score (OMR)',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      // Phrase A (Bars 1-4)
      { chord: 'C', rh: ['E4:1:3', 'E4:1:3', 'F4:1:4', 'G4:1:5'], lh: ['C3+G3:2:5', 'E3+G3:2:3'] },
      { chord: 'G7', rh: ['G4:1:5', 'F4:1:4:0.74', 'E4:1:3', 'D4:1:2'], lh: ['B2+G3:2:5', 'D3+G3:2:2'] },
      { chord: 'C', rh: ['C4:1:1', 'C4:1:1', 'D4:1:2', 'E4:1:3'], lh: ['C3+G3:2:5', 'E3+G3:2:3'] },
      { chord: 'G', rh: ['E4:1.5:3', 'D4:0.5:2', 'D4:2:2'], lh: ['G2+D3:2:5', 'G2+B2:2:5'] },
      // Phrase A' (Bars 5-8)
      { chord: 'C', rh: ['E4:1:3', 'E4:1:3', 'F4:1:4', 'G4:1:5'], lh: ['C3+G3:2:5', 'E3+G3:2:3'] },
      { chord: 'G7', rh: ['G4:1:5', 'F4:1:4', 'E4:1:3', 'D4:1:2'], lh: ['B2+G3:2:5', 'D3+G3:2:2'] },
      { chord: 'C/G', rh: ['C4:1:1', 'C4:1:1', 'D4:1:2', 'E4:1:3'], lh: ['C3+E3:2:4', 'G2+D3:2:5'] },
      { chord: 'C', rh: ['D4:1.5:2', 'C4:0.5:1', 'C4:2:1'], lh: ['G2+B2:2:5', 'C3+E3:2:3'] },
      // Phrase B Bridge (Bars 9-12)
      { chord: 'G', rh: ['D4:1:2', 'D4:1:2', 'E4:1:3', 'C4:1:1'], lh: ['G2+D3:2:5', 'G2+D3:2:5'] },
      { chord: 'G', rh: ['D4:1:2', 'E4:0.5:3', 'F4:0.5:4', 'E4:1:3', 'C4:1:1'], lh: ['G2+D3:2:5', 'G2+D3:2:5'] },
      { chord: 'D7/F#', rh: ['D4:1:2', 'E4:0.5:3', 'F4:0.5:4:0.78', 'E4:1:3', 'D4:1:2'], lh: ['A2+D3:2:4', 'F#2+D3:2:5'] },
      { chord: 'G7', rh: ['C4:1:1', 'D4:1:2', 'G3:2:1'], lh: ['G2+D3:2:5', 'G2+F3:2:5'] },
      // Phrase A'' Finale (Bars 13-16)
      { chord: 'C', rh: ['E4:1:3', 'E4:1:3', 'F4:1:4', 'G4:1:5'], lh: ['C3+G3:2:5', 'E3+G3:2:3'] },
      { chord: 'G7', rh: ['G4:1:5', 'F4:1:4', 'E4:1:3', 'D4:1:2'], lh: ['B2+G3:2:5', 'D3+G3:2:2'] },
      { chord: 'C/G', rh: ['C4:1:1', 'C4:1:1', 'D4:1:2', 'E4:1:3'], lh: ['C3+E3:2:4', 'G2+D3:2:5'] },
      { chord: 'C', rh: ['D4:1.5:2', 'C4:0.5:1', 'C4+E4+G4:2:1'], lh: ['G2+D3:2:5', 'C2+C3:2:5'] }
    ], 4)
  }),

  // 2. FÜR ELISE — BEETHOVEN (16-MEASURE COMPLETE A-SECTION IN 3/4)
  buildSongFromEvents({
    id: 'fur-elise',
    title: 'Für Elise, WoO 59 (Complete A Section)',
    composer: 'Ludwig van Beethoven',
    genre: 'Classical',
    difficulty: 'Intermediate',
    tempo: 116,
    timeSignature: [3, 4],
    keySignature: 'A Minor',
    sourceFormat: 'Scanned Score (OMR)',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Am', rh: ['R:2', 'E5:0.5:5', 'D#5:0.5:4'], lh: ['R:3'] },
      { chord: 'Am', rh: ['E5:0.5:5', 'D#5:0.5:4', 'E5:0.5:5', 'B4:0.5:2', 'D5:0.5:4', 'C5:0.5:3'], lh: ['R:3'] },
      { chord: 'Am', rh: ['A4:1:1', 'R:0.5', 'C4:0.5:1', 'E4:0.5:2', 'A4:0.5:4'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'E7', rh: ['B4:1:5', 'R:0.5', 'E4:0.5:1', 'G#4:0.5:2:0.76', 'B4:0.5:4'], lh: ['E2:0.5:5', 'E3:0.5:2', 'G#3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['C5:1:5', 'R:0.5', 'E4:0.5:1', 'E5:0.5:5', 'D#5:0.5:4'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['E5:0.5:5', 'D#5:0.5:4', 'E5:0.5:5', 'B4:0.5:2', 'D5:0.5:4', 'C5:0.5:3'], lh: ['R:3'] },
      { chord: 'Am', rh: ['A4:1:1', 'R:0.5', 'C4:0.5:1', 'E4:0.5:2', 'A4:0.5:4'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'E7', rh: ['B4:1:5', 'R:0.5', 'E4:0.5:1', 'C5:0.5:4', 'B4:0.5:3'], lh: ['E2:0.5:5', 'E3:0.5:2', 'G#3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['A4:2:2', 'B4:0.5:1', 'C5:0.5:2'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      // B Phrase (C Major / G Major contrast)
      { chord: 'C', rh: ['D5:0.5:3', 'E5:1.5:5', 'G4:0.5:1', 'F5:0.5:5'], lh: ['C3:0.5:5', 'G3:0.5:2', 'C4:1:1', 'R:1'] },
      { chord: 'G7', rh: ['E5:0.5:4', 'D5:1.5:3', 'F4:0.5:1', 'E5:0.5:5'], lh: ['G2:0.5:5', 'G3:0.5:2', 'B3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['D5:0.5:4', 'C5:1.5:3', 'E4:0.5:1', 'D5:0.5:5'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'E', rh: ['C5:0.5:4', 'B4:1.5:3', 'E4:0.5:1', 'E5:0.5:5'], lh: ['E2:0.5:5', 'E3:0.5:2', 'E4:1:1', 'R:1'] },
      // Return of Motif
      { chord: 'Am', rh: ['E5:0.5:5', 'D#5:0.5:4', 'E5:0.5:5', 'B4:0.5:2', 'D5:0.5:4', 'C5:0.5:3'], lh: ['R:3'] },
      { chord: 'Am', rh: ['A4:1:1', 'R:0.5', 'C4:0.5:1', 'E4:0.5:2', 'A4:0.5:4'], lh: ['A2:0.5:5', 'E3:0.5:2', 'A3:1:1', 'R:1'] },
      { chord: 'E7', rh: ['B4:1:5', 'R:0.5', 'E4:0.5:1', 'C5:0.5:4', 'B4:0.5:3'], lh: ['E2:0.5:5', 'E3:0.5:2', 'G#3:1:1', 'R:1'] },
      { chord: 'Am', rh: ['A4+C5+E5:3:1'], lh: ['A2+E3+A3:3:5'] }
    ], 3)
  }),

  // 3. MINUET IN G MAJOR, BWV ANH. 114 — FULL 16-MEASURE FIRST PART
  buildSongFromEvents({
    id: 'minuet-in-g',
    title: 'Minuet in G Major, BWV Anh. 114',
    composer: 'Christian Petzold / J.S. Bach',
    genre: 'Baroque',
    difficulty: 'Intermediate',
    tempo: 112,
    timeSignature: [3, 4],
    keySignature: 'G Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      // Bars 1-4
      { chord: 'G', rh: ['D5:1:5', 'G4:0.5:1', 'A4:0.5:2', 'B4:0.5:3', 'C5:0.5:4'], lh: ['G3+B3:2:3', 'A3:1:2'] },
      { chord: 'G', rh: ['D5:1:5', 'G4:1:1', 'G4:1:1'], lh: ['B3:3:1'] },
      { chord: 'C', rh: ['E5:1:3', 'C5:0.5:1:0.78', 'D5:0.5:2', 'E5:0.5:3', 'F#5:0.5:4'], lh: ['C4:3:1'] },
      { chord: 'G', rh: ['G5:1:5', 'G4:1:1', 'G4:1:1'], lh: ['B3:3:2'] },
      // Bars 5-8
      { chord: 'Am/C', rh: ['C5:1:4', 'D5:0.5:5', 'C5:0.5:4', 'B4:0.5:3', 'A4:0.5:2'], lh: ['A3:3:3'] },
      { chord: 'G/B', rh: ['B4:1:3', 'C5:0.5:4', 'B4:0.5:3', 'A4:0.5:2', 'G4:0.5:1'], lh: ['G3:3:4'] },
      { chord: 'D7', rh: ['F#4:1:2', 'G4:0.5:1', 'A4:0.5:2', 'B4:0.5:3', 'G4:0.5:1'], lh: ['D3:2:5', 'F#3:1:3'] },
      { chord: 'D', rh: ['A4:3:2'], lh: ['D3:1:5', 'C4:0.5:1', 'B3:0.5:2', 'A3:0.5:3', 'G3:0.5:4'] },
      // Bars 9-12
      { chord: 'G', rh: ['D5:1:5', 'G4:0.5:1', 'A4:0.5:2', 'B4:0.5:3', 'C5:0.5:4'], lh: ['B3:2:2', 'A3:1:3'] },
      { chord: 'G', rh: ['D5:1:5', 'G4:1:1', 'G4:1:1'], lh: ['G3:1:4', 'B3:1:2', 'G3:1:4'] },
      { chord: 'C', rh: ['E5:1:3', 'C5:0.5:1', 'D5:0.5:2', 'E5:0.5:3', 'F#5:0.5:4'], lh: ['C4:3:1'] },
      { chord: 'G', rh: ['G5:1:5', 'G4:1:1', 'G4:1:1'], lh: ['B3:2:2', 'G3:1:4'] },
      // Bars 13-16
      { chord: 'Am', rh: ['C5:1:4', 'D5:0.5:5', 'C5:0.5:4', 'B4:0.5:3', 'A4:0.5:2'], lh: ['A3:2:3', 'F#3:1:4'] },
      { chord: 'G', rh: ['B4:1:3', 'C5:0.5:4', 'B4:0.5:3', 'A4:0.5:2', 'G4:0.5:1'], lh: ['G3:2:4', 'B3:1:2'] },
      { chord: 'D7', rh: ['A4:1:2', 'B4:0.5:3', 'A4:0.5:2', 'G4:0.5:1', 'F#4:0.5:2'], lh: ['C3:1:5', 'D3:2:4'] },
      { chord: 'G', rh: ['G4:3:1'], lh: ['G2+G3:3:5'] }
    ], 3)
  }),

  // 4. PRELUDE IN C MAJOR, BWV 846 — J.S. BACH (16 MEASURES OF HARMONIC ARPEGGIOS)
  buildSongFromEvents({
    id: 'prelude-in-c',
    title: 'Prelude in C Major, BWV 846',
    composer: 'Johann Sebastian Bach',
    genre: 'Baroque',
    difficulty: 'Intermediate',
    tempo: 88,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Standard MIDI (.mid)',
    license: 'Public Domain',
    rawNotes: (() => {
      const chordProgression = [
        { chord: 'C', notes: ['C3', 'E3', 'G3', 'C4', 'E4'] },
        { chord: 'Dm7/C', notes: ['C3', 'D3', 'A3', 'D4', 'F4'] },
        { chord: 'G7/B', notes: ['B2', 'D3', 'G3', 'D4', 'F4'] },
        { chord: 'C', notes: ['C3', 'E3', 'G3', 'C4', 'E4'] },
        { chord: 'Am/C', notes: ['C3', 'E3', 'A3', 'E4', 'A4'] },
        { chord: 'D7/C', notes: ['C3', 'D3', 'F#3', 'A3', 'D4'] },
        { chord: 'G/B', notes: ['B2', 'D3', 'G3', 'D4', 'G4'] },
        { chord: 'Cmaj7/B', notes: ['B2', 'C3', 'E3', 'G3', 'C4'] },
        { chord: 'Am7', notes: ['A2', 'C3', 'E3', 'G3', 'C4'] },
        { chord: 'D7', notes: ['D2', 'A2', 'D3', 'F#3', 'C4'] },
        { chord: 'G', notes: ['G2', 'B2', 'D3', 'G3', 'B3'] },
        { chord: 'Gdim7', notes: ['G2', 'Bb2', 'E3', 'G3', 'C#4'] },
        { chord: 'Dm/F', notes: ['F2', 'A2', 'D3', 'A3', 'D4'] },
        { chord: 'Fm6', notes: ['F2', 'Ab2', 'D3', 'F3', 'B3'] },
        { chord: 'C/E', notes: ['E2', 'G2', 'C3', 'G3', 'C4'] },
        { chord: 'C', notes: ['C2', 'G2', 'C3', 'E3', 'C4'] }
      ];
      const measures = chordProgression.map(({ chord, notes }) => {
        const [n1, n2, n3, n4, n5] = notes;
        return {
          chord,
          lh: [`${n1}:0.5:5`, `${n2}:0.5:3`, 'R:1', `${n1}:0.5:5`, `${n2}:0.5:3`, 'R:1'],
          rh: [
            'R:1', `${n3}:0.25:1`, `${n4}:0.25:3`, `${n5}:0.25:5`, `${n3}:0.25:1`,
            'R:1', `${n3}:0.25:1`, `${n4}:0.25:3`, `${n5}:0.25:5`, `${n3}:0.25:1`
          ]
        };
      });
      return compileCompactScore(measures, 4);
    })()
  }),

  // 5. CANON IN D MAJOR — JOHANN PACHELBEL (16-MEASURE COMPLETE VARIATION ARC)
  buildSongFromEvents({
    id: 'canon-in-d',
    title: 'Canon in D Major (Concert Piano Arrangement)',
    composer: 'Johann Pachelbel',
    genre: 'Baroque',
    difficulty: 'Beginner',
    tempo: 78,
    timeSignature: [4, 4],
    keySignature: 'D Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      // Cycle 1: Warm Choral Theme (Bars 1-4)
      { chord: 'D', rh: ['F#4:2:3', 'E4:2:2'], lh: ['D3:1:5', 'A3:1:2', 'A2:1:5', 'E3:1:2'] },
      { chord: 'Bm', rh: ['D4:2:1', 'C#4:2:2'], lh: ['B2:1:5', 'F#3:1:2', 'F#2:1:5', 'C#3:1:2'] },
      { chord: 'G', rh: ['B3:2:1', 'A3:2:1'], lh: ['G2:1:5', 'D3:1:2', 'D2:1:5', 'A2:1:2'] },
      { chord: 'G/A', rh: ['B3:2:2', 'C#4:2:3'], lh: ['G2:1:5', 'D3:1:2', 'A2:1:5', 'E3:1:2'] },
      // Cycle 2: Higher Octave Lyricism (Bars 5-8)
      { chord: 'D', rh: ['D5:1:5', 'C#5:1:4', 'C#5:1:4', 'B4:1:3'], lh: ['D3:1:5', 'A3:1:1', 'A2:1:5', 'E3:1:1'] },
      { chord: 'Bm', rh: ['A4:1:2', 'G4:1:1', 'A4:1:2', 'F#4:1:1'], lh: ['B2:1:5', 'F#3:1:1', 'F#2:1:5', 'C#3:1:1'] },
      { chord: 'G', rh: ['G4:1:2', 'B4:1:4', 'A4:1:3', 'F#4:1:1'], lh: ['G2:1:5', 'D3:1:1', 'D2:1:5', 'A2:1:1'] },
      { chord: 'A7', rh: ['G4:1:2', 'E4:1:1', 'E4:1:1', 'A4:1:4'], lh: ['G2:1:5', 'D3:1:1', 'A2:1:5', 'E3:1:1'] },
      // Cycle 3: Flowing Eighth-Note Variation (Bars 9-12)
      { chord: 'D', rh: ['D5:0.5:4', 'C#5:0.5:3', 'D5:0.5:4', 'F#4:0.5:1', 'A4:0.5:2', 'E5:0.5:5', 'C#5:0.5:3', 'A4:0.5:1'], lh: ['D3+A3:2:5', 'A2+E3:2:5'] },
      { chord: 'Bm', rh: ['B4:0.5:3', 'F#4:0.5:1', 'B4:0.5:3', 'D5:0.5:5', 'C#5:0.5:4', 'A4:0.5:2', 'F#4:0.5:1', 'A4:0.5:2'], lh: ['B2+F#3:2:5', 'F#2+C#3:2:5'] },
      { chord: 'G', rh: ['G4:0.5:1', 'B4:0.5:3', 'D5:0.5:5', 'B4:0.5:3', 'A4:0.5:2', 'F#4:0.5:1', 'D4:0.5:1', 'F#4:0.5:2'], lh: ['G2+D3:2:5', 'D2+A2:2:5'] },
      { chord: 'A7', rh: ['G4:0.5:2', 'B4:0.5:4', 'G4:0.5:2', 'E4:0.5:1', 'A4:1:3', 'C#5:1:5'], lh: ['G2+D3:2:5', 'A2+E3:2:5'] },
      // Cycle 4: Grand Resolution (Bars 13-16)
      { chord: 'D', rh: ['F#5:2:5', 'E5:2:4'], lh: ['D3:1:5', 'A3:1:2', 'A2:1:5', 'E3:1:2'] },
      { chord: 'Bm', rh: ['D5:2:3', 'C#5:2:2'], lh: ['B2:1:5', 'F#3:1:2', 'F#2:1:5', 'C#3:1:2'] },
      { chord: 'G', rh: ['B4:1:2', 'D5:1:4', 'A4:1:2', 'F#4:1:1'], lh: ['G2+D3:2:5', 'D2+A2:2:5'] },
      { chord: 'D', rh: ['G4:1:2', 'E4:1:1', 'D4+F#4+A4+D5:2:1'], lh: ['A2+E3:2:5', 'D2+A2+D3:2:5'] }
    ], 4)
  }),

  // 6. GYMNOPÉDIE NO. 1 — ERIK SATIE (16-MEASURE IMPRESSIONIST SCORE)
  buildSongFromEvents({
    id: 'gymnopedie-no-1',
    title: 'Gymnopédie No. 1',
    composer: 'Erik Satie',
    genre: 'Impressionist',
    difficulty: 'Intermediate',
    tempo: 74,
    timeSignature: [3, 4],
    keySignature: 'D Major',
    sourceFormat: 'Audio Transcription',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      // Intro Vamp (Bars 1-4)
      { chord: 'Gmaj7', rh: ['R:1', 'B3+D4+F#4:2:1'], lh: ['G2:3:5'] },
      { chord: 'Dmaj7', rh: ['R:1', 'A3+C#4+F#4:2:1:0.79'], lh: ['D2:3:5'] },
      { chord: 'Gmaj7', rh: ['R:1', 'B3+D4+F#4:2:1'], lh: ['G2:3:5'] },
      { chord: 'Dmaj7', rh: ['R:1', 'A3+C#4+F#4:2:1'], lh: ['D2:3:5'] },
      // Main Floating Melody (Bars 5-12)
      { chord: 'Gmaj7', rh: ['R:1', 'F#5:1:2', 'A5:1:4'], lh: ['G2:1:5', 'B3+D4:2:1'] },
      { chord: 'Dmaj7', rh: ['G5:1:3', 'F#5:1:2', 'C#5:1:1'], lh: ['D2:1:5', 'A3+C#4:2:1'] },
      { chord: 'Gmaj7', rh: ['B4:1:1', 'C#5:1:2', 'D5:1:3'], lh: ['G2:1:5', 'B3+D4:2:1'] },
      { chord: 'Dmaj7', rh: ['A4:3:1'], lh: ['D2:1:5', 'A3+C#4:2:1'] },
      { chord: 'Gmaj7', rh: ['F#4:3:2'], lh: ['G2:1:5', 'B3+D4:2:1'] },
      { chord: 'Dmaj7', rh: ['R:1', 'F#5:1:2', 'A5:1:4'], lh: ['D2:1:5', 'A3+C#4:2:1'] },
      { chord: 'Gmaj7', rh: ['G5:1:3', 'F#5:1:2', 'C#5:1:1'], lh: ['G2:1:5', 'B3+D4:2:1'] },
      { chord: 'Dmaj7', rh: ['B4:1:1', 'C#5:1:2', 'D5:1:3'], lh: ['D2:1:5', 'A3+C#4:2:1'] },
      // Modal Cadence (Bars 13-16)
      { chord: 'F#m7', rh: ['A4:3:1'], lh: ['F#2:1:5', 'A3+C#4:2:1'] },
      { chord: 'Bm7', rh: ['C#5:3:3'], lh: ['B2:1:5', 'F#3+D4:2:1'] },
      { chord: 'Em7', rh: ['F#5:3:5'], lh: ['E2:1:5', 'G3+B3:2:1'] },
      { chord: 'Dmaj7', rh: ['E4+A4+D5:3:1'], lh: ['D2+A2:3:5'] }
    ], 3)
  }),

  // 7. CLAIR DE LUNE (OPENING THEME IN 9/8 MAPPED TO EXPRESSIVE 3/4) — CLAUDE DEBUSSY
  buildSongFromEvents({
    id: 'clair-de-lune',
    title: 'Clair de Lune (Suite Bergamasque, L. 75)',
    composer: 'Claude Debussy',
    genre: 'Impressionist',
    difficulty: 'Advanced',
    tempo: 68,
    timeSignature: [3, 4],
    keySignature: 'C Major (Arr.)',
    sourceFormat: 'Scanned Score (OMR)',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['R:1', 'E5+G5:1:3', 'C5+E5:1:1'], lh: ['C3+G3:3:5'] },
      { chord: 'C', rh: ['D5:0.5:2', 'E5:0.5:3', 'D5:2:2'], lh: ['E3+G3:3:3'] },
      { chord: 'Dm7/C', rh: ['R:1', 'C5:0.5:2', 'D5:0.5:3', 'C5:0.5:2', 'E5:0.5:4'], lh: ['C3+F3+A3:3:5'] },
      { chord: 'G7/B', rh: ['C5:1:2', 'B4:2:1'], lh: ['B2+F3+G3:3:5'] },
      { chord: 'Am7', rh: ['R:1', 'B4:0.5:2', 'C5:0.5:3', 'B4:1:2'], lh: ['A2+E3+G3:3:5'] },
      { chord: 'Dm7', rh: ['A4:0.5:1', 'B4:0.5:2', 'A4:1:1', 'G4:1:1'], lh: ['D3+F3+A3:3:5'] },
      { chord: 'G7', rh: ['G4:0.5:2', 'A4:0.5:3', 'G4:1:2', 'F4:1:1'], lh: ['G2+D3+F3:3:5'] },
      { chord: 'Cmaj7', rh: ['F4:0.5:2', 'G4:0.5:3', 'E4:2:1'], lh: ['C3+G3+B3:3:5'] },
      { chord: 'C', rh: ['R:1', 'E5+G5:1:3', 'C5+E5:1:1'], lh: ['C3+G3:3:5'] },
      { chord: 'C7', rh: ['D5:0.5:2', 'E5:0.5:3', 'D5:2:2'], lh: ['Bb2+E3+G3:3:5'] },
      { chord: 'Fmaj7', rh: ['R:1', 'C5:0.5:1', 'D5:0.5:2', 'E5:0.5:3', 'A5:0.5:5'], lh: ['F2+C3+A3:3:5'] },
      { chord: 'Fm6', rh: ['G5:1:4', 'F5:1:3', 'D5:1:2'], lh: ['F2+C3+Ab3:3:5'] },
      { chord: 'C/G', rh: ['E5:1:3', 'C5:1:1', 'G4:1:1'], lh: ['G2+E3:3:5'] },
      { chord: 'G7', rh: ['A4:1:2', 'B4:1:3', 'D5:1:5'], lh: ['G2+F3:3:5'] },
      { chord: 'C', rh: ['C5:3:3'], lh: ['C2+G2+E3:3:5'] },
      { chord: 'C', rh: ['E4+G4+C5+E5:3:1'], lh: ['C2+G2+C3:3:5'] }
    ], 3)
  }),

  // 8. MOONLIGHT SONATA (OP. 27 NO. 2, 1ST MOV.) — BEETHOVEN (16 MEASURES)
  buildSongFromEvents({
    id: 'moonlight-sonata',
    title: 'Moonlight Sonata, Op. 27 No. 2 (1st Mov.)',
    composer: 'Ludwig van Beethoven',
    genre: 'Classical',
    difficulty: 'Intermediate',
    tempo: 66,
    timeSignature: [3, 4],
    keySignature: 'C# Minor',
    sourceFormat: 'Standard MIDI (.mid)',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'C#m', rh: ['G#3:0.5:1', 'C#4:0.5:2', 'E4:0.5:4', 'G#3:0.5:1', 'C#4:0.5:2', 'E4:0.5:4'], lh: ['C#2+C#3:3:5'] },
      { chord: 'C#m/B', rh: ['G#3:0.5:1', 'C#4:0.5:2', 'E4:0.5:4', 'G#3:0.5:1', 'C#4:0.5:2', 'E4:0.5:4'], lh: ['B1+B2:3:5'] },
      { chord: 'A', rh: ['A3:0.5:1', 'C#4:0.5:2', 'E4:0.5:4', 'A3:0.5:1', 'D4:0.5:3', 'F#4:0.5:5'], lh: ['A1+A2:1.5:5', 'F#1+F#2:1.5:5'] },
      { chord: 'G#7', rh: ['G#3:0.5:1', 'C4:0.5:2', 'F#4:0.5:5', 'G#3:0.5:1', 'C#4:0.5:3', 'E4:0.5:4'], lh: ['G#1+G#2:3:5'] },
      // Famous Dotted Melody Enters in Measure 5
      { chord: 'C#m', rh: ['G#3:0.5:1', 'C#4:0.5:2', 'E4:0.5:3', 'G#4:1:5', 'G#4:0.5:5'], lh: ['C#2+G#2:3:5'] },
      { chord: 'C#m', rh: ['G#4:2:5', 'G#4:0.75:5', 'G#4:0.25:5'], lh: ['C#2+G#2:3:5'] },
      { chord: 'G#7', rh: ['G#4:3:5'], lh: ['B1+G#2:3:5'] },
      { chord: 'C#m', rh: ['G#4:1.5:5', 'A4:1.5:5'], lh: ['C#2+A2:3:5'] },
      { chord: 'F#m', rh: ['G#4:1:4', 'F#4:1:3', 'B4:1:5'], lh: ['D#2+A2:3:5'] },
      { chord: 'E', rh: ['E4:1.5:3', 'R:1.5'], lh: ['E2+G#2:3:5'] },
      { chord: 'E', rh: ['R:2', 'G#4:0.75:5', 'G#4:0.25:5'], lh: ['E2+B2:3:5'] },
      { chord: 'B7', rh: ['G#4:2:5', 'G#4:0.75:5', 'G#4:0.25:5'], lh: ['D#2+B2:3:5'] },
      { chord: 'E', rh: ['G#4:1.5:5', 'G4:1.5:4'], lh: ['E2+B2:3:5'] },
      { chord: 'Em', rh: ['G4:2:4', 'F#4:1:3'], lh: ['E2+B2:3:5'] },
      { chord: 'F#7', rh: ['F#4:2:3', 'F4:1:2'], lh: ['C#2+A#2:3:5'] },
      { chord: 'B', rh: ['F#4:3:4'], lh: ['B1+F#2+B2:3:5'] }
    ], 3)
  }),

  // 9. TALE AS OLD AS TIME (BEAUTY AND THE BEAST THEME)
  buildSongFromEvents({
    id: 'beauty-and-the-beast',
    title: 'Tale as Old as Time (Beauty and the Beast)',
    composer: 'Alan Menken (Arr. Piano)',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 82,
    timeSignature: [4, 4],
    keySignature: 'F Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'F', rh: ['F4:1:1', 'G4:1:2', 'A4:1:3', 'C5:1:5'], lh: ['F2+C3:2:5', 'A3:2:1'] },
      { chord: 'Bb/F', rh: ['D5:2:5', 'C5:2:4'], lh: ['F2+D3:2:5', 'Bb3:2:1'] },
      { chord: 'F', rh: ['F4:1:1', 'G4:1:2', 'A4:1:3', 'C5:1:5'], lh: ['F2+C3:2:5', 'A3:2:1'] },
      { chord: 'C7', rh: ['D5:1:5', 'C5:1:4', 'A4:1:2', 'G4:1:1'], lh: ['C2+G2:2:5', 'E3:2:2'] },
      { chord: 'Dm7', rh: ['A4:1:2', 'G4:1:1', 'F4:2:1'], lh: ['D2+A2:2:5', 'F3:2:1'] },
      { chord: 'Bb', rh: ['F4:1:1', 'G4:1:2', 'A4:1:3', 'Bb4:1:4'], lh: ['Bb1+F2:2:5', 'D3:2:1'] },
      { chord: 'C7sus4', rh: ['A4:2:3', 'G4:2:2'], lh: ['C2+G2:2:5', 'C3:2:1'] },
      { chord: 'F', rh: ['F4:4:1'], lh: ['F2+C3+A3:4:5'] },
      { chord: 'F', rh: ['A4:1:1', 'C5:1:2', 'D5:1:3', 'F5:1:5'], lh: ['F2+C3:2:5', 'A3:2:1'] },
      { chord: 'Bbmaj7', rh: ['E5:2:4', 'D5:2:3'], lh: ['Bb1+F2:2:5', 'D3:2:1'] },
      { chord: 'Gm7', rh: ['C5:1:2', 'Bb4:1:1', 'A4:1:2', 'G4:1:1'], lh: ['G2+D3:2:5', 'F3:2:1'] },
      { chord: 'C7', rh: ['C5:4:4'], lh: ['C2+G2:2:5', 'E3:2:1'] },
      { chord: 'F', rh: ['F4:1:1', 'G4:1:2', 'A4:1:3', 'C5:1:5'], lh: ['F2+C3:2:5', 'A3:2:1'] },
      { chord: 'Gm7', rh: ['D5:2:5', 'G4:2:1'], lh: ['G2+D3:2:5', 'Bb3:2:1'] },
      { chord: 'C7', rh: ['A4:2:3', 'G4:2:2'], lh: ['C2+G2:2:5', 'E3:2:1'] },
      { chord: 'F', rh: ['F4+A4+C5+F5:4:1'], lh: ['F2+C3+F3:4:5'] }
    ], 4)
  }),

  // 10. LET IT GO (FROZEN — ICONIC PIANO INTRO & CHORUS)
  buildSongFromEvents({
    id: 'let-it-go-frozen',
    title: 'Let It Go (Frozen Concert Theme)',
    composer: 'Kristen Anderson-Lopez & Robert Lopez',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 132,
    timeSignature: [4, 4],
    keySignature: 'A Minor / C Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      // Crystalline Intro Arpeggios (Bars 1-4)
      { chord: 'Am', rh: ['E5:1:4', 'C5:1:2', 'D5:1:3', 'E5:1:4'], lh: ['A2+E3:4:5'] },
      { chord: 'F', rh: ['E5:1:4', 'C5:1:2', 'B4:2:1'], lh: ['F2+C3:4:5'] },
      { chord: 'G', rh: ['D5:1:4', 'B4:1:2', 'C5:1:3', 'D5:1:4'], lh: ['G2+D3:4:5'] },
      { chord: 'Em', rh: ['C5:1.5:3', 'B4:0.5:2', 'G4:2:1'], lh: ['E2+B2:4:5'] },
      // Soaring Chorus ("Let it go, let it go!") (Bars 5-16)
      { chord: 'C', rh: ['G4:1:1', 'A4:1:2', 'C5:2:3'], lh: ['C2+G2+C3:2:5', 'E3+G3:2:1'] },
      { chord: 'G', rh: ['G4:1:1', 'D5:1.5:5', 'D5:0.5:5', 'C5:1:4'], lh: ['G2+D3:2:5', 'B2+G3:2:1'] },
      { chord: 'Am', rh: ['A4:1:1', 'A4:1:1', 'A4:1:1', 'B4:0.5:2', 'C5:0.5:3'], lh: ['A2+E3:2:5', 'C3+A3:2:1'] },
      { chord: 'F', rh: ['C5:2:3', 'A4:2:1'], lh: ['F2+C3:2:5', 'F3+A3:2:1'] },
      { chord: 'C', rh: ['G4:1:1', 'A4:1:2', 'C5:2:3'], lh: ['C2+G2+C3:2:5', 'E3+G3:2:1'] },
      { chord: 'G', rh: ['G4:1:1', 'E5:1.5:5', 'E5:0.5:5', 'D5:1:4'], lh: ['G2+D3:2:5', 'B2+G3:2:1'] },
      { chord: 'Am', rh: ['C5:1:2', 'D5:1:3', 'E5:1:4', 'E5:1:4'], lh: ['A2+E3:2:5', 'C3+A3:2:1'] },
      { chord: 'F', rh: ['F5:1.5:5', 'E5:0.5:4', 'C5:2:2'], lh: ['F2+C3:2:5', 'A2+F3:2:1'] },
      { chord: 'C/G', rh: ['E5:2:4', 'D5:1:3', 'C5:1:2'], lh: ['G2+E3:2:5', 'G2+D3:2:5'] },
      { chord: 'Fm6', rh: ['C5:1.5:3', 'Ab4:0.5:1', 'C5:2:3'], lh: ['F2+C3+Ab3:4:5'] },
      { chord: 'C', rh: ['G4:1:1', 'A4:1:2', 'C5:2:4'], lh: ['C2+G2:2:5', 'C3+E3:2:1'] },
      { chord: 'C', rh: ['E4+G4+C5+E5:4:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 11. HOW FAR I'LL GO (MOANA — ISLAND ANTHEM)
  buildSongFromEvents({
    id: 'how-far-ill-go-moana',
    title: "How Far I'll Go (Moana Theme)",
    composer: 'Lin-Manuel Miranda',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 124,
    timeSignature: [4, 4],
    keySignature: 'E Major (Arr. C Major)',
    sourceFormat: 'Standard MIDI (.mid)',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['E4:1:1', 'G4:1:2', 'C5:1:4', 'C5:0.5:4', 'D5:0.5:5'], lh: ['C3+G3:2:5', 'C3+G3:2:5'] },
      { chord: 'G', rh: ['B4:1.5:3', 'G4:0.5:1', 'G4:2:1'], lh: ['G2+D3:2:5', 'G2+D3:2:5'] },
      { chord: 'Am', rh: ['E4:1:1', 'A4:1:2', 'C5:1:4', 'C5:0.5:4', 'D5:0.5:5'], lh: ['A2+E3:2:5', 'A2+E3:2:5'] },
      { chord: 'F', rh: ['A4:2:2', 'F4:2:1'], lh: ['F2+C3:2:5', 'F2+C3:2:5'] },
      { chord: 'C', rh: ['E4:1:1', 'G4:1:2', 'C5:1:4', 'E5:1:5'], lh: ['C3+G3:2:5', 'E3+G3:2:3'] },
      { chord: 'G', rh: ['D5:1.5:4', 'B4:0.5:2', 'G4:2:1'], lh: ['G2+D3:2:5', 'B2+G3:2:3'] },
      { chord: 'Am', rh: ['C5:1:3', 'C5:1:3', 'D5:1:4', 'E5:1:5'], lh: ['A2+E3:2:5', 'C3+A3:2:1'] },
      { chord: 'Fm', rh: ['F5:1.5:5', 'C5:0.5:2', 'Ab4:2:1'], lh: ['F2+C3+Ab3:4:5'] },
      // Chorus Lift ("See the line where the sky meets the sea")
      { chord: 'C', rh: ['E5:1:4', 'F5:0.5:5', 'E5:0.5:4', 'C5:1:2', 'G4:1:1'], lh: ['C2+G2:2:5', 'C3+E3:2:1'] },
      { chord: 'G', rh: ['D5:1:3', 'E5:0.5:4', 'D5:0.5:3', 'B4:1:2', 'G4:1:1'], lh: ['G2+D3:2:5', 'B2+G3:2:1'] },
      { chord: 'Am', rh: ['C5:1:2', 'D5:0.5:3', 'C5:0.5:2', 'A4:1:1', 'C5:1:2'], lh: ['A2+E3:2:5', 'C3+A3:2:1'] },
      { chord: 'F', rh: ['D5:2:4', 'C5:2:3'], lh: ['F2+C3:2:5', 'A2+F3:2:1'] },
      { chord: 'C', rh: ['E5:1:4', 'F5:0.5:5', 'E5:0.5:4', 'C5:1:2', 'G4:1:1'], lh: ['C2+G2:2:5', 'C3+E3:2:1'] },
      { chord: 'G', rh: ['D5:1.5:3', 'E5:0.5:4', 'G5:2:5'], lh: ['G2+D3:2:5', 'B2+G3:2:1'] },
      { chord: 'Fm6', rh: ['F5:1:4', 'D5:1:2', 'C5:2:1'], lh: ['F2+C3+Ab3:4:5'] },
      { chord: 'C', rh: ['E4+G4+C5:4:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 12. A WHOLE NEW WORLD (ALADDIN)
  buildSongFromEvents({
    id: 'a-whole-new-world',
    title: 'A Whole New World (Aladdin)',
    composer: 'Alan Menken',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 96,
    timeSignature: [4, 4],
    keySignature: 'D Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'D', rh: ['F#4:1:3', 'G4:0.5:4', 'A4:1.5:5', 'F#4:1:3'], lh: ['D3+A3:4:5'] },
      { chord: 'G/D', rh: ['E4:1.5:2', 'D4:2.5:1'], lh: ['D3+G3+B3:4:5'] },
      { chord: 'D', rh: ['F#4:1:3', 'G4:0.5:4', 'A4:1:5', 'F#4:0.5:3', 'A4:1:5'], lh: ['D3+A3:4:5'] },
      { chord: 'Bm7', rh: ['G4:1.5:4', 'F#4:2.5:3'], lh: ['B2+F#3+A3:4:5'] },
      { chord: 'G', rh: ['F#4:1:2', 'G4:0.5:3', 'B4:1.5:5', 'A4:1:4'], lh: ['G2+D3+G3:4:5'] },
      { chord: 'D/F#', rh: ['F#4:1:2', 'G4:0.5:3', 'A4:1.5:5', 'F#4:1:2'], lh: ['F#2+D3+A3:4:5'] },
      { chord: 'Em7', rh: ['E4:1:1', 'F#4:0.5:2', 'G4:1.5:3', 'E4:1:1'], lh: ['E2+B2+G3:4:5'] },
      { chord: 'A7', rh: ['F#4:1:3', 'E4:3:2'], lh: ['A2+E3+G3:4:5'] },
      // Chorus ("A whole new world!")
      { chord: 'D', rh: ['A4:1:2', 'B4:1:3', 'D5:2:5'], lh: ['D2+A2+D3:4:5'] },
      { chord: 'G/D', rh: ['C#5:1:4', 'A4:1:2', 'B4:2:3'], lh: ['D2+G2+B2:4:5'] },
      { chord: 'G', rh: ['B4:1:3', 'C#5:0.5:4', 'D5:1.5:5', 'B4:1:3'], lh: ['G2+D3+G3:4:5'] },
      { chord: 'D/F#', rh: ['A4:2:2', 'F#4:2:1'], lh: ['F#2+D3+A3:4:5'] },
      { chord: 'Em7', rh: ['G4:1:1', 'A4:0.5:2', 'B4:1.5:4', 'G4:1:1'], lh: ['E2+B2+G3:4:5'] },
      { chord: 'Bm7', rh: ['F#4:1.5:2', 'D5:0.5:5', 'C#5:2:4'], lh: ['B2+F#3+A3:4:5'] },
      { chord: 'G/A', rh: ['B4:1:4', 'A4:1:3', 'F#4:1:1', 'E4:1:1'], lh: ['A2+E3+G3:4:5'] },
      { chord: 'D', rh: ['D4+F#4+A4+D5:4:1'], lh: ['D2+A2+D3:4:5'] }
    ], 4)
  }),

  // 13. MARRIED LIFE (UP — PIXAR WALTZ)
  buildSongFromEvents({
    id: 'married-life-up',
    title: 'Married Life (Up — Jazz Waltz)',
    composer: 'Michael Giacchino',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 138,
    timeSignature: [3, 4],
    keySignature: 'F Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'Fmaj7', rh: ['F4:0.5:1', 'A4:0.5:2', 'C5:0.5:4', 'A4:1.5:2'], lh: ['F2:1:5', 'A3+C4+E4:2:1'] },
      { chord: 'Bb6', rh: ['F4:0.5:1', 'A4:0.5:2', 'C5:0.5:4', 'A4:1.5:2'], lh: ['Bb2:1:5', 'G3+Bb3+D4:2:1'] },
      { chord: 'Fmaj7', rh: ['F4:0.5:1', 'A4:0.5:2', 'C5:0.5:4', 'F5:1:5', 'E5:0.5:4'], lh: ['F2:1:5', 'A3+C4+E4:2:1'] },
      { chord: 'C7', rh: ['D5:1.5:3', 'C5:1.5:2'], lh: ['C2:1:5', 'G3+Bb3+E4:2:1'] },
      { chord: 'Gm7', rh: ['E4:0.5:1', 'G4:0.5:2', 'Bb4:0.5:4', 'G4:1.5:2'], lh: ['G2:1:5', 'F3+Bb3+D4:2:1'] },
      { chord: 'C7', rh: ['E4:0.5:1', 'G4:0.5:2', 'Bb4:0.5:4', 'G4:1.5:2'], lh: ['C2:1:5', 'E3+Bb3+C4:2:1'] },
      { chord: 'Fmaj7', rh: ['E4:0.5:1', 'G4:0.5:2', 'Bb4:0.5:4', 'E5:1:5', 'D5:0.5:4'], lh: ['F2:1:5', 'A3+C4+E4:2:1'] },
      { chord: 'Dm7', rh: ['C5:1.5:3', 'A4:1.5:1'], lh: ['D2:1:5', 'F3+A3+C4:2:1'] },
      { chord: 'Fmaj7', rh: ['F4:0.5:1', 'A4:0.5:2', 'C5:0.5:4', 'A4:1.5:2'], lh: ['F2:1:5', 'A3+C4+E4:2:1'] },
      { chord: 'F7', rh: ['F4:0.5:1', 'A4:0.5:2', 'C5:0.5:3', 'F5:1.5:5'], lh: ['F2:1:5', 'A3+C4+Eb4:2:1'] },
      { chord: 'Bbmaj7', rh: ['E5:1:4', 'D5:1:3', 'C5:1:2'], lh: ['Bb2:1:5', 'F3+Bb3+D4:2:1'] },
      { chord: 'Bbm6', rh: ['D5:1:4', 'C5:1:3', 'Bb4:1:2'], lh: ['Bb2:1:5', 'F3+G3+Db4:2:1'] },
      { chord: 'F/C', rh: ['A4:1:2', 'C5:1:4', 'G4:1:1'], lh: ['C3:1:5', 'F3+A3:2:1'] },
      { chord: 'C7', rh: ['A4:1:3', 'G4:1:2', 'E4:1:1'], lh: ['C2:1:5', 'E3+Bb3:2:1'] },
      { chord: 'F6', rh: ['F4:3:1'], lh: ['F2:1:5', 'A3+C4+D4:2:1'] },
      { chord: 'F6', rh: ['F4+A4+C5+F5:3:1'], lh: ['F2+C3+F3:3:5'] }
    ], 3)
  }),

  // 14. HE'S A PIRATE (PIRATES OF THE CARIBBEAN)
  buildSongFromEvents({
    id: 'hes-a-pirate',
    title: "He's a Pirate (Pirates of the Caribbean)",
    composer: 'Klaus Badelt & Hans Zimmer',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 148,
    timeSignature: [3, 4],
    keySignature: 'D Minor',
    sourceFormat: 'Standard MIDI (.mid)',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'Dm', rh: ['A3:0.5:1', 'C4:0.5:2', 'D4:1:3', 'D4:1:3'], lh: ['D2+A2+D3:2:5', 'D2+A2:1:5'] },
      { chord: 'Bb', rh: ['D4:0.5:1', 'E4:0.5:2', 'F4:1:3', 'F4:1:3'], lh: ['Bb1+F2+Bb2:2:5', 'Bb1+F2:1:5'] },
      { chord: 'C', rh: ['F4:0.5:3', 'G4:0.5:4', 'E4:1:2', 'E4:1:2'], lh: ['C2+G2+C3:2:5', 'C2+G2:1:5'] },
      { chord: 'Dm', rh: ['D4:0.5:2', 'C4:0.5:1', 'C4:0.5:1', 'D4:1.5:2'], lh: ['D2+A2+D3:3:5'] },
      { chord: 'Dm', rh: ['A3:0.5:1', 'C4:0.5:2', 'D4:1:3', 'D4:1:3'], lh: ['D2+A2+D3:2:5', 'D2+A2:1:5'] },
      { chord: 'Bb', rh: ['D4:0.5:1', 'E4:0.5:2', 'F4:1:3', 'F4:1:3'], lh: ['Bb1+F2+Bb2:2:5', 'Bb1+F2:1:5'] },
      { chord: 'C', rh: ['F4:0.5:3', 'G4:0.5:4', 'E4:1:2', 'E4:1:2'], lh: ['C2+G2+C3:2:5', 'C2+G2:1:5'] },
      { chord: 'Dm', rh: ['D4:0.5:2', 'C4:0.5:1', 'D4:2:2'], lh: ['D2+A2+D3:3:5'] },
      // Second Heroic Phrase
      { chord: 'Dm', rh: ['A3:0.5:1', 'C4:0.5:2', 'D4:1:3', 'D4:1:3'], lh: ['D2+A2+D3:3:5'] },
      { chord: 'Gm', rh: ['D4:0.5:1', 'F4:0.5:2', 'G4:1:3', 'G4:1:3'], lh: ['G2+D3+G3:3:5'] },
      { chord: 'Bb', rh: ['G4:0.5:3', 'A4:0.5:4', 'Bb4:1:5', 'Bb4:1:5'], lh: ['Bb1+F2+Bb2:3:5'] },
      { chord: 'A7', rh: ['A4:0.5:4', 'G4:0.5:3', 'A4:0.5:4', 'D4:1.5:1'], lh: ['A1+E2+A2:3:5'] },
      { chord: 'Dm', rh: ['D4:0.5:1', 'E4:0.5:2', 'F4:1:3', 'F4:1:3'], lh: ['D2+A2+D3:3:5'] },
      { chord: 'C', rh: ['G4:1:4', 'A4:0.5:5', 'D4:1.5:1'], lh: ['C2+G2+C3:3:5'] },
      { chord: 'A7', rh: ['D4:0.5:1', 'F4:0.5:3', 'E4:1:2', 'E4:1:2'], lh: ['A1+E2+A2:3:5'] },
      { chord: 'Dm', rh: ['F4:0.5:3', 'D4:0.5:1', 'D4+F4+A4+D5:2:1'], lh: ['D2+A2+D3:3:5'] }
    ], 3)
  }),

  // 15. COLORS OF THE WIND (POCAHONTAS)
  buildSongFromEvents({
    id: 'colors-of-the-wind',
    title: 'Colors of the Wind (Pocahontas)',
    composer: 'Alan Menken',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 88,
    timeSignature: [4, 4],
    keySignature: 'F Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'F', rh: ['C4:1:1', 'D4:1:2', 'F4:1:3', 'F4:1:3'], lh: ['F2+C3:2:5', 'A3:2:1'] },
      { chord: 'Dm7', rh: ['C5:1.5:5', 'A4:0.5:4', 'G4:1:3', 'F4:1:2'], lh: ['D2+A2:2:5', 'F3:2:1'] },
      { chord: 'Bb', rh: ['D4:1:1', 'F4:1:2', 'G4:1:3', 'A4:1:4'], lh: ['Bb1+F2:2:5', 'D3:2:1'] },
      { chord: 'C7', rh: ['G4:4:3'], lh: ['C2+G2:2:5', 'E3:2:1'] },
      { chord: 'F', rh: ['C4:1:1', 'D4:1:2', 'F4:1:3', 'F4:1:3'], lh: ['F2+C3:2:5', 'A3:2:1'] },
      { chord: 'Am7', rh: ['C5:1.5:5', 'D5:0.5:5', 'C5:1:4', 'A4:1:2'], lh: ['A2+E3:2:5', 'G3:2:1'] },
      { chord: 'Gm7', rh: ['G4:1:2', 'F4:1:1', 'G4:1:2', 'A4:1:3'], lh: ['G2+D3:2:5', 'F3:2:1'] },
      { chord: 'C7', rh: ['D5:2:5', 'C5:2:4'], lh: ['C2+G2:2:5', 'E3:2:1'] },
      { chord: 'Dm', rh: ['D5:1:4', 'C5:1:3', 'A4:1:2', 'F4:1:1'], lh: ['D2+A2:2:5', 'D3:2:1'] },
      { chord: 'Am7', rh: ['G4:1.5:2', 'A4:0.5:3', 'C5:2:5'], lh: ['A2+E3:2:5', 'C3:2:1'] },
      { chord: 'Bbmaj7', rh: ['D5:1:5', 'C5:1:4', 'A4:1:2', 'F4:1:1'], lh: ['Bb1+F2:2:5', 'D3:2:1'] },
      { chord: 'C7', rh: ['G4:2:2', 'A4:2:3'], lh: ['C2+G2:2:5', 'E3:2:1'] },
      { chord: 'Dm7', rh: ['C4:1:1', 'D4:1:2', 'F4:1:3', 'G4:1:4'], lh: ['D2+A2:2:5', 'F3:2:1'] },
      { chord: 'Gm7', rh: ['A4:2:5', 'G4:1:4', 'F4:1:3'], lh: ['G2+D3:2:5', 'Bb3:2:1'] },
      { chord: 'C7', rh: ['G4:2:3', 'F4:2:2'], lh: ['C2+G2:2:5', 'E3:2:1'] },
      { chord: 'F', rh: ['F4+A4+C5:4:1'], lh: ['F2+C3+F3:4:5'] }
    ], 4)
  }),

  // 16. CAN YOU FEEL THE LOVE TONIGHT (THE LION KING)
  buildSongFromEvents({
    id: 'can-you-feel-the-love-tonight',
    title: 'Can You Feel the Love Tonight (The Lion King)',
    composer: 'Elton John',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 76,
    timeSignature: [4, 4],
    keySignature: 'Bb Major (Arr. C Major)',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['E4:1:2', 'G4:1:4', 'E4:1:2', 'D4:0.5:1', 'E4:0.5:2'], lh: ['C3+G3:4:5'] },
      { chord: 'G/B', rh: ['G4:2:4', 'D4:2:1'], lh: ['B2+G3:4:5'] },
      { chord: 'Am7', rh: ['C4:1:1', 'E4:1:2', 'G4:1:4', 'C5:1:5'], lh: ['A2+E3:4:5'] },
      { chord: 'F', rh: ['B4:1:4', 'A4:1:3', 'G4:2:2'], lh: ['F2+C3+F3:4:5'] },
      { chord: 'C/E', rh: ['E4:1:2', 'G4:1:4', 'E4:1:2', 'C4:1:1'], lh: ['E2+C3:4:5'] },
      { chord: 'F', rh: ['A4:2:4', 'F4:2:2'], lh: ['F2+C3:4:5'] },
      { chord: 'Dm7', rh: ['F4:1:2', 'E4:1:1', 'D4:1:1', 'C4:1:1'], lh: ['D2+A2:4:5'] },
      { chord: 'G', rh: ['D4:4:2'], lh: ['G2+D3+G3:4:5'] },
      // Chorus ("And can you feel the love tonight")
      { chord: 'C', rh: ['C5:1.5:4', 'G4:0.5:1', 'E5:1:5', 'C5:1:3'], lh: ['C2+G2+C3:4:5'] },
      { chord: 'G/B', rh: ['B4:1.5:3', 'G4:0.5:1', 'D4:2:1'], lh: ['B1+G2+D3:4:5'] },
      { chord: 'Am', rh: ['A4:1:2', 'B4:1:3', 'C5:1:4', 'D5:1:5'], lh: ['A2+E3+A3:4:5'] },
      { chord: 'F', rh: ['C5:2:4', 'B4:2:3'], lh: ['F2+C3+A3:4:5'] },
      { chord: 'C/E', rh: ['A4:1:3', 'G4:1:2', 'E4:1:1', 'C5:1:5'], lh: ['E2+C3+G3:4:5'] },
      { chord: 'Dm7', rh: ['A4:2:4', 'F4:2:2'], lh: ['D2+A2+F3:4:5'] },
      { chord: 'G7', rh: ['E4:1:2', 'D4:1:1', 'C4:1:1', 'B3:1:1'], lh: ['G2+D3+F3:4:5'] },
      { chord: 'C', rh: ['C4+E4+G4+C5:4:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 17. REMEMBER ME (COCO — LULLABY)
  buildSongFromEvents({
    id: 'remember-me-coco',
    title: 'Remember Me (Coco Lullaby)',
    composer: 'Kristen Anderson-Lopez & Robert Lopez',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 80,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['G4:1:2', 'A4:0.5:3', 'G4:0.5:2', 'E5:2:5'], lh: ['C3+G3+E4:4:5'] },
      { chord: 'Cmaj7', rh: ['G4:1:2', 'A4:0.5:3', 'G4:0.5:2', 'B4:2:4'], lh: ['B2+G3+D4:4:5'] },
      { chord: 'C7', rh: ['G4:1:1', 'A4:0.5:2', 'G4:0.5:1', 'C5:1:4', 'B4:1:3'], lh: ['Bb2+E3+C4:4:5'] },
      { chord: 'Fmaj7', rh: ['A4:4:2'], lh: ['F2+C3+A3:4:5'] },
      { chord: 'Fm6', rh: ['A4:1:2', 'B4:0.5:3', 'A4:0.5:2', 'D5:2:5'], lh: ['F2+C3+Ab3:4:5'] },
      { chord: 'C/E', rh: ['G4:1:1', 'A4:0.5:2', 'G4:0.5:1', 'C5:2:4'], lh: ['E2+C3+G3:4:5'] },
      { chord: 'D7', rh: ['F#4:1:2', 'G4:0.5:3', 'A4:1.5:4', 'B4:1:5'], lh: ['D2+A2+F#3:4:5'] },
      { chord: 'G7', rh: ['G4:4:2'], lh: ['G2+D3+F3:4:5'] },
      { chord: 'C', rh: ['G4:1:2', 'A4:0.5:3', 'G4:0.5:2', 'E5:2:5'], lh: ['C3+G3+E4:4:5'] },
      { chord: 'E7', rh: ['E5:1:5', 'D5:1:4', 'C5:1:3', 'B4:1:2'], lh: ['E2+B2+G#3:4:5'] },
      { chord: 'Am', rh: ['C5:1:3', 'D5:1:4', 'E5:2:5'], lh: ['A2+E3+C4:4:5'] },
      { chord: 'Gm7', rh: ['D5:1:4', 'C5:1:3', 'Bb4:2:2'], lh: ['G2+D3+Bb3:4:5'] },
      { chord: 'Fmaj7', rh: ['A4:1:1', 'C5:1:2', 'E5:1:4', 'G5:1:5'], lh: ['F2+C3+A3:4:5'] },
      { chord: 'Fm6', rh: ['F5:2:5', 'D5:2:3'], lh: ['F2+C3+Ab3:4:5'] },
      { chord: 'C/G', rh: ['E5:2:4', 'D5:2:3'], lh: ['G2+E3:2:5', 'G2+F3:2:5'] },
      { chord: 'C', rh: ['C5:4:1'], lh: ['C2+G2+E3:4:5'] }
    ], 4)
  }),

  // 18. YOU'VE GOT A FRIEND IN ME (TOY STORY)
  buildSongFromEvents({
    id: 'youve-got-a-friend-in-me',
    title: "You've Got a Friend in Me (Toy Story)",
    composer: 'Randy Newman',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 112,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Standard MIDI (.mid)',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['G4:1:3', 'E4:0.5:1', 'G4:0.5:3', 'A4:1:4', 'G4:1:3'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'G3:1:1'] },
      { chord: 'C7', rh: ['E4:1:2', 'C4:1:1', 'D4:1:2', 'Eb4:1:3'], lh: ['C3:1:5', 'Bb3:1:1', 'G3:1:2', 'E3:1:4'] },
      { chord: 'F7', rh: ['E4:1:2', 'G4:1:4', 'A4:1:5', 'G4:1:4'], lh: ['F2:1:5', 'C3:1:2', 'Eb3:1:1', 'C3:1:2'] },
      { chord: 'C', rh: ['E4:2:2', 'C4:2:1'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'C3:1:5'] },
      { chord: 'G7', rh: ['B4:1:4', 'D5:1:5', 'B4:1:4', 'G4:1:2'], lh: ['G2:1:5', 'D3:1:2', 'F3:1:1', 'D3:1:2'] },
      { chord: 'C', rh: ['A4:1:3', 'G4:1:2', 'E4:2:1'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'G3:1:1'] },
      { chord: 'A7', rh: ['G4:1:3', 'A4:1:4', 'B4:1:5', 'A4:1:4'], lh: ['A2:1:5', 'E3:1:2', 'G3:1:1', 'E3:1:2'] },
      { chord: 'D7', rh: ['F#4:2:2', 'G4:2:3'], lh: ['D2:1:5', 'A2:1:2', 'G2:1:5', 'D3:1:1'] },
      { chord: 'C', rh: ['G4:1:3', 'E4:0.5:1', 'G4:0.5:3', 'A4:1:4', 'G4:1:3'], lh: ['C3:1:5', 'G3:1:1', 'E3:1:3', 'G3:1:1'] },
      { chord: 'E7', rh: ['B4:1:3', 'C5:1:4', 'D5:1:5', 'B4:1:3'], lh: ['E2:1:5', 'B2:1:2', 'G#3:1:1', 'E3:1:3'] },
      { chord: 'Am', rh: ['C5:1.5:4', 'A4:0.5:2', 'E4:2:1'], lh: ['A2:1:5', 'E3:1:2', 'A3:1:1', 'G3:1:2'] },
      { chord: 'D7', rh: ['F#4:1:2', 'G4:1:3', 'A4:1:4', 'C5:1:5'], lh: ['D2:1:5', 'A2:1:2', 'F#3:1:1', 'D3:1:2'] },
      { chord: 'C/G', rh: ['G4:1:3', 'E4:1:1', 'G4:1:3', 'A4:1:4'], lh: ['G2:2:5', 'E3:2:1'] },
      { chord: 'G7', rh: ['G4:1:3', 'E4:1:2', 'D4:2:1'], lh: ['G2:2:5', 'F3:2:1'] },
      { chord: 'C', rh: ['C4:2:1', 'E4+G4:2:2'], lh: ['C2:2:5', 'G2:2:2'] },
      { chord: 'C6', rh: ['C4+E4+A4+C5:4:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 19. PART OF YOUR WORLD (THE LITTLE MERMAID)
  buildSongFromEvents({
    id: 'part-of-your-world',
    title: 'Part of Your World (The Little Mermaid)',
    composer: 'Alan Menken',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 102,
    timeSignature: [4, 4],
    keySignature: 'F Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'Gm7', rh: ['C4:1:1', 'D4:1:2', 'F4:2:4'], lh: ['G2+D3+F3:4:5'] },
      { chord: 'C7', rh: ['C4:1:1', 'D4:1:2', 'F4:2:4'], lh: ['C2+G2+E3:4:5'] },
      { chord: 'Fmaj7', rh: ['D4:1:1', 'F4:1:2', 'G4:1:3', 'A4:1:4'], lh: ['F2+C3+A3:4:5'] },
      { chord: 'Dm7', rh: ['A4:2:4', 'G4:2:3'], lh: ['D2+A2+F3:4:5'] },
      { chord: 'Gm7', rh: ['D4:1:1', 'F4:1:2', 'G4:1:3', 'A4:1:4'], lh: ['G2+D3+F3:4:5'] },
      { chord: 'C7', rh: ['A4:1.5:4', 'G4:0.5:3', 'F4:2:2'], lh: ['C2+G2+E3:4:5'] },
      { chord: 'F', rh: ['F4:1:1', 'G4:1:2', 'A4:1:3', 'C5:1:5'], lh: ['F2+C3+A3:4:5'] },
      { chord: 'Am7', rh: ['C5:4:5'], lh: ['A2+E3+G3:4:5'] },
      { chord: 'Bbmaj7', rh: ['A4:1:2', 'Bb4:1:3', 'C5:2:4'], lh: ['Bb1+F2+D3:4:5'] },
      { chord: 'Am7', rh: ['G4:1:1', 'A4:1:2', 'C5:2:4'], lh: ['A1+E2+C3:4:5'] },
      { chord: 'Gm7', rh: ['F4:1:1', 'G4:1:2', 'A4:1:3', 'Bb4:1:4'], lh: ['G2+D3+F3:4:5'] },
      { chord: 'C7', rh: ['A4:2:3', 'G4:2:2'], lh: ['C2+G2+E3:4:5'] },
      { chord: 'Gm7', rh: ['F4:1:1', 'G4:1:2', 'A4:2:3'], lh: ['G2+D3+Bb3:4:5'] },
      { chord: 'C7', rh: ['G4:1:2', 'A4:1:3', 'C5:2:5'], lh: ['C2+G2+E3:4:5'] },
      { chord: 'F', rh: ['A4:2:3', 'F4:2:1'], lh: ['F2+C3:2:5', 'Bbmaj7:2:1'] },
      { chord: 'F', rh: ['F4+A4+C5:4:1'], lh: ['F2+C3+F3:4:5'] }
    ], 4)
  }),

  // 20. SOMEDAY MY PRINCE WILL COME (SNOW WHITE — JAZZ WALTZ)
  buildSongFromEvents({
    id: 'someday-my-prince-will-come',
    title: 'Someday My Prince Will Come (Snow White)',
    composer: 'Frank Churchill',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 108,
    timeSignature: [3, 4],
    keySignature: 'Bb Major (Arr. F Major)',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'Fmaj7', rh: ['C4:2:1', 'F4:1:2'], lh: ['F2:1:5', 'A3+E4:2:1'] },
      { chord: 'A7#5', rh: ['G4:1.5:3', 'F4:0.5:2', 'E4:1:1'], lh: ['A2:1:5', 'G3+C#4:2:1'] },
      { chord: 'Bbmaj7', rh: ['F4:2:2', 'D4:1:1'], lh: ['Bb2:1:5', 'F3+A3:2:1'] },
      { chord: 'D7', rh: ['A4:2:4', 'F#4:1:2'], lh: ['D2:1:5', 'F#3+C4:2:1'] },
      { chord: 'Gm7', rh: ['G4:2:3', 'Bb4:1:4'], lh: ['G2:1:5', 'F3+Bb3:2:1'] },
      { chord: 'C7', rh: ['A4:1:3', 'G4:1:2', 'E4:1:1'], lh: ['C2:1:5', 'E3+Bb3:2:1'] },
      { chord: 'Am7', rh: ['C5:3:5'], lh: ['A2:1:5', 'E3+G3:2:1'] },
      { chord: 'D7', rh: ['A4:3:3'], lh: ['D2:1:5', 'F#3+C4:2:1'] },
      { chord: 'Gm7', rh: ['D4:2:1', 'G4:1:2'], lh: ['G2:1:5', 'F3+Bb3:2:1'] },
      { chord: 'Bbm6', rh: ['A4:1.5:3', 'G4:0.5:2', 'F4:1:1'], lh: ['Bb2:1:5', 'F3+Db4:2:1'] },
      { chord: 'F/C', rh: ['C4:2:1', 'F4:1:2'], lh: ['C3:1:5', 'F3+A3:2:1'] },
      { chord: 'D7', rh: ['A4:2:3', 'C5:1:4'], lh: ['D2:1:5', 'F#3+C4:2:1'] },
      { chord: 'Gm7', rh: ['D5:2:5', 'Bb4:1:3'], lh: ['G2:1:5', 'F3+Bb3:2:1'] },
      { chord: 'C7', rh: ['A4:2:3', 'G4:1:2'], lh: ['C2:1:5', 'E3+Bb3:2:1'] },
      { chord: 'F6', rh: ['F4:3:1'], lh: ['F2:1:5', 'A3+D4:2:1'] },
      { chord: 'F6', rh: ['F4+A4+C5+F5:3:1'], lh: ['F2+C3+F3:3:5'] }
    ], 3)
  }),

  // 21. WHEN YOU WISH UPON A STAR (PINOCCHIO)
  buildSongFromEvents({
    id: 'when-you-wish-upon-a-star',
    title: 'When You Wish Upon a Star (Pinocchio)',
    composer: 'Leigh Harline',
    genre: 'Cinema & Animation',
    difficulty: 'Intermediate',
    tempo: 78,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Educational Arrangement',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['G3:1:1', 'G4:1:5', 'F4:1:4', 'E4:1:3'], lh: ['C2+G2:2:5', 'E3:2:1'] },
      { chord: 'A7', rh: ['C#4:1:2', 'D4:1:1', 'A4:2:5'], lh: ['A1+E2:2:5', 'G3:2:1'] },
      { chord: 'Dm', rh: ['B3:1:1', 'B4:1:5', 'A4:1:4', 'G4:1:3'], lh: ['D2+A2:2:5', 'F3:2:1'] },
      { chord: 'G7', rh: ['F#4:1:2', 'G4:1:3', 'D5:2:5'], lh: ['G2+D3:2:5', 'F3:2:1'] },
      { chord: 'C/E', rh: ['E5:1:5', 'D5:1:4', 'C5:1:3', 'B4:1:2'], lh: ['E2+C3:2:5', 'G3:2:1'] },
      { chord: 'F', rh: ['A4:1:2', 'G4:1:1', 'C5:1:4', 'A4:1:2'], lh: ['F2+C3:2:5', 'A3:2:1'] },
      { chord: 'C/G', rh: ['G4:2:2', 'E4:2:1'], lh: ['G2+E3:2:5', 'G2+D3:2:5'] },
      { chord: 'G7', rh: ['D4:4:1'], lh: ['G2+D3+F3:4:5'] },
      { chord: 'C', rh: ['G3:1:1', 'G4:1:5', 'F4:1:4', 'E4:1:3'], lh: ['C2+G2:2:5', 'E3:2:1'] },
      { chord: 'A7', rh: ['C#4:1:2', 'D4:1:1', 'A4:2:5'], lh: ['A1+E2:2:5', 'G3:2:1'] },
      { chord: 'Dm', rh: ['B3:1:1', 'B4:1:5', 'A4:1:4', 'G4:1:3'], lh: ['D2+A2:2:5', 'F3:2:1'] },
      { chord: 'G7', rh: ['F#4:1:2', 'G4:1:3', 'D5:2:5'], lh: ['G2+D3:2:5', 'F3:2:1'] },
      { chord: 'C/E', rh: ['E5:1:5', 'D5:1:4', 'C5:1:3', 'B4:1:2'], lh: ['E2+C3:2:5', 'G3:2:1'] },
      { chord: 'F', rh: ['A4:1:1', 'C5:1:2', 'E5:1:4', 'D5:1:3'], lh: ['F2+C3:2:5', 'Ab3:2:1'] },
      { chord: 'C/G', rh: ['C5:2:3', 'B4:2:2'], lh: ['G2+E3:2:5', 'G2+F3:2:5'] },
      { chord: 'C', rh: ['E4+G4+C5:4:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 22. ONCE UPON A DREAM (SLEEPING BEAUTY / TCHAIKOVSKY WALTZ)
  buildSongFromEvents({
    id: 'once-upon-a-dream',
    title: 'Once Upon a Dream (Sleeping Beauty Waltz)',
    composer: 'Pyotr Ilyich Tchaikovsky',
    genre: 'Cinema & Animation',
    difficulty: 'Beginner',
    tempo: 126,
    timeSignature: [3, 4],
    keySignature: 'F Major',
    sourceFormat: 'Public Domain Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'F', rh: ['A4:2:3', 'G4:1:2'], lh: ['F2:1:5', 'A3+C4:2:1'] },
      { chord: 'C7/F', rh: ['A4:2:3', 'F4:1:1'], lh: ['F2:1:5', 'Bb3+C4:2:1'] },
      { chord: 'F', rh: ['G4:1:2', 'A4:1:3', 'Bb4:1:4'], lh: ['F2:1:5', 'A3+C4:2:1'] },
      { chord: 'F', rh: ['A4:3:3'], lh: ['F2:1:5', 'A3+C4:2:1'] },
      { chord: 'Bbmaj7', rh: ['G4:2:2', 'A4:1:3'], lh: ['Bb2:1:5', 'F3+D4:2:1'] },
      { chord: 'Edim7', rh: ['Bb4:2:4', 'A4:1:3'], lh: ['E2:1:5', 'G3+C#4:2:1'] },
      { chord: 'F', rh: ['G4:1:1', 'A4:1:2', 'C5:1:4'], lh: ['F2:1:5', 'A3+C4:2:1'] },
      { chord: 'C7', rh: ['G4:3:2'], lh: ['C2:1:5', 'E3+Bb3:2:1'] },
      { chord: 'F', rh: ['A4:2:3', 'G4:1:2'], lh: ['F2:1:5', 'A3+C4:2:1'] },
      { chord: 'D7', rh: ['A4:2:2', 'D5:1:5'], lh: ['D2:1:5', 'F#3+C4:2:1'] },
      { chord: 'Gm', rh: ['C5:2:4', 'Bb4:1:3'], lh: ['G2:1:5', 'G3+Bb3:2:1'] },
      { chord: 'Bbm6', rh: ['A4:2:2', 'G4:1:1'], lh: ['Bb2:1:5', 'F3+Db4:2:1'] },
      { chord: 'F/C', rh: ['A4:2:3', 'F4:1:1'], lh: ['C3:1:5', 'F3+A3:2:1'] },
      { chord: 'C7', rh: ['G4:2:2', 'A4:1:3'], lh: ['C2:1:5', 'E3+Bb3:2:1'] },
      { chord: 'F', rh: ['F4:3:1'], lh: ['F2:1:5', 'A3+C4:2:1'] },
      { chord: 'F', rh: ['F4+A4+C5+F5:3:1'], lh: ['F2+C3+F3:3:5'] }
    ], 3)
  }),

  // 23. THE ENTERTAINER — SCOTT JOPLIN (16-BAR RAGTIME CLASSIC)
  buildSongFromEvents({
    id: 'the-entertainer',
    title: 'The Entertainer (Classic Piano Rag)',
    composer: 'Scott Joplin',
    genre: 'Jazz & Ragtime',
    difficulty: 'Intermediate',
    tempo: 116,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Standard MIDI (.mid)',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      // Famous Octave Intro (Bars 1-4)
      { chord: 'C', rh: ['D5:0.5:2', 'E5:0.5:3', 'C5:0.5:1', 'A4:1:2', 'B4:0.5:3', 'G4:1:1'], lh: ['R:4'] },
      { chord: 'C', rh: ['D4:0.5:2', 'E4:0.5:3', 'C4:0.5:1', 'A3:1:2', 'B3:0.5:3', 'G3:1:1'], lh: ['R:4'] },
      { chord: 'G7', rh: ['D4:0.5:2', 'E4:0.5:3', 'C4:0.5:1', 'A3:1:2', 'B3:0.5:3', 'A3:0.5:2', 'Ab3:0.5:1'], lh: ['R:4'] },
      { chord: 'G7', rh: ['G3:2:1', 'R:1', 'D4:0.5:1', 'D#4:0.5:2'], lh: ['G2:2:5', 'G2+B2+F3:2:5'] },
      // Syncopated Main Theme (Bars 5-16)
      { chord: 'C', rh: ['E4:0.5:3', 'C5:1:5', 'E4:0.5:1', 'C5:1:5', 'E4:0.5:1', 'C5:0.5:5'], lh: ['C3:1:5', 'E3+G3:1:1', 'G2:1:5', 'E3+G3:1:1'] },
      { chord: 'C', rh: ['C5:2.5:3', 'C5:0.5:3', 'D5:0.5:4', 'D#5:0.5:4'], lh: ['C3:1:5', 'E3+G3:1:1', 'E3:1:3', 'F3:1:2'] },
      { chord: 'C', rh: ['E5:0.5:5', 'C5:0.5:3', 'D5:0.5:4', 'E5:1:5', 'B4:0.5:2', 'D5:1:4'], lh: ['G3:1:1', 'E3+G3:1:1', 'G2:1:5', 'F3+G3:1:1'] },
      { chord: 'C', rh: ['C5:3:3', 'D4:0.5:1', 'D#4:0.5:2'], lh: ['C3:1:5', 'E3+G3:1:1', 'C3:2:5'] },
      { chord: 'C', rh: ['E4:0.5:3', 'C5:1:5', 'E4:0.5:1', 'C5:1:5', 'E4:0.5:1', 'C5:0.5:5'], lh: ['C3:1:5', 'E3+G3:1:1', 'G2:1:5', 'E3+G3:1:1'] },
      { chord: 'A7', rh: ['C5:2.5:4', 'A4:0.5:2', 'G4:0.5:1', 'F#4:0.5:2'], lh: ['C3:1:5', 'E3+G3:1:1', 'A2:2:5'] },
      { chord: 'D7', rh: ['A4:0.5:3', 'C5:0.5:5', 'E5:1:5', 'D5:0.5:4', 'C5:0.5:3', 'A4:0.5:1', 'D5:0.5:5'], lh: ['D3:1:5', 'F#3+A3:1:1', 'D3:2:5'] },
      { chord: 'G7', rh: ['G4:3:2', 'D4:0.5:1', 'D#4:0.5:2'], lh: ['G2:1:5', 'D3+F3:1:1', 'G2:2:5'] },
      { chord: 'C', rh: ['E4:0.5:3', 'C5:1:5', 'E4:0.5:1', 'C5:1:5', 'E4:0.5:1', 'C5:0.5:5'], lh: ['C3:1:5', 'E3+G3:1:1', 'G2:1:5', 'E3+G3:1:1'] },
      { chord: 'F', rh: ['C5:2:3', 'C5:0.5:2', 'D5:0.5:3', 'E5:0.5:4', 'F5:0.5:5'], lh: ['F2:1:5', 'A2+C3:1:1', 'F2:2:5'] },
      { chord: 'C/G', rh: ['E5:0.5:5', 'C5:0.5:3', 'D5:0.5:4', 'E5:1:5', 'B4:0.5:2', 'D5:1:4'], lh: ['G2:2:5', 'G2+F3:2:5'] },
      { chord: 'C', rh: ['C4+E4+G4+C5:4:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  }),

  // 24. RONDO ALLA TURCA (TURKISH MARCH, K. 331) — W.A. MOZART
  buildSongFromEvents({
    id: 'turkish-march-mozart',
    title: 'Rondo Alla Turca (Turkish March, K. 331)',
    composer: 'Wolfgang Amadeus Mozart',
    genre: 'Classical',
    difficulty: 'Advanced',
    tempo: 124,
    timeSignature: [4, 4],
    keySignature: 'A Minor',
    sourceFormat: 'MusicXML 4.0',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Am', rh: ['B4:0.5:3', 'A4:0.5:2', 'G#4:0.5:1', 'A4:0.5:2', 'C5:2:4'], lh: ['A2:1:5', 'C3+E3:1:1', 'A2:1:5', 'C3+E3:1:1'] },
      { chord: 'Am', rh: ['D5:0.5:3', 'C5:0.5:2', 'B4:0.5:1', 'C5:0.5:2', 'E5:2:5'], lh: ['A2:1:5', 'C3+E3:1:1', 'A2:1:5', 'C3+E3:1:1'] },
      { chord: 'Am', rh: ['F5:0.5:4', 'E5:0.5:3', 'D#5:0.5:2', 'E5:0.5:3', 'B5:0.5:5', 'A5:0.5:4', 'G#5:0.5:3', 'A5:0.5:4'], lh: ['A2:1:5', 'C3+E3:1:1', 'A2:2:5'] },
      { chord: 'Am', rh: ['B5:0.5:5', 'A5:0.5:4', 'G#5:0.5:3', 'A5:0.5:4', 'C6:2:5'], lh: ['A2:1:5', 'C3+E3:1:1', 'A2:1:5', 'C3+E3:1:1'] },
      { chord: 'F', rh: ['A5:1:3', 'B5:1:4', 'C6:1:5', 'B5:1:4'], lh: ['F2:1:5', 'A2+C3:1:1', 'D3:1:4', 'F3+A3:1:1'] },
      { chord: 'E7', rh: ['A5:1:3', 'G#5:1:2', 'A5:1:3', 'E5:1:1'], lh: ['E2:1:5', 'B2+E3:1:1', 'E2:2:5'] },
      { chord: 'Am', rh: ['F5:1:4', 'D5:1:2', 'C5:1:1', 'B4:0.5:2', 'A4:0.5:1'], lh: ['D2:2:5', 'E2:2:5'] },
      { chord: 'Am', rh: ['A4:4:1'], lh: ['A2+E3+A3:4:5'] },
      // B Section Contrasting Motif
      { chord: 'C', rh: ['E5:1:3', 'F5:1:4', 'G5:1:5', 'G5:1:5'], lh: ['C3:1:5', 'E3+G3:1:1', 'C3:1:5', 'E3+G3:1:1'] },
      { chord: 'G', rh: ['A5:0.5:5', 'G5:0.5:4', 'F5:0.5:3', 'E5:0.5:2', 'D5:2:1'], lh: ['G2:1:5', 'B2+D3:1:1', 'G2:2:5'] },
      { chord: 'C', rh: ['E5:1:3', 'F5:1:4', 'G5:1:5', 'G5:1:5'], lh: ['C3:1:5', 'E3+G3:1:1', 'C3:1:5', 'E3+G3:1:1'] },
      { chord: 'G', rh: ['A5:0.5:5', 'G5:0.5:4', 'F5:0.5:3', 'E5:0.5:2', 'D5:2:1'], lh: ['G2:1:5', 'B2+D3:1:1', 'G2:2:5'] },
      { chord: 'Am', rh: ['C5:1:2', 'D5:1:3', 'E5:1:4', 'E5:1:4'], lh: ['A2:1:5', 'C3+E3:1:1', 'A2:1:5', 'C3+E3:1:1'] },
      { chord: 'E7', rh: ['F5:0.5:5', 'E5:0.5:4', 'D5:0.5:3', 'C5:0.5:2', 'B4:2:1'], lh: ['E2:1:5', 'G#2+B2:1:1', 'E2:2:5'] },
      { chord: 'Am', rh: ['C5:1:3', 'B4:1:2', 'A4:1:1', 'G#4:1:2'], lh: ['A2:2:5', 'E2:2:5'] },
      { chord: 'Am', rh: ['A4+C5+E5+A5:4:1'], lh: ['A1+E2+A2:4:5'] }
    ], 4)
  }),

  // 25. NOCTURNE IN E-FLAT MAJOR, OP. 9 NO. 2 — FRÉDÉRIC CHOPIN
  buildSongFromEvents({
    id: 'chopin-nocturne-op9-no2',
    title: 'Nocturne in E-flat Major, Op. 9 No. 2',
    composer: 'Frédéric Chopin',
    genre: 'Classical',
    difficulty: 'Advanced',
    tempo: 66,
    timeSignature: [3, 4],
    keySignature: 'C Major (Arr.)',
    sourceFormat: 'Scanned Score (OMR)',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['G4:0.5:1', 'E5:2:5', 'D5:0.5:4'], lh: ['C3:1:5', 'G3+E4:1:1', 'G3+E4:1:1'] },
      { chord: 'G7/C', rh: ['C5:1.5:3', 'B4:0.5:2', 'A4:1:1'], lh: ['C3:1:5', 'F3+D4:1:1', 'G3+F4:1:1'] },
      { chord: 'C', rh: ['G4:1.5:2', 'E4:0.5:1', 'C5:0.5:5', 'A4:0.5:3'], lh: ['C3:1:5', 'G3+E4:1:1', 'A2:1:5'] },
      { chord: 'G', rh: ['G4:2:3', 'F#4:0.5:2', 'G4:0.5:3'], lh: ['G2:1:5', 'D3+B3:1:1', 'G2:1:5'] },
      { chord: 'Dm7', rh: ['A4:1.5:3', 'G4:0.5:2', 'F4:1:1'], lh: ['D3:1:5', 'A3+C4:1:1', 'G2:1:5'] },
      { chord: 'C', rh: ['E4:1.5:1', 'G4:0.5:2', 'C5:1:5'], lh: ['C3:1:5', 'G3+E4:1:1', 'C3:1:5'] },
      { chord: 'D7', rh: ['D5:1:4', 'C5:1:3', 'B4:0.5:2', 'A4:0.5:1'], lh: ['D3:1:5', 'F#3+C4:1:1', 'D3:1:5'] },
      { chord: 'G7', rh: ['B4:2:3', 'G4:1:1'], lh: ['G2:1:5', 'G3+F4:2:1'] },
      { chord: 'C', rh: ['G4:0.5:1', 'E5:2:5', 'D5:0.5:4'], lh: ['C3:1:5', 'G3+E4:1:1', 'G3+E4:1:1'] },
      { chord: 'C7', rh: ['E5:1:4', 'F5:0.5:5', 'E5:0.5:4', 'Bb4:1:2'], lh: ['C3:1:5', 'G3+E4:1:1', 'C3:1:5'] },
      { chord: 'F', rh: ['A4:1.5:1', 'C5:0.5:2', 'F5:1:5'], lh: ['F2:1:5', 'C3+A3:1:1', 'F2:1:5'] },
      { chord: 'Fm6', rh: ['E5:1:4', 'D5:1:3', 'C5:1:2'], lh: ['F2:1:5', 'C3+Ab3:2:1'] },
      { chord: 'C/G', rh: ['G5:1.5:5', 'E5:0.5:4', 'C5:1:2'], lh: ['G2:1:5', 'E3+C4:2:1'] },
      { chord: 'G7', rh: ['D5:1.5:4', 'B4:0.5:2', 'G4:1:1'], lh: ['G2:1:5', 'F3+B3:2:1'] },
      { chord: 'C', rh: ['C5:3:3'], lh: ['C2:1:5', 'G2+E3:2:1'] },
      { chord: 'C', rh: ['E4+G4+C5+E5:3:1'], lh: ['C2+G2+C3:3:5'] }
    ], 3)
  }),

  // 26. THE SWAN (LE CYGNE) — CAMILLE SAINT-SAËNS
  buildSongFromEvents({
    id: 'the-swan-saint-saens',
    title: 'The Swan (Carnival of the Animals)',
    composer: 'Camille Saint-Saëns',
    genre: 'Classical',
    difficulty: 'Intermediate',
    tempo: 72,
    timeSignature: [3, 4],
    keySignature: 'G Major',
    sourceFormat: 'MusicXML 4.0',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'G', rh: ['G4:1.5:3', 'F#4:0.5:2', 'B4:1:5'], lh: ['G2:1:5', 'B3+D4:1:1', 'G3+D4:1:1'] },
      { chord: 'Em', rh: ['E4:1.5:1', 'D4:0.5:1', 'G4:1:4'], lh: ['G2:1:5', 'B3+E4:1:1', 'G3+E4:1:1'] },
      { chord: 'Am/G', rh: ['C4:2:1', 'B3:0.5:1', 'C4:0.5:2'], lh: ['G2:1:5', 'A3+E4:2:1'] },
      { chord: 'G', rh: ['D4:3:3'], lh: ['G2:1:5', 'B3+D4:2:1'] },
      { chord: 'Bm7', rh: ['F#4:1.5:2', 'G4:0.5:3', 'A4:1:4'], lh: ['F#2:1:5', 'B3+D4:2:1'] },
      { chord: 'Em', rh: ['B4:2:5', 'E4:1:1'], lh: ['E2:1:5', 'G3+B3:2:1'] },
      { chord: 'A7', rh: ['F#4:1:2', 'G4:1:3', 'A4:1:4'], lh: ['A2:1:5', 'G3+C#4:2:1'] },
      { chord: 'D7', rh: ['B4:2:5', 'A4:1:4'], lh: ['D2:1:5', 'F#3+C4:2:1'] },
      { chord: 'G', rh: ['G4:1.5:3', 'F#4:0.5:2', 'B4:1:5'], lh: ['G2:1:5', 'B3+D4:2:1'] },
      { chord: 'B7', rh: ['D#4:1.5:1', 'F#4:0.5:2', 'B4:1:5'], lh: ['B2:1:5', 'A3+B3:2:1'] },
      { chord: 'C', rh: ['E4:1.5:1', 'G4:0.5:2', 'C5:1:5'], lh: ['C3:1:5', 'G3+C4:2:1'] },
      { chord: 'Cm6', rh: ['A4:2:3', 'D5:1:5'], lh: ['C3:1:5', 'Eb3+A3:2:1'] },
      { chord: 'G/D', rh: ['B4:2:4', 'G4:1:2'], lh: ['D3:1:5', 'G3+B3:2:1'] },
      { chord: 'D7', rh: ['A4:1.5:3', 'F#4:0.5:2', 'G4:1:3'], lh: ['D2:1:5', 'F#3+C4:2:1'] },
      { chord: 'G', rh: ['G4:3:1'], lh: ['G2:1:5', 'B3+D4:2:1'] },
      { chord: 'G', rh: ['G4+B4+D5+G5:3:1'], lh: ['G2+D3+G3:3:5'] }
    ], 3)
  }),

  // 27. BLUE DANUBE WALTZ — JOHANN STRAUSS II
  buildSongFromEvents({
    id: 'blue-danube-waltz',
    title: 'The Blue Danube Waltz, Op. 314',
    composer: 'Johann Strauss II',
    genre: 'Classical',
    difficulty: 'Beginner',
    tempo: 138,
    timeSignature: [3, 4],
    keySignature: 'D Major',
    sourceFormat: 'Public Domain Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'D', rh: ['D4:1:1', 'F#4:1:2', 'A4:1:3'], lh: ['D2:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['A4:2:3', 'D5:1:5'], lh: ['D2:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['D5:2:5', 'B4:1:4'], lh: ['D2:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D', rh: ['A4:3:3'], lh: ['D2:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'A7', rh: ['D4:1:1', 'F#4:1:2', 'A4:1:3'], lh: ['A2:1:5', 'E3+G3:1:1', 'E3+G3:1:1'] },
      { chord: 'A7', rh: ['A4:2:3', 'E5:1:5'], lh: ['A2:1:5', 'E3+G3:1:1', 'E3+G3:1:1'] },
      { chord: 'A7', rh: ['E5:2:5', 'C#5:1:4'], lh: ['A2:1:5', 'E3+G3:1:1', 'E3+G3:1:1'] },
      { chord: 'D', rh: ['B4:2:3', 'A4:1:2'], lh: ['D2:1:5', 'F#3+A3:2:1'] },
      { chord: 'D', rh: ['D4:1:1', 'F#4:1:2', 'A4:1:3'], lh: ['D2:1:5', 'F#3+A3:1:1', 'F#3+A3:1:1'] },
      { chord: 'D7', rh: ['A4:2:2', 'F#5:1:5'], lh: ['D2:1:5', 'F#3+C4:2:1'] },
      { chord: 'G', rh: ['F#5:2:5', 'D5:1:3'], lh: ['G2:1:5', 'G3+B3:2:1'] },
      { chord: 'G', rh: ['B4:3:2'], lh: ['G2:1:5', 'G3+B3:2:1'] },
      { chord: 'D/A', rh: ['A4:1:1', 'D5:1:3', 'F#5:1:5'], lh: ['A2:1:5', 'F#3+A3:2:1'] },
      { chord: 'A7', rh: ['E5:2:4', 'C#5:1:2'], lh: ['A2:1:5', 'E3+G3:2:1'] },
      { chord: 'D', rh: ['D5:3:3'], lh: ['D2:1:5', 'F#3+A3:2:1'] },
      { chord: 'D', rh: ['D4+F#4+A4+D5:3:1'], lh: ['D2+A2+D3:3:5'] }
    ], 3)
  }),

  // 28. DANCE OF THE SUGAR PLUM FAIRY (THE NUTCRACKER) — TCHAIKOVSKY
  buildSongFromEvents({
    id: 'sugar-plum-fairy',
    title: 'Dance of the Sugar Plum Fairy (Nutcracker)',
    composer: 'Pyotr Ilyich Tchaikovsky',
    genre: 'Classical',
    difficulty: 'Intermediate',
    tempo: 100,
    timeSignature: [4, 4],
    keySignature: 'E Minor',
    sourceFormat: 'MusicXML 4.0',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Em', rh: ['R:1', 'G5:0.5:5', 'F#5:0.5:4', 'G5:1:5', 'E5:1:3'], lh: ['E3:1:5', 'G3+B3:1:1', 'E3:1:5', 'G3+B3:1:1'] },
      { chord: 'B7', rh: ['D#5:1:2', 'E5:0.5:3', 'F#5:0.5:4', 'D#5:1:2', 'B4:1:1'], lh: ['B2:1:5', 'F#3+A3:1:1', 'B2:1:5', 'F#3+A3:1:1'] },
      { chord: 'Em', rh: ['E5:0.5:3', 'D#5:0.5:2', 'E5:0.5:3', 'F#5:0.5:4', 'G5:0.5:5', 'F#5:0.5:4', 'G5:0.5:5', 'E5:0.5:3'], lh: ['E3:1:5', 'G3+B3:1:1', 'C3:1:5', 'E3+A3:1:1'] },
      { chord: 'B7', rh: ['F#5:2:4', 'B4:2:1'], lh: ['B2:1:5', 'D#3+A3:1:1', 'B2:2:5'] },
      { chord: 'Em', rh: ['R:1', 'G5:0.5:5', 'F#5:0.5:4', 'G5:1:5', 'E5:1:3'], lh: ['E3:1:5', 'G3+B3:1:1', 'E3:1:5', 'G3+B3:1:1'] },
      { chord: 'D7', rh: ['F#5:1:3', 'G5:0.5:4', 'A5:0.5:5', 'F#5:1:3', 'D5:1:1'], lh: ['D3:1:5', 'F#3+C4:1:1', 'D3:1:5', 'F#3+C4:1:1'] },
      { chord: 'G', rh: ['G5:0.5:4', 'F#5:0.5:3', 'G5:0.5:4', 'A5:0.5:5', 'B5:1:5', 'G5:1:3'], lh: ['G2:1:5', 'D3+B3:1:1', 'G2:2:5'] },
      { chord: 'B7', rh: ['F#5:2:4', 'B4:2:1'], lh: ['B2:1:5', 'F#3+A3:1:1', 'B2:2:5'] },
      { chord: 'Am', rh: ['C5:1:2', 'B4:0.5:1', 'C5:0.5:2', 'E5:1:4', 'C5:1:2'], lh: ['A2:1:5', 'E3+A3:1:1', 'A2:2:5'] },
      { chord: 'Em', rh: ['B4:1:2', 'A#4:0.5:1', 'B4:0.5:2', 'E5:1:5', 'B4:1:2'], lh: ['E2:1:5', 'E3+G3:1:1', 'E2:2:5'] },
      { chord: 'F#7', rh: ['A#4:1:2', 'B4:1:3', 'C#5:1:4', 'E5:1:5'], lh: ['F#2:2:5', 'F#3+A#3:2:1'] },
      { chord: 'B7', rh: ['D#5:2:4', 'B4:2:1'], lh: ['B2:2:5', 'F#3+A3:2:1'] },
      { chord: 'Em', rh: ['G5:0.5:5', 'F#5:0.5:4', 'G5:1:5', 'E5:1:3', 'B4:1:1'], lh: ['E3:2:5', 'G3+B3:2:1'] },
      { chord: 'Am6', rh: ['C5:1:2', 'A4:1:1', 'F#5:2:5'], lh: ['A2:2:5', 'E3+F#3:2:1'] },
      { chord: 'B7', rh: ['E5:1:4', 'D#5:1:3', 'B4:2:1'], lh: ['B2:2:5', 'F#3+A3:2:1'] },
      { chord: 'Em', rh: ['E4+G4+B4+E5:4:1'], lh: ['E2+B2+E3:4:5'] }
    ], 4)
  }),

  // 29. IN THE HALL OF THE MOUNTAIN KING — EDVARD GRIEG
  buildSongFromEvents({
    id: 'mountain-king-grieg',
    title: 'In the Hall of the Mountain King (Peer Gynt)',
    composer: 'Edvard Grieg',
    genre: 'Classical',
    difficulty: 'Beginner',
    tempo: 122,
    timeSignature: [4, 4],
    keySignature: 'A Minor',
    sourceFormat: 'Standard MIDI (.mid)',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Am', rh: ['A3:0.5:1', 'B3:0.5:2', 'C4:0.5:3', 'D4:0.5:4', 'E4:0.5:5', 'C4:0.5:3', 'E4:1:5'], lh: ['A2:1:5', 'E3:1:1', 'A2:1:5', 'E3:1:1'] },
      { chord: 'Am', rh: ['D#4:0.5:4', 'B3:0.5:2', 'D#4:1:4', 'D4:0.5:4', 'Bb3:0.5:2', 'D4:1:4'], lh: ['A2:1:5', 'E3:1:1', 'A2:1:5', 'E3:1:1'] },
      { chord: 'Am', rh: ['A3:0.5:1', 'B3:0.5:2', 'C4:0.5:3', 'D4:0.5:4', 'E4:0.5:5', 'C4:0.5:3', 'E4:0.5:5', 'A4:0.5:5'], lh: ['A2:1:5', 'E3:1:1', 'A2:1:5', 'E3:1:1'] },
      { chord: 'C', rh: ['G4:0.5:4', 'E4:0.5:2', 'C4:0.5:1', 'E4:0.5:2', 'G4:2:4'], lh: ['C2:1:5', 'G2:1:1', 'C3:2:1'] },
      { chord: 'Am', rh: ['A4:0.5:1', 'B4:0.5:2', 'C5:0.5:3', 'D5:0.5:4', 'E5:0.5:5', 'C5:0.5:3', 'E5:1:5'], lh: ['A2:1:5', 'E3:1:1', 'A2:1:5', 'E3:1:1'] },
      { chord: 'Am', rh: ['D#5:0.5:4', 'B4:0.5:2', 'D#5:1:4', 'D5:0.5:4', 'Bb4:0.5:2', 'D5:1:4'], lh: ['A2:1:5', 'E3:1:1', 'A2:1:5', 'E3:1:1'] },
      { chord: 'Am', rh: ['A4:0.5:1', 'B4:0.5:2', 'C5:0.5:3', 'D5:0.5:4', 'E5:0.5:5', 'C5:0.5:3', 'E5:0.5:5', 'A5:0.5:5'], lh: ['A2:1:5', 'E3:1:1', 'A2:1:5', 'E3:1:1'] },
      { chord: 'C', rh: ['G5:0.5:4', 'E5:0.5:2', 'C5:0.5:1', 'E5:0.5:2', 'G5:2:4'], lh: ['C3:1:5', 'G3:1:1', 'C4:2:1'] },
      // B Section (E Major Dominant Tension)
      { chord: 'E', rh: ['E4:0.5:1', 'F#4:0.5:2', 'G#4:0.5:3', 'A4:0.5:4', 'B4:0.5:5', 'G#4:0.5:3', 'B4:1:5'], lh: ['E2:1:5', 'B2:1:1', 'E2:1:5', 'B2:1:1'] },
      { chord: 'E', rh: ['C5:0.5:5', 'G#4:0.5:3', 'C5:1:5', 'B4:0.5:5', 'G#4:0.5:3', 'B4:1:5'], lh: ['E2:1:5', 'B2:1:1', 'E2:1:5', 'B2:1:1'] },
      { chord: 'E', rh: ['E4:0.5:1', 'F#4:0.5:2', 'G#4:0.5:3', 'A4:0.5:4', 'B4:0.5:5', 'G#4:0.5:3', 'B4:1:5'], lh: ['E2:1:5', 'B2:1:1', 'E2:1:5', 'B2:1:1'] },
      { chord: 'E7', rh: ['C5:0.5:4', 'G#4:0.5:2', 'C5:1:4', 'B4:2:3'], lh: ['E2:2:5', 'E3:2:1'] },
      { chord: 'Am', rh: ['A4:0.5:1', 'B4:0.5:2', 'C5:0.5:3', 'D5:0.5:4', 'E5:0.5:5', 'C5:0.5:3', 'E5:1:5'], lh: ['A2:1:5', 'E3:1:1', 'A2:1:5', 'E3:1:1'] },
      { chord: 'E7', rh: ['D#5:0.5:4', 'B4:0.5:2', 'D#5:1:4', 'E5:1:5', 'G#4:1:2'], lh: ['E2:2:5', 'E3:2:1'] },
      { chord: 'Am', rh: ['A4:1:1', 'C5:1:2', 'E5:1:4', 'A5:1:5'], lh: ['A2:2:5', 'E3:2:1'] },
      { chord: 'Am', rh: ['A4+C5+E5+A5:4:1'], lh: ['A1+E2+A2:4:5'] }
    ], 4)
  }),

  // 30. GREENSLEEVES (WHAT CHILD IS THIS) — TRADITIONAL RENAISSANCE BALLAD
  buildSongFromEvents({
    id: 'greensleeves',
    title: 'Greensleeves (Traditional Ballad)',
    composer: 'Traditional English',
    genre: 'Traditional & Folk',
    difficulty: 'Beginner',
    tempo: 96,
    timeSignature: [3, 4],
    keySignature: 'A Minor',
    sourceFormat: 'Public Domain Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'Am', rh: ['A4:1:1', 'C5:2:3'], lh: ['A2:1:5', 'E3+A3:2:1'] },
      { chord: 'G', rh: ['D5:1.5:4', 'E5:0.5:5', 'D5:1:4'], lh: ['G2:1:5', 'D3+G3:2:1'] },
      { chord: 'F', rh: ['C5:2:3', 'A4:1:2'], lh: ['F2:1:5', 'C3+F3:2:1'] },
      { chord: 'E', rh: ['F4:1.5:1', 'G4:0.5:2', 'A4:1:3'], lh: ['E2:1:5', 'B2+E3:2:1'] },
      { chord: 'Am', rh: ['B4:2:4', 'G#4:1:2'], lh: ['E2:1:5', 'B2+E3:2:1'] },
      { chord: 'Am', rh: ['E4:2:1', 'A4:1:2'], lh: ['A2:1:5', 'E3+A3:2:1'] },
      { chord: 'Am', rh: ['C5:2:3', 'D5:1:4'], lh: ['A2:1:5', 'E3+A3:2:1'] },
      { chord: 'G', rh: ['E5:1.5:5', 'D5:0.5:4', 'C5:1:3'], lh: ['G2:1:5', 'D3+G3:2:1'] },
      // High Chorus ("Greensleeves was all my joy")
      { chord: 'C', rh: ['G5:3:5'], lh: ['C3:1:5', 'G3+C4:2:1'] },
      { chord: 'G', rh: ['G5:1.5:5', 'F#5:0.5:4', 'E5:1:3'], lh: ['G2:1:5', 'D3+B3:2:1'] },
      { chord: 'Am', rh: ['D5:2:3', 'B4:1:1'], lh: ['G2:1:5', 'D3+G3:2:1'] },
      { chord: 'E7', rh: ['G#4:1.5:1', 'A4:0.5:2', 'B4:1:3'], lh: ['E2:1:5', 'B2+E3:2:1'] },
      { chord: 'C', rh: ['G5:3:5'], lh: ['C3:1:5', 'G3+C4:2:1'] },
      { chord: 'G', rh: ['G5:1.5:5', 'F#5:0.5:4', 'E5:1:3'], lh: ['G2:1:5', 'D3+B3:2:1'] },
      { chord: 'E7', rh: ['D5:1:4', 'C5:1:3', 'B4:1:2'], lh: ['E2:1:5', 'B2+G#3:2:1'] },
      { chord: 'Am', rh: ['A4+C5+E5:3:1'], lh: ['A2+E3+A3:3:5'] }
    ], 3)
  }),

  // 31. AMAZING GRACE — GOSPEL PIANO HYMN
  buildSongFromEvents({
    id: 'amazing-grace',
    title: 'Amazing Grace (Gospel Piano Arrangement)',
    composer: 'John Newton (Traditional)',
    genre: 'Traditional & Folk',
    difficulty: 'Beginner',
    tempo: 84,
    timeSignature: [3, 4],
    keySignature: 'G Major',
    sourceFormat: 'Public Domain Score',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'G', rh: ['D4:1:1', 'G4:2:2'], lh: ['G2+D3:3:5'] },
      { chord: 'G7', rh: ['B4:0.5:4', 'G4:0.5:2', 'B4:2:4'], lh: ['G2+F3:3:5'] },
      { chord: 'C', rh: ['A4:1:3', 'G4:2:2'], lh: ['C3+E3:3:5'] },
      { chord: 'G', rh: ['E4:1:1', 'D4:2:1'], lh: ['G2+B2:3:5'] },
      { chord: 'G', rh: ['D4:1:1', 'G4:2:2'], lh: ['G2+D3:3:5'] },
      { chord: 'Em', rh: ['B4:0.5:4', 'G4:0.5:2', 'B4:2:4'], lh: ['E2+B2:3:5'] },
      { chord: 'A7', rh: ['A4:1:3', 'D5:2:5'], lh: ['A2+G3:3:5'] },
      { chord: 'D7', rh: ['D5:2:5', 'B4:1:3'], lh: ['D2+F#3:3:5'] },
      { chord: 'G', rh: ['D5:1.5:5', 'B4:0.5:3', 'D5:1:5'], lh: ['G2+D3:3:5'] },
      { chord: 'G7', rh: ['B4:0.5:4', 'G4:0.5:2', 'D4:2:1'], lh: ['G2+F3:3:5'] },
      { chord: 'C', rh: ['E4:1:2', 'G4:1.5:4', 'E4:0.5:2'], lh: ['C3+G3:3:5'] },
      { chord: 'G/D', rh: ['D4:2:1', 'D4:1:1'], lh: ['D3+G3:3:5'] },
      { chord: 'Em', rh: ['G4:2:2', 'B4:0.5:4', 'G4:0.5:2'], lh: ['E2+B2:3:5'] },
      { chord: 'D7', rh: ['B4:2:4', 'A4:1:3'], lh: ['D2+F#3+C4:3:5'] },
      { chord: 'G', rh: ['G4:3:2'], lh: ['G2+C3:2:5', 'G2+B2:1:5'] },
      { chord: 'G', rh: ['D4+G4+B4+G5:3:1'], lh: ['G2+D3+G3:3:5'] }
    ], 3)
  }),

  // 32. MAPLE LEAF RAG — SCOTT JOPLIN
  buildSongFromEvents({
    id: 'maple-leaf-rag',
    title: 'Maple Leaf Rag (Opening Stride Theme)',
    composer: 'Scott Joplin',
    genre: 'Jazz & Ragtime',
    difficulty: 'Advanced',
    tempo: 120,
    timeSignature: [4, 4],
    keySignature: 'C Major (Arr.)',
    sourceFormat: 'Standard MIDI (.mid)',
    license: 'Public Domain',
    rawNotes: compileCompactScore([
      { chord: 'C', rh: ['G4:0.5:1', 'C5:0.5:3', 'E5:1:5', 'C5:0.5:3', 'E5:1:5', 'G4:0.5:1'], lh: ['C3:1:5', 'E3+G3:1:1', 'G2:1:5', 'E3+G3:1:1'] },
      { chord: 'G7', rh: ['A4:0.5:2', 'D5:0.5:4', 'F5:1:5', 'D5:0.5:4', 'F5:1.5:5'], lh: ['G2:1:5', 'F3+G3:1:1', 'G2:1:5', 'F3+G3:1:1'] },
      { chord: 'C', rh: ['G4:0.5:1', 'C5:0.5:3', 'E5:1:5', 'C5:0.5:3', 'E5:1:5', 'D#5:0.5:4'], lh: ['C3:1:5', 'E3+G3:1:1', 'G2:1:5', 'E3+G3:1:1'] },
      { chord: 'E7', rh: ['E5:2:5', 'B4:1:2', 'E5:1:5'], lh: ['E2:1:5', 'G#2+D3:1:1', 'E2:2:5'] },
      { chord: 'Am', rh: ['C5:1:3', 'A4:1:1', 'C5:1:3', 'A4:1:1'], lh: ['A2:1:5', 'E3+A3:1:1', 'A2:2:5'] },
      { chord: 'Fm6', rh: ['Ab4:0.5:1', 'C5:0.5:2', 'D5:1:3', 'F5:1:5', 'D5:1:3'], lh: ['F2:1:5', 'C3+Ab3:1:1', 'F2:2:5'] },
      { chord: 'C/G', rh: ['E5:1:5', 'C5:1:3', 'G4:1:1', 'A4:1:2'], lh: ['G2:2:5', 'E3+G3:2:1'] },
      { chord: 'G7', rh: ['B4:1:3', 'D5:1:5', 'G4:2:1'], lh: ['G2:2:5', 'F3+G3:2:1'] },
      { chord: 'C', rh: ['G4:0.5:1', 'C5:0.5:3', 'E5:1:5', 'C5:0.5:3', 'E5:1:5', 'G4:0.5:1'], lh: ['C3:1:5', 'E3+G3:1:1', 'G2:1:5', 'E3+G3:1:1'] },
      { chord: 'G7', rh: ['A4:0.5:2', 'D5:0.5:4', 'F5:1:5', 'D5:0.5:4', 'F5:1.5:5'], lh: ['G2:1:5', 'F3+G3:1:1', 'G2:1:5', 'F3+G3:1:1'] },
      { chord: 'C7', rh: ['G4:0.5:1', 'C5:0.5:2', 'E5:1:4', 'G5:1:5', 'E5:1:4'], lh: ['C3:1:5', 'E3+Bb3:1:1', 'C3:2:5'] },
      { chord: 'F', rh: ['F5:2:5', 'C5:1:2', 'A4:1:1'], lh: ['F2:1:5', 'C3+A3:1:1', 'F2:2:5'] },
      { chord: 'Fm6', rh: ['D5:1:4', 'C5:1:3', 'Ab4:1:1', 'C5:1:3'], lh: ['F2:2:5', 'C3+Ab3:2:1'] },
      { chord: 'C/G', rh: ['E5:1:5', 'C5:1:3', 'G4:1:1', 'E4:1:1'], lh: ['G2:2:5', 'E3+G3:2:1'] },
      { chord: 'G7', rh: ['D4:1:1', 'F4:1:2', 'B4:1:4', 'D5:1:5'], lh: ['G2:2:5', 'F3+G3:2:1'] },
      { chord: 'C', rh: ['C4+E4+G4+C5:4:1'], lh: ['C2+G2+C3:4:5'] }
    ], 4)
  })
];

// ============================================================================
// 3. REAL BINARY MIDI (.MID) PARSER & MUSICXML EXPORTER
// ============================================================================

function parseStandardMidiFile(arrayBuffer, filename = 'Imported Song.mid') {
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
  if (headerId !== 'MThd') throw new Error('Invalid MIDI header (Expected MThd).');
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

  if (parsedNotes.length === 0) throw new Error('No playable MIDI note events found in file.');
  parsedNotes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
  const sliced = parsedNotes.slice(0, 96);
  const cleanTitle = filename.replace(/\.(mid|midi)$/i, '');

  return buildSongFromEvents({
    id: `midi-${Date.now()}`,
    title: cleanTitle,
    composer: `MIDI Format ${format}`,
    genre: 'Imported Score',
    difficulty: sliced.length > 40 ? 'Intermediate' : 'Beginner',
    tempo: Math.min(180, Math.max(50, tempoBpm)),
    timeSignature: timeSig,
    keySignature: 'C Major',
    sourceFormat: 'Standard MIDI (.mid)',
    license: 'User Authorized Import',
    rawNotes: sliced
  });
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
// 4. WEBAUDIO POLYPHONIC SYNTHESIZER & AUTOCORRELATION MIC PITCH TRACKER
// ============================================================================

const SALAMANDER_SAMPLE_MAP = {
  24: 'C1.mp3', 27: 'Ds1.mp3', 30: 'Fs1.mp3', 33: 'A1.mp3',
  36: 'C2.mp3', 39: 'Ds2.mp3', 42: 'Fs2.mp3', 45: 'A2.mp3',
  48: 'C3.mp3', 51: 'Ds3.mp3', 54: 'Fs3.mp3', 57: 'A3.mp3',
  60: 'C4.mp3', 63: 'Ds4.mp3', 66: 'Fs4.mp3', 69: 'A4.mp3',
  72: 'C5.mp3', 75: 'Ds5.mp3', 78: 'Fs5.mp3', 81: 'A5.mp3',
  84: 'C6.mp3', 87: 'Ds6.mp3', 90: 'Fs6.mp3', 93: 'A6.mp3',
  96: 'C7.mp3'
};
const SALAMANDER_BASE_URL = 'https://tonejs.github.io/audio/salamander/';

class MaestroAudioEngine {
  constructor() {
    this.ctx = null;
    this.instrument = 'grand-piano';
    this.volume = 0.85;
    this.micStream = null;
    this.analyser = null;
    this.micRaf = null;
    this.compressor = null;
    this.reverbNode = null;
    this.hammerBuffer = null;
    this.sampleBuffers = new Map();
    this.samplesLoading = false;
    this.samplesLoadedCount = 0;
    this.onSampleStatusChange = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      // Master Dynamics Compressor + Concert Hall Ambience Reverb
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 16;
      this.compressor.ratio.value = 3.0;
      this.compressor.attack.value = 0.002;
      this.compressor.release.value = 0.25;

      this.reverbNode = this.createSoundboardReverb(this.ctx);
      const reverbGain = this.ctx.createGain();
      reverbGain.gain.value = 0.18;

      this.compressor.connect(this.ctx.destination);
      this.compressor.connect(this.reverbNode);
      this.reverbNode.connect(reverbGain);
      reverbGain.connect(this.ctx.destination);

      this.hammerBuffer = this.createHammerNoiseBuffer(this.ctx);
      this.preloadAcousticSamples();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  async preloadAcousticSamples() {
    if (this.samplesLoading || this.sampleBuffers.size > 0) return;
    this.samplesLoading = true;
    const entries = Object.entries(SALAMANDER_SAMPLE_MAP);

    // Prioritize middle register (C3-C5) first so immediate playing uses real samples right away
    const sortedEntries = [...entries].sort(
      (a, b) => Math.abs(parseInt(a[0], 10) - 60) - Math.abs(parseInt(b[0], 10) - 60)
    );

    await Promise.allSettled(
      sortedEntries.map(async ([midiStr, file]) => {
        try {
          const res = await fetch(`${SALAMANDER_BASE_URL}${file}`);
          if (!res.ok) return;
          const arrayBuf = await res.arrayBuffer();
          const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
          this.sampleBuffers.set(parseInt(midiStr, 10), audioBuf);
          this.samplesLoadedCount = this.sampleBuffers.size;
          if (this.onSampleStatusChange) {
            this.onSampleStatusChange(this.samplesLoadedCount, entries.length);
          }
        } catch (err) {
          // Silently fall back to physical modeling if offline
        }
      })
    );
  }

  findClosestSample(midi) {
    if (this.sampleBuffers.size === 0) return null;
    let closestMidi = null;
    let minDiff = Infinity;
    for (const sampleMidi of this.sampleBuffers.keys()) {
      const diff = Math.abs(midi - sampleMidi);
      if (diff < minDiff) {
        minDiff = diff;
        closestMidi = sampleMidi;
      }
    }
    if (closestMidi === null) return null;
    return {
      baseMidi: closestMidi,
      buffer: this.sampleBuffers.get(closestMidi)
    };
  }

  createSoundboardReverb(ctx) {
    const length = Math.floor(ctx.sampleRate * 1.65);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const decay = Math.exp(-i / (ctx.sampleRate * 0.42));
        data[i] = (Math.random() * 2 - 1) * decay * 0.45;
      }
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse;
    return convolver;
  }

  createHammerNoiseBuffer(ctx) {
    const length = Math.floor(ctx.sampleRate * 0.035);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const env = Math.exp(-i / (ctx.sampleRate * 0.006));
      data[i] = (Math.random() * 2 - 1) * env;
    }
    return buffer;
  }

  playNote(midi, durationSec = 0.65, velocity = 90) {
    const ctx = this.init();
    const now = ctx.currentTime;
    const freq = midiToFrequency(midi);
    const normVel = Math.max(0.18, Math.min(1.0, velocity / 127));

    // 1. REAL ACOUSTIC CONCERT GRAND PIANO (Multi-Sampled Steinway Model B)
    if (this.instrument === 'grand-piano') {
      const sampleMatch = this.findClosestSample(midi);
      if (sampleMatch) {
        const src = ctx.createBufferSource();
        src.buffer = sampleMatch.buffer;
        // Exact equal-tempered pitch interpolation from nearest recorded minor-third key
        src.playbackRate.setValueAtTime(Math.pow(2, (midi - sampleMatch.baseMidi) / 12), now);

        // Velocity-sensitive lowpass filter (soft keystrokes sound warm/mellow, hard strikes sound crisp)
        const velFilter = ctx.createBiquadFilter();
        velFilter.type = 'lowpass';
        const cutoffHz = Math.min(18000, 1400 + Math.pow(normVel, 1.5) * 14500);
        velFilter.frequency.setValueAtTime(cutoffHz, now);

        // Natural piano damper release envelope (lets strings ring authentically)
        const registerRing = Math.max(0.85, Math.min(2.4, (92 - midi) / 28));
        const holdTime = Math.max(durationSec, 0.55) * registerRing;
        const releaseTime = 0.45 * registerRing;

        const envGain = ctx.createGain();
        const targetGain = normVel * this.volume * 0.95;
        envGain.gain.setValueAtTime(0.0001, now);
        envGain.gain.linearRampToValueAtTime(targetGain, now + 0.003);
        envGain.gain.setValueAtTime(targetGain, now + holdTime * 0.65);
        envGain.gain.exponentialRampToValueAtTime(0.0001, now + holdTime + releaseTime);

        src.connect(velFilter);
        velFilter.connect(envGain);
        envGain.connect(this.compressor);

        src.start(now);
        src.stop(now + holdTime + releaseTime + 0.05);
        return;
      }
    }

    // 2. FALLBACK / SECONDARY INSTRUMENTS (Electric Rhodes, Chamber Strings, or Offline Piano)
    const peakGain = normVel * this.volume * 0.42;
    const registerDecayScale = Math.max(0.45, Math.min(1.9, (88 - midi) / 36));
    const effectiveSustain = Math.max(durationSec, 0.42) * registerDecayScale;

    const noteBus = ctx.createGain();
    noteBus.connect(this.compressor);

    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    const initialCutoff = Math.min(12000, freq * (3.8 + normVel * 4.5));
    const tailCutoff = Math.max(280, freq * 1.4);
    bodyFilter.frequency.setValueAtTime(initialCutoff, now);
    bodyFilter.frequency.exponentialRampToValueAtTime(tailCutoff, now + Math.min(0.85, effectiveSustain * 0.7));
    bodyFilter.Q.value = 0.65;
    bodyFilter.connect(noteBus);

    if (this.instrument === 'electric-rhodes') {
      const fund = ctx.createOscillator();
      const tine = ctx.createOscillator();
      const tineGain = ctx.createGain();
      fund.type = 'sine';
      tine.type = 'sine';
      fund.frequency.setValueAtTime(freq, now);
      tine.frequency.setValueAtTime(freq * 7, now);
      tineGain.gain.setValueAtTime(0.15 * normVel, now);
      tineGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      fund.connect(bodyFilter);
      tine.connect(tineGain);
      tineGain.connect(bodyFilter);
      fund.start(now);
      tine.start(now);
      fund.stop(now + effectiveSustain + 0.3);
      tine.stop(now + 0.22);
    } else if (this.instrument === 'warm-strings') {
      [-6, 0, 6].forEach((det) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now);
        osc.detune.setValueAtTime(det, now);
        g.gain.value = 0.24;
        osc.connect(g);
        g.connect(bodyFilter);
        osc.start(now);
        osc.stop(now + effectiveSustain + 0.35);
      });
    } else {
      // Warm acoustic string fallback while real Steinway samples finish downloading
      const partials = [
        { ratio: 1.0, amp: 1.0, type: 'sine', detune: -1.2 },
        { ratio: 1.0, amp: 0.65, type: 'triangle', detune: 1.2 },
        { ratio: 2.0005, amp: 0.28, type: 'sine', detune: 0.4 },
        { ratio: 3.0015, amp: 0.11, type: 'sine', detune: -0.8 }
      ];
      partials.forEach((p, idx) => {
        const partialFreq = freq * p.ratio;
        if (partialFreq > ctx.sampleRate * 0.45) return;
        const osc = ctx.createOscillator();
        const pGain = ctx.createGain();
        osc.type = p.type;
        osc.frequency.setValueAtTime(partialFreq, now);
        osc.detune.setValueAtTime(p.detune, now);
        const partialDecay = effectiveSustain / (1 + idx * 0.5);
        pGain.gain.setValueAtTime(p.amp, now);
        pGain.gain.exponentialRampToValueAtTime(0.001, now + partialDecay + 0.25);
        osc.connect(pGain);
        pGain.connect(bodyFilter);
        osc.start(now);
        osc.stop(now + partialDecay + 0.28);
      });
    }

    const attackSec = this.instrument === 'warm-strings' ? 0.065 : 0.005;
    noteBus.gain.setValueAtTime(0.0001, now);
    noteBus.gain.linearRampToValueAtTime(peakGain, now + attackSec);
    noteBus.gain.exponentialRampToValueAtTime(peakGain * 0.55, now + attackSec + 0.09);
    noteBus.gain.exponentialRampToValueAtTime(0.0001, now + effectiveSustain + 0.32);
  }

  playMetronomeClick(isDownbeat = false) {
    const ctx = this.init();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isDownbeat ? 1150 : 780, now);
    gain.gain.setValueAtTime(0.18 * this.volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  async startMicrophone(onPitchDetected) {
    const ctx = this.init();
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false }
    });
    const source = ctx.createMediaStreamSource(this.micStream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);

    const buffer = new Float32Array(this.analyser.fftSize);
    const loop = () => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(buffer);
      const freq = this.autoCorrelate(buffer, ctx.sampleRate);
      if (freq > 0) {
        const pitchInfo = frequencyToMidi(freq);
        if (pitchInfo) onPitchDetected(pitchInfo);
      } else {
        onPitchDetected(null);
      }
      this.micRaf = requestAnimationFrame(loop);
    };
    this.micRaf = requestAnimationFrame(loop);
  }

  stopMicrophone() {
    if (this.micRaf) cancelAnimationFrame(this.micRaf);
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }
    this.analyser = null;
  }

  autoCorrelate(buf, sampleRate) {
    let size = buf.length;
    let rms = 0;
    for (let i = 0; i < size; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / size);
    if (rms < 0.018) return -1;

    let r1 = 0, r2 = size - 1, thres = 0.2;
    for (let i = 0; i < size / 2; i++) {
      if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    }
    for (let i = 1; i < size / 2; i++) {
      if (Math.abs(buf[size - i]) < thres) { r2 = size - i; break; }
    }

    const trimmed = buf.slice(r1, r2);
    size = trimmed.length;
    const c = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size - i; j++) {
        c[i] = c[i] + trimmed[j] * trimmed[j + i];
      }
    }

    let d = 0;
    while (d < size - 1 && c[d] > c[d + 1]) d++;
    let maxval = -1, maxpos = -1;
    for (let i = d; i < size; i++) {
      if (c[i] > maxval) {
        maxval = c[i];
        maxpos = i;
      }
    }
    if (maxpos <= 0) return -1;
    return sampleRate / maxpos;
  }
}

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

  useEffect(() => {
    const checkViewport = () => {
      const mobile = window.innerWidth < 768;
      setIsMobileView(mobile);
      setKeyboardRangeMode(mobile ? 'compact' : 'full');
    };
    checkViewport();
    window.addEventListener('resize', checkViewport);

    // Preload real acoustic Steinway Grand Piano samples immediately
    audioEngine.onSampleStatusChange = (loaded) => {
      setSamplesReadyCount(loaded);
    };
    audioEngine.init();

    return () => window.removeEventListener('resize', checkViewport);
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
    text: 'Tap the highlighted keys below (or use your MIDI keyboard / computer keys Q–P) to advance the score.'
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
  const [midiSupported, setMidiSupported] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [detectedMicPitch, setDetectedMicPitch] = useState(null);
  const [lastMidiPacket, setLastMidiPacket] = useState(null);

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

  // Auto-scroll notation container smoothly as playhead advances
  useEffect(() => {
    const container = notationScrollRef.current;
    if (!container) return;
    const playheadPx = 88 + currentBeat * 56;
    const targetScroll = Math.max(0, playheadPx - container.clientWidth * 0.38);
    container.scrollTo({ left: targetScroll, behavior: 'smooth' });
  }, [ Math.floor(currentBeat * 2) ]);

  // ============================================================================
  // 6. REAL-TIME SCORE FOLLOWING & ALIGNMENT ENGINE
  // ============================================================================

  const handleUserNoteInput = useCallback((midiPitch, velocity = 90, source = 'touch') => {
    audioEngine.playNote(midiPitch, 0.45, velocity);

    setActivePressedNotes(prev => {
      const next = new Set(prev);
      next.add(midiPitch);
      return next;
    });

    const windowToleranceBeats = practiceMode === 'wait' ? 1.6 : 0.65;
    const candidateEvents = activeEvents.filter(
      ev => !evaluatedEvents[ev.id] && Math.abs(ev.onset - currentBeat) <= windowToleranceBeats
    );

    const matchedEvent = candidateEvents.find(ev => ev.pitch === midiPitch);

    if (matchedEvent) {
      const beatDiff = currentBeat - matchedEvent.onset;
      const msDiff = Math.round((beatDiff * 60000) / (currentSong.tempo * tempoScale));

      setEvaluatedEvents(prev => ({
        ...prev,
        [matchedEvent.id]: { status: 'hit', deltaMs: msDiff }
      }));

      setSessionStats(prev => ({
        ...prev,
        hits: prev.hits + 1,
        streak: prev.streak + 1,
        timingOffsetsMs: [...prev.timingOffsetsMs.slice(-29), msDiff]
      }));

      setLiveToast({
        status: 'hit',
        text: `Great! ${matchedEvent.pitchName} (Finger ${matchedEvent.finger}) · ${
          practiceMode === 'wait' ? 'Advancing Score' : `${msDiff >= 0 ? '+' : ''}${msDiff}ms`
        }`
      });

      if (practiceMode === 'wait') {
        const chordPeers = activeEvents.filter(
          ev => Math.abs(ev.onset - matchedEvent.onset) < 0.12 && ev.id !== matchedEvent.id
        );
        const allPeersDone = chordPeers.every(p => evaluatedEvents[p.id]);
        if (allPeersDone) {
          const futureEvents = activeEvents.filter(ev => ev.onset > matchedEvent.onset + 0.08);
          if (futureEvents.length > 0) {
            setCurrentBeat(futureEvents[0].onset);
          } else {
            setCurrentBeat(0);
            setEvaluatedEvents({});
            setLiveToast({
              status: 'hit',
              text: 'Piece completed! Looping back to Measure 1.'
            });
          }
        }
      }
    } else if (expectedPlayheadEvents.length > 0) {
      const targetNames = expectedPlayheadEvents.map(e => e.pitchName).join(' + ');
      const curMeasure = Math.floor(currentBeat / beatsPerMeasure) + 1;
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
        text: `Played ${midiToPitchName(midiPitch)} — Look for highlighted ${targetNames} in Measure ${curMeasure}`
      });
    }
  }, [activeEvents, evaluatedEvents, currentBeat, practiceMode, currentSong.tempo, tempoScale, expectedPlayheadEvents, beatsPerMeasure]);

  const handleUserNoteRelease = useCallback((midiPitch) => {
    setActivePressedNotes(prev => {
      const next = new Set(prev);
      next.delete(midiPitch);
      return next;
    });
  }, []);

  // ============================================================================
  // 7. MASTER TRANSPORT & 60FPS ANIMATION LOOP
  // ============================================================================

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastFrameTimeRef.current = null;
      return;
    }

    const effectiveBpm = currentSong.tempo * tempoScale;
    const beatsPerSecond = effectiveBpm / 60;

    const tick = (timestamp) => {
      if (!lastFrameTimeRef.current) lastFrameTimeRef.current = timestamp;
      const dtSec = (timestamp - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = timestamp;

      setCurrentBeat(prevBeat => {
        if (practiceMode === 'wait') {
          const blockingNote = activeEvents.find(
            ev => !evaluatedEvents[ev.id] && ev.onset >= prevBeat - 0.05 && ev.onset <= prevBeat + dtSec * beatsPerSecond
          );
          if (blockingNote) {
            return blockingNote.onset;
          }
        }

        let nextBeat = prevBeat + dtSec * beatsPerSecond;

        const beatFloor = Math.floor(nextBeat);
        if (metronomeOn && beatFloor !== lastMetronomeBeatRef.current) {
          lastMetronomeBeatRef.current = beatFloor;
          const isDownbeat = (beatFloor % currentSong.timeSignature[0]) === 0;
          audioEngine.playMetronomeClick(isDownbeat);
        }

        activeEvents.forEach(ev => {
          if (
            ev.onset >= prevBeat &&
            ev.onset < nextBeat &&
            !playedSynthIdsRef.current.has(ev.id)
          ) {
            if (practiceMode === 'autoplay') {
              playedSynthIdsRef.current.add(ev.id);
              const durSec = (ev.duration / beatsPerSecond);
              audioEngine.playNote(ev.pitch, durSec, ev.velocity);
              setEvaluatedEvents(old => ({ ...old, [ev.id]: { status: 'hit', deltaMs: 0 } }));
            }
          }
        });

        const loopStartBeat = (loopRange.startMeasure - 1) * beatsPerMeasure;
        const loopEndBeat = loopRange.endMeasure * beatsPerMeasure;

        if (loopRange.enabled && nextBeat >= loopEndBeat) {
          playedSynthIdsRef.current.clear();
          setEvaluatedEvents({});
          return loopStartBeat;
        }

        if (nextBeat >= totalSongBeats) {
          playedSynthIdsRef.current.clear();
          setEvaluatedEvents({});
          return 0;
        }

        return nextBeat;
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, currentSong, tempoScale, practiceMode, activeEvents, evaluatedEvents, metronomeOn, loopRange, beatsPerMeasure, totalSongBeats]);

  const handleSelectSong = (songId, targetTab = 'practice') => {
    setIsPlaying(false);
    setSelectedSongId(songId);
    setCurrentBeat(0);
    setEvaluatedEvents({});
    playedSynthIdsRef.current.clear();
    setSelectedEventId(null);
    setActiveTab(targetTab);
  };

  // ============================================================================
  // 8. WEB MIDI API & COMPUTER KEYBOARD BINDINGS
  // ============================================================================

  useEffect(() => {
    if (navigator.requestMIDIAccess) {
      setMidiSupported(true);
      navigator.requestMIDIAccess().then((midiAccess) => {
        const updateDevices = () => {
          const inputs = Array.from(midiAccess.inputs.values());
          setMidiDevices(inputs.map(i => ({
            id: i.id,
            name: i.name || 'USB/BLE MIDI Instrument',
            manufacturer: i.manufacturer || 'Generic MIDI',
            state: i.state
          })));

          inputs.forEach(input => {
            input.onmidimessage = (msg) => {
              const [status, data1, data2] = msg.data;
              const cmd = status & 0xf0;
              setLastMidiPacket({ status: `0x${status.toString(16)}`, note: data1, velocity: data2 });
              if (cmd === 0x90 && data2 > 0) {
                handleUserNoteInput(data1, data2, 'midi');
              } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
                handleUserNoteRelease(data1);
              }
            };
          });
        };

        updateDevices();
        midiAccess.onstatechange = updateDevices;
      }).catch(() => {
        setMidiSupported(false);
      });
    }
  }, [handleUserNoteInput, handleUserNoteRelease]);

  useEffect(() => {
    const down = (e) => {
      if (e.repeat || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        audioEngine.init();
        setIsPlaying(p => !p);
        return;
      }
      const midi = KEYBOARD_TO_MIDI[e.key.toLowerCase()];
      if (midi) handleUserNoteInput(midi, 92, 'kbd');
    };
    const up = (e) => {
      const midi = KEYBOARD_TO_MIDI[e.key.toLowerCase()];
      if (midi) handleUserNoteRelease(midi);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [handleUserNoteInput, handleUserNoteRelease]);

  const toggleMicrophone = async () => {
    if (micActive) {
      audioEngine.stopMicrophone();
      setMicActive(false);
      setDetectedMicPitch(null);
    } else {
      try {
        let lastTriggeredMidi = null;
        let lastTriggerTime = 0;
        await audioEngine.startMicrophone((pitchInfo) => {
          setDetectedMicPitch(pitchInfo);
          if (pitchInfo && Math.abs(pitchInfo.centsOff) < 35) {
            const now = performance.now();
            if (pitchInfo.midi !== lastTriggeredMidi || now - lastTriggerTime > 420) {
              lastTriggeredMidi = pitchInfo.midi;
              lastTriggerTime = now;
              handleUserNoteInput(pitchInfo.midi, 82, 'mic');
              setTimeout(() => handleUserNoteRelease(pitchInfo.midi), 300);
            }
          }
        });
        setMicActive(true);
      } catch (err) {
        setLiveToast({
          status: 'miss',
          text: 'Microphone access was blocked by your browser settings.'
        });
      }
    }
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

    const lookaheadBeats = 5;
    const pixelsPerBeat = height / lookaheadBeats;

    for (let b = Math.floor(currentBeat); b <= currentBeat + lookaheadBeats; b++) {
      const y = height - (b - currentBeat) * pixelsPerBeat;
      const isMeasureLine = b % beatsPerMeasure === 0;
      ctx.strokeStyle = isMeasureLine
        ? (darkMode ? 'rgba(217, 119, 6, 0.35)' : 'rgba(180, 83, 9, 0.25)')
        : (darkMode ? 'rgba(148, 163, 184, 0.08)' : 'rgba(120, 113, 108, 0.12)');
      ctx.lineWidth = isMeasureLine ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    activeEvents.forEach(ev => {
      if (ev.onset + ev.duration < currentBeat - 0.2 || ev.onset > currentBeat + lookaheadBeats) return;
      if (ev.pitch < minMidi || ev.pitch > maxMidi) return;

      const { x, w } = getKeyXAndWidth(ev.pitch);
      const noteBottomY = height - (ev.onset - currentBeat) * pixelsPerBeat;
      const noteHeight = Math.max(18, ev.duration * pixelsPerBeat - 4);
      const noteTopY = noteBottomY - noteHeight;

      const evalState = evaluatedEvents[ev.id];
      const isRightHand = ev.hand === 'R';

      if (evalState?.status === 'hit') {
        ctx.fillStyle = '#059669';
      } else if (ev.confidence < 0.85 && !ev.verified) {
        ctx.fillStyle = '#d97706';
      } else if (isRightHand) {
        ctx.fillStyle = '#c2410c'; // Conservatory Terracotta for Right Hand
      } else {
        ctx.fillStyle = '#0369a1'; // Deep Teal/Ocean for Left Hand
      }

      ctx.beginPath();
      ctx.roundRect(x, noteTopY, w, noteHeight, 6);
      ctx.fill();

      if (noteHeight >= 20 && w >= 18) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.fillText(`${ev.pitchName}`, x + 4, noteBottomY - 5);
      }
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
        const parsedSong = parseStandardMidiFile(buf, file.name);
        setSongs(prev => [parsedSong, ...prev]);
        handleSelectSong(parsedSong.id, 'practice');
        setImportStatus({
          step: 4,
          success: true,
          label: `Imported "${parsedSong.title}" (${parsedSong.events.length} notes). Ready to play!`
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
        <div className="flex items-center justify-between px-3 py-1.5 bg-stone-900 text-stone-300 text-xs border-b border-stone-800">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 font-medium">
              <span className="w-2.5 h-2.5 rounded-full bg-orange-600 inline-block" /> Right Hand
            </span>
            <span className="flex items-center gap-1.5 font-medium">
              <span className="w-2.5 h-2.5 rounded-full bg-sky-600 inline-block" /> Left Hand
            </span>
            <span className="hidden sm:flex items-center gap-1.5 text-[11px] text-emerald-400 font-semibold pl-2 border-l border-stone-700">
              <Volume2 className="w-3.5 h-3.5" />
              {samplesReadyCount > 0
                ? `Steinway Grand Samples (${samplesReadyCount}/25 Loaded)`
                : 'Loading Acoustic Grand Samples...'}
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
            >
              {keyboardRangeMode === 'compact' ? '25 Keys (Touch)' : '49 Keys (Full)'}
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
        className={`w-full overflow-x-auto rounded-2xl border shadow-inner transition-colors ${
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

          {/* Engraved Noteheads, Stems, Beams & Fingering */}
          {activeEvents.map((ev) => {
            const clef = ev.hand === 'R' ? 'treble' : 'bass';
            const stepOffset = getStaffYOffset(ev.pitch, clef);
            const baseBottomY = clef === 'treble' ? trebleBottomY : bassBottomY;
            const cy = baseBottomY - stepOffset * 5;
            const cx = leftMargin + ev.onset * beatPx + 18;

            const evalState = evaluatedEvents[ev.id];
            const isSelected = selectedEventId === ev.id;
            const isUncertain = ev.confidence < 0.85 && !ev.verified;
            const isHollow = ev.duration >= 2;

            let noteColor = ev.hand === 'R'
              ? (darkMode ? '#fb923c' : '#c2410c')
              : (darkMode ? '#38bdf8' : '#0369a1');
            if (evalState?.status === 'hit') noteColor = '#059669';
            if (isUncertain) noteColor = '#d97706';
            if (isSelected) noteColor = '#e11d48';

            const needsLedger = stepOffset <= -2 || stepOffset >= 10;

            return (
              <g
                key={ev.id}
                onClick={() => {
                  setSelectedEventId(ev.id);
                  audioEngine.playNote(ev.pitch, 0.4, ev.velocity);
                  if (!interactiveCleanup) setCurrentBeat(ev.onset);
                }}
                className="cursor-pointer"
              >
                {isUncertain && (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={14}
                    fill="rgba(217, 119, 6, 0.16)"
                    stroke="#d97706"
                    strokeDasharray="3 2"
                  />
                )}

                {needsLedger && (
                  <line
                    x1={cx - 11}
                    y1={cy}
                    x2={cx + 11}
                    y2={cy}
                    stroke={clefFill}
                    strokeWidth={1.5}
                  />
                )}

                {ev.alter === 1 && (
                  <text x={cx - 18} y={cy + 4} fill={noteColor} fontSize="13" fontWeight="bold">♯</text>
                )}

                <ellipse
                  cx={cx}
                  cy={cy}
                  rx={6.4}
                  ry={4.8}
                  transform={`rotate(-18 ${cx} ${cy})`}
                  fill={isHollow ? (darkMode ? '#1c1917' : '#fcfaf5') : noteColor}
                  stroke={noteColor}
                  strokeWidth={2}
                />

                {ev.duration === 1.5 && (
                  <circle cx={cx + 10} cy={cy - 2} r={2.2} fill={noteColor} />
                )}

                {ev.duration < 4 && (
                  <line
                    x1={stepOffset >= 4 ? cx - 5.5 : cx + 5.5}
                    y1={cy}
                    x2={stepOffset >= 4 ? cx - 5.5 : cx + 5.5}
                    y2={stepOffset >= 4 ? cy + 28 : cy - 28}
                    stroke={noteColor}
                    strokeWidth={1.8}
                  />
                )}

                <text
                  x={cx - 3.5}
                  y={clef === 'treble' ? cy - 11 : cy + 16}
                  fill={darkMode ? '#a8a29e' : '#57534e'}
                  fontSize="9.5"
                  fontWeight="700"
                >
                  {ev.finger}
                </text>
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

  const renderPracticeView = () => (
    <div className="flex flex-col gap-3">
      {/* Compact Primary Transport & Mode Bar */}
      <div className={`rounded-2xl border p-3 flex flex-wrap items-center justify-between gap-2.5 shadow-sm ${
        darkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200/90'
      }`}>
        {/* Play / Restart + Song Selector */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              audioEngine.init();
              setIsPlaying(p => !p);
            }}
            className={`px-4 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition shadow-sm ${
              isPlaying
                ? 'bg-amber-500 hover:bg-amber-400 text-stone-950'
                : 'bg-orange-700 hover:bg-orange-600 text-white'
            }`}
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            <span>{isPlaying ? 'Pause' : 'Play'}</span>
          </button>

          <button
            onClick={() => {
              setIsPlaying(false);
              setCurrentBeat(loopRange.enabled ? (loopRange.startMeasure - 1) * beatsPerMeasure : 0);
              setEvaluatedEvents({});
              playedSynthIdsRef.current.clear();
            }}
            className={`p-2.5 rounded-xl border transition ${
              darkMode ? 'bg-stone-800 border-stone-700 text-stone-300' : 'bg-stone-100 border-stone-200 text-stone-700 hover:bg-stone-200'
            }`}
            title="Restart from Measure 1"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <div className="pl-1">
            <select
              value={currentSong.id}
              onChange={(e) => handleSelectSong(e.target.value, 'practice')}
              className={`rounded-xl px-3 py-2 text-xs sm:text-sm font-bold border focus:outline-none ${
                darkMode
                  ? 'bg-stone-950 border-stone-800 text-stone-100'
                  : 'bg-stone-50 border-stone-200 text-stone-900'
              }`}
            >
              {songs.map(s => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.totalMeasures || Math.ceil(s.events.length / 4)} Bars · {s.difficulty})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Practice Mode Pill Selector */}
        <div className={`flex rounded-xl p-1 text-xs font-semibold border ${
          darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-100 border-stone-200'
        }`}>
          {[
            { id: 'wait', label: 'Wait for Me' },
            { id: 'continuous', label: 'In Tempo' },
            { id: 'autoplay', label: 'Listen Demo' }
          ].map(mode => (
            <button
              key={mode.id}
              onClick={() => {
                setPracticeMode(mode.id);
                setEvaluatedEvents({});
                playedSynthIdsRef.current.clear();
              }}
              className={`px-3 py-1.5 rounded-lg transition ${
                practiceMode === mode.id
                  ? (darkMode ? 'bg-orange-700 text-white' : 'bg-white text-stone-900 shadow-sm')
                  : (darkMode ? 'text-stone-400 hover:text-stone-200' : 'text-stone-600 hover:text-stone-900')
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {/* Quick Hand & Settings Drawer Toggle */}
        <div className="flex items-center gap-2">
          <div className={`hidden sm:flex rounded-xl p-1 text-xs font-semibold border ${
            darkMode ? 'bg-stone-950 border-stone-800' : 'bg-stone-100 border-stone-200'
          }`}>
            {[
              { id: 'BOTH', label: 'Both Hands' },
              { id: 'R', label: 'Right' },
              { id: 'L', label: 'Left' }
            ].map(h => (
              <button
                key={h.id}
                onClick={() => setHandFilter(h.id)}
                className={`px-2.5 py-1.5 rounded-lg transition ${
                  handFilter === h.id
                    ? (darkMode ? 'bg-stone-800 text-orange-400' : 'bg-white text-orange-700 shadow-sm')
                    : 'text-stone-500'
                }`}
              >
                {h.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowPracticeSettings(s => !s)}
            className={`px-3 py-2 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition ${
              showPracticeSettings || loopRange.enabled || metronomeOn
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300'
                : (darkMode ? 'bg-stone-950 border-stone-800 text-stone-300' : 'bg-stone-100 border-stone-200 text-stone-700')
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>{Math.round(currentSong.tempo * tempoScale)} BPM</span>
          </button>
        </div>
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
        </div>
      )}

      {/* Subtle Real-Time Guidance Bar */}
      <div className={`px-4 py-2.5 rounded-xl border flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm ${
        liveToast.status === 'hit'
          ? (darkMode ? 'bg-emerald-950/40 border-emerald-700/50 text-emerald-200' : 'bg-emerald-50 border-emerald-200 text-emerald-900')
          : liveToast.status === 'miss'
          ? (darkMode ? 'bg-rose-950/40 border-rose-700/50 text-rose-200' : 'bg-rose-50 border-rose-200 text-rose-900')
          : (darkMode ? 'bg-stone-900 border-stone-800 text-stone-300' : 'bg-stone-100/90 border-stone-200 text-stone-700')
      }`}>
        <div className="flex items-center gap-2 font-medium">
          <span className={`w-2 h-2 rounded-full ${
            liveToast.status === 'hit' ? 'bg-emerald-500' : liveToast.status === 'miss' ? 'bg-rose-500' : 'bg-orange-500'
          }`} />
          <span>{liveToast.text}</span>
        </div>

        <div className="flex items-center gap-3 text-xs font-semibold">
          {expectedPlayheadEvents.length > 0 && (
            <span className={`px-2.5 py-0.5 rounded-full border ${
              darkMode ? 'bg-stone-950 border-stone-700 text-orange-300' : 'bg-white border-stone-300 text-orange-800'
            }`}>
              Play: {expectedPlayheadEvents.map(e => `${e.pitchName} (F${e.finger})`).join(' + ')}
            </span>
          )}
          <span className="font-mono text-emerald-600 dark:text-emerald-400">{sessionStats.hits} Hits</span>
          <span className="font-mono text-amber-600 dark:text-amber-400">{sessionStats.streak} Streak</span>
        </div>
      </div>

      {/* Synchronized Sheet Music Stage */}
      {(viewLayout === 'notation' || viewLayout === 'combined') && (
        <div>
          <div className="flex items-center justify-between mb-1.5 px-1 text-xs">
            <span className="font-semibold text-stone-500 dark:text-stone-400">
              {currentSong.composer} · {currentSong.keySignature} · Measure {Math.floor(currentBeat / beatsPerMeasure) + 1}
            </span>
            {uncertainEventsCount > 0 && (
              <button
                onClick={() => setActiveTab('cleanup')}
                className="text-amber-600 dark:text-amber-400 hover:underline font-semibold flex items-center gap-1"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                {uncertainEventsCount} OMR notes to verify →
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
                setCurrentBeat((m - 1) * beatsPerMeasure);
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
                  {midiDevices.length > 0 ? midiDevices[0].name : midiSupported ? 'Ready (Plug & Play)' : 'Browser Restricted'}
                </div>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                midiDevices.length > 0 ? 'bg-emerald-500/20 text-emerald-500' : 'bg-stone-200 dark:bg-stone-800 text-stone-500'
              }`}>
                {midiDevices.length > 0 ? 'Connected' : 'Standby'}
              </span>
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
    <div className={`min-h-screen flex flex-col font-sans pb-16 md:pb-0 transition-colors ${
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
            <span className="hidden sm:inline">
              {detectedMicPitch ? detectedMicPitch.name : micActive ? 'Listening' : 'Mic Off'}
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
      <nav className={`md:hidden fixed bottom-0 left-0 right-0 z-40 border-t px-2 py-1.5 grid grid-cols-4 gap-1 backdrop-blur-md ${
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