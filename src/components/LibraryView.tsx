import { useRef, useState, type DragEvent } from 'react';
import { FileDown, Loader2, Music, Play, Search, Upload } from 'lucide-react';
import { readPracticeMidi } from '../music/midi-parser';
import {
  buildToddlerScore,
  getSongPreviewPitches,
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
    ? 'bg-[#1c1a18] border-[#efe9de]/[0.08] text-[#efe9de]'
    : 'bg-[#fdfbf7] border-[#1f1b16]/[0.08] text-[#1f1b16]';
  const secondaryText = darkMode ? 'text-[#aaa398]' : 'text-[#5e554a]';
  const mutedText = darkMode ? 'text-[#8a847a]' : 'text-[#7b7266]';
  const hairlineBorder = darkMode ? 'border-[#efe9de]/[0.08]' : 'border-[#1f1b16]/[0.08]';
  const subtleBtn = darkMode
    ? 'border-[#efe9de]/[0.08] bg-[#262421] text-[#efe9de] hover:bg-[#2f2c28]'
    : 'border-[#1f1b16]/[0.08] bg-[#fdfbf7] text-[#1f1b16] hover:bg-[#efe9df]';
  const primaryBtn = darkMode
    ? 'bg-[#efe9de] text-[#161513] hover:bg-white'
    : 'bg-[#c85a32] text-white hover:bg-[#b44e29]';
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TODDLER_SONGS.map((song) => {
            const isPlaying = activeScoreId === song.id;
            const previewPitches = getSongPreviewPitches(song, 6);
            return (
              <article
                key={song.id}
                className={`flex flex-col justify-between rounded-[12px] border p-4 transition-colors duration-150 ${cardSurface} ${
                  isPlaying
                    ? darkMode
                      ? 'border-[#e07047]'
                      : 'border-[#c85a32]'
                    : ''
                }`}
              >
                <div>
                  <div className="mb-3 flex items-center gap-1.5" aria-hidden="true">
                    {previewPitches.map((pitch, idx) => (
                      <span
                        key={`${song.id}-dot-${idx}`}
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: getKeyStickerColor(pitch).bg }}
                      />
                    ))}
                  </div>
                  <h3 className="text-[15px] font-medium leading-snug">{song.title}</h3>
                  <p className={`mt-1 text-[13px] ${secondaryText}`}>{song.subtitle}</p>
                </div>

                <div className="mt-4 flex items-center justify-between gap-2">
                  <span className={`font-mono text-xs tabular-nums ${mutedText}`}>
                    {song.tempo} BPM · {song.timeSignature[0]}/{song.timeSignature[1]}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenScore(buildToddlerScore(song))}
                    className={`inline-flex h-9 items-center gap-2 rounded-[8px] px-3 text-[13px] font-medium transition-colors duration-150 active:scale-[0.98] ${
                      isPlaying
                        ? darkMode
                          ? 'bg-[#4cc38a] text-[#161513] hover:bg-[#5cd099]'
                          : 'bg-[#16a34a] text-white hover:bg-[#15803d]'
                        : primaryBtn
                    }`}
                  >
                    <Play className="h-4 w-4 fill-current" strokeWidth={1.5} />
                    <span>{isPlaying ? 'Playing' : 'Play'}</span>
                  </button>
                </div>
              </article>
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
          <section className={`lg:col-span-7 rounded-[12px] border p-5 ${cardSurface}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-medium">Open from MuseScore</h3>
                <p className={`mt-1 text-[13px] ${secondaryText}`}>
                  Paste a score link or open the bundled sample piece
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onLoadSample()}
                disabled={sampleLoading}
                className={`inline-flex h-9 items-center gap-2 rounded-[8px] px-3 text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${primaryBtn}`}
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

          <section className={`lg:col-span-5 rounded-[12px] border p-5 ${cardSurface}`}>
            <h3 className="text-base font-medium">Upload MIDI</h3>
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
              className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-[8px] border border-dashed px-4 py-6 text-center transition-colors duration-150 ${
                dragging
                  ? darkMode
                    ? 'border-[#e07047] bg-[#e07047]/10'
                    : 'border-[#c85a32] bg-[#c85a32]/10'
                  : darkMode
                    ? 'border-[#efe9de]/[0.16] bg-[#161513] hover:border-[#efe9de]/30'
                    : 'border-[#1f1b16]/[0.16] bg-[#f7f4ee] hover:border-[#1f1b16]/30'
              }`}
            >
              <Upload
                className={`h-4 w-4 ${dragging ? (darkMode ? 'text-[#e07047]' : 'text-[#c85a32]') : secondaryText}`}
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
              className={`h-9 w-full rounded-[8px] border pl-9 pr-3 text-[13px] focus:outline-none ${
                darkMode
                  ? 'border-[#efe9de]/[0.08] bg-[#1c1a18] text-[#efe9de] placeholder:text-[#8a847a] focus:border-[#e07047]/60'
                  : 'border-[#1f1b16]/[0.08] bg-[#fdfbf7] text-[#1f1b16] placeholder:text-[#7b7266] focus:border-[#c85a32]/60'
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
              <h3 className="text-sm font-medium">
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
                    className={`flex flex-col justify-between rounded-[12px] border p-4 transition-colors duration-150 ${cardSurface} ${
                      isCurrent
                        ? darkMode
                          ? 'border-[#e07047]'
                          : 'border-[#c85a32]'
                        : ''
                    }`}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="line-clamp-2 text-[15px] font-medium leading-snug">
                          {score.title}
                        </h4>
                        {isCurrent ? (
                          <span
                            className={`shrink-0 text-xs font-medium ${
                              darkMode ? 'text-[#e07047]' : 'text-[#c85a32]'
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
                        className={`inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-[8px] px-3 text-[13px] font-medium transition-colors duration-150 ${primaryBtn}`}
                      >
                        <Play className="h-4 w-4" strokeWidth={1.5} />
                        <span>Practice</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSessionPdf(score)}
                        className={`inline-flex h-9 items-center justify-center gap-2 rounded-[8px] border px-3 text-[13px] font-medium transition-colors duration-150 ${subtleBtn}`}
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
            <h3 className="text-sm font-medium">
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
            <div className={`rounded-[12px] border p-8 text-center ${cardSurface}`}>
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
                    className={`flex flex-col justify-between rounded-[12px] border p-4 transition-colors duration-150 ${cardSurface}`}
                  >
                    <div>
                      <h4 className="line-clamp-2 text-[15px] font-medium leading-snug">
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
                        className={`inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-[8px] px-3 text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${primaryBtn}`}
                      >
                        <Play className="h-4 w-4" strokeWidth={1.5} />
                        <span>Practice</span>
                      </button>
                      <button
                        type="button"
                        disabled={isPdfBusy}
                        onClick={() => void handleSavedPdf(row)}
                        className={`inline-flex h-9 items-center justify-center gap-2 rounded-[8px] border px-3 text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${subtleBtn}`}
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
