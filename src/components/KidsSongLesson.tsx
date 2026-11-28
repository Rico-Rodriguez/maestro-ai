import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Headphones, Pause, Play, RotateCcw, Volume2 } from 'lucide-react';
import { keyboardNotes, noteIdentity, resolvedAids, type KidsSettings, type KidsSong, type SongMode } from '../music/kids-learning';
import KidsPiano from './KidsPiano';
import { Mascot, PracticeHeader } from './KidsVisuals';
import { useKidsInput, type KidsGuide, type RegisterInput } from './kids-audio';

type Props = {
  song: KidsSong;
  mode: SongMode;
  startingNote: number;
  settings: KidsSettings;
  stage: number;
  guide: KidsGuide;
  register: RegisterInput;
  back: () => void;
  save: (cursor: number) => void;
};

export default function KidsSongLesson({ song, mode, startingNote, settings, stage, guide, register, back, save }: Props) {
  const { phrases, score } = song;
  const [cursor, setCursor] = useState(startingNote);
  const cursorRef = useRef(startingNote);
  const [phraseIndex, setPhraseIndex] = useState(Math.min(phrases.length - 1, Math.floor(startingNote / 4)));
  const [mistakes, setMistakes] = useState(0);
  const [replay, setReplay] = useState(0);
  const [playing, setPlaying] = useState(mode === 'listen');
  const [demoPitch, setDemoPitch] = useState<number>();
  const phrase = phrases[phraseIndex];
  const phraseStart = phraseIndex * 4;
  const phraseEnd = phraseStart + phrase.length;
  const phraseDone = cursor >= phraseEnd;
  const finished = cursor >= score.events.length;
  const guideMode = mode === 'guided';
  const listenMode = mode === 'listen';
  const target = phraseDone || listenMode ? undefined : score.events[cursor]?.pitch;
  const cue = target === undefined ? undefined : noteIdentity(target);
  const aids = resolvedAids(settings.aids, stage);
  const instruction = cue && aids === 'shapes' ? `Find the ${cue.colorName.toLowerCase()} ${cue.shape}.` : cue ? `Play ${cue.letter}.` : '';
  const keys = keyboardNotes(settings.keys, stage, phrase.map((event) => event.pitch));

  function setPosition(next: number) {
    cursorRef.current = next;
    setCursor(next);
    if (!listenMode) save(next);
  }

  function nextPhrase() {
    guide.stop();
    setPhraseIndex(phraseIndex + 1);
    setMistakes(0);
    if (listenMode) setPlaying(true);
  }

  function restart() {
    guide.stop();
    setPosition(0);
    setPhraseIndex(0);
    setMistakes(0);
    setDemoPitch(undefined);
    setReplay(replay + 1);
    setPlaying(listenMode);
  }

  const { handle: onInput, held } = useKidsInput(register, guide, (pitch, _, source) => {
    if (listenMode || cursorRef.current >= phraseEnd) return;
    if (score.events[cursorRef.current]?.pitch !== pitch) {
      // Acoustic detections are optional hints for matching, so uncertainty adds no correction.
      if (source !== 'mic' && guideMode) setMistakes((count) => count + 1);
      return;
    }
    guide.stop();
    setDemoPitch(undefined);
    setMistakes(0);
    setPosition(cursorRef.current + 1);
  });

  useEffect(() => {
    if (!guideMode || target === undefined) return;
    let reminders = 0;
    const demonstrate = () => {
      if (document.hidden) return;
      guide.note(target);
      guide.after(470, () => guide.speak(instruction));
      reminders += 1;
      if (reminders < 2) guide.after(10000, demonstrate);
    };
    guide.after(680, demonstrate);
    return guide.stop;
  }, [cursor, target, instruction, guideMode, replay, guide]);

  useEffect(() => {
    if (!listenMode || !playing || cursorRef.current >= phraseEnd) return;
    let elapsed = 0;
    for (const event of score.events.slice(cursorRef.current, phraseEnd)) {
      guide.after(elapsed, () => {
        setDemoPitch(event.pitch);
        guide.note(event.pitch, event.durationSec * 820, 72);
      });
      elapsed += event.durationSec * 1000;
      guide.after(elapsed, () => {
        cursorRef.current += 1;
        setCursor(cursorRef.current);
      });
    }
    guide.after(elapsed + 30, () => {
      setDemoPitch(undefined);
      setPlaying(false);
    });
    const pauseWhenHidden = () => {
      if (document.hidden) {
        setPlaying(false);
        setDemoPitch(undefined);
      }
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      guide.stop();
    };
  }, [guide, listenMode, phraseEnd, playing, score, replay]);

  useEffect(() => {
    if (!phraseDone) return;
    const line = listenMode ? 'That was lovely.' : finished ? 'You played the whole song.' : 'Lovely. You finished a phrase.';
    guide.after(620, () => guide.speak(line));
    return guide.stop;
  }, [guide, phraseDone, finished, listenMode]);

  const status = finished ? (listenMode ? 'That was lovely.' : 'You played the whole song.')
    : phraseDone ? (listenMode ? 'Ready for the next phrase?' : 'You finished a phrase.')
      : listenMode ? (playing ? 'Listen along' : 'Ready to listen?')
        : guideMode ? instruction : 'Play this phrase on your own.';

  return (
    <div className="kids-session">
      <PracticeHeader back={back} title={song.spec.title} />
      <div className="kids-lesson-top">
        <Mascot mood={phraseDone ? 'dance' : mistakes ? 'hint' : cursor > phraseStart || playing ? 'happy' : 'rest'} />
        <div className="kids-lesson-copy">
          <p className="kids-mode"><span>{guideMode ? 'Follow the Star' : listenMode ? 'Listen' : 'Play by myself'}</span></p>
          <h1 aria-live="polite">{status}</h1>
          {guideMode && cue && aids === 'shapes' && (
            <span className="kids-cue" aria-hidden="true">{cue.symbol} {cue.letter}</span>
          )}
          <div className="kids-phrase-progress">
            <span>{finished ? 'Song complete' : `Phrase ${phraseIndex + 1} of ${phrases.length}`}</span>
            <progress aria-label="Notes in this phrase" max={phrase.length} value={cursor - phraseStart} />
          </div>
        </div>
        <div className="kids-session-actions">
          {phraseDone && !finished && <button type="button" className="kids-primary" onClick={nextPhrase}>Next phrase <ArrowRight size={18} /></button>}
          {listenMode && !phraseDone && <button type="button" className="kids-control" onClick={() => {
            if (playing) {
              guide.stop();
              setDemoPitch(undefined);
            }
            setPlaying(!playing);
          }}>{playing ? <Pause size={18} /> : <Play size={18} />}{playing ? 'Pause' : 'Listen'}</button>}
          {guideMode && !phraseDone && <button type="button" className="kids-control" onClick={() => {
            guide.stop();
            setReplay(replay + 1);
          }}><Volume2 size={20} /> Hear the note</button>}
          <button type="button" className="kids-control" onClick={restart}><RotateCcw size={17} /> Restart</button>
        </div>
      </div>
      <KidsPiano notes={keys} aids={listenMode ? 'shapes' : aids} target={guideMode ? target : undefined} flourish={mistakes > 0}
        playing={demoPitch} held={held} onInput={onInput} />
      {listenMode && <p className="kids-listen-label"><Headphones size={16} /> Maestro Star is playing the melody.</p>}
    </div>
  );
}
