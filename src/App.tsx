import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Moon, Music2, Sun, Usb } from 'lucide-react';
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
import type { Score } from './music/types';
import { useMuseScorePaste } from './musescore-paste';
import { renderScorePdf } from './score-pdf.mjs';

type AppTab = 'practice' | 'library';

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
  const [darkMode, setDarkMode] = useState(true);
  const [sessionScores, setSessionScores] = useState<Score[]>([]);
  const [activeScore, setActiveScore] = useState<Score | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [pdfNotice, setPdfNotice] = useState<string | null>(null);

  const [midiController] = useState(() => new MidiInputController());
  const [midiState, setMidiState] = useState<MidiAccessState>('unknown');
  const [midiDevices, setMidiDevices] = useState<MidiDeviceInfo[]>([]);

  const [micController] = useState(() => new MicInputController());
  const [micActive, setMicActive] = useState(false);
  const [micPitch, setMicPitch] = useState<MicPitchReading | null>(null);
  const [micError, setMicError] = useState<string | null>(null);

  const [audioStatus, setAudioStatus] = useState<AudioEngineStatus>(() =>
    pianoEngine.getStatus(),
  );

  const noteHandlerRef = useRef<((event: NoteInput) => void) | null>(null);
  const micGateRef = useRef<(() => boolean) | null>(null);

  const registerNoteHandler = useCallback((handler: ((event: NoteInput) => void) | null) => {
    noteHandlerRef.current = handler;
  }, []);

  const registerMicGate = useCallback((gate: (() => boolean) | null) => {
    micGateRef.current = gate;
  }, []);

  useEffect(() => {
    document.body.style.backgroundColor = darkMode ? '#0c0a09' : '#f6f3ec';
    document.body.style.color = darkMode ? '#f5f5f4' : '#1c1917';
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
    });
    void midiController.probeIfPermitted();
    return () => {
      unsub();
      midiController.dispose();
    };
  }, [midiController]);

  useEffect(() => {
    return () => {
      micController.stop();
      pianoEngine.setRecordingSession(false);
    };
  }, [micController]);

  const openScoreInPractice = useCallback((song: Score) => {
    setSessionScores((prev) => {
      const idx = prev.findIndex((item) => item.id === song.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = song;
        return next;
      }
      return [song, ...prev];
    });
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

  const handleConnectMidi = useCallback(() => {
    void midiController.connect();
  }, [midiController]);

  const handleToggleMic = useCallback(async () => {
    if (micActive) {
      micController.stop();
      pianoEngine.setRecordingSession(false);
      setMicActive(false);
      setMicPitch(null);
      setMicError(null);
      return;
    }

    setMicError(null);
    await pianoEngine.unlockFromGesture();
    pianoEngine.setRecordingSession(true);

    try {
      await micController.start({
        audioContext: pianoEngine.getContext() ?? undefined,
        onPitch: (reading) => setMicPitch(reading),
        onNote: (event) => noteHandlerRef.current?.(event),
        shouldGate: () =>
          micGateRef.current ? micGateRef.current() : pianoEngine.isPlaybackSounding(),
      });
      setMicActive(true);
    } catch (err) {
      pianoEngine.setRecordingSession(false);
      setMicActive(false);
      setMicPitch(null);
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setMicError('Microphone permission denied. Allow mic access in your browser settings.');
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

  const midiBadgeLabel =
    midiDevices.length > 0
      ? `${midiDevices.length} MIDI`
      : midiState === 'ready'
        ? 'MIDI Ready'
        : midiState === 'denied'
          ? 'MIDI Blocked'
          : midiState === 'unsupported'
            ? 'No WebMIDI'
            : 'Connect MIDI';

  return (
    <div
      className={`min-h-screen transition-colors ${
        darkMode ? 'bg-stone-950 text-stone-100' : 'bg-[#f6f3ec] text-stone-900'
      }`}
    >
      <header
        className={`sticky top-0 z-30 border-b backdrop-blur-md ${
          darkMode
            ? 'border-stone-800/80 bg-stone-950/90'
            : 'border-stone-200/90 bg-[#f6f3ec]/90'
        }`}
      >
        <div className="mx-auto flex max-w-[1440px] flex-nowrap items-center justify-between gap-2 px-3 py-2 sm:px-6 sm:py-2.5">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <div className="flex shrink-0 items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-amber-600 text-stone-950 shadow-sm sm:h-8 sm:w-8">
                <Music2 className="h-4 w-4" />
              </div>
              <div>
                <span className="font-display text-xl leading-none tracking-tight sm:text-2xl">
                  Maestro
                </span>
                <span
                  className={`ml-2 hidden text-[11px] font-medium uppercase tracking-widest md:inline ${
                    darkMode ? 'text-stone-400' : 'text-stone-500'
                  }`}
                >
                  Conservatory Studio
                </span>
              </div>
            </div>

            <nav
              aria-label="Primary"
              className={`inline-flex shrink-0 items-center rounded-xl border p-0.5 ${
                darkMode ? 'border-stone-800 bg-stone-900' : 'border-stone-200 bg-stone-200/60'
              }`}
            >
              <button
                type="button"
                onClick={() => setTab('practice')}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition sm:px-3.5 ${
                  tab === 'practice'
                    ? darkMode
                      ? 'bg-stone-800 text-amber-300 shadow-sm'
                      : 'bg-white text-stone-900 shadow-sm'
                    : darkMode
                      ? 'text-stone-400 hover:text-stone-200'
                      : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                Practice
              </button>
              <button
                type="button"
                onClick={() => setTab('library')}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition sm:px-3.5 ${
                  tab === 'library'
                    ? darkMode
                      ? 'bg-stone-800 text-amber-300 shadow-sm'
                      : 'bg-white text-stone-900 shadow-sm'
                    : darkMode
                      ? 'text-stone-400 hover:text-stone-200'
                      : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                Library
              </button>
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={handleConnectMidi}
              title={
                midiDevices.length > 0
                  ? midiDevices.map((d) => d.name).join(', ')
                  : 'Connect Web MIDI keyboard'
              }
              className={`inline-flex items-center gap-1.5 rounded-xl border px-2 py-1.5 text-xs font-semibold transition sm:px-2.5 ${
                midiDevices.length > 0
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                  : darkMode
                    ? 'border-stone-800 bg-stone-900 text-stone-300 hover:bg-stone-800'
                    : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-100'
              }`}
            >
              <Usb className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{midiBadgeLabel}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleToggleMic()}
              title={micActive ? 'Stop acoustic microphone' : 'Enable acoustic microphone'}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-2 py-1.5 text-xs font-semibold transition sm:px-2.5 ${
                micActive
                  ? 'border-rose-500/40 bg-rose-500/15 text-rose-400'
                  : darkMode
                    ? 'border-stone-800 bg-stone-900 text-stone-300 hover:bg-stone-800'
                    : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-100'
              }`}
            >
              {micActive ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
              {micActive ? (
                <span className="max-w-[44px] truncate sm:max-w-none">
                  {micPitch ? micPitch.name : 'On'}
                </span>
              ) : (
                <span className="hidden sm:inline">Mic</span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setDarkMode((prev) => !prev)}
              aria-label={darkMode ? 'Switch to Warm Ivory Paper theme' : 'Switch to Dark Concert Studio theme'}
              title={darkMode ? 'Warm Ivory Paper' : 'Dark Concert Studio'}
              className={`inline-flex items-center justify-center rounded-xl border p-1.5 transition ${
                darkMode
                  ? 'border-stone-800 bg-stone-900 text-amber-300 hover:bg-stone-800'
                  : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-100'
              }`}
            >
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {pdfNotice ? (
          <div className="border-t border-rose-500/30 bg-rose-500/10 px-4 py-1.5 text-center text-xs font-medium text-rose-400">
            {pdfNotice}
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
            midiController={midiController}
            midiState={midiState}
            midiDevices={midiDevices}
            onConnectMidi={handleConnectMidi}
            micActive={micActive}
            micPitch={micPitch}
            micError={micError}
            onToggleMic={() => void handleToggleMic()}
            audioStatus={audioStatus}
            viewActive={tab === 'practice'}
            registerNoteHandler={registerNoteHandler}
            registerMicGate={registerMicGate}
          />
        </div>

        {tab === 'library' ? (
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
