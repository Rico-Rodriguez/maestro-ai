import type { Hand, NoteEvent, Score } from '../music/types';

export type PracticeMode = 'wait' | 'tempo' | 'listen';
export type HandFilter = 'BOTH' | 'R' | 'L';

export type ChordGroup = {
  index: number;
  onset: number;
  endBeat: number;
  measure: number;
  notes: NoteEvent[];
};

export type PracticeGrade = {
  status: 'hit' | 'miss';
  deltaMs: number | null;
};

export type PracticeStats = {
  hits: number;
  misses: number;
  wrongNotes: number;
  streak: number;
  bestStreak: number;
  offsetsMs: number[];
  missesByMeasure: Record<number, number>;
};

export type PracticeState = {
  mode: PracticeMode;
  handFilter: HandFilter;
  beat: number;
  running: boolean;
  chords: ChordGroup[];
  cursor: number;
  grades: Record<string, PracticeGrade>;
  loop: { enabled: boolean; startMeasure: number; endMeasure: number };
  stats: PracticeStats;
  finished: boolean;
  lastFeedback: { status: 'idle' | 'hit' | 'miss'; text: string };
};

export type PracticeAction =
  | { type: 'tick'; dtSec: number; tempo?: number }
  | { type: 'noteOn'; pitch: number; timeMs?: number }
  | { type: 'seek'; beat: number }
  | { type: 'setRunning'; running: boolean }
  | { type: 'setMode'; mode: PracticeMode }
  | { type: 'setHandFilter'; handFilter: HandFilter }
  | { type: 'setLoop'; loop: Partial<{ enabled: boolean; startMeasure: number; endMeasure: number }> }
  | { type: 'reset' };

export const CHORD_EPSILON = 0.06;
export const TEMPO_WINDOW_BEATS = 0.45;

export const PRACTICE_MODES: readonly {
  id: PracticeMode;
  label: string;
  hint: string;
  idle: string;
}[] = [
  {
    id: 'wait',
    label: 'Wait',
    hint: 'Press the lit keys. The on-screen keyboard and your MIDI keyboard both count. The song stays quiet.',
    idle: 'Press the lit keys.',
  },
  {
    id: 'tempo',
    label: 'Tempo',
    hint: 'Maestro plays each note in time. Keep up on your keyboard. Late notes turn red.',
    idle: 'Keep up with the notes.',
  },
  {
    id: 'listen',
    label: 'Listen',
    hint: 'Maestro plays the song. You can just listen.',
    idle: 'Press Play to hear it.',
  },
];

function emptyStats(): PracticeStats {
  return {
    hits: 0,
    misses: 0,
    wrongNotes: 0,
    streak: 0,
    bestStreak: 0,
    offsetsMs: [],
    missesByMeasure: {},
  };
}

function idleText(mode: PracticeMode): string {
  return PRACTICE_MODES.find((item) => item.id === mode)?.idle ?? '';
}

function matchesHand(hand: Hand, filter: HandFilter): boolean {
  return filter === 'BOTH' || hand === filter;
}

function beatsPerMeasure(score: Score): number {
  const [num, den] = score.timeSignature;
  return Math.max(1, num * (4 / Math.max(1, den)));
}

function measureRangeBeats(
  loop: { startMeasure: number; endMeasure: number },
  score: Score,
): { startBeat: number; endBeat: number } {
  const bpb = beatsPerMeasure(score);
  return {
    startBeat: Math.max(0, (loop.startMeasure - 1) * bpb),
    endBeat: Math.max(bpb, loop.endMeasure * bpb),
  };
}

function songEndBeat(chords: readonly ChordGroup[], score: Score): number {
  const lastChordEnd = chords.length > 0 ? chords[chords.length - 1].endBeat : 0;
  return Math.max(score.totalBeats, lastChordEnd);
}

function findCursorForBeat(chords: readonly ChordGroup[], beat: number): number {
  for (let i = 0; i < chords.length; i += 1) {
    if (chords[i].onset >= beat - CHORD_EPSILON) {
      return i;
    }
  }
  return chords.length;
}

function isChordGraded(chord: ChordGroup, grades: Record<string, PracticeGrade>): boolean {
  return chord.notes.every((note) => grades[note.id] !== undefined);
}

function clearGradesFromBeat(
  grades: Record<string, PracticeGrade>,
  chords: readonly ChordGroup[],
  fromBeat: number,
): Record<string, PracticeGrade> {
  const next = { ...grades };
  for (const chord of chords) {
    if (chord.onset >= fromBeat - CHORD_EPSILON) {
      for (const note of chord.notes) {
        delete next[note.id];
      }
    }
  }
  return next;
}

export function groupIntoChords(
  events: readonly NoteEvent[],
  handFilter: HandFilter = 'BOTH',
): ChordGroup[] {
  const filtered = events.filter((note) => matchesHand(note.hand, handFilter));
  if (filtered.length === 0) return [];

  const sorted = [...filtered].sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
  const groups: ChordGroup[] = [];

  for (const note of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(note.onset - last.onset) <= CHORD_EPSILON) {
      last.notes.push(note);
      last.endBeat = Math.max(last.endBeat, note.onset + note.duration);
    } else {
      groups.push({
        index: groups.length,
        onset: note.onset,
        endBeat: note.onset + note.duration,
        measure: note.measure,
        notes: [note],
      });
    }
  }

  return groups;
}

export function createPracticeState(
  score: Score,
  options?: { mode?: PracticeMode; handFilter?: HandFilter },
): PracticeState {
  const mode = options?.mode ?? 'wait';
  const handFilter = options?.handFilter ?? 'BOTH';
  const chords = groupIntoChords(score.events, handFilter);
  const totalMeasures = Math.max(1, score.totalMeasures);

  return {
    mode,
    handFilter,
    beat: 0,
    running: false,
    chords,
    cursor: 0,
    grades: {},
    loop: { enabled: false, startMeasure: 1, endMeasure: totalMeasures },
    stats: emptyStats(),
    finished: false,
    lastFeedback: { status: 'idle', text: idleText(mode) },
  };
}

function wrapToLoopStart(state: PracticeState, score: Score): PracticeState {
  const { startBeat } = measureRangeBeats(state.loop, score);
  const cursor = findCursorForBeat(state.chords, startBeat);
  return {
    ...state,
    beat: startBeat,
    cursor,
    grades: clearGradesFromBeat(state.grades, state.chords, startBeat),
    finished: false,
  };
}

function reduceTick(
  state: PracticeState,
  dtSec: number,
  tempoOverride: number | undefined,
  score: Score,
): PracticeState {
  if (!state.running || state.finished) return state;

  const tempo = tempoOverride ?? score.tempo ?? 120;
  const dtBeats = Math.max(0, dtSec) * (tempo / 60);

  if (state.mode === 'wait') {
    const activeChord = state.chords[state.cursor];
    if (activeChord) {
      if (state.beat >= activeChord.onset) return state;
      return {
        ...state,
        beat: Math.min(activeChord.onset, state.beat + dtBeats),
      };
    }

    const nextBeat = state.beat + dtBeats;
    if (state.loop.enabled) {
      const { endBeat } = measureRangeBeats(state.loop, score);
      if (nextBeat >= endBeat) {
        return wrapToLoopStart(state, score);
      }
    }
    const endBeat = songEndBeat(state.chords, score);
    if (nextBeat >= endBeat) {
      return { ...state, beat: endBeat, finished: true, running: false };
    }
    return { ...state, beat: nextBeat };
  }

  const nextBeat = state.beat + dtBeats;
  let cursor = state.cursor;
  let grades = state.grades;
  let stats = state.stats;
  let lastFeedback = state.lastFeedback;

  if (state.mode === 'tempo') {
    while (
      cursor < state.chords.length &&
      nextBeat > state.chords[cursor].onset + TEMPO_WINDOW_BEATS
    ) {
      const chord = state.chords[cursor];
      for (const note of chord.notes) {
        if (grades[note.id] !== undefined) continue;
        if (grades === state.grades) grades = { ...state.grades };
        if (stats === state.stats) {
          stats = {
            ...state.stats,
            missesByMeasure: { ...state.stats.missesByMeasure },
          };
        }
        grades[note.id] = { status: 'miss', deltaMs: null };
        stats.misses += 1;
        stats.streak = 0;
        stats.missesByMeasure[note.measure] = (stats.missesByMeasure[note.measure] ?? 0) + 1;
        lastFeedback = {
          status: 'miss',
          text: `Missed ${note.pitchName} · bar ${note.measure}`,
        };
      }
      cursor += 1;
    }
  } else {
    while (cursor < state.chords.length && state.chords[cursor].onset <= nextBeat) {
      cursor += 1;
    }
  }

  if (state.loop.enabled) {
    const { endBeat } = measureRangeBeats(state.loop, score);
    if (nextBeat >= endBeat) {
      return wrapToLoopStart({ ...state, grades, stats, lastFeedback }, score);
    }
  } else {
    const endBeat = songEndBeat(state.chords, score);
    if (cursor >= state.chords.length && nextBeat >= endBeat) {
      return {
        ...state,
        beat: endBeat,
        cursor,
        grades,
        stats,
        lastFeedback,
        finished: true,
        running: false,
      };
    }
  }

  return {
    ...state,
    beat: nextBeat,
    cursor,
    grades,
    stats,
    lastFeedback,
  };
}

function recordWrongNote(state: PracticeState, measure: number): PracticeState {
  return {
    ...state,
    stats: {
      ...state.stats,
      wrongNotes: state.stats.wrongNotes + 1,
      streak: 0,
      missesByMeasure: {
        ...state.stats.missesByMeasure,
        [measure]: (state.stats.missesByMeasure[measure] ?? 0) + 1,
      },
    },
    lastFeedback: { status: 'miss', text: `Wrong note · bar ${measure}` },
  };
}

function reduceNoteOn(state: PracticeState, pitch: number, score: Score): PracticeState {
  if (state.mode === 'listen' || state.finished || state.chords.length === 0) {
    return state;
  }

  const bpb = beatsPerMeasure(score);

  if (state.mode === 'wait') {
    const chord = state.chords[state.cursor];
    if (!chord) return state;

    const match = chord.notes.find((note) => note.pitch === pitch && state.grades[note.id] === undefined);
    if (!match) {
      return recordWrongNote(state, chord.measure);
    }

    const nextGrades: Record<string, PracticeGrade> = {
      ...state.grades,
      [match.id]: { status: 'hit', deltaMs: 0 },
    };
    const nextStreak = state.stats.streak + 1;
    const nextStats: PracticeStats = {
      ...state.stats,
      hits: state.stats.hits + 1,
      streak: nextStreak,
      bestStreak: Math.max(state.stats.bestStreak, nextStreak),
    };
    const feedback = { status: 'hit' as const, text: `Got ${match.pitchName}` };

    if (!isChordGraded(chord, nextGrades)) {
      return {
        ...state,
        grades: nextGrades,
        stats: nextStats,
        lastFeedback: feedback,
      };
    }

    const nextCursor = state.cursor + 1;
    if (state.loop.enabled) {
      const { endBeat } = measureRangeBeats(state.loop, score);
      if (nextCursor >= state.chords.length || state.chords[nextCursor].onset >= endBeat - CHORD_EPSILON) {
        return wrapToLoopStart(
          { ...state, grades: nextGrades, stats: nextStats, lastFeedback: feedback },
          score,
        );
      }
      return {
        ...state,
        beat: state.chords[nextCursor].onset,
        cursor: nextCursor,
        grades: nextGrades,
        stats: nextStats,
        lastFeedback: feedback,
      };
    }

    if (nextCursor >= state.chords.length) {
      return {
        ...state,
        beat: chord.endBeat,
        cursor: nextCursor,
        grades: nextGrades,
        stats: nextStats,
        finished: true,
        running: false,
        lastFeedback: feedback,
      };
    }

    return {
      ...state,
      beat: state.chords[nextCursor].onset,
      cursor: nextCursor,
      grades: nextGrades,
      stats: nextStats,
      lastFeedback: feedback,
    };
  }

  let matchedChord: ChordGroup | null = null;
  let matchedNote: NoteEvent | null = null;

  for (let i = state.cursor; i < state.chords.length; i += 1) {
    const chord = state.chords[i];
    if (chord.onset > state.beat + TEMPO_WINDOW_BEATS) break;
    if (Math.abs(chord.onset - state.beat) <= TEMPO_WINDOW_BEATS) {
      const note = chord.notes.find((n) => n.pitch === pitch && state.grades[n.id] === undefined);
      if (note) {
        matchedChord = chord;
        matchedNote = note;
        break;
      }
    }
  }

  if (!matchedChord || !matchedNote) {
    const activeMeasure = state.chords[state.cursor]?.measure ?? Math.floor(state.beat / bpb) + 1;
    return recordWrongNote(state, activeMeasure);
  }

  const tempo = score.tempo || 120;
  const deltaMs = Math.round(((state.beat - matchedChord.onset) * 60000) / tempo);
  const nextGrades: Record<string, PracticeGrade> = {
    ...state.grades,
    [matchedNote.id]: { status: 'hit', deltaMs },
  };
  const nextStreak = state.stats.streak + 1;
  const nextStats: PracticeStats = {
    ...state.stats,
    hits: state.stats.hits + 1,
    streak: nextStreak,
    bestStreak: Math.max(state.stats.bestStreak, nextStreak),
    offsetsMs: [...state.stats.offsetsMs, deltaMs],
  };

  let nextCursor = state.cursor;
  while (nextCursor < state.chords.length && isChordGraded(state.chords[nextCursor], nextGrades)) {
    nextCursor += 1;
  }

  return {
    ...state,
    cursor: nextCursor,
    grades: nextGrades,
    stats: nextStats,
    lastFeedback: {
      status: 'hit',
      text: `${deltaMs >= 0 ? '+' : ''}${deltaMs} ms · ${matchedNote.pitchName}`,
    },
  };
}

export function reducePractice(
  state: PracticeState,
  action: PracticeAction,
  score: Score,
): PracticeState {
  switch (action.type) {
    case 'tick':
      return reduceTick(state, action.dtSec, action.tempo, score);

    case 'noteOn':
      return reduceNoteOn(state, action.pitch, score);

    case 'seek': {
      const beat = Math.max(0, action.beat);
      const cursor = findCursorForBeat(state.chords, beat);
      return {
        ...state,
        beat,
        cursor,
        grades: clearGradesFromBeat(state.grades, state.chords, beat),
        finished: false,
      };
    }

    case 'setRunning': {
      if (action.running && state.finished) {
        const startBeat = state.loop.enabled ? measureRangeBeats(state.loop, score).startBeat : 0;
        return {
          ...state,
          beat: startBeat,
          cursor: findCursorForBeat(state.chords, startBeat),
          grades: {},
          finished: false,
          running: true,
        };
      }
      if (action.running === state.running) return state;
      return { ...state, running: action.running };
    }

    case 'setMode': {
      if (action.mode === state.mode) return state;
      return {
        ...state,
        mode: action.mode,
        lastFeedback: { status: 'idle', text: idleText(action.mode) },
      };
    }

    case 'setHandFilter': {
      if (action.handFilter === state.handFilter) return state;
      const chords = groupIntoChords(score.events, action.handFilter);
      let cursor = findCursorForBeat(chords, state.beat);
      while (cursor < chords.length && isChordGraded(chords[cursor], state.grades)) {
        cursor += 1;
      }
      return {
        ...state,
        handFilter: action.handFilter,
        chords,
        cursor,
        finished: false,
      };
    }

    case 'setLoop': {
      const totalMeasures = Math.max(1, score.totalMeasures);
      const rawStart = action.loop.startMeasure ?? state.loop.startMeasure;
      const rawEnd = action.loop.endMeasure ?? state.loop.endMeasure;
      const startMeasure = Math.max(1, Math.min(totalMeasures, Math.round(rawStart)));
      const endMeasure = Math.max(startMeasure, Math.min(totalMeasures, Math.round(rawEnd)));
      const enabled = action.loop.enabled ?? state.loop.enabled;
      const nextLoop = { enabled, startMeasure, endMeasure };

      if (!enabled) {
        return { ...state, loop: nextLoop };
      }

      const { startBeat, endBeat } = measureRangeBeats(nextLoop, score);
      if (state.beat < startBeat || state.beat >= endBeat) {
        return {
          ...state,
          loop: nextLoop,
          beat: startBeat,
          cursor: findCursorForBeat(state.chords, startBeat),
          grades: clearGradesFromBeat(state.grades, state.chords, startBeat),
          finished: false,
        };
      }
      return { ...state, loop: nextLoop };
    }

    case 'reset': {
      const startBeat = state.loop.enabled ? measureRangeBeats(state.loop, score).startBeat : 0;
      return {
        ...createPracticeState(score, { mode: state.mode, handFilter: state.handFilter }),
        loop: state.loop,
        beat: startBeat,
        cursor: findCursorForBeat(state.chords, startBeat),
      };
    }
  }
}

export function formatNextChip(notes: readonly NoteEvent[], compact = false): string {
  if (notes.length === 0) return compact ? '—' : 'Next —';
  const first = notes[0].pitchName || '—';
  if (notes.length === 1) return compact ? first : `Next ${first}`;
  return compact ? `${first}+${notes.length - 1}` : `Next ${first} +${notes.length - 1}`;
}

export function getExpectedNotes(state: PracticeState): NoteEvent[] {
  if (state.finished || state.cursor >= state.chords.length) return [];
  const chord = state.chords[state.cursor];
  return chord.notes.filter((note) => state.grades[note.id] === undefined);
}

export function getAccuracyPercent(stats: PracticeStats): number {
  const total = stats.hits + stats.misses + stats.wrongNotes;
  if (total === 0) return 0;
  return Math.round((stats.hits / total) * 100);
}

export function getAverageOffsetMs(stats: PracticeStats): number {
  if (stats.offsetsMs.length === 0) return 0;
  const total = stats.offsetsMs.reduce((sum, offset) => sum + offset, 0);
  return Math.round(total / stats.offsetsMs.length);
}

export function getHardestMeasure(stats: PracticeStats): number | null {
  let hardest: number | null = null;
  let maxMisses = 0;

  for (const [measureKey, count] of Object.entries(stats.missesByMeasure)) {
    if (count > maxMisses) {
      maxMisses = count;
      hardest = Number(measureKey);
    }
  }

  return hardest;
}
