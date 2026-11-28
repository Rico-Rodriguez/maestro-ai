import type { NoteEvent } from '../music/types';
import type { PracticeState } from '../practice/engine';
import { getKidNoteHint } from './note-colors';

export type MascotMood = 'happy' | 'cheering' | 'encouraging' | 'dancing' | 'celebrating';

export interface KidPrompt {
  mood: MascotMood;
  headline: string;
  targetNote: { letter: string; colorName: string; bg: string; text: string } | null;
  cheerBadge: string | null;
  starsEarned: number;
  progressRatio: number;
}

const CHEER_BADGES = ['Nice', 'Good', 'Spot on', 'Steady'] as const;

export function deriveKidPrompt(
  state: PracticeState,
  expectedNotes: readonly NoteEvent[],
): KidPrompt {
  const totalChords = state.chords.length;
  const progressRatio = state.finished
    ? 1
    : totalChords > 0
      ? Math.max(0, Math.min(1, state.cursor / totalChords))
      : 0;
  const starsEarned = state.stats.hits;

  const nextNote = expectedNotes[0] ?? null;
  const hint = nextNote ? getKidNoteHint(nextNote.pitch) : null;
  const targetNote = hint
    ? {
        letter: hint.letter,
        colorName: hint.colorName,
        bg: hint.bg,
        text: hint.text,
      }
    : null;

  if (state.finished) {
    return {
      mood: 'celebrating',
      headline: 'Song complete',
      targetNote: null,
      cheerBadge: 'Well played',
      starsEarned,
      progressRatio: 1,
    };
  }

  if (state.mode === 'listen') {
    return {
      mood: state.running ? 'dancing' : 'happy',
      headline: state.running ? 'Listening along' : 'Press Play to hear the song',
      targetNote: null,
      cheerBadge: null,
      starsEarned,
      progressRatio,
    };
  }

  if (state.lastFeedback.status === 'miss') {
    return {
      mood: 'encouraging',
      headline: targetNote
        ? `Almost, tap ${targetNote.colorName.toLowerCase()} ${targetNote.letter}`
        : 'Try the highlighted key',
      targetNote,
      cheerBadge: null,
      starsEarned,
      progressRatio,
    };
  }

  if (state.lastFeedback.status === 'hit') {
    const cheerIndex = Math.max(0, state.stats.hits - 1) % CHEER_BADGES.length;
    return {
      mood: 'cheering',
      headline: targetNote
        ? `Next, ${targetNote.colorName.toLowerCase()} ${targetNote.letter}`
        : 'Keep going',
      targetNote,
      cheerBadge: CHEER_BADGES[cheerIndex],
      starsEarned,
      progressRatio,
    };
  }

  return {
    mood: 'happy',
    headline: targetNote
      ? `Tap ${targetNote.colorName.toLowerCase()} ${targetNote.letter}`
      : 'Tap any key',
    targetNote,
    cheerBadge: null,
    starsEarned,
    progressRatio,
  };
}
