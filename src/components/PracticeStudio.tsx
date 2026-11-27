import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  FileDown,
  Headphones,
  Library,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Usb,
  Volume2,
} from 'lucide-react';
import { pianoEngine, type AudioEngineStatus, type InstrumentVoice } from '../audio/piano-engine';
import { PlaybackScheduler } from '../audio/scheduler';
import { attachKeyboardInput } from '../input/keyboard-adapter';
import type { MidiInputController } from '../input/midi-adapter';
import type { MicPitchReading, MidiAccessState, MidiDeviceInfo, NoteInput } from '../input/types';
import { bpmAtBeat } from '../music/midi-parser';
import type { Hand, Score } from '../music/types';
import {
  createPracticeState,
  formatNextChip,
  getAccuracyPercent,
  getAverageOffsetMs,
  getExpectedNotes,
  getHardestMeasure,
  PRACTICE_MODES,
  reducePractice,
  type HandFilter,
  type PracticeAction,
  type PracticeMode,
  type PracticeState,
} from '../practice/engine';
import FallingNotesCanvas from './FallingNotesCanvas';
import GrandStaff from './GrandStaff';
import type { SavedMuseScore } from './LibraryView';
import { measureAtBeat, type ColorMode } from './note-colors';
import {
  autoOctaveShiftForPitches,
  buildPianoLayout,
  computePianoRange,
  type PianoRangeMode,
} from './piano-geometry';
import PianoKeyboard from './PianoKeyboard';

export type StudioViewLayout = 'combined' | 'falling' | 'notation';

export interface PracticeStudioProps {
  score: Score | null;
  sessionScores: Score[];
  savedScores: SavedMuseScore[];
  scoreBusy: boolean;
  onSelectScore: (score: Score) => void;
  onOpenSavedScore: (scoreId: string) => void;
  onGoToLibrary: () => void;
  onLoadSample: () => Promise<void>;
  sampleLoading: boolean;
  onExportPdf: (score: Score) => void;
  darkMode: boolean;
  midiController: MidiInputController;
  midiState: MidiAccessState;
  midiDevices: MidiDeviceInfo[];
  onConnectMidi: () => void;
  micActive: boolean;
  micPitch: MicPitchReading | null;
  micError: string | null;
  onToggleMic: () => void;
  audioStatus: AudioEngineStatus;
  viewActive: boolean;
  registerNoteHandler: (handler: ((event: NoteInput) => void) | null) => void;
  registerMicGate: (gate: (() => boolean) | null) => void;
  kidLocked?: boolean;
  onExitKidLock?: () => void;
}

const EMPTY_PRACTICE_STATE: PracticeState = {
  mode: 'wait',
  handFilter: 'BOTH',
  beat: 0,
  running: false,
  chords: [],
  cursor: 0,
  grades: {},
  loop: { enabled: false, startMeasure: 1, endMeasure: 1 },
  stats: {
    hits: 0,
    misses: 0,
    wrongNotes: 0,
    streak: 0,
    bestStreak: 0,
    offsetsMs: [],
    missesByMeasure: {},
  },
  finished: false,
  lastFeedback: { status: 'idle', text: 'Open a score to begin.' },
};

const VOICE_OPTIONS: readonly { id: InstrumentVoice; label: string }[] = [
  { id: 'grand-piano', label: 'Concert Grand' },
  { id: 'electric-piano', label: 'Electric Piano' },
  { id: 'warm-upright', label: 'Warm Upright' },
];

const LAYOUT_OPTIONS: readonly { id: StudioViewLayout; label: string }[] = [
  { id: 'combined', label: 'Split' },
  { id: 'falling', label: 'Falling' },
  { id: 'notation', label: 'Sheet' },
];

const HAND_OPTIONS: readonly { id: HandFilter; label: string }[] = [
  { id: 'BOTH', label: 'Both' },
  { id: 'R', label: 'R' },
  { id: 'L', label: 'L' },
];

const KEY_SIZE_OPTIONS: readonly { mode: PianoRangeMode; label: string }[] = [
  { mode: 'kid', label: 'Big 15' },
  { mode: 'compact', label: '25' },
  { mode: 'auto', label: 'Auto' },
  { mode: '61', label: '61' },
  { mode: '88', label: '88' },
];

const COLOR_MODE_OPTIONS: readonly { id: ColorMode; label: string }[] = [
  { id: 'rainbow', label: 'Rainbow' },
  { id: 'hands', label: 'Hands' },
];

export default function PracticeStudio({
  score,
  sessionScores,
  savedScores,
  scoreBusy,
  onSelectScore,
  onOpenSavedScore,
  onGoToLibrary,
  onLoadSample,
  sampleLoading,
  onExportPdf,
  darkMode,
  midiController,
  midiState,
  midiDevices,
  onConnectMidi,
  micActive,
  micPitch,
  micError,
  onToggleMic,
  audioStatus,
  viewActive,
  registerNoteHandler,
  registerMicGate,
  kidLocked = false,
}: PracticeStudioProps) {
  const [practiceState, setPracticeState] = useState<PracticeState>(() =>
    score ? createPracticeState(score) : EMPTY_PRACTICE_STATE,
  );
  const [userPressedNotes, setUserPressedNotes] = useState<Set<number>>(() => new Set());
  const [userSustainDown, setUserSustainDown] = useState(false);
  const [rangeMode, setRangeMode] = useState<PianoRangeMode>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'compact' : 'auto',
  );
  const [octaveShift, setOctaveShift] = useState(0);
  const [viewLayout, setViewLayout] = useState<StudioViewLayout>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'falling' : 'combined',
  );
  const [colorMode, setColorMode] = useState<ColorMode>('rainbow');
  const [tempoScale, setTempoScale] = useState(1);
  const [metronomeOn, setMetronomeOn] = useState(false);
  const [guideSoundOn, setGuideSoundOn] = useState(true);
  const [muteLocalForMidi, setMuteLocalForMidi] = useState(false);
  const [headphonesMode, setHeadphonesMode] = useState(false);
  const [voice, setVoice] = useState<InstrumentVoice>('grand-piano');
  const [volume, setVolume] = useState(0.85);
  const [showSettings, setShowSettings] = useState(false);
  const [liveBpm, setLiveBpm] = useState<number>(() => (score ? Math.round(score.tempo || 120) : 120));

  const scoreRef = useRef<Score | null>(score);
  const practiceStateRef = useRef<PracticeState>(practiceState);
  const schedulerRef = useRef<PlaybackScheduler | null>(null);
  const tempoScaleRef = useRef(tempoScale);
  const metronomeOnRef = useRef(metronomeOn);
  const guideSoundOnRef = useRef(guideSoundOn);
  const muteLocalForMidiRef = useRef(muteLocalForMidi);
  const headphonesModeRef = useRef(headphonesMode);
  const octaveShiftRef = useRef(octaveShift);

  scoreRef.current = score;
  tempoScaleRef.current = tempoScale;
  metronomeOnRef.current = metronomeOn;
  guideSoundOnRef.current = guideSoundOn;
  muteLocalForMidiRef.current = muteLocalForMidi;
  headphonesModeRef.current = headphonesMode;
  octaveShiftRef.current = octaveShift;

  const dispatchPractice = useCallback((action: PracticeAction): PracticeState => {
    const activeScore = scoreRef.current;
    if (!activeScore) return practiceStateRef.current;
    const next = reducePractice(practiceStateRef.current, action, activeScore);
    practiceStateRef.current = next;
    setPracticeState(next);
    return next;
  }, []);

  useEffect(() => {
    const scheduler = new PlaybackScheduler(pianoEngine, {
      score: scoreRef.current,
      mode: practiceStateRef.current.mode,
      handFilter: practiceStateRef.current.handFilter,
      tempoScale: tempoScaleRef.current,
      loop: practiceStateRef.current.loop,
      metronomeOn: metronomeOnRef.current,
      guideSoundOn: guideSoundOnRef.current,
      onBeatAdvance: (_prevBeat, nextBeat, bpm) => {
        setLiveBpm(Math.round(bpm));
        const activeScore = scoreRef.current;
        if (!activeScore) return;
        const prev = practiceStateRef.current;
        if (prev.mode === 'wait') return;
        const dtBeats = Math.max(0, nextBeat - prev.beat);
        dispatchPractice({ type: 'tick', dtSec: dtBeats, tempo: 60 });
      },
      onLoopWrap: (loopStartBeat) => {
        dispatchPractice({ type: 'seek', beat: loopStartBeat });
      },
      onEnd: () => {
        const activeScore = scoreRef.current;
        if (!activeScore) return;
        const prev = practiceStateRef.current;
        if (!prev.finished) {
          const endBeat = Math.max(prev.beat, activeScore.totalBeats);
          dispatchPractice({ type: 'tick', dtSec: Math.max(0, endBeat - prev.beat), tempo: 60 });
          if (!practiceStateRef.current.finished) {
            dispatchPractice({ type: 'setRunning', running: false });
          }
        }
      },
    });
    schedulerRef.current = scheduler;
    return () => {
      scheduler.dispose();
      if (schedulerRef.current === scheduler) {
        schedulerRef.current = null;
      }
    };
  }, [dispatchPractice]);

  useEffect(() => {
    const next = score
      ? createPracticeState(score, {
          mode: practiceStateRef.current.mode,
          handFilter: practiceStateRef.current.handFilter,
        })
      : EMPTY_PRACTICE_STATE;
    practiceStateRef.current = next;
    setPracticeState(next);
    setUserPressedNotes(new Set());
    setUserSustainDown(false);
    setLiveBpm(score ? Math.round(bpmAtBeat(score, 0)) : 120);
    schedulerRef.current?.pause();
    schedulerRef.current?.updateConfig({
      score,
      mode: next.mode,
      handFilter: next.handFilter,
      loop: next.loop,
    });
  }, [score]);

  useEffect(() => {
    schedulerRef.current?.updateConfig({
      mode: practiceState.mode,
      handFilter: practiceState.handFilter,
      loop: practiceState.loop,
      tempoScale,
      metronomeOn,
      guideSoundOn,
    });
  }, [
    practiceState.mode,
    practiceState.handFilter,
    practiceState.loop,
    tempoScale,
    metronomeOn,
    guideSoundOn,
  ]);

  useEffect(() => {
    pianoEngine.setVoice(voice);
  }, [voice]);

  useEffect(() => {
    pianoEngine.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    if (!score || !practiceState.running || practiceState.mode !== 'wait' || practiceState.finished) {
      return;
    }
    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dtSec = Math.min(0.08, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;

      const prev = practiceStateRef.current;
      const baseBpm = bpmAtBeat(score, prev.beat);
      setLiveBpm(Math.round(baseBpm));
      const next = dispatchPractice({
        type: 'tick',
        dtSec,
        tempo: baseBpm * tempoScaleRef.current,
      });

      if (next.beat !== prev.beat) {
        schedulerRef.current?.setClampedBeat(next.beat);
      }
      if (next.finished) {
        schedulerRef.current?.pause();
        return;
      }
      if (next.running && next.mode === 'wait') {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [score, practiceState.running, practiceState.mode, practiceState.finished, dispatchPractice]);

  const handleNoteInput = useCallback(
    (event: NoteInput) => {
      if (event.kind === 'on') {
        if (event.source !== 'mic') {
          void pianoEngine.unlockFromGesture();
          if (!(event.source === 'midi' && muteLocalForMidiRef.current)) {
            pianoEngine.noteOn(event.pitch, event.velocity, undefined, 'user');
          }
        }
        setUserPressedNotes((prev) => {
          if (prev.has(event.pitch)) return prev;
          const next = new Set(prev);
          next.add(event.pitch);
          return next;
        });

        if (scoreRef.current) {
          const prev = practiceStateRef.current;
          const next = dispatchPractice({
            type: 'noteOn',
            pitch: event.pitch,
            timeMs: event.timeMs,
          });
          if (prev.mode === 'wait' && (next.beat !== prev.beat || next.cursor !== prev.cursor)) {
            schedulerRef.current?.setClampedBeat(next.beat);
          }
          if (next.finished && !prev.finished) {
            schedulerRef.current?.pause();
          }
        }
        return;
      }

      if (event.kind === 'off') {
        if (event.source !== 'mic') {
          pianoEngine.noteOff(event.pitch, undefined, 'user');
        }
        setUserPressedNotes((prev) => {
          if (!prev.has(event.pitch)) return prev;
          const next = new Set(prev);
          next.delete(event.pitch);
          return next;
        });
        return;
      }

      pianoEngine.setSustain(event.down, undefined, 'user');
      setUserSustainDown(event.down);
    },
    [dispatchPractice],
  );

  const handleNoteInputRef = useRef(handleNoteInput);
  handleNoteInputRef.current = handleNoteInput;

  const togglePlay = useCallback(() => {
    const activeScore = scoreRef.current;
    if (!activeScore) return;
    const prev = practiceStateRef.current;
    if (prev.running) {
      dispatchPractice({ type: 'setRunning', running: false });
      schedulerRef.current?.pause();
      return;
    }

    void pianoEngine.unlockFromGesture();
    const wasFinished = prev.finished;
    const next = dispatchPractice({ type: 'setRunning', running: true });
    if (wasFinished) {
      schedulerRef.current?.seekBeat(next.beat);
    }
    schedulerRef.current?.play();
  }, [dispatchPractice]);

  const togglePlayRef = useRef(togglePlay);
  togglePlayRef.current = togglePlay;

  const shiftOctave = useCallback((delta: number) => {
    setOctaveShift((prev) => Math.max(-2, Math.min(2, prev + delta)));
  }, []);

  const shiftOctaveRef = useRef(shiftOctave);
  shiftOctaveRef.current = shiftOctave;

  useEffect(() => {
    return midiController.subscribe((event) => handleNoteInputRef.current(event));
  }, [midiController]);

  useEffect(() => {
    registerNoteHandler((event) => handleNoteInputRef.current(event));
    registerMicGate(() => !headphonesModeRef.current && pianoEngine.isPlaybackSounding());
    return () => {
      registerNoteHandler(null);
      registerMicGate(null);
    };
  }, [registerNoteHandler, registerMicGate]);

  useEffect(() => {
    if (!viewActive) return;
    return attachKeyboardInput({
      octaveShift: () => octaveShiftRef.current,
      onNote: (event) => handleNoteInputRef.current(event),
      onTogglePlay: () => togglePlayRef.current(),
      onShiftOctave: (delta) => shiftOctaveRef.current(delta),
    });
  }, [viewActive]);

  const handleRestart = useCallback(() => {
    if (!scoreRef.current) return;
    schedulerRef.current?.pause();
    const next = dispatchPractice({ type: 'reset' });
    schedulerRef.current?.seekBeat(next.beat);
  }, [dispatchPractice]);

  const handleModeChange = useCallback(
    (mode: PracticeMode) => {
      dispatchPractice({ type: 'setMode', mode });
    },
    [dispatchPractice],
  );

  const handleHandChange = useCallback(
    (handFilter: HandFilter) => {
      dispatchPractice({ type: 'setHandFilter', handFilter });
    },
    [dispatchPractice],
  );

  const handleSeekBeat = useCallback(
    (beat: number) => {
      if (!scoreRef.current) return;
      dispatchPractice({ type: 'seek', beat });
      schedulerRef.current?.seekBeat(beat);
    },
    [dispatchPractice],
  );

  const handlePreviewPitch = useCallback((pitch: number) => {
    void pianoEngine.unlockFromGesture();
    pianoEngine.noteOn(pitch, 88, undefined, 'user');
    window.setTimeout(() => {
      pianoEngine.noteOff(pitch, undefined, 'user');
    }, 320);
  }, []);

  const handlePianoNoteOn = useCallback((pitch: number, velocity = 92) => {
    handleNoteInputRef.current({
      kind: 'on',
      pitch,
      velocity,
      source: 'touch',
      timeMs: performance.now(),
    });
  }, []);

  const handlePianoNoteOff = useCallback((pitch: number) => {
    handleNoteInputRef.current({
      kind: 'off',
      pitch,
      source: 'touch',
      timeMs: performance.now(),
    });
  }, []);

  const getLiveBeat = useCallback(() => {
    const state = practiceStateRef.current;
    if (state.running && state.mode !== 'wait' && schedulerRef.current) {
      return schedulerRef.current.getLiveBeat();
    }
    return state.beat;
  }, []);

  const getPlaybackPitches = useCallback(
    () => schedulerRef.current?.getActivePlaybackPitches() ?? new Map<number, Hand>(),
    [],
  );

  const getPlaybackSustain = useCallback(
    () => schedulerRef.current?.getPlaybackSustain() ?? false,
    [],
  );

  const pianoLayout = useMemo(() => {
    const { minMidi, maxMidi } = computePianoRange(
      rangeMode,
      score?.minPitch,
      score?.maxPitch,
      octaveShift,
    );
    return buildPianoLayout(minMidi, maxMidi);
  }, [rangeMode, score?.minPitch, score?.maxPitch, octaveShift]);

  const filteredEvents = useMemo(() => {
    if (!score) return [];
    if (practiceState.handFilter === 'BOTH') return score.events;
    return score.events.filter((ev) => ev.hand === practiceState.handFilter);
  }, [score, practiceState.handFilter]);

  const expectedNotes = useMemo(() => {
    if (!score) return [];
    return getExpectedNotes(practiceState);
  }, [score, practiceState]);

  const defaultBeatsPerMeasure = useMemo(() => {
    if (!score) return 4;
    const [num, den] = score.timeSignature;
    return Math.max(1, num * (4 / Math.max(1, den)));
  }, [score]);

  useEffect(() => {
    if (kidLocked) {
      setShowSettings(false);
    }
  }, [kidLocked]);

  useEffect(() => {
    if (!score) return;
    if (rangeMode !== 'kid' && rangeMode !== 'compact') return;

    const pitches =
      practiceState.mode === 'listen'
        ? filteredEvents
            .filter(
              (ev) =>
                ev.onset >= practiceState.beat - 0.1 &&
                ev.onset <= practiceState.beat + 1.2,
            )
            .map((ev) => ev.pitch)
        : expectedNotes.map((n) => n.pitch);

    if (pitches.length === 0) return;

    setOctaveShift((prev) => {
      const next = autoOctaveShiftForPitches(pitches, prev, rangeMode);
      return next !== prev ? next : prev;
    });
  }, [score, rangeMode, practiceState.mode, practiceState.beat, filteredEvents, expectedNotes]);

  const effectiveBpm = Math.max(1, Math.round(liveBpm * tempoScale));
  const totalAttempts =
    practiceState.stats.hits + practiceState.stats.misses + practiceState.stats.wrongNotes;
  const accuracyPct = getAccuracyPercent(practiceState.stats);
  const avgOffsetMs = getAverageOffsetMs(practiceState.stats);
  const hardestMeasure = getHardestMeasure(practiceState.stats);
  const nextChip = formatNextChip(expectedNotes);
  const totalMeasures = score ? Math.max(1, score.totalMeasures) : 1;
  const currentBar = score
    ? measureAtBeat(score.timeSignatures, defaultBeatsPerMeasure, practiceState.beat)
    : 1;

  const unopenedSaved = useMemo(() => {
    const openIds = new Set(sessionScores.map((s) => s.id));
    return savedScores.filter((row) => !openIds.has(`musescore:${row.scoreId}`));
  }, [sessionScores, savedScores]);

  const handleScoreDropdown = (value: string) => {
    if (!value) return;
    if (value.startsWith('saved:')) {
      onOpenSavedScore(value.slice(6));
      return;
    }
    const found = sessionScores.find((s) => s.id === value);
    if (found) onSelectScore(found);
  };

  const handleDrillHardest = () => {
    if (!score || hardestMeasure === null) return;
    setTempoScale(0.75);
    const loop = { enabled: true, startMeasure: hardestMeasure, endMeasure: hardestMeasure };
    dispatchPractice({ type: 'setLoop', loop });
    const reset = dispatchPractice({ type: 'reset' });
    schedulerRef.current?.updateConfig({ tempoScale: 0.75, loop });
    schedulerRef.current?.seekBeat(reset.beat);
    void pianoEngine.unlockFromGesture();
    dispatchPractice({ type: 'setRunning', running: true });
    schedulerRef.current?.play();
  };

  const surface = darkMode
    ? 'bg-stone-900/80 border-stone-800 text-stone-100'
    : 'bg-white/90 border-stone-200 text-stone-900 shadow-sm';
  const pillGroup = darkMode
    ? 'bg-stone-950/90 border-stone-800'
    : 'bg-stone-100 border-stone-200';
  const pillInactive = darkMode
    ? 'text-stone-400 hover:text-stone-200'
    : 'text-stone-600 hover:text-stone-900';
  const pillActive = darkMode
    ? 'bg-stone-800 text-amber-300 shadow-sm'
    : 'bg-white text-stone-900 shadow-sm';
  const mutedText = darkMode ? 'text-stone-400' : 'text-stone-500';
  const subtleBtn = darkMode
    ? 'border-stone-700 bg-stone-800/80 text-stone-200 hover:bg-stone-700'
    : 'border-stone-200 bg-stone-100 text-stone-700 hover:bg-stone-200';

  const selectValue = score ? score.id : '';
  const hasDeviceActive = midiDevices.length > 0 || micActive;

  const renderKeyboard = (flushTop: boolean) => (
    <PianoKeyboard
      layout={pianoLayout}
      rangeMode={rangeMode}
      onRangeModeChange={setRangeMode}
      octaveShift={octaveShift}
      onOctaveShift={shiftOctave}
      userPressedNotes={userPressedNotes}
      expectedNotes={practiceState.mode === 'listen' ? [] : expectedNotes}
      getPlaybackPitches={getPlaybackPitches}
      getPlaybackSustain={getPlaybackSustain}
      userSustainDown={userSustainDown}
      audioStatus={audioStatus}
      onNoteOn={handlePianoNoteOn}
      onNoteOff={handlePianoNoteOff}
      darkMode={darkMode}
      colorMode={colorMode}
      showKeyStickers={true}
      flushTop={flushTop}
      hideControls={Boolean(kidLocked)}
    />
  );

  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-2.5">
      {kidLocked ? (
        <div className={`flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 ${surface}`}>
          <button
            type="button"
            disabled={!score}
            onClick={togglePlay}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-bold text-stone-950 shadow-sm transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {practiceState.running ? (
              <>
                <Pause className="h-4 w-4" />
                Pause
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Play
              </>
            )}
          </button>

          <button
            type="button"
            disabled={!score}
            onClick={handleRestart}
            title="Restart"
            className={`inline-flex shrink-0 items-center justify-center rounded-xl border p-2.5 transition disabled:cursor-not-allowed disabled:opacity-40 ${subtleBtn}`}
          >
            <RotateCcw className="h-4 w-4" />
          </button>

          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {score ? score.title : 'Ready to Play'}
          </span>
        </div>
      ) : (
        <div className={`flex flex-col gap-2 rounded-2xl border px-2.5 py-2 sm:px-3 lg:flex-row lg:items-center lg:justify-between ${surface}`}>
        <div className="flex w-full items-center gap-1.5 sm:w-auto sm:flex-1 sm:gap-2">
          <button
            type="button"
            disabled={!score}
            onClick={togglePlay}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-amber-600 px-2.5 py-1.5 text-xs font-semibold text-stone-950 shadow-sm transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40 sm:px-3.5"
          >
            {practiceState.running ? (
              <>
                <Pause className="h-3.5 w-3.5" />
                Pause
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" />
                Play
              </>
            )}
          </button>

          <button
            type="button"
            disabled={!score}
            onClick={handleRestart}
            title="Restart"
            className={`inline-flex shrink-0 items-center justify-center rounded-xl border p-1.5 transition disabled:cursor-not-allowed disabled:opacity-40 ${subtleBtn}`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>

          <select
            aria-label="Open score"
            value={selectValue}
            disabled={scoreBusy}
            onChange={(e) => handleScoreDropdown(e.target.value)}
            className={`min-w-0 flex-1 truncate rounded-xl border px-2 py-1.5 text-xs font-medium focus:outline-none sm:max-w-[220px] sm:px-2.5 ${
              darkMode
                ? 'border-stone-800 bg-stone-950 text-stone-100'
                : 'border-stone-200 bg-stone-50 text-stone-800'
            }`}
          >
            {!score ? <option value="">Select a score…</option> : null}
            {sessionScores.length > 0 ? (
              <optgroup label="Opened">
                {sessionScores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {unopenedSaved.length > 0 ? (
              <optgroup label="Saved Library">
                {unopenedSaved.map((row) => (
                  <option key={row.scoreId} value={`saved:${row.scoreId}`}>
                    {row.title}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>

          <button
            type="button"
            onClick={() => setShowSettings((prev) => !prev)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-semibold transition sm:hidden ${
              showSettings
                ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                : subtleBtn
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Studio</span>
            <span
              className={`h-2 w-2 rounded-full ${
                hasDeviceActive ? 'bg-emerald-400' : 'bg-stone-500/60'
              }`}
            />
          </button>
        </div>

        <div className="flex w-full items-center justify-between gap-1.5 sm:w-auto sm:flex-wrap sm:justify-end sm:gap-2">
          <div className={`inline-flex items-center rounded-xl border p-0.5 ${pillGroup}`}>
            {PRACTICE_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.hint}
                onClick={() => handleModeChange(m.id)}
                className={`rounded-lg px-2 py-1 text-[11px] font-semibold transition sm:px-2.5 sm:text-xs ${
                  practiceState.mode === m.id ? pillActive : pillInactive
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className={`hidden items-center rounded-xl border p-0.5 sm:inline-flex ${pillGroup}`}>
            {HAND_OPTIONS.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => handleHandChange(h.id)}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  practiceState.handFilter === h.id ? pillActive : pillInactive
                }`}
              >
                {h.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowSettings((prev) => !prev)}
            className={`hidden items-center gap-1.5 rounded-xl border px-2.5 py-1.5 font-mono text-xs font-medium transition sm:inline-flex ${subtleBtn}`}
            title="Tempo & studio settings"
          >
            <span>{effectiveBpm} BPM</span>
            {tempoScale !== 1 ? (
              <span className="text-amber-400">{Math.round(tempoScale * 100)}%</span>
            ) : null}
          </button>

          <div className={`inline-flex items-center rounded-xl border p-0.5 ${pillGroup}`}>
            {LAYOUT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setViewLayout(opt.id)}
                className={`rounded-lg px-2 py-1 text-[11px] font-semibold transition sm:px-2.5 sm:text-xs ${
                  viewLayout === opt.id ? pillActive : pillInactive
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowSettings((prev) => !prev)}
            className={`hidden items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-semibold transition sm:inline-flex ${
              showSettings
                ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                : subtleBtn
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Studio</span>
            <span
              className={`h-2 w-2 rounded-full ${
                hasDeviceActive ? 'bg-emerald-400' : 'bg-stone-500/60'
              }`}
            />
          </button>

          <button
            type="button"
            disabled={!score}
            onClick={() => score && onExportPdf(score)}
            title="Export sheet music PDF"
            className={`hidden items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 sm:inline-flex ${subtleBtn}`}
          >
            <FileDown className="h-3.5 w-3.5" />
            <span>PDF</span>
          </button>
        </div>
      </div>
      )}

      {showSettings && !kidLocked ? (
        <section className={`rounded-2xl border p-4 ${surface}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-stone-800/40 pb-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold">Hand Focus</span>
                <div className={`inline-flex items-center rounded-xl border p-0.5 ${pillGroup}`}>
                  {HAND_OPTIONS.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => handleHandChange(h.id)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                        practiceState.handFilter === h.id ? pillActive : pillInactive
                      }`}
                    >
                      {h.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold">Key Size</span>
                <div className={`inline-flex items-center rounded-xl border p-0.5 ${pillGroup}`}>
                  {KEY_SIZE_OPTIONS.map((opt) => (
                    <button
                      key={opt.mode}
                      type="button"
                      onClick={() => setRangeMode(opt.mode)}
                      className={`rounded-lg px-2 py-1 text-xs font-semibold transition ${
                        rangeMode === opt.mode ? pillActive : pillInactive
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold">Colors</span>
                <div className={`inline-flex items-center rounded-xl border p-0.5 ${pillGroup}`}>
                  {COLOR_MODE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setColorMode(opt.id)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                        colorMode === opt.id ? pillActive : pillInactive
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              type="button"
              disabled={!score}
              onClick={() => score && onExportPdf(score)}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${subtleBtn}`}
            >
              <FileDown className="h-3.5 w-3.5" />
              <span>Export PDF</span>
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span>Tempo Speed</span>
                  <span className="font-mono text-amber-400">{Math.round(tempoScale * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.4}
                  max={1.4}
                  step={0.05}
                  value={tempoScale}
                  onChange={(e) => setTempoScale(Number(e.target.value))}
                  className="mt-1.5 w-full accent-amber-500"
                />
                <div className="mt-1 flex items-center justify-between text-[11px] text-stone-400">
                  <span>40%</span>
                  <button
                    type="button"
                    onClick={() => setTempoScale(1)}
                    className="hover:text-amber-400"
                  >
                    Reset 100%
                  </button>
                  <span>140%</span>
                </div>
              </div>

              <div className="space-y-2 border-t border-stone-800/60 pt-3">
                <div className="flex items-center justify-between">
                  <label className="inline-flex items-center gap-2 text-xs font-semibold">
                    <Repeat className="h-3.5 w-3.5 text-amber-400" />
                    <span>Measure Loop</span>
                  </label>
                  <input
                    type="checkbox"
                    disabled={!score}
                    checked={practiceState.loop.enabled}
                    onChange={(e) =>
                      dispatchPractice({
                        type: 'setLoop',
                        loop: { enabled: e.target.checked },
                      })
                    }
                    className="h-4 w-4 accent-amber-500"
                  />
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={mutedText}>Bars</span>
                  <input
                    type="number"
                    min={1}
                    max={totalMeasures}
                    disabled={!score}
                    value={practiceState.loop.startMeasure}
                    onChange={(e) =>
                      dispatchPractice({
                        type: 'setLoop',
                        loop: { startMeasure: Number(e.target.value) || 1 },
                      })
                    }
                    className={`w-16 rounded-lg border px-2 py-1 font-mono text-xs ${
                      darkMode
                        ? 'border-stone-800 bg-stone-950 text-stone-100'
                        : 'border-stone-200 bg-stone-50 text-stone-900'
                    }`}
                  />
                  <span className={mutedText}>to</span>
                  <input
                    type="number"
                    min={practiceState.loop.startMeasure}
                    max={totalMeasures}
                    disabled={!score}
                    value={practiceState.loop.endMeasure}
                    onChange={(e) =>
                      dispatchPractice({
                        type: 'setLoop',
                        loop: { endMeasure: Number(e.target.value) || totalMeasures },
                      })
                    }
                    className={`w-16 rounded-lg border px-2 py-1 font-mono text-xs ${
                      darkMode
                        ? 'border-stone-800 bg-stone-950 text-stone-100'
                        : 'border-stone-200 bg-stone-50 text-stone-900'
                    }`}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Metronome Click</span>
                <input
                  type="checkbox"
                  checked={metronomeOn}
                  onChange={(e) => setMetronomeOn(e.target.checked)}
                  className="h-4 w-4 accent-amber-500"
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold">Guide Piano</div>
                  <div className={`text-[11px] ${mutedText}`}>Plays reference notes in Tempo mode</div>
                </div>
                <input
                  type="checkbox"
                  checked={guideSoundOn}
                  onChange={(e) => setGuideSoundOn(e.target.checked)}
                  className="h-4 w-4 accent-amber-500"
                />
              </div>

              <div>
                <div className="text-xs font-semibold">Piano Voice</div>
                <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                  {VOICE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setVoice(opt.id)}
                      className={`rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition ${
                        voice === opt.id
                          ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                          : subtleBtn
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="inline-flex items-center gap-1.5">
                    <Volume2 className="h-3.5 w-3.5 text-amber-400" />
                    Volume
                  </span>
                  <span className="font-mono text-[11px]">{Math.round(volume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className="mt-1 w-full accent-amber-500"
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold">
                    <Usb className="h-3.5 w-3.5 text-amber-400" />
                    MIDI Keyboard
                  </div>
                  <div className={`text-[11px] ${mutedText}`}>
                    {midiDevices.length > 0
                      ? midiDevices.map((d) => d.name).join(', ')
                      : midiState === 'denied'
                        ? 'Permission denied'
                        : midiState === 'unsupported'
                          ? 'Web MIDI unsupported'
                          : midiState === 'ready'
                            ? 'Ready · no device plugged in'
                            : 'Not connected'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onConnectMidi}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${subtleBtn}`}
                >
                  {midiState === 'ready' ? 'Refresh' : 'Connect'}
                </button>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold">Mute local sound for MIDI</div>
                  <div className={`text-[11px] ${mutedText}`}>
                    Use digital piano speakers without double audio
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={muteLocalForMidi}
                  onChange={(e) => setMuteLocalForMidi(e.target.checked)}
                  className="h-4 w-4 accent-amber-500"
                />
              </div>

              <div className="space-y-2 border-t border-stone-800/60 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="inline-flex items-center gap-1.5 text-xs font-semibold">
                      <AudioLines className="h-3.5 w-3.5 text-amber-400" />
                      Acoustic Mic
                    </div>
                    <div className="font-mono text-[11px] text-amber-400">
                      {micActive
                        ? micPitch
                          ? `${micPitch.name} · ${micPitch.centsOff >= 0 ? '+' : ''}${micPitch.centsOff}¢`
                          : 'Listening…'
                        : 'Off'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onToggleMic}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                      micActive
                        ? 'bg-rose-600 text-white hover:bg-rose-500'
                        : 'bg-emerald-600 text-white hover:bg-emerald-500'
                    }`}
                  >
                    {micActive ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
                    {micActive ? 'Stop Mic' : 'Enable Mic'}
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <label className="inline-flex items-center gap-1.5 text-xs font-semibold">
                    <Headphones className="h-3.5 w-3.5 text-stone-400" />
                    Using Headphones
                  </label>
                  <input
                    type="checkbox"
                    checked={headphonesMode}
                    onChange={(e) => setHeadphonesMode(e.target.checked)}
                    className="h-4 w-4 accent-amber-500"
                  />
                </div>

                <p className={`text-[11px] leading-snug ${mutedText}`}>
                  Monophonic pitch detection (one note at a time). Automatically pauses during speaker
                  playback unless headphones are enabled.
                </p>
                {micError ? <p className="text-[11px] font-medium text-rose-400">{micError}</p> : null}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {score ? (
        <div className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-1.5 text-xs ${surface}`}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                practiceState.lastFeedback.status === 'hit'
                  ? 'bg-emerald-400'
                  : practiceState.lastFeedback.status === 'miss'
                    ? 'bg-rose-400'
                    : 'bg-amber-400'
              }`}
            />
            <span className="truncate font-medium">
              {practiceState.mode === 'listen'
                ? practiceState.running
                  ? `Listening · Bar ${currentBar}`
                  : 'Press Play to listen.'
                : practiceState.mode === 'wait' &&
                    practiceState.lastFeedback.status === 'hit' &&
                    practiceState.stats.streak >= 3
                  ? `Awesome! ⭐ ${practiceState.stats.streak} in a row · ${practiceState.lastFeedback.text}`
                  : practiceState.lastFeedback.text ||
                    PRACTICE_MODES.find((m) => m.id === practiceState.mode)?.idle}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] sm:gap-3 sm:text-xs">
            {practiceState.mode !== 'listen' ? (
              <>
                <span className="rounded-lg bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-400">
                  {nextChip}
                </span>
                <span className="hidden sm:inline">
                  <span className={mutedText}>Hits </span>
                  <strong>{practiceState.stats.hits}</strong>
                </span>
                <span>
                  <span className={mutedText}>Acc </span>
                  <strong>{totalAttempts > 0 ? `${accuracyPct}%` : '—'}</strong>
                </span>
                <span>
                  <span className={mutedText}>Streak </span>
                  <strong>{practiceState.stats.streak}</strong>
                </span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {score && practiceState.finished ? (
        <div
          className={`flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-5 py-4 ${
            darkMode
              ? 'border-amber-500/40 bg-amber-500/10 text-stone-100'
              : 'border-amber-600/30 bg-amber-50 text-stone-900'
          }`}
        >
          <div>
            <p className="font-display text-2xl">You played it! 🌟</p>
            <div className="mt-1 flex flex-wrap items-center gap-4 font-mono text-xs">
              <span>Accuracy: {totalAttempts > 0 ? `${accuracyPct}%` : '—'}</span>
              <span>
                Avg Offset:{' '}
                {practiceState.stats.offsetsMs.length > 0
                  ? `${avgOffsetMs >= 0 ? '+' : ''}${avgOffsetMs} ms`
                  : '—'}
              </span>
              <span>Best Streak: {practiceState.stats.bestStreak}</span>
              <span>
                Hardest Measure: {hardestMeasure !== null ? `Bar ${hardestMeasure}` : 'None'}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRestart}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-semibold text-stone-950 transition hover:bg-amber-500"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Play Again
            </button>
            {hardestMeasure !== null ? (
              <button
                type="button"
                onClick={handleDrillHardest}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition ${subtleBtn}`}
              >
                <Repeat className="h-3.5 w-3.5" />
                Drill Bar {hardestMeasure} at 75%
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {!score ? (
        <>
          <div className={`flex flex-col items-center justify-center rounded-2xl border px-6 py-12 text-center ${surface}`}>
            <h2 className="font-display text-3xl tracking-tight">Ready at the Bench</h2>
            <p className={`mt-2 max-w-md text-xs leading-relaxed ${mutedText}`}>
              Open a saved score or local MIDI file from the Library, or load the bundled sample
              piece to start practicing with interactive notation and falling notes.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                disabled={sampleLoading}
                onClick={() => void onLoadSample()}
                className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-stone-950 shadow-sm transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sampleLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Load Sample: Merry-Go-Round of Life
              </button>
              <button
                type="button"
                onClick={onGoToLibrary}
                className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-xs font-semibold transition ${subtleBtn}`}
              >
                <Library className="h-3.5 w-3.5" />
                Browse Library
              </button>
            </div>
          </div>

          {renderKeyboard(false)}
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {viewLayout === 'notation' || viewLayout === 'combined' ? (
            <GrandStaff
              score={score}
              events={filteredEvents}
              grades={practiceState.grades}
              loop={practiceState.loop}
              getLiveBeat={getLiveBeat}
              onSeekBeat={handleSeekBeat}
              onPreviewPitch={handlePreviewPitch}
              darkMode={darkMode}
            />
          ) : null}

          {viewLayout === 'falling' || viewLayout === 'combined' ? (
            <div
              className={[
                'flex flex-col overflow-hidden rounded-2xl border',
                darkMode ? 'border-stone-800' : 'border-stone-300/80',
              ].join(' ')}
            >
              <div
                className={
                  viewLayout === 'combined'
                    ? 'h-36 sm:h-48 lg:h-56'
                    : 'h-[44dvh] min-h-[270px] max-h-[500px]'
                }
              >
                <FallingNotesCanvas
                  events={filteredEvents}
                  layout={pianoLayout}
                  timeSignatures={score.timeSignatures}
                  defaultBeatsPerMeasure={defaultBeatsPerMeasure}
                  grades={practiceState.grades}
                  getLiveBeat={getLiveBeat}
                  darkMode={darkMode}
                  colorMode={colorMode}
                  onColorModeChange={setColorMode}
                  flushBottom
                  hideToolbar={Boolean(kidLocked)}
                  canShiftOctave={rangeMode === 'kid' || rangeMode === 'compact'}
                  octaveShift={octaveShift}
                  onOctaveShift={shiftOctave}
                />
              </div>

              {renderKeyboard(true)}
            </div>
          ) : (
            renderKeyboard(false)
          )}
        </div>
      )}
    </div>
  );
}
