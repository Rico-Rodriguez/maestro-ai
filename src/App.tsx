import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Library, Music2, SlidersHorizontal } from 'lucide-react';
import { pianoEngine, type AudioEngineStatus } from './audio/piano-engine';
import LibraryView, { type MuseScoreController } from './components/LibraryView';
import MaestroKids from './components/MaestroKids';
import PracticeStudio from './components/PracticeStudio';
import type { RegisterInput } from './components/kids-audio';
import { MicInputController } from './input/mic-adapter';
import { MidiInputController } from './input/midi-adapter';
import type {
  MicPitchReading,
  MidiAccessState,
  MidiDeviceInfo,
  NoteInput,
} from './input/types';
import { readPracticeMidi } from './music/midi-parser';
import { loadKidsData, saveKidsData, type KidsData } from './music/kids-learning';
import { DEFAULT_TODDLER_SCORE } from './music/toddler-songs';
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
  const [inStudio, setInStudio] = useState(false);
  const [studioOpened, setStudioOpened] = useState(false);
  const [kidsData, setKidsData] = useState(loadKidsData);
  const kidsDataRef = useRef(kidsData);
  const [muteLocalForMidi, setMuteLocalForMidi] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionScores, setSessionScores] = useState<Score[]>([]);
  const [activeScore, setActiveScore] = useState<Score | null>(DEFAULT_TODDLER_SCORE);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [pdfNotice, setPdfNotice] = useState<string | null>(null);

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
  const kidsNoteHandler = useRef<Parameters<RegisterInput>[0]>(null);
  const kidsMicGate = useRef<Parameters<RegisterInput>[1]>(null);

  const updateKids = useCallback((apply: (data: KidsData) => KidsData) => {
    const next = apply(kidsDataRef.current);
    if (next === kidsDataRef.current) return;
    kidsDataRef.current = next;
    saveKidsData(next);
    setKidsData(next);
  }, []);

  const registerKidsInput = useCallback<RegisterInput>((listener, gate) => {
    kidsNoteHandler.current = listener;
    kidsMicGate.current = gate;
  }, []);

  const registerNoteHandler = useCallback((handler: ((event: NoteInput) => void) | null) => {
    noteHandlerRef.current = handler;
  }, []);

  const registerMicGate = useCallback((gate: (() => boolean) | null) => {
    micGateRef.current = gate;
  }, []);

  useEffect(() => {
    const night = inStudio && darkMode;
    document.body.style.backgroundColor = night ? '#17131a' : '#faf4ec';
    document.body.style.color = night ? '#f3eaf0' : '#38252d';
    void globalThis.__maestroSetSystemBars?.(night)?.catch?.(() => {});
  }, [darkMode, inStudio]);

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
    if (inStudio) return;
    return midiController.subscribe((event) => kidsNoteHandler.current?.(event));
  }, [midiController, inStudio]);

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
        onNote: (event) => (kidsNoteHandler.current ?? noteHandlerRef.current)?.(event),
        shouldGate: () => (kidsMicGate.current ?? micGateRef.current)?.() ?? true,
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

  const headerButton = `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-bold ${darkMode ? 'border-white/10 bg-white/5 aria-pressed:border-[#f06595] aria-pressed:text-[#f06595]' : 'border-[#e9dcd0] bg-[#fffbf6] aria-pressed:border-[#b72355] aria-pressed:text-[#b72355]'}`;

  return (
    <>
      {!inStudio && <MaestroKids data={kidsData} update={updateKids} register={registerKidsInput}
        midiSound={!muteLocalForMidi} openStudio={() => {
          setInStudio(true);
          setStudioOpened(true);
          setTab('practice');
          setShowSettings(true);
          window.scrollTo(0, 0);
        }} />}
      {studioOpened && <div hidden={!inStudio}
        className={`min-h-screen ${darkMode ? 'bg-[#17131a] text-[#f3eaf0]' : 'bg-[#faf4ec] text-[#38252d]'}`}>
        <header className={`border-b ${darkMode ? 'border-white/10' : 'border-[#e9dcd0] bg-[#fffbf6]'}`}>
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
            <h1 className="flex items-center gap-2 text-lg font-black"><Music2 size={21} /> Maestro Studio</h1>
            <nav aria-label="Maestro Studio" className="flex flex-wrap gap-1.5">
              <button type="button" className={headerButton} aria-pressed={tab === 'practice' && !showSettings}
                onClick={() => { setTab('practice'); setShowSettings(false); }}>Practice</button>
              <button type="button" className={headerButton} aria-pressed={tab === 'library'}
                onClick={() => { setTab('library'); setShowSettings(false); }}><Library size={16} /> Library</button>
              <button type="button" className={headerButton} aria-pressed={tab === 'practice' && showSettings}
                onClick={() => { setTab('practice'); setShowSettings(true); }}><SlidersHorizontal size={16} /> Settings</button>
              <button type="button" className={headerButton} onClick={() => setInStudio(false)}><ArrowLeft size={16} /> Maestro Kids</button>
            </nav>
          </div>
        </header>
        {pdfNotice && <p role="status" className="px-4 py-2 text-center text-sm">{pdfNotice}</p>}
        {midiNotice && <p role="status" className="px-4 py-2 text-center text-sm">{midiNotice}</p>}
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
              kidsData={kidsData}
              onKidsSettings={(settings) => updateKids((previous) => ({ ...previous, settings: { ...previous.settings, ...settings } }))}
              muteLocalForMidi={muteLocalForMidi}
              onMuteLocalForMidi={setMuteLocalForMidi}
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
              viewActive={inStudio && tab === 'practice' && !showSettings}
              registerNoteHandler={registerNoteHandler}
              registerMicGate={registerMicGate}
            />
          </div>

          {inStudio && tab === 'library' ? (
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
      </div>}
    </>
  );
}
