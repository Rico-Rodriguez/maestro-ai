import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, LockOpen, Mic, MicOff, Music2, SlidersHorizontal, X } from 'lucide-react';
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

function PianoMark() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect
        x="1.75"
        y="3.25"
        width="16.5"
        height="13.5"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line x1="7.25" y1="3.5" x2="7.25" y2="16.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="12.75" y1="3.5" x2="12.75" y2="16.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="5.75" y="3.5" width="3" height="7.5" rx="0.75" fill="currentColor" />
      <rect x="11.25" y="3.5" width="3" height="7.5" rx="0.75" fill="currentColor" />
    </svg>
  );
}

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
    document.body.style.backgroundColor = darkMode ? '#17131a' : '#fbf5f1';
    document.body.style.color = darkMode ? '#f3eaf0' : '#2a1d22';
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
        throw new Error(`Sample download failed (${response.status})`);
      }
      const bytes = await response.arrayBuffer();
      const read = readPracticeMidi(bytes, "Merry-Go-Round of Life (Howl's Moving Castle).mid");
      if (!read.ok) {
        throw new Error('Sample MIDI file could not be parsed');
      }
      const sampleScore: Score = {
        ...read.song,
        id: 'sample:4197961',
        composer: 'Joe Hisaishi',
      };
      openScoreInPractice(sampleScore);
    } catch (err) {
      setSampleError(err instanceof Error ? err.message : 'Could not load sample score');
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
          ? 'MIDI unavailable on this device'
          : 'Web MIDI is not supported in this browser. Use Chrome, Edge, or the iOS app.',
      );
    } else if (state === 'denied') {
      setMidiNotice('MIDI permission denied. Check browser or Bluetooth settings.');
    } else if (state === 'ready') {
      setMidiNotice(
        globalThis.__maestroNativeMidi
          ? 'No MIDI keyboard detected yet. Plug in a USB-MIDI adapter or pair one in Bluetooth MIDI.'
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
            ? 'Microphone permission denied. Enable it in iOS Settings under Maestro.'
            : 'Microphone permission denied. Allow mic access in browser settings.',
        );
      } else if (name === 'NotFoundError') {
        setMicError('No microphone found on this device');
      } else {
        setMicError('Could not start microphone input');
      }
    }
  }, [micActive, micController]);

  const handleExportPdf = useCallback((score: Score) => {
    setPdfNotice(null);
    try {
      downloadScorePdf(score);
    } catch (err) {
      setPdfNotice(err instanceof Error ? err.message : 'Could not generate PDF');
    }
  }, []);

  const hasDeviceActive = midiDevices.length > 0 || micActive;

  const headerButtonClass = darkMode
    ? 'border-[#f3eaf0]/[0.08] bg-[#1f1a22] text-[#f3eaf0] hover:bg-[#2a2430]'
    : 'border-[#2a1d22]/[0.08] bg-[#fffdfb] text-[#2a1d22] hover:bg-[#f6ebe6]';

  const mutedIconClass = darkMode ? 'text-[#b9a9b4]' : 'text-[#6b5560]';

  return (
    <div
      className={`min-h-screen transition-colors duration-150 ${
        darkMode ? 'bg-[#17131a] text-[#f3eaf0]' : 'bg-[#fbf5f1] text-[#2a1d22]'
      }`}
    >
      <header
        className={`sticky top-0 z-30 border-b ${
          darkMode
            ? 'border-[#f3eaf0]/[0.08] bg-[#17131a]/95'
            : 'border-[#2a1d22]/[0.08] bg-[#fbf5f1]/95'
        } backdrop-blur-sm`}
      >
        <div className="mx-auto flex h-14 max-w-[1440px] flex-nowrap items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex shrink-0 items-center gap-2.5">
            <PianoMark />
            <span className="text-[17px] font-semibold leading-none tracking-[-0.01em]">
              Maestro
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {kidLocked ? (
              <button
                type="button"
                onPointerDown={beginHoldToUnlock}
                onPointerUp={cancelHoldToUnlock}
                onPointerLeave={cancelHoldToUnlock}
                onPointerCancel={cancelHoldToUnlock}
                title="Press and hold to unlock controls (or press Escape)"
                className={`relative inline-flex h-10 items-center gap-2 overflow-hidden rounded-[12px] border px-3 text-xs font-medium transition-colors duration-150 select-none touch-none ${
                  darkMode
                    ? 'border-[#f3eaf0]/[0.12] bg-[#1f1a22] text-[#f3eaf0]'
                    : 'border-[#2a1d22]/[0.12] bg-[#fffdfb] text-[#2a1d22]'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-y-0 left-0 transition-none ${
                    darkMode ? 'bg-[#f3eaf0]/15' : 'bg-[#2a1d22]/10'
                  }`}
                  style={{ width: `${Math.round(unlockProgress * 100)}%` }}
                />
                <LockOpen className={`relative h-4 w-4 ${mutedIconClass}`} strokeWidth={1.5} />
                <span className="relative">Hold to unlock</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setTab((prev) => (prev === 'practice' ? 'library' : 'practice'))}
                  className={`inline-flex h-10 items-center gap-2 rounded-[12px] border px-3 text-[13px] font-medium transition-colors duration-150 ${
                    tab === 'library'
                      ? darkMode
                        ? 'border-[#f06595] bg-[#f06595] text-[#17131a] hover:bg-[#f47aa4]'
                        : 'border-[#d6336c] bg-[#d6336c] text-white hover:bg-[#be2a5e]'
                      : headerButtonClass
                  }`}
                >
                  <Music2
                    className={`h-4 w-4 ${tab === 'library' ? 'text-current' : mutedIconClass}`}
                    strokeWidth={1.5}
                  />
                  <span>{tab === 'practice' ? 'Songs' : 'Piano'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleToggleMic()}
                  title={micActive ? 'Stop acoustic microphone' : 'Enable acoustic microphone'}
                  className={`inline-flex h-10 items-center gap-2 rounded-[12px] border px-3 text-[13px] font-medium transition-colors duration-150 ${
                    micActive
                      ? darkMode
                        ? 'border-[#4cc38a]/40 bg-[#4cc38a]/10 text-[#4cc38a]'
                        : 'border-[#16a34a]/40 bg-[#16a34a]/10 text-[#16a34a]'
                      : headerButtonClass
                  }`}
                >
                  {micActive ? (
                    <Mic className="h-4 w-4" strokeWidth={1.5} />
                  ) : (
                    <MicOff className={`h-4 w-4 ${mutedIconClass}`} strokeWidth={1.5} />
                  )}
                  {micActive ? (
                    <>
                      <span className="max-w-[48px] truncate font-mono text-xs tabular-nums sm:max-w-none">
                        {micPitch ? micPitch.name : 'On'}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-6 overflow-hidden rounded-full ${
                          darkMode ? 'bg-[#2a2430]' : 'bg-[#f6ebe6]'
                        }`}
                      >
                        <span
                          className={`block h-full rounded-full transition-[width] duration-75 ${
                            darkMode ? 'bg-[#4cc38a]' : 'bg-[#16a34a]'
                          }`}
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
                  title="Lock controls for focused practice"
                  className={`inline-flex h-10 items-center gap-2 rounded-[12px] border px-3 text-[13px] font-medium transition-colors duration-150 ${headerButtonClass}`}
                >
                  <Lock className={`h-4 w-4 ${mutedIconClass}`} strokeWidth={1.5} />
                  <span className="hidden sm:inline">Lock</span>
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
                  title="Studio settings"
                  className={`inline-flex h-10 items-center gap-2 rounded-[12px] border px-3 text-[13px] font-medium transition-colors duration-150 ${
                    showSettings && tab === 'practice'
                      ? darkMode
                        ? 'border-[#f06595]/60 bg-[#2a2430] text-[#f3eaf0]'
                        : 'border-[#d6336c]/50 bg-[#f6ebe6] text-[#2a1d22]'
                      : headerButtonClass
                  }`}
                >
                  <SlidersHorizontal className={`h-4 w-4 ${mutedIconClass}`} strokeWidth={1.5} />
                  <span className="hidden sm:inline">Settings</span>
                  {hasDeviceActive ? (
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        darkMode ? 'bg-[#4cc38a]' : 'bg-[#16a34a]'
                      }`}
                    />
                  ) : null}
                </button>
              </>
            )}
          </div>
        </div>

        {pdfNotice ? (
          <div
            className={`border-t px-4 py-2 text-center text-xs font-medium ${
              darkMode
                ? 'border-[#e5484d]/30 bg-[#e5484d]/10 text-[#e5484d]'
                : 'border-[#dc2626]/20 bg-[#dc2626]/10 text-[#dc2626]'
            }`}
          >
            {pdfNotice}
          </div>
        ) : null}
        {micError ? (
          <div
            className={`flex items-center justify-center gap-2 border-t px-4 py-2 text-xs font-medium ${
              darkMode
                ? 'border-[#e5484d]/30 bg-[#e5484d]/10 text-[#e5484d]'
                : 'border-[#dc2626]/20 bg-[#dc2626]/10 text-[#dc2626]'
            }`}
          >
            <span>{micError}</span>
            <button
              type="button"
              onClick={() => setMicError(null)}
              aria-label="Dismiss microphone notice"
              className="rounded-[8px] p-1 hover:bg-black/5"
            >
              <X className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </div>
        ) : null}
        {midiNotice ? (
          <div
            className={`flex items-center justify-center gap-2 border-t px-4 py-2 text-xs font-medium ${
              darkMode
                ? 'border-[#f3eaf0]/[0.08] bg-[#1f1a22] text-[#b9a9b4]'
                : 'border-[#2a1d22]/[0.08] bg-[#f6ebe6] text-[#6b5560]'
            }`}
          >
            <span>{midiNotice}</span>
            <button
              type="button"
              onClick={() => setMidiNotice(null)}
              aria-label="Dismiss MIDI notice"
              className="rounded-[8px] p-1 hover:bg-black/5"
            >
              <X className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </div>
        ) : null}
      </header>

      <main className="px-4 py-4 sm:px-6 sm:py-6">
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
