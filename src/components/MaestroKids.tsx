import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Headphones, LockKeyhole, Music2, RotateCcw, Sparkles, Volume2 } from 'lucide-react';
import { pianoEngine } from '../audio/piano-engine';
import { GAMES, SONGS, STAGES, learningStage, recordPractice, recordSkill, type GameId, type KidsData, type KidsSong, type SongMode } from '../music/kids-learning';
import { songArtUrl } from '../music/toddler-songs';
import KidsGames from './KidsGames';
import KidsSongLesson from './KidsSongLesson';
import { ActivityCard, Brand, Mascot, PracticeHeader, ToyArt } from './KidsVisuals';
import { useKidsGuide, type RegisterInput } from './kids-audio';
import './kids.css';

type Screen =
  | { name: 'home' | 'songs' | 'games' }
  | { name: 'game'; id: GameId | 'play' }
  | { name: 'song'; song: KidsSong }
  | { name: 'lesson'; song: KidsSong; mode: SongMode; cursor: number };

type Props = {
  data: KidsData;
  update: (apply: (previous: KidsData) => KidsData) => void;
  register: RegisterInput;
  midiSound: boolean;
  openStudio: () => void;
};

const MODE_LABELS = { listen: 'Listen', guided: 'Play with me', solo: 'Play by myself' };

function ParentGate({ onCancel, onUnlock }: { onCancel: () => void; onUnlock: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [left] = useState(() => 6 + Math.floor(Math.random() * 6));
  const [right] = useState(() => 3 + Math.floor(Math.random() * 6));
  const [answer, setAnswer] = useState('');
  const [tryAgain, setTryAgain] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return <dialog ref={dialog} className="kids-gate" aria-labelledby="parent-title" onCancel={onCancel}>
    <div className="kids-gate-mark"><LockKeyhole size={22} /></div>
    <h2 id="parent-title">Grown-ups only</h2>
    <p>Answer to open Maestro Studio.</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (answer.trim() && Number(answer) === left + right) onUnlock();
      else setTryAgain(true);
    }}>
      <label htmlFor="gate-answer">What is {left} + {right}?</label>
      <input id="gate-answer" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={answer}
        onChange={(event) => { setTryAgain(false); setAnswer(event.target.value); }} />
      {tryAgain && <p role="status">Try another answer.</p>}
      <button type="submit" className="kids-primary">Open Studio <ArrowRight size={18} /></button>
      <button type="button" className="kids-control" onClick={onCancel}>Back to Kids</button>
    </form>
  </dialog>;
}

export default function MaestroKids({ data, update, register, openStudio, midiSound }: Props) {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [gate, setGate] = useState(false);
  const [resume, setResume] = useState<'guided' | 'solo'>();
  const main = useRef<HTMLElement>(null);
  const studioButton = useRef<HTMLButtonElement>(null);
  const guide = useKidsGuide(data.settings.voice, midiSound);
  const stage = learningStage(data);

  function go(next: Screen, voice?: string) {
    guide.stop();
    setResume(undefined);
    setScreen(next);
    if (voice) guide.speak(voice);
    void pianoEngine.unlockFromGesture();
  }

  useEffect(() => {
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [screen]);

  function startSong(song: KidsSong, mode: SongMode, continueSong = false) {
    const saved = data.songs[`${song.score.id}:${mode}`]?.cursor ?? 0;
    if (mode !== 'listen' && saved > 0 && saved < song.score.events.length && resume !== mode) {
      setResume(mode);
      return;
    }
    const cursor = continueSong ? saved : 0;
    if (mode !== 'listen' && !continueSong) update((previous) => recordPractice(previous, song, mode, 0));
    go({ name: 'lesson', song, mode, cursor });
  }

  const isSession = screen.name === 'lesson' || screen.name === 'game';
  return (
    <div className={`maestro-kids${isSession ? ' maestro-kids-session' : ''}`}>
      {!isSession && <header className="kids-header">
        <div className="kids-header-inner">
          <button type="button" className="kids-home-link" onClick={() => go({ name: 'home' })} aria-label="Maestro home"><Brand /></button>
          <button ref={studioButton} type="button" className="kids-studio-link" onClick={() => { guide.stop(); setGate(true); }}><LockKeyhole size={15} /> Grown-ups</button>
        </div>
      </header>}
      <main ref={main} tabIndex={-1} className="kids-main">
        {screen.name === 'home' && <>
          <section className="kids-hero">
            <div className="kids-hero-copy">
              <h1>Let’s make<br className="kids-hero-break" /> <em>music!</em></h1>
              <p>Choose something fun to play.</p>
              {data.settings.voice && <button type="button" className="kids-welcome" aria-label="Hear Maestro Star’s welcome" onClick={() => guide.speak('Hello, little musician. I’m Maestro Star. Let’s make music together. Choose Play, Songs, or Games.')}><Volume2 size={20} /></button>}
            </div>
            <div className="kids-hero-picture"><Music2 className="kids-hero-note" aria-hidden="true" /><Mascot /><Sparkles className="kids-hero-spark" aria-hidden="true" /></div>
          </section>
          <div className="kids-activities">
            <ActivityCard title="Play" description="Make your own music" tone="peach" art={<ToyArt toy="piano" />}
              onClick={() => go({ name: 'game', id: 'play' }, 'Let’s play piano. Tap a key to make a sound.')} />
            <ActivityCard title="Songs" description="Learn a favorite song" tone="lavender" art={<ToyArt toy="book" />}
              onClick={() => go({ name: 'songs' }, 'Choose a song to play.')} />
            <ActivityCard title="Games" description="Discover musical sounds" tone="mint" art={<ToyArt toy="xylophone" />}
              onClick={() => go({ name: 'games' }, 'Choose a music game.')} />
          </div>
        </>}
        {screen.name === 'songs' && <>
          <PracticeHeader title="" back={() => go({ name: 'home' })} />
          <h1 className="kids-page-title">My Songs</h1>
          <div className="kids-song-grid">
            {SONGS.map((song) => {
              const guided = data.songs[`${song.score.id}:guided`]?.best ?? 0;
              const solo = data.songs[`${song.score.id}:solo`]?.best ?? 0;
              const stars = Number(guided >= song.phrases[0].length || solo >= song.phrases[0].length)
                + Number(guided >= song.score.events.length || solo >= song.score.events.length)
                + Number(solo >= song.score.events.length);
              return <button key={song.spec.id} type="button" className="kids-song-card"
                onClick={() => go({ name: 'song', song }, song.spec.title)}>
                <img src={songArtUrl(song.spec)} alt="" />
                <span><strong>{song.spec.title}</strong><span className="kids-stars" aria-label={`${stars} of 3 stars`}>{'★'.repeat(stars)}{'☆'.repeat(3 - stars)}</span></span>
              </button>;
            })}
          </div>
        </>}
        {screen.name === 'song' && <>
          <PracticeHeader title="" back={() => go({ name: 'songs' })} />
          <div className="kids-song-detail">
            <img src={songArtUrl(screen.song.spec)} alt="" />
            <div>
              <h1>{screen.song.spec.title}</h1>
              <div className="kids-song-modes">
                {resume ? <>
                  <p>Pick up where you left off?</p>
                  <button type="button" className="kids-primary" onClick={() => startSong(screen.song, resume, true)}>Continue <ArrowRight size={18} /></button>
                  <button type="button" className="kids-control" onClick={() => startSong(screen.song, resume)}><RotateCcw size={17} /> Start again</button>
                  <button type="button" className="kids-control" onClick={() => setResume(undefined)}>Choose another way to play</button>
                </> : (['listen', 'guided', 'solo'] as const).map((mode) => {
                  const Icon = mode === 'listen' ? Headphones : mode === 'guided' ? Sparkles : Music2;
                  return <button key={mode} type="button" className={mode === 'guided' ? 'kids-primary' : 'kids-control'}
                    onClick={() => startSong(screen.song, mode)}><Icon size={20} /> {MODE_LABELS[mode]}</button>;
                })}
              </div>
            </div>
          </div>
        </>}
        {screen.name === 'lesson' && <KidsSongLesson song={screen.song} mode={screen.mode} startingNote={screen.cursor}
          settings={data.settings} stage={stage} guide={guide} register={register}
          back={() => go({ name: 'song', song: screen.song })}
          save={(cursor) => {
            const mode = screen.mode;
            if (mode !== 'listen') update((previous) => recordPractice(previous, screen.song, mode, cursor));
          }} />}
        {screen.name === 'games' && <>
          <PracticeHeader title="" back={() => go({ name: 'home' })} />
          <h1 className="kids-page-title">Music Games</h1>
          <p className="kids-next-stage">Learning now <strong>{STAGES[stage].title}</strong></p>
          <div className="kids-game-grid">
            {GAMES.map((game) => <ActivityCard key={game.id} title={game.title} description={game.description}
              tone={game.tone} art={<span aria-hidden="true">{game.art}</span>}
              onClick={() => go({ name: 'game', id: game.id }, game.description)} />)}
          </div>
        </>}
        {screen.name === 'game' && <KidsGames game={screen.id} settings={data.settings} stage={stage} guide={guide} register={register}
          back={() => go({ name: screen.id === 'play' ? 'home' : 'games' })}
          onPitch={(pitch) => update((previous) => {
            if (previous.sounds.includes(pitch) || ![60, 62, 64, 65, 67].includes(pitch)) return previous;
            const next = { ...previous, sounds: [...previous.sounds, pitch] };
            return next.sounds.length >= 3 ? recordSkill(next, 'sounds') : next;
          })}
          onSkill={(skill) => update((previous) => recordSkill(previous, skill))} />}
      </main>
      {gate && <ParentGate onCancel={() => { setGate(false); studioButton.current?.focus(); }}
        onUnlock={() => { setGate(false); guide.stop(); openStudio(); }} />}
    </div>
  );
}
