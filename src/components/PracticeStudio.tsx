import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  CheckCircle2,
  ChevronRight,
  FileDown,
  Headphones,
  Library,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Moon,
  Music2,
  Pause,
  Play,
  Repeat,
  RotateCcw,
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
import { measureAtBeat, type ColorMode } from './note-colors';
import {
  autoOctaveShiftForPitches,
  buildPianoLayout,
  chooseSmartRangeMode,
  computePianoRange,
  initialOctaveShiftForScore,
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
  lastFeedback: { status: 'idle', text: 'Open a score to begin' },
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
  { id: 'wait', label: 'Learn' },
  { id: 'tempo', label: 'Tempo' },
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
  const hasExternalInput = midiDevices.length > 0 || micActive;
  const [practiceState, setPracticeState] = useState<PracticeState>(() =>
    score ? createPracticeState(score) : EMPTY_PRACTICE_STATE,
  );
  const [userPressedNotes, setUserPressedNotes] = useState<Set<number>>(() => new Set());
  const [userSustainDown, setUserSustainDown] = useState(false);
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 390,
  );
  const [manualRangeOverride, setManualRangeOverride] = useState(false);
  const [rangeMode, setRangeMode] = useState<PianoRangeMode>(() =>
    chooseSmartRangeMode({
      minPitch: score?.minPitch,
      maxPitch: score?.maxPitch,
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 390,
      mode: EMPTY_PRACTICE_STATE.mode,
      hasExternalInput,
    }),
  );
  const [octaveShift, setOctaveShift] = useState<number>(() => {
    if (!score) return 0;
    const initMode = chooseSmartRangeMode({
      minPitch: score.minPitch,
      maxPitch: score.maxPitch,
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 390,
      mode: EMPTY_PRACTICE_STATE.mode,
      hasExternalInput,
    });
    return initialOctaveShiftForScore(
      score.minPitch,
      score.maxPitch,
      initMode === 'kid' ? 'kid' : 'compact',
      score.events.slice(0, 12).map((e) => e.pitch),
    );
  });
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
  const viewportWidthRef = useRef(viewportWidth);
  const hasExternalInputRef = useRef(hasExternalInput);
  const prevFinishedRef = useRef(false);
  const celebrationTimersRef = useRef<number[]>([]);

  scoreRef.current = score;
  tempoScaleRef.current = tempoScale;
  metronomeOnRef.current = metronomeOn;
  guideSoundOnRef.current = guideSoundOn;
  muteLocalForMidiRef.current = muteLocalForMidi;
  headphonesModeRef.current = headphonesMode;
  octaveShiftRef.current = octaveShift;
  viewportWidthRef.current = viewportWidth;
  hasExternalInputRef.current = hasExternalInput;

  const handleManualRangeModeChange = useCallback((mode: PianoRangeMode) => {
    setManualRangeOverride(true);
    setRangeMode(mode);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

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
    setManualRangeOverride(false);
    const nextMode = chooseSmartRangeMode({
      minPitch: score?.minPitch,
      maxPitch: score?.maxPitch,
      viewportWidth: viewportWidthRef.current,
      mode: next.mode,
      hasExternalInput: hasExternalInputRef.current,
    });
    setRangeMode(nextMode);
    setOctaveShift(
      score
        ? initialOctaveShiftForScore(
            score.minPitch,
            score.maxPitch,
            nextMode === 'kid' ? 'kid' : 'compact',
            score.events.slice(0, 12).map((e) => e.pitch),
          )
        : 0,
    );
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
    if (manualRangeOverride) return;
    const nextMode = chooseSmartRangeMode({
      minPitch: score?.minPitch,
      maxPitch: score?.maxPitch,
      viewportWidth,
      mode: practiceState.mode,
      hasExternalInput,
    });
    setRangeMode(nextMode);
  }, [
    manualRangeOverride,
    score?.minPitch,
    score?.maxPitch,
    viewportWidth,
    practiceState.mode,
    hasExternalInput,
  ]);

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
  const currentBar = score
    ? Math.min(
        totalMeasures,
        measureAtBeat(score.timeSignatures, defaultBeatsPerMeasure, practiceState.beat),
      )
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

  const cardSurface = darkMode
    ? 'bg-[#1c1a18] border-[#efe9de]/[0.08] text-[#efe9de]'
    : 'bg-[#fdfbf7] border-[#1f1b16]/[0.08] text-[#1f1b16]';
  const drawerCard = darkMode
    ? 'rounded-[12px] border border-[#efe9de]/[0.08] bg-[#161513] p-4'
    : 'rounded-[12px] border border-[#1f1b16]/[0.08] bg-[#f7f4ee] p-4';
  const segmentedTrack = darkMode ? 'bg-[#262421]' : 'bg-[#efe9df]';
  const segmentedInactive = darkMode
    ? 'text-[#aaa398] hover:text-[#efe9de]'
    : 'text-[#5e554a] hover:text-[#1f1b16]';
  const segmentedActive = darkMode
    ? 'bg-[#1c1a18] text-[#efe9de]'
    : 'bg-[#fdfbf7] text-[#1f1b16]';
  const secondaryText = darkMode ? 'text-[#aaa398]' : 'text-[#5e554a]';
  const mutedText = darkMode ? 'text-[#8a847a]' : 'text-[#7b7266]';
  const hairlineBorder = darkMode ? 'border-[#efe9de]/[0.08]' : 'border-[#1f1b16]/[0.08]';
  const controlBtn = darkMode
    ? 'border-[#efe9de]/[0.08] bg-[#262421] text-[#efe9de] hover:bg-[#2f2c28]'
    : 'border-[#1f1b16]/[0.08] bg-[#fdfbf7] text-[#1f1b16] hover:bg-[#efe9df]';
  const accentFill = darkMode
    ? 'bg-[#efe9de] text-[#161513] hover:bg-white'
    : 'bg-[#c85a32] text-white hover:bg-[#b44e29]';
  const accentText = darkMode ? 'text-[#e07047]' : 'text-[#c85a32]';
  const accentInput = darkMode ? 'accent-[#e07047]' : 'accent-[#c85a32]';
  const positiveText = darkMode ? 'text-[#4cc38a]' : 'text-[#16a34a]';

  const selectValue = score ? score.id : '';
  const songWiderThanKeys = Boolean(
    score && (score.minPitch < pianoLayout.minMidi || score.maxPitch > pianoLayout.maxMidi),
  );
  const isNarrowSongFit = Boolean(
    score &&
      !songWiderThanKeys &&
      viewportWidth < 700 &&
      manualRangeOverride &&
      rangeMode === 'auto' &&
      score.maxPitch - score.minPitch > 24,
  );

  const renderKeyboard = (flushTop: boolean) => (
    <PianoKeyboard
      layout={pianoLayout}
      rangeMode={rangeMode}
      onRangeModeChange={handleManualRangeModeChange}
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
    <div className="mx-auto flex max-w-[1440px] flex-col gap-3">
      <div
        className={`flex flex-wrap items-center justify-between gap-2 rounded-[16px] border p-2 ${cardSurface}`}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!score}
            onClick={togglePlay}
            className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-[8px] px-4 text-sm font-medium transition-colors duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
              practiceState.running
                ? darkMode
                  ? 'border border-[#efe9de]/25 bg-[#262421] text-[#efe9de] hover:bg-[#2f2c28]'
                  : 'border border-[#c85a32]/40 bg-[#c85a32]/10 text-[#c85a32] hover:bg-[#c85a32]/15'
                : accentFill
            }`}
          >
            {practiceState.running ? (
              <>
                <Pause className="h-4 w-4 fill-current" strokeWidth={1.5} />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="h-4 w-4 fill-current" strokeWidth={1.5} />
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
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border transition-colors duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${controlBtn}`}
          >
            <RotateCcw className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
          </button>
        </div>

        {kidLocked ? (
          <div className="flex min-w-0 flex-1 items-center justify-end pr-2">
            <span className="truncate text-sm font-medium">
              {score ? score.title : 'Ready to play'}
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className={`inline-flex items-center rounded-[10px] p-1 ${segmentedTrack}`}>
              <button
                type="button"
                onClick={() => handleModeChange('wait')}
                className={`h-7 rounded-[6px] px-3 text-[13px] font-medium transition-colors duration-150 ${
                  practiceState.mode === 'wait' ? segmentedActive : segmentedInactive
                }`}
              >
                Learn
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('listen')}
                className={`h-7 rounded-[6px] px-3 text-[13px] font-medium transition-colors duration-150 ${
                  practiceState.mode === 'listen' ? segmentedActive : segmentedInactive
                }`}
              >
                Listen
              </button>
              {practiceState.mode === 'tempo' ? (
                <button
                  type="button"
                  onClick={() => handleModeChange('tempo')}
                  className={`h-7 rounded-[6px] px-3 text-[13px] font-medium transition-colors duration-150 ${segmentedActive}`}
                >
                  Tempo
                </button>
              ) : null}
            </div>

            <div className={`inline-flex items-center rounded-[10px] p-1 ${segmentedTrack}`}>
              <button
                type="button"
                onClick={() => setTempoScale(0.65)}
                className={`h-7 rounded-[6px] px-3 text-[13px] font-medium transition-colors duration-150 ${
                  tempoScale <= 0.7 ? segmentedActive : segmentedInactive
                }`}
              >
                Slow
              </button>
              <button
                type="button"
                onClick={() => setTempoScale(0.85)}
                className={`h-7 rounded-[6px] px-3 text-[13px] font-medium transition-colors duration-150 ${
                  tempoScale > 0.7 ? segmentedActive : segmentedInactive
                }`}
              >
                Normal
              </button>
            </div>

            {score && songWiderThanKeys ? (
              <button
                type="button"
                onClick={() => handleManualRangeModeChange('auto')}
                className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-[8px] border px-3 text-[13px] font-medium transition-colors duration-150 ${controlBtn}`}
              >
                <Maximize2 className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                <span>Fit song</span>
              </button>
            ) : score && isNarrowSongFit ? (
              <button
                type="button"
                onClick={() => handleManualRangeModeChange('compact')}
                className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-[8px] border px-3 text-[13px] font-medium transition-colors duration-150 ${controlBtn}`}
              >
                <Minimize2 className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                <span>Bigger keys</span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={onGoToLibrary}
              title="Choose a song"
              className={`inline-flex h-9 max-w-[200px] items-center gap-2 rounded-[8px] border px-3 text-[13px] font-medium transition-colors duration-150 sm:max-w-[260px] ${controlBtn}`}
            >
              <span className="truncate">{score ? score.title : 'Choose song'}</span>
              <ChevronRight className={`h-4 w-4 shrink-0 ${mutedText}`} strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>

      {showSettings && !kidLocked ? (
        <section className={`rounded-[16px] border p-5 ${cardSurface}`}>
          <div className={`mb-4 flex flex-wrap items-center justify-between gap-2 border-b pb-3 ${hairlineBorder}`}>
            <div>
              <h2 className="text-base font-semibold">Studio settings</h2>
              <p className={`text-xs ${mutedText}`}>
                Practice mode, keyboard range, audio, MIDI, and microphone
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onToggleDarkMode ? (
                <button
                  type="button"
                  onClick={onToggleDarkMode}
                  className={`inline-flex h-9 items-center gap-2 rounded-[8px] border px-3 text-[13px] font-medium transition-colors duration-150 ${controlBtn}`}
                >
                  {darkMode ? (
                    <Sun className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                  ) : (
                    <Moon className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                  )}
                  <span>{darkMode ? 'Light' : 'Dark'}</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={closeSettings}
                aria-label="Close settings"
                className={`inline-flex h-9 w-9 items-center justify-center rounded-[8px] border transition-colors duration-150 ${controlBtn}`}
              >
                <X className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className={`space-y-4 ${drawerCard}`}>
              <div>
                <div className="mb-1.5 text-xs font-medium">Practice mode</div>
                <div className={`inline-flex flex-wrap items-center rounded-[10px] p-1 ${segmentedTrack}`}>
                  {GROWNUP_PRACTICE_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleModeChange(m.id)}
                      className={`h-7 rounded-[6px] px-2.5 text-xs font-medium transition-colors duration-150 ${
                        practiceState.mode === m.id ? segmentedActive : segmentedInactive
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-xs font-medium">View</div>
                <div className={`inline-flex items-center rounded-[10px] p-1 ${segmentedTrack}`}>
                  {LAYOUT_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setViewLayout(opt.id)}
                      className={`h-7 rounded-[6px] px-2.5 text-xs font-medium transition-colors duration-150 ${
                        viewLayout === opt.id ? segmentedActive : segmentedInactive
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs font-medium">
                  <span>Key size</span>
                  {(rangeMode === 'kid' || rangeMode === 'compact') && (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        disabled={octaveShift <= -2}
                        onClick={() => shiftOctave(-1)}
                        className={`rounded-[6px] border px-2 py-0.5 font-mono text-[11px] font-medium disabled:opacity-40 ${controlBtn}`}
                      >
                        -8va
                      </button>
                      <button
                        type="button"
                        disabled={octaveShift >= 2}
                        onClick={() => shiftOctave(1)}
                        className={`rounded-[6px] border px-2 py-0.5 font-mono text-[11px] font-medium disabled:opacity-40 ${controlBtn}`}
                      >
                        +8va
                      </button>
                    </div>
                  )}
                </div>
                <div className={`inline-flex flex-wrap items-center rounded-[10px] p-1 ${segmentedTrack}`}>
                  {KEY_SIZE_OPTIONS.map((opt) => (
                    <button
                      key={opt.mode}
                      type="button"
                      onClick={() => handleManualRangeModeChange(opt.mode)}
                      className={`h-7 rounded-[6px] px-2.5 text-xs font-medium transition-colors duration-150 ${
                        rangeMode === opt.mode ? segmentedActive : segmentedInactive
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="mb-1.5 text-xs font-medium">Hand focus</div>
                  <div className={`inline-flex items-center rounded-[10px] p-1 ${segmentedTrack}`}>
                    {HAND_OPTIONS.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => handleHandChange(h.id)}
                        className={`h-7 rounded-[6px] px-2.5 text-xs font-medium transition-colors duration-150 ${
                          practiceState.handFilter === h.id ? segmentedActive : segmentedInactive
                        }`}
                      >
                        {h.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 text-xs font-medium">Note colors</div>
                  <div className={`inline-flex items-center rounded-[10px] p-1 ${segmentedTrack}`}>
                    {COLOR_MODE_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setColorMode(opt.id)}
                        className={`h-7 rounded-[6px] px-2.5 text-xs font-medium transition-colors duration-150 ${
                          colorMode === opt.id ? segmentedActive : segmentedInactive
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
                  <div className="mb-1.5 text-xs font-medium">Switch score</div>
                  <select
                    aria-label="Open score"
                    value={selectValue}
                    disabled={scoreBusy}
                    onChange={(e) => handleScoreDropdown(e.target.value)}
                    className={`h-9 w-full truncate rounded-[8px] border px-2.5 text-xs font-medium focus:outline-none ${
                      darkMode
                        ? 'border-[#efe9de]/[0.08] bg-[#1c1a18] text-[#efe9de]'
                        : 'border-[#1f1b16]/[0.08] bg-[#fdfbf7] text-[#1f1b16]'
                    }`}
                  >
                    {!score || score.id.startsWith('toddler:') ? (
                      <option value="">Choose uploaded or saved score</option>
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
                      <optgroup label="Saved library">
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

            <div className={`space-y-4 ${drawerCard}`}>
              <div>
                <div className="flex items-center justify-between text-xs font-medium">
                  <span>
                    Tempo (<span className="font-mono tabular-nums">{effectiveBpm}</span> BPM)
                  </span>
                  <span className={`font-mono tabular-nums ${accentText}`}>
                    {Math.round(tempoScale * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.4}
                  max={1.4}
                  step={0.05}
                  value={tempoScale}
                  onChange={(e) => setTempoScale(Number(e.target.value))}
                  className={`mt-2 w-full ${accentInput}`}
                />
                <div className={`mt-1 flex items-center justify-between font-mono text-[11px] tabular-nums ${mutedText}`}>
                  <span>40%</span>
                  <button
                    type="button"
                    onClick={() => setTempoScale(1)}
                    className={`font-sans text-[11px] font-medium transition-colors duration-150 ${
                      darkMode ? 'hover:text-[#efe9de]' : 'hover:text-[#1f1b16]'
                    }`}
                  >
                    Reset 100%
                  </button>
                  <span>140%</span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Metronome click</span>
                <input
                  type="checkbox"
                  checked={metronomeOn}
                  onChange={(e) => setMetronomeOn(e.target.checked)}
                  className={`h-4 w-4 ${accentInput}`}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium">Guide piano</div>
                  <div className={`text-[11px] ${mutedText}`}>Plays reference notes in Tempo mode</div>
                </div>
                <input
                  type="checkbox"
                  checked={guideSoundOn}
                  onChange={(e) => setGuideSoundOn(e.target.checked)}
                  className={`h-4 w-4 ${accentInput}`}
                />
              </div>

              <div>
                <div className="text-xs font-medium">Audio</div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {VOICE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setVoice(opt.id)}
                      className={`h-8 rounded-[8px] border px-2 text-[11px] font-medium transition-colors duration-150 ${
                        voice === opt.id
                          ? darkMode
                            ? 'border-[#e07047]/60 bg-[#262421] text-[#efe9de]'
                            : 'border-[#c85a32]/50 bg-[#fdfbf7] text-[#c85a32]'
                          : controlBtn
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="inline-flex items-center gap-2">
                    <Volume2 className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                    Volume
                  </span>
                  <span className="font-mono text-xs tabular-nums">{Math.round(volume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className={`mt-2 w-full ${accentInput}`}
                />
              </div>

              <div className={`space-y-2 border-t pt-3 ${hairlineBorder}`}>
                <div className="flex items-center justify-between">
                  <label className="inline-flex items-center gap-2 text-xs font-medium">
                    <Repeat className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                    <span>Measure loop</span>
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
                    className={`h-4 w-4 ${accentInput}`}
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
                    className={`h-8 w-16 rounded-[8px] border px-2 font-mono text-xs tabular-nums ${
                      darkMode
                        ? 'border-[#efe9de]/[0.08] bg-[#1c1a18] text-[#efe9de]'
                        : 'border-[#1f1b16]/[0.08] bg-[#fdfbf7] text-[#1f1b16]'
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
                    className={`h-8 w-16 rounded-[8px] border px-2 font-mono text-xs tabular-nums ${
                      darkMode
                        ? 'border-[#efe9de]/[0.08] bg-[#1c1a18] text-[#efe9de]'
                        : 'border-[#1f1b16]/[0.08] bg-[#fdfbf7] text-[#1f1b16]'
                    }`}
                  />
                </div>
              </div>
            </div>

            <div className={`space-y-4 ${drawerCard}`}>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="inline-flex items-center gap-2 text-xs font-medium">
                      <Usb className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                      MIDI keyboard
                    </div>
                    <div className={`mt-0.5 text-[11px] ${mutedText}`}>
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
                    className={`h-8 rounded-[8px] border px-3 text-xs font-medium transition-colors duration-150 ${controlBtn}`}
                  >
                    {midiState === 'ready' && midiDevices.length === 0
                      ? 'Scan'
                      : midiState === 'ready'
                        ? 'Refresh'
                        : 'Connect'}
                  </button>
                </div>
                {midiDevices.length === 0 ? (
                  <p className={`text-[11px] leading-snug ${mutedText}`}>
                    Plug in USB-MIDI or tap Scan for Bluetooth MIDI
                  </p>
                ) : null}
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium">Mute local sound for MIDI</div>
                  <div className={`text-[11px] ${mutedText}`}>
                    Avoid double audio with piano speakers
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={muteLocalForMidi}
                  onChange={(e) => setMuteLocalForMidi(e.target.checked)}
                  className={`h-4 w-4 ${accentInput}`}
                />
              </div>

              <div className={`space-y-2.5 border-t pt-3 ${hairlineBorder}`}>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="inline-flex items-center gap-2 text-xs font-medium">
                      <AudioLines className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                      Acoustic microphone
                    </div>
                    <div className={`mt-0.5 font-mono text-[11px] tabular-nums ${mutedText}`}>
                      {micActive
                        ? micPitch
                          ? `${micPitch.name} · ${micPitch.centsOff >= 0 ? '+' : ''}${micPitch.centsOff}¢`
                          : audioStatus.playbackSounding && !headphonesMode
                            ? 'Paused during playback'
                            : 'Listening'
                        : 'Off'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onToggleMic}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-xs font-medium transition-colors duration-150 ${
                      micActive
                        ? darkMode
                          ? 'bg-[#e5484d] text-white hover:bg-[#dc2626]'
                          : 'bg-[#dc2626] text-white hover:bg-[#b91c1c]'
                        : accentFill
                    }`}
                  >
                    {micActive ? (
                      <Mic className="h-4 w-4" strokeWidth={1.5} />
                    ) : (
                      <MicOff className="h-4 w-4" strokeWidth={1.5} />
                    )}
                    {micActive ? 'Stop' : 'Enable'}
                  </button>
                </div>

                <div>
                  <div className={`mb-1 flex items-center justify-between text-[11px] ${mutedText}`}>
                    <span>Input level</span>
                    <span className="font-mono tabular-nums">{Math.round(micLevel * 100)}%</span>
                  </div>
                  <div
                    className={`h-1.5 w-full overflow-hidden rounded-full ${segmentedTrack}`}
                  >
                    <div
                      className={`h-full rounded-full transition-[width] duration-75 ${
                        darkMode ? 'bg-[#4cc38a]' : 'bg-[#16a34a]'
                      }`}
                      style={{ width: `${Math.round(micLevel * 100)}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <label className="inline-flex items-center gap-2 text-xs font-medium">
                    <Headphones className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                    Using headphones
                  </label>
                  <input
                    type="checkbox"
                    checked={headphonesMode}
                    onChange={(e) => setHeadphonesMode(e.target.checked)}
                    className={`h-4 w-4 ${accentInput}`}
                  />
                </div>

                {micError ? (
                  <p className={`text-[11px] font-medium ${darkMode ? 'text-[#e5484d]' : 'text-[#dc2626]'}`}>
                    {micError}
                  </p>
                ) : null}
              </div>

              <div className={`border-t pt-3 ${hairlineBorder}`}>
                <button
                  type="button"
                  disabled={!score}
                  onClick={() => score && onExportPdf(score)}
                  className={`inline-flex h-9 w-full items-center justify-center gap-2 rounded-[8px] border px-3 text-xs font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${controlBtn}`}
                >
                  <FileDown className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                  <span>Export sheet music PDF</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {score ? (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-[12px] border px-4 py-3 ${cardSurface}`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {kidPrompt.targetNote && !practiceState.finished && practiceState.mode !== 'listen' ? (
              <span
                style={{
                  backgroundColor: kidPrompt.targetNote.bg,
                  color: kidPrompt.targetNote.text,
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-black/10"
              >
                {kidPrompt.targetNote.letter}
              </span>
            ) : practiceState.finished ? (
              <CheckCircle2 className={`h-4 w-4 shrink-0 ${positiveText}`} strokeWidth={1.5} />
            ) : (
              <Music2 className={`h-4 w-4 shrink-0 ${secondaryText}`} strokeWidth={1.5} />
            )}

            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-medium">{kidPrompt.headline}</span>
              {kidPrompt.cheerBadge ? (
                <span className={`text-[13px] font-medium ${positiveText}`}>
                  {kidPrompt.cheerBadge}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <span className={`font-mono text-xs tabular-nums ${mutedText}`}>
              {practiceState.mode === 'listen'
                ? `Bar ${currentBar}`
                : `${practiceState.stats.hits} / ${Math.max(1, practiceState.chords.length)}`}
            </span>
            <div
              aria-label="Song progress"
              className={`h-1 w-24 overflow-hidden rounded-full sm:w-32 ${segmentedTrack}`}
            >
              <div
                className={`h-full rounded-full transition-[width] duration-150 ${
                  darkMode ? 'bg-[#e07047]' : 'bg-[#c85a32]'
                }`}
                style={{ width: `${Math.round(kidPrompt.progressRatio * 100)}%` }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {score && practiceState.finished ? (
        <div
          className={`flex flex-col justify-between gap-4 rounded-[16px] border p-5 sm:flex-row sm:items-center ${cardSurface}`}
        >
          <div className="flex items-start gap-3">
            <CheckCircle2
              className={`mt-0.5 h-[18px] w-[18px] shrink-0 ${positiveText}`}
              strokeWidth={1.5}
            />
            <div>
              <p className="text-base font-semibold">{score.title}</p>
              <div className={`mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs tabular-nums ${mutedText}`}>
                <span>{practiceState.stats.hits} notes played</span>
                {!kidLocked ? (
                  <>
                    <span>Accuracy {totalAttempts > 0 ? `${accuracyPct}%` : '—'}</span>
                    <span>
                      Avg offset{' '}
                      {practiceState.stats.offsetsMs.length > 0
                        ? `${avgOffsetMs >= 0 ? '+' : ''}${avgOffsetMs} ms`
                        : '—'}
                    </span>
                    <span>Best streak {practiceState.stats.bestStreak}</span>
                    <span>
                      Hardest measure {hardestMeasure !== null ? `Bar ${hardestMeasure}` : 'None'}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRestart}
              className={`inline-flex h-9 items-center gap-2 rounded-[8px] px-4 text-[13px] font-medium transition-colors duration-150 active:scale-[0.98] ${accentFill}`}
            >
              <RotateCcw className="h-4 w-4" strokeWidth={1.5} />
              <span>Play again</span>
            </button>
            {!kidLocked ? (
              <button
                type="button"
                onClick={onGoToLibrary}
                className={`inline-flex h-9 items-center gap-2 rounded-[8px] border px-3 text-[13px] font-medium transition-colors duration-150 ${controlBtn}`}
              >
                <Library className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                <span>Choose song</span>
              </button>
            ) : null}
            {!kidLocked && hardestMeasure !== null ? (
              <button
                type="button"
                onClick={handleDrillHardest}
                className={`inline-flex h-9 items-center gap-2 rounded-[8px] border px-3 text-[13px] font-medium transition-colors duration-150 ${controlBtn}`}
              >
                <Repeat className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                <span>Drill bar {hardestMeasure}</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {!score ? (
        <>
          <div className={`flex flex-col items-center justify-center rounded-[16px] border px-6 py-12 text-center ${cardSurface}`}>
            <h2 className="text-xl font-semibold">Ready at the bench</h2>
            <p className={`mt-2 max-w-md text-xs leading-relaxed ${mutedText}`}>
              Pick a starter song, open a saved score, or load the bundled sample piece
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                disabled={sampleLoading}
                onClick={() => void onLoadSample()}
                className={`inline-flex h-9 items-center gap-2 rounded-[8px] px-4 text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${accentFill}`}
              >
                {sampleLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Play className="h-4 w-4" strokeWidth={1.5} />
                )}
                <span>Load sample</span>
              </button>
              <button
                type="button"
                onClick={onGoToLibrary}
                className={`inline-flex h-9 items-center gap-2 rounded-[8px] border px-4 text-[13px] font-medium transition-colors duration-150 ${controlBtn}`}
              >
                <Library className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                <span>Browse songs</span>
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
            <div className={`flex flex-col overflow-hidden rounded-[16px] border ${hairlineBorder}`}>
              <div
                className={
                  viewLayout === 'combined'
                    ? 'h-36 sm:h-48 lg:h-56'
                    : 'kid-falling-stage h-[44dvh] min-h-[270px] max-h-[500px]'
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
