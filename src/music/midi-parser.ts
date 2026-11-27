import * as ToneMidi from '@tonejs/midi';
import type { Midi as MidiType } from '@tonejs/midi';
import {
  getDiatonicSpelling,
  keySignatureLabel,
  keySignatureSf,
  midiToPitchName,
  prefersFlatsForKey,
} from './pitch';
import type {
  Hand,
  KeySigPoint,
  NoteEvent,
  PedalEvent,
  Score,
  TempoPoint,
  TimeSigPoint,
} from './types';

// @tonejs/midi ships UMD on "main" and CJS on "module", so Vite SSR exposes
// Midi either directly on the namespace or nested under .default.
const MidiCtor =
  (ToneMidi as { Midi?: typeof MidiType; default?: { Midi?: typeof MidiType } }).Midi ??
  (ToneMidi as { default?: { Midi?: typeof MidiType } }).default?.Midi;

export interface ParsedMidiResult {
  song: Score;
  kept: number;
  dropped: number;
}

export type PracticeMidiReadResult =
  | { ok: true; song: Score; kept: number; dropped: number }
  | { ok: false; reason: 'empty' | 'bad' };

interface MeasureSegment {
  startBeat: number;
  endBeat: number;
  startMeasure: number;
  beatsPerMeasure: number;
}

function createCodedError(message: string, code: 'midi-bad' | 'midi-empty'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function assertMidiHeader(arrayBuffer: ArrayBuffer): void {
  const bytes = new Uint8Array(arrayBuffer);
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x4d ||
    bytes[1] !== 0x54 ||
    bytes[2] !== 0x68 ||
    bytes[3] !== 0x64
  ) {
    throw createCodedError('Invalid MIDI header (Expected MThd).', 'midi-bad');
  }
}

function medianPitch(midis: number[]): number {
  const sorted = [...midis].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function extractTempos(midi: MidiType, ppq: number): TempoPoint[] {
  const raw = [...midi.header.tempos]
    .filter((t) => Number.isFinite(t.bpm) && t.bpm > 0)
    .sort((a, b) => a.ticks - b.ticks);

  if (raw.length === 0) {
    return [{ tick: 0, beat: 0, timeSec: 0, bpm: 120 }];
  }

  const deduped: TempoPoint[] = [];
  for (const t of raw) {
    const beat = t.ticks / ppq;
    const prev = deduped[deduped.length - 1];
    if (prev && prev.tick === t.ticks) {
      prev.bpm = t.bpm;
      continue;
    }
    const timeSec =
      typeof t.time === 'number' && Number.isFinite(t.time)
        ? t.time
        : prev
          ? prev.timeSec + (beat - prev.beat) * (60 / prev.bpm)
          : beat * (60 / t.bpm);
    deduped.push({ tick: t.ticks, beat, timeSec, bpm: t.bpm });
  }
  return deduped;
}

function extractTimeSignatures(midi: MidiType, ppq: number): TimeSigPoint[] {
  const raw = [...midi.header.timeSignatures].sort((a, b) => a.ticks - b.ticks);
  if (raw.length === 0) {
    return [{ tick: 0, beat: 0, numerator: 4, denominator: 4 }];
  }

  const deduped: TimeSigPoint[] = [];
  for (const ts of raw) {
    const numerator = ts.timeSignature[0] > 0 ? ts.timeSignature[0] : 4;
    const denominator = ts.timeSignature[1] > 0 ? ts.timeSignature[1] : 4;
    const prev = deduped[deduped.length - 1];
    if (prev && prev.tick === ts.ticks) {
      prev.numerator = numerator;
      prev.denominator = denominator;
      continue;
    }
    deduped.push({ tick: ts.ticks, beat: ts.ticks / ppq, numerator, denominator });
  }
  return deduped;
}

function extractKeySignatures(midi: MidiType, ppq: number): KeySigPoint[] {
  const raw = [...midi.header.keySignatures].sort((a, b) => a.ticks - b.ticks);
  if (raw.length === 0) {
    return [{ tick: 0, beat: 0, key: 'C', scale: 'major', sf: 0, preferFlats: false }];
  }

  const deduped: KeySigPoint[] = [];
  for (const ks of raw) {
    const scale: 'major' | 'minor' = ks.scale === 'minor' ? 'minor' : 'major';
    const key = ks.key || 'C';
    const sf = keySignatureSf(key, scale);
    const preferFlats = prefersFlatsForKey(key, scale);
    const prev = deduped[deduped.length - 1];
    if (prev && prev.tick === ks.ticks) {
      prev.key = key;
      prev.scale = scale;
      prev.sf = sf;
      prev.preferFlats = preferFlats;
      continue;
    }
    deduped.push({ tick: ks.ticks, beat: ks.ticks / ppq, key, scale, sf, preferFlats });
  }
  return deduped;
}

function buildMeasureSegments(timeSignatures: TimeSigPoint[]): MeasureSegment[] {
  const segments: MeasureSegment[] = [];
  let currentMeasure = 1;

  if (timeSignatures[0].beat > 0) {
    const beatsPerMeasure = 4;
    const endBeat = timeSignatures[0].beat;
    const count = Math.ceil(Math.max(0, endBeat - 1e-6) / beatsPerMeasure);
    segments.push({ startBeat: 0, endBeat, startMeasure: currentMeasure, beatsPerMeasure });
    currentMeasure += count;
  }

  for (let i = 0; i < timeSignatures.length; i += 1) {
    const ts = timeSignatures[i];
    const beatsPerMeasure = ts.numerator * (4 / ts.denominator);
    const nextBeat = i + 1 < timeSignatures.length ? timeSignatures[i + 1].beat : Infinity;
    segments.push({
      startBeat: ts.beat,
      endBeat: nextBeat,
      startMeasure: currentMeasure,
      beatsPerMeasure,
    });
    if (Number.isFinite(nextBeat)) {
      const span = Math.max(0, nextBeat - ts.beat);
      currentMeasure += Math.ceil(Math.max(0, span - 1e-6) / beatsPerMeasure);
    }
  }

  return segments;
}

function measureAndBeatAt(
  segments: MeasureSegment[],
  onsetBeat: number,
): { measure: number; beat: number } {
  let seg = segments[0];
  for (let i = 0; i < segments.length; i += 1) {
    if (onsetBeat >= segments[i].startBeat - 1e-6) {
      seg = segments[i];
    } else {
      break;
    }
  }
  const offset = Math.max(0, onsetBeat - seg.startBeat);
  const measureOffset = Math.floor((offset + 1e-4) / seg.beatsPerMeasure);
  const beatOffset = Math.max(0, offset - measureOffset * seg.beatsPerMeasure);
  return {
    measure: seg.startMeasure + measureOffset,
    beat: Math.round((beatOffset + 1) * 1000) / 1000,
  };
}

function activeKeySigAt(keySignatures: KeySigPoint[], tick: number): KeySigPoint {
  let active = keySignatures[0];
  for (let i = 0; i < keySignatures.length; i += 1) {
    if (keySignatures[i].tick <= tick) {
      active = keySignatures[i];
    } else {
      break;
    }
  }
  return active;
}

export function parseStandardMidiFile(
  arrayBuffer: ArrayBuffer,
  filename = 'Imported Song.mid',
): ParsedMidiResult {
  assertMidiHeader(arrayBuffer);
  if (!MidiCtor) {
    throw createCodedError('Unable to load @tonejs/midi parser.', 'midi-bad');
  }

  let midi: MidiType;
  try {
    midi = new MidiCtor(arrayBuffer);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 'midi-bad') {
      throw err;
    }
    throw createCodedError('Invalid MIDI data.', 'midi-bad');
  }

  const ppq = midi.header.ppq > 0 ? midi.header.ppq : 480;
  const tempos = extractTempos(midi, ppq);
  const timeSignatures = extractTimeSignatures(midi, ppq);
  const keySignatures = extractKeySignatures(midi, ppq);
  const measureSegments = buildMeasureSegments(timeSignatures);

  const melodicTracks = midi.tracks
    .map((track, trackIndex) => ({ track, trackIndex }))
    .filter(
      ({ track }) =>
        track.channel !== 9 && !track.instrument?.percussion && track.notes.length >= 1,
    );

  if (melodicTracks.length === 0) {
    throw createCodedError('No playable MIDI note events found in file.', 'midi-empty');
  }

  let leftTrackIndex: number | null = null;
  if (melodicTracks.length >= 2) {
    let lowestMedian = Infinity;
    for (const { track, trackIndex } of melodicTracks) {
      const med = medianPitch(track.notes.map((n) => n.midi));
      if (med < lowestMedian) {
        lowestMedian = med;
        leftTrackIndex = trackIndex;
      }
    }
  }

  const rawEvents: NoteEvent[] = [];
  const pedals: PedalEvent[] = [];

  for (const { track, trackIndex } of melodicTracks) {
    const cc64 = track.controlChanges?.[64] ?? [];
    for (const cc of cc64) {
      pedals.push({
        timeSec: cc.time,
        beat: cc.ticks / ppq,
        value: cc.value,
        down: cc.value >= 0.5,
      });
    }

    for (const note of track.notes) {
      const onset = note.ticks / ppq;
      const duration = Math.max(0.05, note.durationTicks / ppq);
      const timeSec = note.time;
      const durationSec = Math.max(0.04, note.duration);
      const velocity = Math.max(1, Math.min(127, Math.round(note.velocity * 127)));
      const hand: Hand =
        melodicTracks.length >= 2
          ? trackIndex === leftTrackIndex
            ? 'L'
            : 'R'
          : note.midi >= 60
            ? 'R'
            : 'L';
      const keySig = activeKeySigAt(keySignatures, note.ticks);
      const preferFlats = keySig.preferFlats;
      const spelling = getDiatonicSpelling(note.midi, preferFlats);
      const { measure, beat } = measureAndBeatAt(measureSegments, onset);

      rawEvents.push({
        id: '',
        pitch: note.midi,
        pitchName: midiToPitchName(note.midi, preferFlats),
        step: spelling.step,
        alter: spelling.alter,
        octave: spelling.octave,
        preferFlats,
        onset,
        duration,
        timeSec,
        durationSec,
        measure,
        beat,
        hand,
        velocity,
        track: trackIndex,
      });
    }
  }

  if (rawEvents.length === 0) {
    throw createCodedError('No playable MIDI note events found in file.', 'midi-empty');
  }

  rawEvents.sort((a, b) => a.onset - b.onset || b.pitch - a.pitch);
  pedals.sort((a, b) => a.beat - b.beat || a.timeSec - b.timeSec);

  const idPrefix = `midi-${Date.now()}`;
  let totalBeats = 0;
  let totalSeconds = 0;
  let minPitch = Infinity;
  let maxPitch = -Infinity;

  const events = rawEvents.map((ev, idx) => {
    totalBeats = Math.max(totalBeats, ev.onset + ev.duration);
    totalSeconds = Math.max(totalSeconds, ev.timeSec + ev.durationSec);
    if (ev.pitch < minPitch) minPitch = ev.pitch;
    if (ev.pitch > maxPitch) maxPitch = ev.pitch;
    return { ...ev, id: `${idPrefix}-ev-${idx}` };
  });

  const endLocation = measureAndBeatAt(measureSegments, Math.max(0, totalBeats - 1e-4));
  const totalMeasures = Math.max(1, endLocation.measure);
  const cleanTitle = filename.replace(/\.(mid|midi)$/i, '') || midi.name || 'Imported Song';
  const primaryTimeSig: [number, number] = [
    timeSignatures[0].numerator,
    timeSignatures[0].denominator,
  ];
  const primaryKeyLabel = keySignatureLabel(keySignatures[0].key, keySignatures[0].scale);

  const song: Score = {
    id: idPrefix,
    title: cleanTitle,
    composer: 'Imported MIDI',
    genre: 'Imported Score',
    tempo: Math.round(tempos[0].bpm),
    timeSignature: primaryTimeSig,
    keySignature: primaryKeyLabel,
    sourceFormat: 'Standard MIDI (.mid)',
    totalMeasures,
    totalBeats,
    totalSeconds: Math.max(totalSeconds, Number.isFinite(midi.duration) ? midi.duration : 0),
    minPitch,
    maxPitch,
    events,
    pedals,
    tempos,
    timeSignatures,
    keySignatures,
  };

  return { song, kept: events.length, dropped: 0 };
}

export function readPracticeMidi(bytes: ArrayBuffer, filename: string): PracticeMidiReadResult {
  try {
    const opened = parseStandardMidiFile(bytes, filename);
    return { ok: true, song: opened.song, kept: opened.kept, dropped: opened.dropped };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'midi-empty') {
      return { ok: false, reason: 'empty' };
    }
    return { ok: false, reason: 'bad' };
  }
}

export function bpmAtBeat(score: Score, beat: number): number {
  const tempos = score.tempos;
  if (!tempos || tempos.length === 0) return score.tempo || 120;
  let active = tempos[0];
  for (let i = 0; i < tempos.length; i += 1) {
    if (tempos[i].beat <= beat) {
      active = tempos[i];
    } else {
      break;
    }
  }
  return active.bpm;
}

export function beatToSeconds(score: Score, beat: number): number {
  const tempos = score.tempos;
  if (!tempos || tempos.length === 0) {
    return beat * (60 / (score.tempo || 120));
  }
  if (beat <= tempos[0].beat) {
    return tempos[0].timeSec + (beat - tempos[0].beat) * (60 / tempos[0].bpm);
  }
  let active = tempos[0];
  for (let i = 1; i < tempos.length; i += 1) {
    if (tempos[i].beat <= beat) {
      active = tempos[i];
    } else {
      break;
    }
  }
  return active.timeSec + (beat - active.beat) * (60 / active.bpm);
}

export function secondsToBeat(score: Score, sec: number): number {
  const tempos = score.tempos;
  if (!tempos || tempos.length === 0) {
    return sec * ((score.tempo || 120) / 60);
  }
  if (sec <= tempos[0].timeSec) {
    return tempos[0].beat + (sec - tempos[0].timeSec) * (tempos[0].bpm / 60);
  }
  let active = tempos[0];
  for (let i = 1; i < tempos.length; i += 1) {
    if (tempos[i].timeSec <= sec) {
      active = tempos[i];
    } else {
      break;
    }
  }
  return active.beat + (sec - active.timeSec) * (active.bpm / 60);
}
