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

const CHEER_BADGES = ['Lovely', 'Pretty', 'Yes', 'Beautiful'] as const;

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
  const color = targetNote ? targetNote.colorName.toLowerCase() : null;

  if (state.finished) {
    return {
      mood: 'celebrating',
      headline: 'Your garden is full',
      targetNote: null,
      cheerBadge: 'Well played',
      starsEarned,
      progressRatio: 1,
    };
  }

  if (state.mode === 'listen') {
    return {
      mood: state.running ? 'dancing' : 'happy',
      headline: state.running ? 'Listen along' : 'Press play to hear it',
      targetNote: null,
      cheerBadge: null,
      starsEarned,
      progressRatio,
    };
  }

  if (state.lastFeedback.status === 'miss') {
    return {
      mood: 'encouraging',
      headline: color ? `Try the ${color} key` : 'Try the lit key',
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
      headline: color ? `Next, the ${color} key` : 'Keep going',
      targetNote,
      cheerBadge: CHEER_BADGES[cheerIndex],
      starsEarned,
      progressRatio,
    };
  }

  return {
    mood: 'happy',
    headline: color ? `Tap the ${color} key` : 'Tap any key',
    targetNote,
    cheerBadge: null,
    starsEarned,
    progressRatio,
  };
}
