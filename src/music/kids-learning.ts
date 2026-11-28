import { getKidNoteHint } from '../components/note-colors';
import { buildToddlerScore, TODDLER_SONGS } from './toddler-songs';

export const WHITE_KEYS = [60, 62, 64, 65, 67, 69, 71, 72, 74];
export const STAGES = [
  { title: 'Discover Sounds', skill: 'Explore three different pitches in Musical Bubbles.' },
  { title: 'Meet the Notes', skill: 'Match three notes in Find the Note.' },
  { title: 'Copy Me', skill: 'Echo a three-note pattern in Copy the Bird.' },
  { title: 'My First Song', skill: 'Play a phrase with Maestro Star.' },
  { title: 'Feel the Rhythm', skill: 'Echo a short beat in Rhythm Bunny.' },
  { title: 'Little Pianist', skill: 'Play a phrase independently and explore notation in Studio.' },
] as const;

export const GAMES = [
  { id: 'bubbles', title: 'Musical Bubbles', description: 'Pop a bubble to hear its note.', art: '🫧', tone: 'sky', stage: 0 },
  { id: 'bird', title: 'Copy the Bird', description: 'Listen, then echo the bird’s tune.', art: '🐦', tone: 'peach', stage: 2 },
  { id: 'rainbow', title: 'Rainbow Steps', description: 'Play up and down the rainbow.', art: '🌈', tone: 'lavender', stage: 1 },
  { id: 'rhythm', title: 'Rhythm Bunny', description: 'Listen and tap the same beat.', art: '🐇', tone: 'peach', stage: 4 },
  { id: 'find', title: 'Find the Note', description: 'Match the sound and shape.', art: '🎵', tone: 'mint', stage: 1 },
  { id: 'sleepy', title: 'Sleepy Songs', description: 'Make soft sounds for bedtime.', art: '🌙', tone: 'lavender', stage: 0 },
] as const;
export type GameId = typeof GAMES[number]['id'];
export type SongMode = 'listen' | 'guided' | 'solo';
export type AidMode = 'auto' | 'shapes' | 'letters' | 'none';
export type KeySize = 'auto' | 'one' | 'three' | 'five' | 'seven' | 'chromatic' | 'full';
export type KidsSettings = { voice: boolean; aids: AidMode; keys: KeySize };
export type Milestone = 'sounds' | 'match' | 'copy' | 'phrase' | 'rhythm' | 'solo';
export type SongProgress = { cursor: number; best: number };
export type KidsData = {
  settings: KidsSettings;
  skills: Milestone[];
  sounds: number[];
  songs: Record<string, SongProgress>;
};

const STORAGE_KEY = 'maestro:kids:v1';
const MILESTONES: Milestone[] = ['sounds', 'match', 'copy', 'phrase', 'rhythm', 'solo'];
export const SONGS = TODDLER_SONGS.map((spec) => {
  const score = buildToddlerScore(spec);
  const phrases: typeof score.events[] = [];
  for (let index = 0; index < score.events.length; index += 4) {
    phrases.push(score.events.slice(index, index + 4));
  }
  return { spec, score, phrases };
});
export type KidsSong = typeof SONGS[number];

export function loadKidsData(): KidsData {
  const initial: KidsData = {
    settings: { voice: true, aids: 'auto', keys: 'auto' },
    skills: [],
    sounds: [],
    songs: {},
  };
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!data) return initial;
    const settings = data.settings;
    if (typeof settings?.voice === 'boolean') initial.settings.voice = settings.voice;
    if (['auto', 'shapes', 'letters', 'none'].includes(settings?.aids)) initial.settings.aids = settings.aids;
    if (['auto', 'one', 'three', 'five', 'seven', 'chromatic', 'full'].includes(settings?.keys)) initial.settings.keys = settings.keys;
    if (Array.isArray(data.skills)) initial.skills = MILESTONES.filter((id) => data.skills.includes(id));
    if (Array.isArray(data.sounds)) initial.sounds = WHITE_KEYS.filter((pitch) => data.sounds.includes(pitch));
    for (const { score } of SONGS) {
      for (const mode of ['guided', 'solo']) {
        const id = `${score.id}:${mode}`;
        const entry = data.songs?.[id];
        if (!Number.isInteger(entry?.cursor) || !Number.isInteger(entry?.best)) continue;
        const best = Math.max(0, Math.min(score.events.length, entry.best));
        initial.songs[id] = { best, cursor: Math.max(0, Math.min(best, entry.cursor)) };
      }
    }
  } catch {
    // The app can still play if device storage is unavailable.
  }
  return initial;
}

export function saveKidsData(data: KidsData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Keep working with the current session's progress.
  }
}

export function recordSkill(data: KidsData, skill: Milestone): KidsData {
  return data.skills.includes(skill) ? data : { ...data, skills: [...data.skills, skill] };
}

export function learningStage(data: KidsData): number {
  const next = MILESTONES.findIndex((id) => !data.skills.includes(id));
  return next === -1 ? STAGES.length - 1 : next;
}

export function recordPractice(data: KidsData, song: KidsSong, mode: 'guided' | 'solo', cursor: number): KidsData {
  const id = `${song.score.id}:${mode}`;
  const saved = data.songs[id];
  const songs = { ...data.songs, [id]: { cursor, best: Math.max(saved?.best ?? 0, cursor) } };
  const next = { ...data, songs };
  const firstPhrase = song.phrases[0].length;
  return cursor >= firstPhrase ? recordSkill(next, mode === 'guided' ? 'phrase' : 'solo') : next;
}

const SYMBOLS: Record<string, [string, string]> = {
  C: ['●', 'circle'], D: ['♥', 'heart'], E: ['★', 'star'], F: ['▲', 'triangle'],
  G: ['◆', 'diamond'], A: ['☾', 'moon'], B: ['✿', 'flower'],
};

export function noteIdentity(pitch: number) {
  const hint = getKidNoteHint(pitch);
  const [symbol, shape] = SYMBOLS[hint.letter] ?? ['♯', 'sharp'];
  return { ...hint, symbol, shape };
}

export function resolvedAids(aids: AidMode, stage: number): Exclude<AidMode, 'auto'> {
  if (aids !== 'auto') return aids;
  return stage >= 5 ? 'letters' : 'shapes';
}

export function keyboardNotes(size: KeySize, stage: number, required: readonly number[] = []): number[] {
  const resolved = size === 'auto' ? (['three', 'five', 'seven', 'seven', 'seven', 'chromatic'] as const)[stage] : size;
  if (resolved === 'full') return Array.from({ length: 88 }, (_, i) => i + 21);
  if (resolved === 'chromatic') return Array.from({ length: 15 }, (_, i) => i + 60);
  const count = { one: 1, three: 3, five: 5, seven: 7 }[resolved];
  if (!required.length) return WHITE_KEYS.slice(0, count);
  const first = WHITE_KEYS.indexOf(Math.min(...required));
  const last = WHITE_KEYS.indexOf(Math.max(...required));
  const start = Math.max(0, Math.min(first, WHITE_KEYS.length - count));
  return WHITE_KEYS.slice(start, Math.max(start + count, last + 1));
}

export const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);

export const BEAT_PATTERNS = [
  [0, 650, 1300],
  [0, 600, 1500],
] as const;

export function echoesBeat(taps: readonly number[], pattern: readonly number[]): boolean {
  if (taps.length !== pattern.length) return false;
  return taps.slice(1).every((tap, index) => {
    const interval = pattern[index + 1] - pattern[index];
    const elapsed = tap - taps[index];
    return Math.abs(elapsed - interval) <= Math.max(240, interval * 0.42);
  });
}
