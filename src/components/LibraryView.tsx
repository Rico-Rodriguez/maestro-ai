import { useRef, useState, type DragEvent } from 'react';
import { FileDown, Loader2, Music, Play, Search, Upload } from 'lucide-react';
import { readPracticeMidi } from '../music/midi-parser';
import {
  buildToddlerScore,
  getSongPreviewPitches,
  songArtUrl,
  TODDLER_SONGS,
} from '../music/toddler-songs';
import type { Score } from '../music/types';
import { renderScorePdf } from '../score-pdf.mjs';
import { getKeyStickerColor } from './note-colors';

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
  const [failedArtIds, setFailedArtIds] = useState<Record<string, boolean>>({});
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
            ? 'That MIDI file has no playable notes'
            : 'Choose a valid .mid or .midi file',
        );
        return;
      }
      onOpenScore(result.song);
    } catch {
      setUploadError('Failed to read the selected file');
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
        setPdfError(`Could not load "${row.title}" for PDF export`);
        return;
      }
      downloadPdf(loaded, row.title);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Could not build that PDF');
    } finally {
      setPdfBusyId(null);
    }
  };

  const handleSessionPdf = (score: Score) => {
    setPdfError(null);
    try {
      downloadPdf(score);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Could not build that PDF');
    }
  };

  const cardSurface = darkMode
    ? 'bg-[#1f1a22] border-[#f3eaf0]/[0.08] text-[#f3eaf0]'
    : 'bg-[#fffdfb] border-[#2a1d22]/[0.08] text-[#2a1d22]';
  const secondaryText = darkMode ? 'text-[#b9a9b4]' : 'text-[#6b5560]';
  const mutedText = darkMode ? 'text-[#94838f]' : 'text-[#8a7680]';
  const hairlineBorder = darkMode ? 'border-[#f3eaf0]/[0.08]' : 'border-[#2a1d22]/[0.08]';
  const subtleBtn = darkMode
    ? 'border-[#f3eaf0]/[0.08] bg-[#2a2430] text-[#f3eaf0] hover:bg-[#352d3c]'
    : 'border-[#2a1d22]/[0.08] bg-[#f6ebe6] text-[#2a1d22] hover:bg-[#ede0da]';
  const primaryBtn = darkMode
    ? 'bg-[#f06595] text-[#17131a] hover:bg-[#f47aa4]'
    : 'bg-[#d6336c] text-white hover:bg-[#be2a5e]';
  const errorText = darkMode ? 'text-[#e5484d]' : 'text-[#dc2626]';

  return (
    <div className="mx-auto max-w-[1440px] space-y-8 py-2">
      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.01em]">Starter songs</h2>
          <p className={`mt-1 text-[13px] ${secondaryText}`}>
            White-key melodies for early practice
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {TODDLER_SONGS.map((song) => {
            const isPlaying = activeScoreId === song.id;
            const previewPitches = getSongPreviewPitches(song, 6);
            const artFailed = Boolean(failedArtIds[song.id]);
            return (
              <button
                key={song.id}
                type="button"
                onClick={() => onOpenScore(buildToddlerScore(song))}
                className={`group flex flex-col rounded-[20px] border p-3 text-left transition-colors duration-150 active:scale-[0.98] ${cardSurface} ${
                  isPlaying
                    ? darkMode
                      ? 'border-[#f06595]'
                      : 'border-[#d6336c]'
                    : darkMode
                      ? 'hover:border-[#f3eaf0]/20'
                      : 'hover:border-[#2a1d22]/20'
                }`}
              >
                <div
                  className={`relative aspect-square w-full overflow-hidden rounded-[16px] ${
                    darkMode ? 'bg-[#2a2430]' : 'bg-[#f6ebe6]'
                  }`}
                >
                  {!artFailed ? (
                    <img
                      src={songArtUrl(song)}
                      alt={song.title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                      onError={() =>
                        setFailedArtIds((prev) => (prev[song.id] ? prev : { ...prev, [song.id]: true }))
                      }
                    />
                  ) : (
                    <div
                      className="flex h-full w-full items-center justify-center gap-2 px-4"
                      aria-hidden="true"
                    >
                      {previewPitches.map((pitch, idx) => (
                        <span
                          key={`${song.id}-fallback-${idx}`}
                          className="h-3.5 w-3.5 rounded-full"
                          style={{ backgroundColor: getKeyStickerColor(pitch).bg }}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-3 flex flex-1 flex-col justify-between gap-2">
                  <div>
                    <h3 className="text-[15px] font-semibold leading-snug">{song.title}</h3>
                    <div className="mt-2 flex items-center gap-1.5" aria-hidden="true">
                      {previewPitches.map((pitch, idx) => (
                        <span
                          key={`${song.id}-dot-${idx}`}
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: getKeyStickerColor(pitch).bg }}
                        />
                      ))}
                    </div>
                  </div>

                  {isPlaying ? (
                    <span
                      className={`text-xs font-medium ${
                        darkMode ? 'text-[#f06595]' : 'text-[#d6336c]'
                      }`}
                    >
                      Playing
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className={`space-y-6 border-t pt-6 ${hairlineBorder}`}>
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.01em]">MuseScore and MIDI</h2>
          <p className={`mt-1 text-[13px] ${secondaryText}`}>
            Load a MuseScore link, local MIDI file, or saved score
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <section className={`lg:col-span-7 rounded-[20px] border p-5 ${cardSurface}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">Open from MuseScore</h3>
                <p className={`mt-1 text-[13px] ${secondaryText}`}>
                  Paste a score link or open the bundled sample piece
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onLoadSample()}
                disabled={sampleLoading}
                className={`inline-flex h-10 items-center gap-2 rounded-[12px] px-4 text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${primaryBtn}`}
              >
                {sampleLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Play className="h-4 w-4" strokeWidth={1.5} />
                )}
                <span>Merry-Go-Round of Life</span>
              </button>
            </div>

            {sampleError ? (
              <p className={`mt-3 text-xs font-medium ${errorText}`}>{sampleError}</p>
            ) : null}

            {museScore.field}
          </section>

          <section className={`lg:col-span-5 rounded-[20px] border p-5 ${cardSurface}`}>
            <h3 className="text-base font-semibold">Upload MIDI</h3>
            <p className={`mt-1 text-[13px] ${secondaryText}`}>
              Open a local <span className="font-mono">.mid</span> or{' '}
              <span className="font-mono">.midi</span> file in your browser
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
              className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-[12px] border border-dashed px-4 py-6 text-center transition-colors duration-150 ${
                dragging
                  ? darkMode
                    ? 'border-[#f06595] bg-[#f06595]/10'
                    : 'border-[#d6336c] bg-[#d6336c]/10'
                  : darkMode
                    ? 'border-[#f3eaf0]/[0.16] bg-[#17131a] hover:border-[#f3eaf0]/30'
                    : 'border-[#2a1d22]/[0.16] bg-[#fbf5f1] hover:border-[#2a1d22]/30'
              }`}
            >
              <Upload
                className={`h-4 w-4 ${dragging ? (darkMode ? 'text-[#f06595]' : 'text-[#d6336c]') : secondaryText}`}
                strokeWidth={1.5}
              />
              <p className="mt-2 text-[13px] font-medium">
                Drop a MIDI file or click to browse
              </p>
              <p className={`mt-1 text-xs ${mutedText}`}>
                Parsed locally with hands and sustain preserved
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
              <p className={`mt-3 text-xs font-medium ${errorText}`} role="alert">
                {uploadError}
              </p>
            ) : null}
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-sm">
            <Search
              className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${mutedText}`}
              strokeWidth={1.5}
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search"
              className={`h-10 w-full rounded-[12px] border pl-9 pr-3 text-[13px] focus:outline-none ${
                darkMode
                  ? 'border-[#f3eaf0]/[0.08] bg-[#1f1a22] text-[#f3eaf0] placeholder:text-[#94838f] focus:border-[#f06595]/60'
                  : 'border-[#2a1d22]/[0.08] bg-[#fffdfb] text-[#2a1d22] placeholder:text-[#8a7680] focus:border-[#d6336c]/60'
              }`}
            />
          </div>

          {pdfError ? (
            <p className={`text-xs font-medium ${errorText}`} role="alert">
              {pdfError}
            </p>
          ) : null}
        </div>

        {filteredSession.length > 0 ? (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Session scores{' '}
                <span className={`font-mono text-xs tabular-nums ${mutedText}`}>
                  ({filteredSession.length})
                </span>
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredSession.map((score) => {
                const isCurrent = score.id === activeScoreId;
                const cut = museScore.cutLabel(score.id);
                return (
                  <article
                    key={score.id}
                    className={`flex flex-col justify-between rounded-[16px] border p-4 transition-colors duration-150 ${cardSurface} ${
                      isCurrent
                        ? darkMode
                          ? 'border-[#f06595]'
                          : 'border-[#d6336c]'
                        : ''
                    }`}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="line-clamp-2 text-[15px] font-semibold leading-snug">
                          {score.title}
                        </h4>
                        {isCurrent ? (
                          <span
                            className={`shrink-0 text-xs font-medium ${
                              darkMode ? 'text-[#f06595]' : 'text-[#d6336c]'
                            }`}
                          >
                            Open
                          </span>
                        ) : null}
                      </div>
                      <p className={`mt-1.5 font-mono text-xs tabular-nums ${mutedText}`}>
                        {score.keySignature} · {score.timeSignature[0]}/{score.timeSignature[1]} ·{' '}
                        {score.tempo} BPM · {score.totalMeasures} bars
                      </p>
                      {cut ? <p className={`mt-1 text-xs ${mutedText}`}>{cut}</p> : null}
                    </div>

                    <div className="mt-4 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenScore(score)}
                        className={`inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-[12px] px-3 text-[13px] font-medium transition-colors duration-150 ${primaryBtn}`}
                      >
                        <Play className="h-4 w-4" strokeWidth={1.5} />
                        <span>Practice</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSessionPdf(score)}
                        className={`inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border px-3 text-[13px] font-medium transition-colors duration-150 ${subtleBtn}`}
                        title="Export sheet music PDF"
                      >
                        <FileDown className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                        <span>PDF</span>
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
            <h3 className="text-sm font-semibold">
              Saved library{' '}
              <span className={`font-mono text-xs tabular-nums ${mutedText}`}>
                ({filteredSaved.length})
              </span>
            </h3>
            <span className={`text-xs ${mutedText}`}>
              {museScore.libraryStatus === 'checking'
                ? 'Checking helper'
                : museScore.libraryStatus === 'off'
                  ? 'Helper offline'
                  : 'Helper connected'}
            </span>
          </div>

          {filteredSaved.length === 0 ? (
            <div className={`rounded-[16px] border p-8 text-center ${cardSurface}`}>
              <Music className={`mx-auto h-5 w-5 ${mutedText}`} strokeWidth={1.5} />
              <p className="mt-2 text-sm font-medium">
                {museScore.scores.length === 0
                  ? museScore.libraryStatus === 'off'
                    ? 'Saved library is unavailable while the helper is offline'
                    : 'No saved scores yet'
                  : 'No saved scores match your search'}
              </p>
              <p className={`mt-1 text-xs ${mutedText}`}>
                Upload a local MIDI file above or open Merry-Go-Round of Life
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredSaved.map((row) => {
                const savedDate = formatSavedDate(row.savedAt);
                const isPdfBusy = pdfBusyId === row.scoreId;
                return (
                  <article
                    key={row.scoreId}
                    className={`flex flex-col justify-between rounded-[16px] border p-4 transition-colors duration-150 ${cardSurface}`}
                  >
                    <div>
                      <h4 className="line-clamp-2 text-[15px] font-semibold leading-snug">
                        {row.title}
                      </h4>
                      <p className={`mt-1.5 font-mono text-xs tabular-nums ${mutedText}`}>
                        #{row.scoreId}
                        {savedDate ? ` · ${savedDate}` : ''}
                      </p>
                    </div>

                    <div className="mt-4 flex items-center gap-2">
                      <button
                        type="button"
                        disabled={museScore.busy}
                        onClick={() => void museScore.openSaved(row.scoreId)}
                        className={`inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-[12px] px-3 text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${primaryBtn}`}
                      >
                        <Play className="h-4 w-4" strokeWidth={1.5} />
                        <span>Practice</span>
                      </button>
                      <button
                        type="button"
                        disabled={isPdfBusy}
                        onClick={() => void handleSavedPdf(row)}
                        className={`inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border px-3 text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${subtleBtn}`}
                        title="Export sheet music PDF"
                      >
                        {isPdfBusy ? (
                          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                        ) : (
                          <FileDown className={`h-4 w-4 ${secondaryText}`} strokeWidth={1.5} />
                        )}
                        <span>PDF</span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </section>
    </div>
  );
}
