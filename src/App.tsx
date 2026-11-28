import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, LockOpen, Mic, MicOff, Music2, Settings, Sparkles, X } from 'lucide-react';
import { pianoEngine, type AudioEngineStatus } from './audio/piano-engine';
import LibraryView, { type MuseScoreController } from './components/LibraryView';
import PracticeStudio from './components/PracticeStudio';
import { MicInputController } from './input/mic-adapter';
import { MidiInputController } from './input/midi-adapter';
import type {
  MicPitchReading,
  MidiAccessState,
  MidiDeviceInfo,
  NoteInput,
} from './input/types';
import { readPracticeMidi } from './music/midi-parser';
import { DEFAULT_TODDLER_SCORE } from './music/toddler-songs';
import type { Score } from './music/types';
import { useMuseScorePaste } from './musescore-paste';
import { renderScorePdf } from './score-pdf.mjs';

type AppTab = 'practice' | 'library';

const UNLOCK_HOLD_MS = 900;

function pdfFileName(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'score';
  return `${cleaned}.pdf`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x4000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

function downloadScorePdf(score: Score): void {
  const bytes = renderScorePdf(score);
  const filename = pdfFileName(score.title);
  if (globalThis.__maestroShareFile) {
    void globalThis.__maestroShareFile({
      filename,
      mimeType: 'application/pdf',
      base64: uint8ToBase64(bytes),
    });
    return;
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [tab, setTab] = useState<AppTab>('practice');
  const [kidLocked, setKidLocked] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionScores, setSessionScores] = useState<Score[]>([]);
  const [activeScore, setActiveScore] = useState<Score | null>(DEFAULT_TODDLER_SCORE);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [pdfNotice, setPdfNotice] = useState<string | null>(null);
  const [unlockProgress, setUnlockProgress] = useState(0);

  const [midiController] = useState(() => new MidiInputController());
  const [midiState, setMidiState] = useState<MidiAccessState>('unknown');
  const [midiDevices, setMidiDevices] = useState<MidiDeviceInfo[]>([]);
  const [midiNotice, setMidiNotice] = useState<string | null>(null);

  const [micController] = useState(() => new MicInputController());
  const [micActive, setMicActive] = useState(false);
  const [micPitch, setMicPitch] = useState<MicPitchReading | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  const [audioStatus, setAudioStatus] = useState<AudioEngineStatus>(() =>
    pianoEngine.getStatus(),
  );

  const noteHandlerRef = useRef<((event: NoteInput) => void) | null>(null);
  const micGateRef = useRef<(() => boolean) | null>(null);
  const unlockRafRef = useRef<number>(0);

  const registerNoteHandler = useCallback((handler: ((event: NoteInput) => void) | null) => {
    noteHandlerRef.current = handler;
  }, []);

  const registerMicGate = useCallback((gate: (() => boolean) | null) => {
    micGateRef.current = gate;
  }, []);

  useEffect(() => {
    document.body.style.backgroundColor = darkMode ? '#141936' : '#fffbf0';
    document.body.style.color = darkMode ? '#fef3c7' : '#451a03';
    void globalThis.__maestroSetSystemBars?.(darkMode)?.catch?.(() => {});
  }, [darkMode]);

  useEffect(() => {
    const unlock = () => {
      void pianoEngine.unlockFromGesture();
    };
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  useEffect(() => {
    return pianoEngine.subscribeStatus(setAudioStatus);
  }, []);

  useEffect(() => {
    const unsub = midiController.onStateChange((nextState, nextDevices) => {
      setMidiState(nextState);
      setMidiDevices(nextDevices);
      if (nextDevices.length > 0) {
        setMidiNotice(null);
      }
    });
    void midiController.probeIfPermitted();
    return () => {
      unsub();
      midiController.dispose();
    };
  }, [midiController]);

  useEffect(() => {
    if (!midiNotice) return;
    const timer = window.setTimeout(() => setMidiNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [midiNotice]);

  useEffect(() => {
    return () => {
      micController.stop();
      void pianoEngine.setRecordingSession(false);
    };
  }, [micController]);

  useEffect(() => {
    if (!kidLocked) {
      cancelAnimationFrame(unlockRafRef.current);
      setUnlockProgress(0);
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setKidLocked(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(unlockRafRef.current);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [kidLocked]);

  const beginHoldToUnlock = useCallback(() => {
    cancelAnimationFrame(unlockRafRef.current);
    const startMs = performance.now();
    const tick = (nowMs: number) => {
      const progress = Math.min(1, (nowMs - startMs) / UNLOCK_HOLD_MS);
      setUnlockProgress(progress);
      if (progress >= 1) {
        setUnlockProgress(0);
        setKidLocked(false);
        return;
      }
      unlockRafRef.current = requestAnimationFrame(tick);
    };
    unlockRafRef.current = requestAnimationFrame(tick);
  }, []);

  const cancelHoldToUnlock = useCallback(() => {
    cancelAnimationFrame(unlockRafRef.current);
    setUnlockProgress(0);
  }, []);

  const openScoreInPractice = useCallback((song: Score) => {
    if (!song.id.startsWith('toddler:')) {
      setSessionScores((prev) => {
        const idx = prev.findIndex((item) => item.id === song.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = song;
          return next;
        }
        return [song, ...prev];
      });
    }
    setActiveScore(song);
    setTab('practice');
  }, []);

  const museScore = useMuseScorePaste({
    darkMode,
    readMidi: readPracticeMidi,
    onOpen: openScoreInPractice,
  }) as unknown as MuseScoreController;

  const handleLoadSample = useCallback(async () => {
    setSampleLoading(true);
    setSampleError(null);
    try {
      const baseUrl =
        (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
      const url = `${baseUrl}library/4197961.mid`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Sample download failed (${response.status}).`);
      }
      const bytes = await response.arrayBuffer();
      const read = readPracticeMidi(bytes, "Merry-Go-Round of Life (Howl's Moving Castle).mid");
      if (!read.ok) {
        throw new Error('Sample MIDI file could not be parsed.');
      }
      const sampleScore: Score = {
        ...read.song,
        id: 'sample:4197961',
        composer: 'Joe Hisaishi',
      };
      openScoreInPractice(sampleScore);
    } catch (err) {
      setSampleError(err instanceof Error ? err.message : 'Could not load sample score.');
    } finally {
      setSampleLoading(false);
    }
  }, [openScoreInPractice]);

  const handleConnectMidi = useCallback(async () => {
    setMidiNotice(null);
    const state = await midiController.connect({ interactive: true });
    if (midiController.getDevices().length > 0) {
      setMidiNotice(null);
      return;
    }
    if (state === 'unsupported') {
      setMidiNotice(
        globalThis.__maestroNativeMidi
          ? 'MIDI unavailable on this device.'
          : 'Web MIDI is not supported in this browser. Use Chrome/Edge or the iOS app.',
      );
    } else if (state === 'denied') {
      setMidiNotice('MIDI permission denied. Check browser or Bluetooth settings.');
    } else if (state === 'ready') {
      setMidiNotice(
        globalThis.__maestroNativeMidi
          ? 'No MIDI keyboard detected yet. Plug in a USB-MIDI adapter or pair one in the Bluetooth MIDI picker.'
          : 'MIDI ready, but no keyboard detected. Plug in a USB-MIDI keyboard and try again.',
      );
    }
  }, [midiController]);

  const handleToggleMic = useCallback(async () => {
    if (micActive) {
      micController.stop();
      void pianoEngine.setRecordingSession(false);
      setMicActive(false);
      setMicPitch(null);
      setMicLevel(0);
      setMicError(null);
      return;
    }

    setMicError(null);
    setMicLevel(0);
    if (!globalThis.__maestroNativeMic) {
      await pianoEngine.unlockFromGesture();
      await pianoEngine.setRecordingSession(true);
    }

    try {
      await micController.start({
        audioContext: pianoEngine.getContext() ?? undefined,
        onLevel: setMicLevel,
        onPitch: (reading) => setMicPitch(reading),
        onNote: (event) => noteHandlerRef.current?.(event),
        shouldGate: () =>
          micGateRef.current ? micGateRef.current() : pianoEngine.isPlaybackSounding(),
      });
      await pianoEngine.setRecordingSession(true);
      setMicActive(true);
      void pianoEngine.unlockFromGesture();
    } catch (err) {
      void pianoEngine.setRecordingSession(false);
      setMicActive(false);
      setMicPitch(null);
      setMicLevel(0);
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setMicError(
          globalThis.__maestroNativeMic
            ? 'Microphone permission denied. Enable it in iOS Settings -> Maestro AI -> Microphone.'
            : 'Microphone permission denied. Allow mic access in your browser settings.',
        );
      } else if (name === 'NotFoundError') {
        setMicError('No microphone found on this device.');
      } else {
        setMicError('Could not start microphone input.');
      }
    }
  }, [micActive, micController]);

  const handleExportPdf = useCallback((score: Score) => {
    setPdfNotice(null);
    try {
      downloadScorePdf(score);
    } catch (err) {
      setPdfNotice(err instanceof Error ? err.message : 'Could not generate PDF.');
    }
  }, []);

  const hasDeviceActive = midiDevices.length > 0 || micActive;

  return (
    <div
      className={`min-h-screen transition-colors ${
        darkMode
          ? 'bg-gradient-to-b from-[#141936] via-[#171d40] to-[#111630] text-amber-50'
          : 'bg-gradient-to-b from-[#fffbf0] via-[#fffdf7] to-[#f4f9ff] text-amber-950'
      }`}
    >
      <header
        className={`sticky top-0 z-30 border-b backdrop-blur-md ${
          darkMode
            ? 'border-indigo-900/70 bg-[#141936]/90'
            : 'border-amber-200/80 bg-[#fffbf0]/90'
        }`}
      >
        <div className="mx-auto flex max-w-[1440px] flex-nowrap items-center justify-between gap-2 px-3 py-2 sm:px-6 sm:py-2.5">
          <div className="flex shrink-0 items-center gap-2.5">
            <div className="animate-kid-bob flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-400 via-amber-400 to-sky-400 text-white shadow-sm ring-2 ring-white/80">
              <Sparkles className="h-4 w-4" />
            </div>
            <span className="font-display text-xl font-bold leading-none tracking-tight sm:text-2xl">
              Little Maestro
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {kidLocked ? (
              <button
                type="button"
                onPointerDown={beginHoldToUnlock}
                onPointerUp={cancelHoldToUnlock}
                onPointerLeave={cancelHoldToUnlock}
                onPointerCancel={cancelHoldToUnlock}
                title="Press and hold to unlock grown-up controls (or press Escape)"
                className={`relative inline-flex items-center gap-1.5 overflow-hidden rounded-2xl border px-3.5 py-2 text-xs font-bold shadow-sm transition select-none touch-none ${
                  darkMode
                    ? 'border-amber-400/50 bg-indigo-950/80 text-amber-200'
                    : 'border-amber-300 bg-white text-amber-900'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 bg-amber-400/35 transition-none"
                  style={{ width: `${Math.round(unlockProgress * 100)}%` }}
                />
                <LockOpen className="relative h-3.5 w-3.5" />
                <span className="relative">Hold to Unlock</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setTab((prev) => (prev === 'practice' ? 'library' : 'practice'))}
                  className={`inline-flex items-center gap-1.5 rounded-2xl border-b-2 border px-3 py-1.5 text-xs font-bold transition active:translate-y-[1px] ${
                    tab === 'library'
                      ? 'border-sky-400 bg-sky-500 text-white shadow-sm'
                      : darkMode
                        ? 'border-indigo-800 bg-indigo-900/70 text-amber-100 hover:bg-indigo-800/80'
                        : 'border-amber-300 bg-white text-amber-900 shadow-sm hover:bg-amber-50'
                  }`}
                >
                  <Music2 className="h-3.5 w-3.5" />
                  <span>{tab === 'practice' ? 'Songs' : 'Piano'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleToggleMic()}
                  title={micActive ? 'Stop acoustic microphone' : 'Enable acoustic microphone'}
                  className={`inline-flex items-center gap-1.5 rounded-2xl border px-2.5 py-1.5 text-xs font-bold transition ${
                    micActive
                      ? darkMode
                        ? 'border-emerald-400/70 bg-emerald-500/15 text-emerald-300'
                        : 'border-emerald-500/70 bg-emerald-500/15 text-emerald-700'
                      : darkMode
                        ? 'border-indigo-800 bg-indigo-900/70 text-amber-100 hover:bg-indigo-800/80'
                        : 'border-amber-200 bg-white text-amber-900 hover:bg-amber-50'
                  }`}
                >
                  {micActive ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
                  {micActive ? (
                    <>
                      <span className="max-w-[44px] truncate sm:max-w-none">
                        {micPitch ? micPitch.name : 'On'}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-6 overflow-hidden rounded-full ${
                          darkMode ? 'bg-indigo-950' : 'bg-amber-100'
                        }`}
                      >
                        <span
                          className="block h-full rounded-full bg-emerald-500 transition-[width] duration-75"
                          style={{ width: `${Math.round(micLevel * 100)}%` }}
                        />
                      </span>
                    </>
                  ) : (
                    <span className="hidden sm:inline">Mic</span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setTab('practice');
                    setShowSettings(false);
                    setKidLocked(true);
                  }}
                  title="Lock controls for toddler practice"
                  className={`inline-flex items-center gap-1.5 rounded-2xl border px-2.5 py-1.5 text-xs font-bold transition ${
                    darkMode
                      ? 'border-indigo-800 bg-indigo-900/70 text-amber-100 hover:bg-indigo-800/80'
                      : 'border-amber-200 bg-white text-amber-900 hover:bg-amber-50'
                  }`}
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Kid Lock</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (tab !== 'practice') {
                      setTab('practice');
                      setShowSettings(true);
                    } else {
                      setShowSettings((prev) => !prev);
                    }
                  }}
                  title="Grown-up studio settings"
                  className={`inline-flex items-center gap-1.5 rounded-2xl border px-2.5 py-1.5 text-xs font-bold transition ${
                    showSettings && tab === 'practice'
                      ? darkMode
                        ? 'border-amber-400 bg-amber-400/20 text-amber-200'
                        : 'border-amber-400 bg-amber-400/20 text-amber-800'
                      : darkMode
                        ? 'border-indigo-800 bg-indigo-900/70 text-amber-100 hover:bg-indigo-800/80'
                        : 'border-amber-200 bg-white text-amber-900 hover:bg-amber-50'
                  }`}
                >
                  <Settings className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Grown-ups</span>
                  {hasDeviceActive ? (
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  ) : null}
                </button>
              </>
            )}
          </div>
        </div>

        {pdfNotice ? (
          <div className="border-t border-rose-500/30 bg-rose-500/10 px-4 py-1.5 text-center text-xs font-medium text-rose-500">
            {pdfNotice}
          </div>
        ) : null}
        {micError ? (
          <div className="flex items-center justify-center gap-2 border-t border-rose-500/30 bg-rose-500/10 px-4 py-1.5 text-xs font-medium text-rose-500">
            <span>{micError}</span>
            <button
              type="button"
              onClick={() => setMicError(null)}
              aria-label="Dismiss microphone notice"
              className="rounded p-0.5 hover:bg-rose-500/20"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        {midiNotice ? (
          <div
            className={`flex items-center justify-center gap-2 border-t border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs font-medium ${
              darkMode ? 'text-amber-300' : 'text-amber-800'
            }`}
          >
            <span>{midiNotice}</span>
            <button
              type="button"
              onClick={() => setMidiNotice(null)}
              aria-label="Dismiss MIDI notice"
              className="rounded p-0.5 hover:bg-amber-500/20"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </header>

      <main className="px-2.5 py-2 sm:px-6 sm:py-4">
        <div className={tab === 'practice' ? '' : 'hidden'}>
          <PracticeStudio
            score={activeScore}
            sessionScores={sessionScores}
            savedScores={museScore.scores}
            scoreBusy={museScore.busy}
            onSelectScore={openScoreInPractice}
            onOpenSavedScore={(scoreId) => void museScore.openSaved(scoreId)}
            onGoToLibrary={() => setTab('library')}
            onLoadSample={handleLoadSample}
            sampleLoading={sampleLoading}
            onExportPdf={handleExportPdf}
            darkMode={darkMode}
            onToggleDarkMode={() => setDarkMode((prev) => !prev)}
            showSettings={showSettings}
            onToggleSettings={() => setShowSettings((prev) => !prev)}
            onCloseSettings={() => setShowSettings(false)}
            midiController={midiController}
            midiState={midiState}
            midiDevices={midiDevices}
            onConnectMidi={() => void handleConnectMidi()}
            micActive={micActive}
            micPitch={micPitch}
            micLevel={micLevel}
            micError={micError}
            onToggleMic={() => void handleToggleMic()}
            audioStatus={audioStatus}
            viewActive={tab === 'practice'}
            registerNoteHandler={registerNoteHandler}
            registerMicGate={registerMicGate}
            kidLocked={kidLocked}
            onExitKidLock={() => setKidLocked(false)}
          />
        </div>

        {!kidLocked && tab === 'library' ? (
          <LibraryView
            darkMode={darkMode}
            museScore={museScore}
            sessionScores={sessionScores}
            activeScoreId={activeScore?.id ?? null}
            onOpenScore={openScoreInPractice}
            onLoadSample={handleLoadSample}
            sampleLoading={sampleLoading}
            sampleError={sampleError}
          />
        ) : null}
      </main>
    </div>
  );
}
