import { useEffect, useRef, useState } from 'react';
import { Headphones, RotateCcw, Volume2 } from 'lucide-react';
import { BEAT_PATTERNS, GAMES, WHITE_KEYS, echoesBeat, keyboardNotes, noteIdentity, resolvedAids, type GameId, type KidsSettings, type Milestone } from '../music/kids-learning';
import KidsPiano from './KidsPiano';
import { Mascot, PracticeHeader } from './KidsVisuals';
import { useKidsInput, type KidsGuide, type RegisterInput } from './kids-audio';

const FIND_ROUNDS = [[60, 64, 62], [65, 67, 69], [71, 62, 67]];
const BIRD_ROUNDS = [[60, 64], [64, 62, 60], [62, 67, 64]];
const SCALE = WHITE_KEYS.slice(0, 8);
const SLEEPY_TUNE = [64, 62, 60, 62, 64, 67, 64, 60];

type Props = {
  game: GameId | 'play';
  settings: KidsSettings;
  stage: number;
  guide: KidsGuide;
  register: RegisterInput;
  back: () => void;
  onPitch: (pitch: number) => void;
  onSkill: (skill: Milestone) => void;
};

export default function KidsGames({ game, settings, stage, guide, register, back, onPitch, onSkill }: Props) {
  const [round, setRound] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [demoPitch, setDemoPitch] = useState<number>();
  const [hint, setHint] = useState(false);
  const [retryBeat, setRetryBeat] = useState(false);
  const [touched, setTouched] = useState<number[]>([]);
  const nextNote = useRef(0);
  const taps = useRef<number[]>([]);
  const title = GAMES.find((item) => item.id === game)?.title ?? 'Play piano';
  const find = game === 'find';
  const bird = game === 'bird';
  const rainbow = game === 'rainbow';
  const rhythm = game === 'rhythm';
  const sleepy = game === 'sleepy';
  const bubbles = game === 'bubbles';
  const sequence = find ? FIND_ROUNDS[round % FIND_ROUNDS.length]
    : bird ? BIRD_ROUNDS[round % BIRD_ROUNDS.length]
      : rainbow ? (round % 2 ? [...SCALE].reverse() : SCALE) : [];
  const beat = BEAT_PATTERNS[round % BEAT_PATTERNS.length];
  const end = rhythm ? beat.length : sequence.length;
  const complete = end > 0 && cursor >= end;
  const expected = sequence[cursor];
  const cue = expected === undefined ? undefined : noteIdentity(expected);
  const aids = resolvedAids(settings.aids, stage);
  const requestedKeys = bird || find ? sequence : rainbow ? SCALE : [];
  const keys = rhythm ? [60] : bubbles
    ? WHITE_KEYS.slice(0, 5)
    : keyboardNotes(settings.keys, stage, requestedKeys);

  function playDemo() {
    guide.stop();
    setPlaying(true);
    setHint(false);
    const pitches = sleepy ? SLEEPY_TUNE : rhythm ? beat.map(() => 60)
      : bird ? sequence : [sequence[cursor]];
    pitches.forEach((pitch, index) => {
      guide.after(rhythm ? beat[index] : index * (sleepy ? 550 : 510), () => {
        setDemoPitch(pitch);
        guide.note(pitch, sleepy ? 480 : 260, sleepy ? 44 : 63);
        guide.after(sleepy ? 480 : 280, () => setDemoPitch(undefined));
      });
    });
    const duration = rhythm ? beat[beat.length - 1] + 320 : pitches.length * (sleepy ? 550 : 510);
    guide.after(duration, () => {
      setPlaying(false);
      if (rhythm || bird) guide.speak('Your turn.');
    });
  }

  const { handle: onInput, held } = useKidsInput(register, guide, (pitch, time, source) => {
    if (bubbles) {
      onPitch(pitch);
      setTouched((prev) => prev.includes(pitch) ? prev : [...prev, pitch]);
    }
    if (playing || !end || nextNote.current >= end) return;
    if (rhythm) {
      if (source === 'touch' && pitch !== 60) return;
      taps.current.push(time);
      nextNote.current += 1;
      setCursor(nextNote.current);
      setRetryBeat(false);
      if (nextNote.current === end && !echoesBeat(taps.current, beat)) {
        taps.current = [];
        nextNote.current = 0;
        setCursor(0);
        setRetryBeat(true);
      } else if (nextNote.current === end) {
        onSkill('rhythm');
      }
      return;
    }
    if (pitch !== sequence[nextNote.current]) {
      if (source !== 'mic') setHint(true);
      return;
    }
    guide.stop();
    setDemoPitch(undefined);
    setHint(false);
    const next = ++nextNote.current;
    setCursor(next);
    if (next === end && find) onSkill('match');
    if (next === end && bird && end === 3) onSkill('copy');
  }, sleepy);

  useEffect(() => {
    const reset = () => {
      if (document.hidden) {
        setPlaying(false);
        setDemoPitch(undefined);
      }
    };
    document.addEventListener('visibilitychange', reset);
    return () => document.removeEventListener('visibilitychange', reset);
  }, []);

  useEffect(() => {
    if (complete) guide.after(450, () => guide.speak('Lovely music.'));
  }, [complete, guide]);

  const coloredCue = (find || rainbow) && cue && aids === 'shapes';
  const instruction = complete ? (bird && end === 2 ? 'Ready for three notes?' : 'Lovely music.')
    : playing ? 'Listen closely.'
      : rhythm ? (retryBeat ? 'Let’s try that beat again.' : 'Tap the same beat.')
        : find ? (coloredCue ? `Find the ${cue.colorName.toLowerCase()} ${cue.shape}.` : `Find ${cue?.letter}.`)
          : rainbow ? (round % 2 ? 'Play down the rainbow.' : 'Play up the rainbow.')
            : bird ? 'Listen, then copy the bird.'
              : sleepy ? 'Play something soft.'
                : bubbles ? 'Pop a bubble to hear its note.' : 'Make your own music.';

  return <div className="kids-session">
    <PracticeHeader back={back} title={title} />
    <div className="kids-lesson-top">
      <Mascot mood={complete || (bubbles && touched.length >= 3) ? 'dance' : hint ? 'hint' : touched.length || cursor ? 'happy' : 'rest'} />
      <div className="kids-lesson-copy">
        <h1 aria-live="polite">{instruction}</h1>
        {coloredCue && <span className="kids-cue" aria-hidden="true">{cue.symbol} {cue.letter}</span>}
        {end > 0 && <div className="kids-phrase-progress"><progress aria-label={rhythm ? 'Beat progress' : 'Pattern progress'} value={cursor} max={end} /></div>}
      </div>
      <div className="kids-session-actions">
        {(find || bird || sleepy || rhythm) && !complete && <button type="button" className="kids-control" disabled={playing} onClick={() => {
          if (bird || rhythm) {
            nextNote.current = 0;
            taps.current = [];
            setCursor(0);
          }
          playDemo();
        }}>{sleepy || bird ? <Headphones size={20} /> : <Volume2 size={20} />}{find ? 'Hear the note' : rhythm ? 'Hear the beat' : sleepy ? 'Hear a lullaby' : 'Hear the bird'}</button>}
        {complete && <button type="button" className="kids-primary" onClick={() => {
          guide.stop();
          nextNote.current = 0;
          taps.current = [];
          setCursor(0);
          setRetryBeat(false);
          setRound(round + 1);
        }}><RotateCcw size={18} /> {bird && end === 2 ? 'Three notes' : rainbow ? 'Turn around' : 'Play again'}</button>}
      </div>
    </div>
    <KidsPiano notes={keys} aids={bubbles || rainbow ? 'shapes' : rhythm ? 'none' : aids} target={rainbow || hint ? expected : undefined}
      flourish={hint} playing={demoPitch} held={held} onInput={onInput} bubbles={bubbles || rhythm} />
  </div>;
}
