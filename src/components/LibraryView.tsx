import { useRef, useState, type DragEvent } from 'react';
import { FileDown, Loader2, Music, Play, Search, Sparkles, Upload } from 'lucide-react';
import { readPracticeMidi } from '../music/midi-parser';
import type { Score } from '../music/types';
import { renderScorePdf } from '../score-pdf.mjs';

export interface SavedMuseScore {
  scoreId: string;
  title: string;
  sourceUrl?: string;
  savedAt?: string;
}

export interface MuseScoreController {
  field: JSX.Element;
  scores: SavedMuseScore[];
  libraryStatus: 'checking' | 'off' | 'ready';
  busy: boolean;
  notice: string | null;
  openSaved: (scoreId: string) => Promise<void>;
  loadScore: (scoreId: string) => Promise<Score | null>;
  cutLabel: (songId: string) => string | null;
}

export interface LibraryViewProps {
  darkMode: boolean;
  museScore: MuseScoreController;
  sessionScores: Score[];
  activeScoreId: string | null;
  onOpenScore: (score: Score) => void;
  onLoadSample: () => Promise<void>;
  sampleLoading: boolean;
  sampleError: string | null;
}

function pdfFileName(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'score';
  return `${cleaned}.pdf`;
}

function downloadPdf(score: Score, fallbackTitle?: string): void {
  const bytes = renderScorePdf(score);
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = pdfFileName(score.title || fallbackTitle || 'score');
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatSavedDate(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function LibraryView({
  darkMode,
  museScore,
  sessionScores,
  activeScoreId,
  onOpenScore,
  onLoadSample,
  sampleLoading,
  sampleError,
}: LibraryViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const query = searchQuery.trim().toLowerCase();
  const filteredSaved = museScore.scores.filter((item) =>
    query ? item.title.toLowerCase().includes(query) : true,
  );
  const filteredSession = sessionScores.filter((item) =>
    query ? item.title.toLowerCase().includes(query) : true,
  );

  const handleMidiFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setUploadError(null);
    try {
      const bytes = await file.arrayBuffer();
      const result = readPracticeMidi(bytes, file.name);
      if (!result.ok) {
        setUploadError(
          result.reason === 'empty'
            ? 'That MIDI file has no playable notes.'
            : 'Could not read that MIDI file. Please choose a valid .mid or .midi file.',
        );
        return;
      }
      onOpenScore(result.song);
    } catch {
      setUploadError('Failed to read the selected file.');
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void handleMidiFiles(e.dataTransfer.files);
  };

  const handleSavedPdf = async (row: SavedMuseScore) => {
    setPdfBusyId(row.scoreId);
    setPdfError(null);
    try {
      const cached = sessionScores.find((s) => s.id === `musescore:${row.scoreId}`);
      const loaded = cached ?? (await museScore.loadScore(row.scoreId));
      if (!loaded) {
        setPdfError(`Could not load "${row.title}" for PDF export.`);
        return;
      }
      downloadPdf(loaded, row.title);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Could not build that PDF.');
    } finally {
      setPdfBusyId(null);
    }
  };

  const handleSessionPdf = (score: Score) => {
    setPdfError(null);
    try {
      downloadPdf(score);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Could not build that PDF.');
    }
  };

  const cardBg = darkMode
    ? 'bg-stone-900/75 border-stone-800'
    : 'bg-white/90 border-stone-200/90 shadow-sm';
  const mutedText = darkMode ? 'text-stone-400' : 'text-stone-500';
  const subtleBtn = darkMode
    ? 'bg-stone-800/80 border-stone-700 text-stone-200 hover:bg-stone-700/80'
    : 'bg-stone-100 border-stone-200 text-stone-700 hover:bg-stone-200/80';

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 space-y-6">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <section className={`lg:col-span-7 rounded-2xl border p-5 ${cardBg}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-2xl tracking-tight">Open from MuseScore</h2>
              <p className={`mt-1 text-xs ${mutedText}`}>
                Paste a MuseScore score link or try the bundled repertoire piece offline.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void onLoadSample()}
              disabled={sampleLoading}
              className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-semibold text-stone-950 shadow-sm transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sampleLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Try Sample: Merry-Go-Round of Life
            </button>
          </div>

          {sampleError ? (
            <p className="mt-3 text-xs font-medium text-rose-400">{sampleError}</p>
          ) : null}

          {museScore.field}
        </section>

        <section className={`lg:col-span-5 rounded-2xl border p-5 ${cardBg}`}>
          <h2 className="font-display text-2xl tracking-tight">Upload Standard MIDI</h2>
          <p className={`mt-1 text-xs ${mutedText}`}>
            Open any local <span className="font-mono">.mid</span> or{' '}
            <span className="font-mono">.midi</span> file directly in your browser.
          </p>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${
              dragging
                ? 'border-amber-500 bg-amber-500/10'
                : darkMode
                  ? 'border-stone-700/90 bg-stone-950/50 hover:border-stone-600'
                  : 'border-stone-300 bg-stone-50/70 hover:border-stone-400'
            }`}
          >
            <Upload className={`h-5 w-5 ${dragging ? 'text-amber-400' : mutedText}`} />
            <p className="mt-2 text-xs font-semibold">
              Drop a MIDI file here, or click to browse
            </p>
            <p className={`mt-0.5 text-[11px] ${mutedText}`}>
              Parsed locally · multi-track hands &amp; sustain pedal preserved
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mid,.midi,audio/midi,audio/x-midi"
              className="hidden"
              onChange={(e) => {
                void handleMidiFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {uploadError ? (
            <p className="mt-2.5 text-xs font-medium text-rose-400" role="alert">
              {uploadError}
            </p>
          ) : null}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search
            className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${mutedText}`}
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search saved or session scores…"
            className={`w-full rounded-xl border py-2 pl-9 pr-3 text-xs focus:outline-none ${
              darkMode
                ? 'border-stone-800 bg-stone-900 text-stone-100 placeholder:text-stone-500 focus:border-amber-500/60'
                : 'border-stone-200 bg-white text-stone-900 placeholder:text-stone-400 focus:border-amber-600/60'
            }`}
          />
        </div>

        {pdfError ? (
          <p className="text-xs font-medium text-rose-400" role="alert">
            {pdfError}
          </p>
        ) : null}
      </div>

      {filteredSession.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-500">
              Session Scores ({filteredSession.length})
            </h3>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredSession.map((score) => {
              const isCurrent = score.id === activeScoreId;
              const cut = museScore.cutLabel(score.id);
              return (
                <article
                  key={score.id}
                  className={`flex flex-col justify-between rounded-2xl border p-4 transition ${cardBg} ${
                    isCurrent ? 'ring-1 ring-amber-500/60' : ''
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="line-clamp-2 text-sm font-semibold leading-snug">
                        {score.title}
                      </h4>
                      {isCurrent ? (
                        <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
                          Open
                        </span>
                      ) : null}
                    </div>
                    <p className={`mt-1.5 font-mono text-[11px] ${mutedText}`}>
                      {score.keySignature} · {score.timeSignature[0]}/{score.timeSignature[1]} ·{' '}
                      {score.tempo} BPM · {score.totalMeasures} bars
                    </p>
                    {cut ? <p className={`mt-1 text-[11px] ${mutedText}`}>{cut}</p> : null}
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenScore(score)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-600 px-3 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-amber-500"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Practice
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSessionPdf(score)}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${subtleBtn}`}
                      title="Export sheet music PDF"
                    >
                      <FileDown className="h-3.5 w-3.5" />
                      PDF
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className={`text-xs font-semibold uppercase tracking-wider ${mutedText}`}>
            Saved MuseScore Library ({filteredSaved.length})
          </h3>
          <span className={`text-[11px] ${mutedText}`}>
            {museScore.libraryStatus === 'checking'
              ? 'Checking helper…'
              : museScore.libraryStatus === 'off'
                ? 'Helper offline'
                : 'Helper connected'}
          </span>
        </div>

        {filteredSaved.length === 0 ? (
          <div className={`rounded-2xl border p-8 text-center ${cardBg}`}>
            <Music className={`mx-auto h-6 w-6 ${mutedText}`} />
            <p className="mt-2 text-sm font-medium">
              {museScore.scores.length === 0
                ? museScore.libraryStatus === 'off'
                  ? 'Saved MuseScore library is unavailable while the helper is offline.'
                  : 'No saved MuseScore scores yet.'
                : 'No saved scores match your search.'}
            </p>
            <p className={`mt-1 text-xs ${mutedText}`}>
              Upload a local MIDI file above or try Merry-Go-Round of Life right away.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredSaved.map((row) => {
              const savedDate = formatSavedDate(row.savedAt);
              const isPdfBusy = pdfBusyId === row.scoreId;
              return (
                <article
                  key={row.scoreId}
                  className={`flex flex-col justify-between rounded-2xl border p-4 transition ${cardBg}`}
                >
                  <div>
                    <h4 className="line-clamp-2 text-sm font-semibold leading-snug">{row.title}</h4>
                    <p className={`mt-1.5 font-mono text-[11px] ${mutedText}`}>
                      #{row.scoreId}
                      {savedDate ? ` · Saved ${savedDate}` : ''}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={museScore.busy}
                      onClick={() => void museScore.openSaved(row.scoreId)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-600 px-3 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Practice
                    </button>
                    <button
                      type="button"
                      disabled={isPdfBusy}
                      onClick={() => void handleSavedPdf(row)}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${subtleBtn}`}
                      title="Export sheet music PDF"
                    >
                      {isPdfBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FileDown className="h-3.5 w-3.5" />
                      )}
                      PDF
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
