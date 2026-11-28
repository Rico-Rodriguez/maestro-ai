import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  FileDown,
  Headphones,
  Library,
  Loader2,
  Mic,
  MicOff,
  Moon,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Sparkles,
  Star,
  Sun,
  Usb,
  Volume2,
  X,
} from 'lucide-react';
import { pianoEngine, type AudioEngineStatus, type InstrumentVoice } from '../audio/piano-engine';
import { PlaybackScheduler } from '../audio/scheduler';
import { attachKeyboardInput } from '../input/keyboard-adapter';
import type { MidiInputController } from '../input/midi-adapter';
import type { MicPitchReading, MidiAccessState, MidiDeviceInfo, NoteInput } from '../input/types';
import { bpmAtBeat } from '../music/midi-parser';
import { findToddlerSongSpec } from '../music/toddler-songs';
import type { Hand, Score } from '../music/types';
import {
  createPracticeState,
  getAccuracyPercent,
  getAverageOffsetMs,
  getExpectedNotes,
  getHardestMeasure,
  reducePractice,
  type HandFilter,
  type PracticeAction,
  type PracticeMode,
  type PracticeState,
} from '../practice/engine';
import FallingNotesCanvas from './FallingNotesCanvas';
import GrandStaff from './GrandStaff';
import { deriveKidPrompt } from './kid-feedback';
import type { SavedMuseScore } from './LibraryView';
import MascotBuddy from './MascotBuddy';
import { type ColorMode } from './note-colors';
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
  onToggleDarkMode?: () => void;
  showSettings?: boolean;
  onToggleSettings?: () => void;
  onCloseSettings?: () => void;
  midiController: MidiInputController;
  midiState: MidiAccessState;
  midiDevices: MidiDeviceInfo[];
  onConnectMidi: () => void;
  micActive: boolean;
  micPitch: MicPitchReading | null;
  micLevel?: number;
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
  { id: 'falling', label: 'Falling' },
  { id: 'notation', label: 'Sheet' },
  { id: 'combined', label: 'Split' },
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

const GROWNUP_PRACTICE_MODES: readonly { id: PracticeMode; label: string }[] = [
  { id: 'wait', label: 'Learn (Wait)' },
  { id: 'tempo', label: 'Keep Time (Tempo)' },
  { id: 'listen', label: 'Listen' },
];

const CELEBRATION_ARPEGGIO = [72, 76, 79, 84] as const;

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
  onToggleDarkMode,
  showSettings: controlledShowSettings,
  onToggleSettings,
  onCloseSettings,
  midiController,
  midiState,
  midiDevices,
  onConnectMidi,
  micActive,
  micPitch,
  micLevel = 0,
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
  const [rangeMode, setRangeMode] = useState<PianoRangeMode>('kid');
  const [octaveShift, setOctaveShift] = useState(0);
  const [viewLayout, setViewLayout] = useState<StudioViewLayout>('falling');
  const [colorMode, setColorMode] = useState<ColorMode>('rainbow');
  const [tempoScale, setTempoScale] = useState(0.85);
  const [metronomeOn, setMetronomeOn] = useState(false);
  const [guideSoundOn, setGuideSoundOn] = useState(true);
  const [muteLocalForMidi, setMuteLocalForMidi] = useState(false);
  const [headphonesMode, setHeadphonesMode] = useState(false);
  const [voice, setVoice] = useState<InstrumentVoice>('grand-piano');
  const [volume, setVolume] = useState(0.85);
  const [internalShowSettings, setInternalShowSettings] = useState(false);
  const [liveBpm, setLiveBpm] = useState<number>(() => (score ? Math.round(score.tempo || 120) : 120));

  const showSettings = controlledShowSettings ?? internalShowSettings;
  const closeSettings = useCallback(() => {
    if (onCloseSettings) {
      onCloseSettings();
    } else {
      setInternalShowSettings(false);
    }
  }, [onCloseSettings]);

  const scoreRef = useRef<Score | null>(score);
  const practiceStateRef = useRef<PracticeState>(practiceState);
  const schedulerRef = useRef<PlaybackScheduler | null>(null);
  const tempoScaleRef = useRef(tempoScale);
  const metronomeOnRef = useRef(metronomeOn);
  const guideSoundOnRef = useRef(guideSoundOn);
  const muteLocalForMidiRef = useRef(muteLocalForMidi);
  const headphonesModeRef = useRef(headphonesMode);
  const octaveShiftRef = useRef(octaveShift);
  const prevFinishedRef = useRef(false);
  const celebrationTimersRef = useRef<number[]>([]);

  scoreRef.current = score;
  tempoScaleRef.current = tempoScale;
  metronomeOnRef.current = metronomeOn;
  guideSoundOnRef.current = guideSoundOn;
  muteLocalForMidiRef.current = muteLocalForMidi;
  headphonesModeRef.current = headphonesMode;
  octaveShiftRef.current = octaveShift;

  const clearCelebrationTimers = useCallback(() => {
    for (const timerId of celebrationTimersRef.current) {
      window.clearTimeout(timerId);
    }
    celebrationTimersRef.current = [];
  }, []);

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
    clearCelebrationTimers();
    prevFinishedRef.current = false;
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
  }, [score, clearCelebrationTimers]);

  useEffect(() => {
    return () => {
      clearCelebrationTimers();
    };
  }, [clearCelebrationTimers]);

  useEffect(() => {
    if (!practiceState.finished) {
      prevFinishedRef.current = false;
      return;
    }
    if (!prevFinishedRef.current && practiceState.mode !== 'listen') {
      prevFinishedRef.current = true;
      clearCelebrationTimers();
      void pianoEngine.unlockFromGesture();
      CELEBRATION_ARPEGGIO.forEach((midi, idx) => {
        const onTimer = window.setTimeout(() => {
          pianoEngine.noteOn(midi, 88, undefined, 'playback');
          const offTimer = window.setTimeout(() => {
            pianoEngine.noteOff(midi, undefined, 'playback');
          }, 260);
          celebrationTimersRef.current.push(offTimer);
        }, idx * 110);
        celebrationTimersRef.current.push(onTimer);
      });
    }
  }, [practiceState.finished, practiceState.mode, clearCelebrationTimers]);

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
      clearCelebrationTimers();
      schedulerRef.current?.seekBeat(next.beat);
    }
    schedulerRef.current?.play();
  }, [dispatchPractice, clearCelebrationTimers]);

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
    clearCelebrationTimers();
    schedulerRef.current?.pause();
    const next = dispatchPractice({ type: 'reset' });
    schedulerRef.current?.seekBeat(next.beat);
  }, [dispatchPractice, clearCelebrationTimers]);

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
      clearCelebrationTimers();
      dispatchPractice({ type: 'seek', beat });
      schedulerRef.current?.seekBeat(beat);
    },
    [dispatchPractice, clearCelebrationTimers],
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

  const expectedPitches = useMemo(() => {
    if (practiceState.mode === 'listen' || practiceState.finished) return [];
    return expectedNotes.map((n) => n.pitch);
  }, [practiceState.mode, practiceState.finished, expectedNotes]);

  const kidPrompt = useMemo(
    () => deriveKidPrompt(practiceState, expectedNotes),
    [practiceState, expectedNotes],
  );

  const defaultBeatsPerMeasure = useMemo(() => {
    if (!score) return 4;
    const [num, den] = score.timeSignature;
    return Math.max(1, num * (4 / Math.max(1, den)));
  }, [score]);

  useEffect(() => {
    if (kidLocked) {
      closeSettings();
    }
  }, [kidLocked, closeSettings]);

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
  const totalMeasures = score ? Math.max(1, score.totalMeasures) : 1;
  const activeToddlerSpec = findToddlerSongSpec(score?.id ?? null);
  const songEmoji = activeToddlerSpec?.emoji ?? '🎹';

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
    clearCelebrationTimers();
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
    ? 'bg-[#1a2042]/90 border-indigo-800/70 text-amber-50'
    : 'bg-white/95 border-amber-200/80 text-amber-950 shadow-sm';
  const drawerCard = darkMode
    ? 'rounded-2xl border border-indigo-800/70 bg-[#141936]/75 p-3.5'
    : 'rounded-2xl border border-amber-200/80 bg-[#fffbf0]/90 p-3.5';
  const pillGroup = darkMode
    ? 'bg-[#141936]/90 border-indigo-800/80'
    : 'bg-amber-100/70 border-amber-200/90';
  const pillInactive = darkMode
    ? 'text-indigo-200/75 hover:text-amber-100'
    : 'text-amber-800/75 hover:text-amber-950';
  const pillActive = darkMode
    ? 'bg-indigo-700 text-amber-200 shadow-sm'
    : 'bg-white text-amber-950 shadow-sm';
  const mutedText = darkMode ? 'text-indigo-200/70' : 'text-amber-800/70';
  const subtleBtn = darkMode
    ? 'border-indigo-700/80 bg-indigo-900/60 text-amber-100 hover:bg-indigo-800'
    : 'border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100';

  const selectValue = score ? score.id : '';

  const renderKeyboard = (flushTop: boolean) => (
    <PianoKeyboard
      layout={pianoLayout}
      rangeMode={rangeMode}
      onRangeModeChange={setRangeMode}
      octaveShift={octaveShift}
      onOctaveShift={shiftOctave}
      userPressedNotes={userPressedNotes}
      expectedNotes={practiceState.mode === 'listen' || practiceState.finished ? [] : expectedNotes}
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
      hideControls={colorMode === 'rainbow' || Boolean(kidLocked)}
    />
  );

  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-2.5">
      <div
        className={`flex flex-wrap items-center justify-between gap-2 rounded-3xl border px-3 py-2 sm:px-4 ${surface}`}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!score}
            onClick={togglePlay}
            className={`inline-flex shrink-0 items-center gap-2 rounded-2xl border-b-4 px-4 py-2 text-sm font-extrabold shadow-sm transition active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40 ${
              practiceState.running
                ? 'border-amber-600 bg-amber-400 text-amber-950 hover:bg-amber-300'
                : 'border-emerald-700 bg-emerald-500 text-white hover:bg-emerald-400'
            }`}
          >
            {practiceState.running ? (
              <>
                <Pause className="h-4 w-4 fill-current" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="h-4 w-4 fill-current" />
                <span>Play</span>
              </>
            )}
          </button>

          <button
            type="button"
            disabled={!score}
            onClick={handleRestart}
            title="Start song over"
            aria-label="Restart song"
            className={`inline-flex shrink-0 items-center justify-center rounded-2xl border border-b-4 p-2 transition active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40 ${subtleBtn}`}
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        </div>

        {kidLocked ? (
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <span className="truncate font-display text-sm font-bold sm:text-base">
              {songEmoji} {score ? score.title : 'Ready to Play'}
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className={`inline-flex items-center rounded-2xl border p-0.5 ${pillGroup}`}>
              <button
                type="button"
                onClick={() => handleModeChange('wait')}
                className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                  practiceState.mode === 'wait' ? pillActive : pillInactive
                }`}
              >
                Learn
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('listen')}
                className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                  practiceState.mode === 'listen' ? pillActive : pillInactive
                }`}
              >
                Listen
              </button>
              {practiceState.mode === 'tempo' ? (
                <button
                  type="button"
                  onClick={() => handleModeChange('tempo')}
                  className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${pillActive}`}
                >
                  Tempo
                </button>
              ) : null}
            </div>

            <div className={`inline-flex items-center rounded-2xl border p-0.5 ${pillGroup}`}>
              <button
                type="button"
                onClick={() => setTempoScale(0.65)}
                className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                  tempoScale <= 0.7 ? pillActive : pillInactive
                }`}
              >
                🐢 Slow
              </button>
              <button
                type="button"
                onClick={() => setTempoScale(0.85)}
                className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                  tempoScale > 0.7 ? pillActive : pillInactive
                }`}
              >
                🐰 Normal
              </button>
            </div>

            <button
              type="button"
              onClick={onGoToLibrary}
              title="Pick a different song"
              className={`inline-flex max-w-[190px] items-center gap-1.5 rounded-2xl border px-3 py-1.5 text-xs font-bold transition sm:max-w-[260px] ${subtleBtn}`}
            >
              <span className="shrink-0">{songEmoji}</span>
              <span className="truncate">{score ? score.title : 'Pick a Song'}</span>
            </button>
          </div>
        )}
      </div>

      {showSettings && !kidLocked ? (
        <section className={`rounded-3xl border p-4 ${surface}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-amber-300/30 pb-2.5">
            <div>
              <h2 className="font-display text-lg font-bold">Grown-up Studio Settings</h2>
              <p className={`text-xs ${mutedText}`}>
                Fine-tune practice mode, keyboard size, audio, MIDI, and acoustic mic.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onToggleDarkMode ? (
                <button
                  type="button"
                  onClick={onToggleDarkMode}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-bold transition ${subtleBtn}`}
                >
                  {darkMode ? <Sun className="h-3.5 w-3.5 text-amber-300" /> : <Moon className="h-3.5 w-3.5" />}
                  <span>{darkMode ? 'Sunny Day' : 'Cozy Night'}</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={closeSettings}
                aria-label="Close settings"
                className={`inline-flex items-center justify-center rounded-xl border p-1.5 transition ${subtleBtn}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
            <div className={`space-y-3 ${drawerCard}`}>
              <div>
                <div className="mb-1.5 text-xs font-bold">Practice Mode</div>
                <div className={`inline-flex flex-wrap items-center rounded-xl border p-0.5 ${pillGroup}`}>
                  {GROWNUP_PRACTICE_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleModeChange(m.id)}
                      className={`rounded-lg px-2 py-1 text-[11px] font-bold transition ${
                        practiceState.mode === m.id ? pillActive : pillInactive
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-xs font-bold">View</div>
                <div className={`inline-flex items-center rounded-xl border p-0.5 ${pillGroup}`}>
                  {LAYOUT_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setViewLayout(opt.id)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                        viewLayout === opt.id ? pillActive : pillInactive
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs font-bold">
                  <span>Key Size</span>
                  {(rangeMode === 'kid' || rangeMode === 'compact') && (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        disabled={octaveShift <= -2}
                        onClick={() => shiftOctave(-1)}
                        className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold disabled:opacity-40 ${subtleBtn}`}
                      >
                        -8va
                      </button>
                      <button
                        type="button"
                        disabled={octaveShift >= 2}
                        onClick={() => shiftOctave(1)}
                        className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold disabled:opacity-40 ${subtleBtn}`}
                      >
                        +8va
                      </button>
                    </div>
                  )}
                </div>
                <div className={`inline-flex flex-wrap items-center rounded-xl border p-0.5 ${pillGroup}`}>
                  {KEY_SIZE_OPTIONS.map((opt) => (
                    <button
                      key={opt.mode}
                      type="button"
                      onClick={() => setRangeMode(opt.mode)}
                      className={`rounded-lg px-2 py-1 text-xs font-bold transition ${
                        rangeMode === opt.mode ? pillActive : pillInactive
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="mb-1 text-xs font-bold">Hand Focus</div>
                  <div className={`inline-flex items-center rounded-xl border p-0.5 ${pillGroup}`}>
                    {HAND_OPTIONS.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => handleHandChange(h.id)}
                        className={`rounded-lg px-2 py-1 text-xs font-bold transition ${
                          practiceState.handFilter === h.id ? pillActive : pillInactive
                        }`}
                      >
                        {h.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-xs font-bold">Colors</div>
                  <div className={`inline-flex items-center rounded-xl border p-0.5 ${pillGroup}`}>
                    {COLOR_MODE_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setColorMode(opt.id)}
                        className={`rounded-lg px-2 py-1 text-xs font-bold transition ${
                          colorMode === opt.id ? pillActive : pillInactive
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {(sessionScores.length > 0 || unopenedSaved.length > 0) && (
                <div>
                  <div className="mb-1 text-xs font-bold">Switch Grown-up Score</div>
                  <select
                    aria-label="Open score"
                    value={selectValue}
                    disabled={scoreBusy}
                    onChange={(e) => handleScoreDropdown(e.target.value)}
                    className={`w-full truncate rounded-xl border px-2.5 py-1.5 text-xs font-medium focus:outline-none ${
                      darkMode
                        ? 'border-indigo-800 bg-[#1a2042] text-amber-50'
                        : 'border-amber-200 bg-white text-amber-950'
                    }`}
                  >
                    {!score || score.id.startsWith('toddler:') ? (
                      <option value="">Choose uploaded or saved score…</option>
                    ) : null}
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
                </div>
              )}
            </div>

            <div className={`space-y-3 ${drawerCard}`}>
              <div>
                <div className="flex items-center justify-between text-xs font-bold">
                  <span>Tempo Speed ({effectiveBpm} BPM)</span>
                  <span className="font-mono text-amber-500">{Math.round(tempoScale * 100)}%</span>
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
                <div className={`mt-1 flex items-center justify-between text-[11px] ${mutedText}`}>
                  <span>40%</span>
                  <button
                    type="button"
                    onClick={() => setTempoScale(1)}
                    className="font-semibold hover:text-amber-500"
                  >
                    Reset 100%
                  </button>
                  <span>140%</span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs font-bold">Metronome Click</span>
                <input
                  type="checkbox"
                  checked={metronomeOn}
                  onChange={(e) => setMetronomeOn(e.target.checked)}
                  className="h-4 w-4 accent-amber-500"
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold">Guide Piano</div>
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
                <div className="text-xs font-bold">Piano Voice</div>
                <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                  {VOICE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setVoice(opt.id)}
                      className={`rounded-lg border px-2 py-1.5 text-[11px] font-bold transition ${
                        voice === opt.id
                          ? darkMode
                            ? 'border-amber-400 bg-amber-400/20 text-amber-200'
                            : 'border-amber-500 bg-amber-400/20 text-amber-900'
                          : subtleBtn
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs font-bold">
                  <span className="inline-flex items-center gap-1.5">
                    <Volume2 className="h-3.5 w-3.5 text-amber-500" />
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

              <div className="space-y-2 border-t border-amber-300/30 pt-2.5">
                <div className="flex items-center justify-between">
                  <label className="inline-flex items-center gap-1.5 text-xs font-bold">
                    <Repeat className="h-3.5 w-3.5 text-amber-500" />
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
                        ? 'border-indigo-800 bg-[#1a2042] text-amber-50'
                        : 'border-amber-200 bg-white text-amber-950'
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
                        ? 'border-indigo-800 bg-[#1a2042] text-amber-50'
                        : 'border-amber-200 bg-white text-amber-950'
                    }`}
                  />
                </div>
              </div>
            </div>

            <div className={`space-y-3 ${drawerCard}`}>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="inline-flex items-center gap-1.5 text-xs font-bold">
                      <Usb className="h-3.5 w-3.5 text-amber-500" />
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
                    className={`rounded-lg border px-2.5 py-1 text-xs font-bold transition ${subtleBtn}`}
                  >
                    {midiState === 'ready' && midiDevices.length === 0
                      ? 'Connect / Scan'
                      : midiState === 'ready'
                        ? 'Refresh'
                        : 'Connect'}
                  </button>
                </div>
                {midiDevices.length === 0 ? (
                  <p className={`text-[11px] leading-snug ${mutedText}`}>
                    Plug in USB-MIDI or tap Connect / Scan for Bluetooth MIDI
                  </p>
                ) : null}
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold">Mute local sound for MIDI</div>
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

              <div className="space-y-2 border-t border-amber-300/30 pt-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="inline-flex items-center gap-1.5 text-xs font-bold">
                      <AudioLines className="h-3.5 w-3.5 text-amber-500" />
                      Acoustic Mic
                    </div>
                    <div className="font-mono text-[11px] text-amber-500">
                      {micActive
                        ? micPitch
                          ? `${micPitch.name} · ${micPitch.centsOff >= 0 ? '+' : ''}${micPitch.centsOff}¢`
                          : audioStatus.playbackSounding && !headphonesMode
                            ? 'Paused during speaker playback'
                            : 'Listening…'
                        : 'Off'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onToggleMic}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                      micActive
                        ? 'bg-rose-600 text-white hover:bg-rose-500'
                        : 'bg-emerald-600 text-white hover:bg-emerald-500'
                    }`}
                  >
                    {micActive ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
                    {micActive ? 'Stop Mic' : 'Enable Mic'}
                  </button>
                </div>

                <div>
                  <div className={`mb-1 flex items-center justify-between text-[11px] ${mutedText}`}>
                    <span>Mic Level</span>
                    <span className="font-mono">{Math.round(micLevel * 100)}%</span>
                  </div>
                  <div
                    className={`h-1.5 w-full overflow-hidden rounded-full ${
                      darkMode ? 'bg-indigo-950' : 'bg-amber-100'
                    }`}
                  >
                    <div
                      className="h-full rounded-full bg-emerald-400 transition-[width] duration-75"
                      style={{ width: `${Math.round(micLevel * 100)}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <label className="inline-flex items-center gap-1.5 text-xs font-bold">
                    <Headphones className="h-3.5 w-3.5 text-amber-500" />
                    Using Headphones
                  </label>
                  <input
                    type="checkbox"
                    checked={headphonesMode}
                    onChange={(e) => setHeadphonesMode(e.target.checked)}
                    className="h-4 w-4 accent-amber-500"
                  />
                </div>

                {micError ? <p className="text-[11px] font-medium text-rose-500">{micError}</p> : null}
              </div>

              <div className="border-t border-amber-300/30 pt-2.5">
                <button
                  type="button"
                  disabled={!score}
                  onClick={() => score && onExportPdf(score)}
                  className={`inline-flex w-full items-center justify-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${subtleBtn}`}
                >
                  <FileDown className="h-3.5 w-3.5" />
                  <span>Export Sheet Music PDF</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {score ? (
        <div className={`rounded-3xl border px-3.5 py-2.5 sm:px-4 ${surface}`}>
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <MascotBuddy mood={kidPrompt.mood} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-base font-bold leading-tight sm:text-lg">
                    {kidPrompt.headline}
                  </span>
                  {kidPrompt.targetNote ? (
                    <span
                      style={{
                        backgroundColor: kidPrompt.targetNote.bg,
                        color: kidPrompt.targetNote.text,
                      }}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-extrabold shadow-sm ring-2 ring-white/80"
                    >
                      {kidPrompt.targetNote.colorName} {kidPrompt.targetNote.letter}
                    </span>
                  ) : null}
                  {kidPrompt.cheerBadge ? (
                    <span
                      key={`${kidPrompt.starsEarned}-${kidPrompt.cheerBadge}`}
                      className="animate-kid-pop inline-flex items-center rounded-full bg-gradient-to-r from-amber-300 to-rose-300 px-2.5 py-0.5 text-xs font-extrabold text-amber-950 shadow-sm"
                    >
                      {kidPrompt.cheerBadge}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-300/80 bg-amber-100/90 px-3 py-1 text-xs font-extrabold text-amber-900 shadow-sm">
              <span>⭐ {kidPrompt.starsEarned}</span>
            </div>
          </div>

          <div
            aria-label="Song progress"
            className={`mt-2 h-2.5 w-full overflow-hidden rounded-full ${
              darkMode ? 'bg-indigo-950/90' : 'bg-amber-100'
            }`}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-rose-400 via-amber-400 via-emerald-400 via-sky-400 to-purple-400 transition-[width] duration-300"
              style={{ width: `${Math.round(kidPrompt.progressRatio * 100)}%` }}
            />
          </div>
        </div>
      ) : null}

      {score && practiceState.finished ? (
        <div
          className={`flex flex-col items-center justify-between gap-4 rounded-3xl border-2 p-5 sm:flex-row ${
            darkMode
              ? 'border-amber-400/50 bg-[#1d244c] text-amber-50'
              : 'border-amber-300 bg-gradient-to-r from-amber-50 via-rose-50/70 to-sky-50 text-amber-950 shadow-sm'
          }`}
        >
          <div className="flex items-center gap-4">
            <MascotBuddy mood="celebrating" size="lg" />
            <div>
              <div className="mb-1 flex items-center gap-1 text-amber-400">
                <Star className="h-5 w-5 fill-amber-400" />
                <Star className="h-6 w-6 fill-amber-400" />
                <Star className="h-5 w-5 fill-amber-400" />
              </div>
              <p className="font-display text-2xl font-bold sm:text-3xl">
                Hooray! You played {score.title}!
              </p>
              {!kidLocked ? (
                <div className={`mt-1.5 flex flex-wrap items-center gap-3 font-mono text-xs ${mutedText}`}>
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
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRestart}
              className="inline-flex items-center gap-1.5 rounded-2xl border-b-4 border-emerald-700 bg-emerald-500 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-emerald-400 active:translate-y-[1px]"
            >
              <RotateCcw className="h-4 w-4" />
              Play Again!
            </button>
            {!kidLocked ? (
              <button
                type="button"
                onClick={onGoToLibrary}
                className="inline-flex items-center gap-1.5 rounded-2xl border-b-4 border-amber-600 bg-amber-400 px-4 py-2.5 text-sm font-extrabold text-amber-950 transition hover:bg-amber-300 active:translate-y-[1px]"
              >
                <Library className="h-4 w-4" />
                Pick Another Song!
              </button>
            ) : null}
            {!kidLocked && hardestMeasure !== null ? (
              <button
                type="button"
                onClick={handleDrillHardest}
                className={`inline-flex items-center gap-1.5 rounded-2xl border px-3.5 py-2 text-xs font-bold transition ${subtleBtn}`}
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
          <div className={`flex flex-col items-center justify-center rounded-3xl border px-6 py-12 text-center ${surface}`}>
            <h2 className="font-display text-3xl font-bold tracking-tight">Ready at the Bench</h2>
            <p className={`mt-2 max-w-md text-xs leading-relaxed ${mutedText}`}>
              Pick a toddler starter song, open a saved score, or load the bundled sample piece.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                disabled={sampleLoading}
                onClick={() => void onLoadSample()}
                className="inline-flex items-center gap-2 rounded-2xl bg-amber-400 px-4 py-2 text-xs font-bold text-amber-950 shadow-sm transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
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
                className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-xs font-bold transition ${subtleBtn}`}
              >
                <Library className="h-3.5 w-3.5" />
                Browse Songs
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
                'flex flex-col overflow-hidden rounded-3xl border-2 shadow-sm',
                darkMode ? 'border-indigo-800/80' : 'border-amber-200/90',
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
                  hideToolbar={colorMode === 'rainbow' || Boolean(kidLocked)}
                  canShiftOctave={rangeMode === 'kid' || rangeMode === 'compact'}
                  octaveShift={octaveShift}
                  onOctaveShift={shiftOctave}
                  expectedPitches={expectedPitches}
                  playfulMode={colorMode === 'rainbow'}
                  lookaheadOverride={tempoScale <= 0.7 ? 8 : 6}
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
