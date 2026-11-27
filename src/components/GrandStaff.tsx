import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { getStaffYOffset } from '../music/pitch';
import type { NoteEvent, Score, TimeSigPoint } from '../music/types';
import type { PracticeGrade } from '../practice/engine';
import { groupStaffEvents, layoutStaffGroup } from '../staff-layout.mjs';
import {
  buildBeamGroups,
  computeBeamLine,
  effectiveDisplayDuration,
  flagCountForDuration,
  type BeamRun,
} from './staff-beaming';

export interface GrandStaffProps {
  score: Score;
  events: NoteEvent[];
  grades: Record<string, PracticeGrade>;
  loop: { enabled: boolean; startMeasure: number; endMeasure: number };
  getLiveBeat: () => number;
  onSeekBeat: (beat: number) => void;
  onPreviewPitch?: (pitch: number) => void;
  darkMode: boolean;
}

interface MeasureSpan {
  measure: number;
  startBeat: number;
  endBeat: number;
  timeSignatureChange?: [number, number];
}

interface RoutedNoteEvent extends NoteEvent {
  originalHand: NoteEvent['hand'];
}

interface StaffNoteGroup {
  hand: 'R' | 'L';
  onset: number;
  notes: RoutedNoteEvent[];
}

interface PreparedNote extends RoutedNoteEvent {
  stepOffset: number;
}

interface LaidOutNote extends PreparedNote {
  dx: number;
  accidentalLane: number;
}

interface DrawnNote extends LaidOutNote {
  cx: number;
  cy: number;
}

interface LaidOutGroupEntry {
  group: StaffNoteGroup;
  groupKey: string;
  stemUp: boolean;
  stemX: number;
  drawn: DrawnNote[];
  topY: number;
  bottomY: number;
  stemDx: number;
  nextOnsetInHand: number | null;
}

const SVG_HEIGHT = 256;
const TREBLE_BOTTOM_Y = 82;
const BASS_BOTTOM_Y = 192;
const STEP_PX = 5;
const STEM_LEN = 26;
const BUFFER_BEATS = 14;
const WINDOW_QUANT_BEATS = 4;
const MANUAL_SCROLL_PAUSE_MS = 2400;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.6;
const ZOOM_STEP = 0.1;

const TREBLE_SHARP_STEPS = [8, 5, 9, 6, 3, 7, 4] as const;
const TREBLE_FLAT_STEPS = [4, 7, 3, 6, 2, 5, 1] as const;
const BASS_SHARP_STEPS = [6, 3, 7, 4, 1, 5, 2] as const;
const BASS_FLAT_STEPS = [2, 5, 1, 4, 0, 3, -1] as const;
const STAFF_LINE_INDICES = [0, 1, 2, 3, 4] as const;
const DOTTED_BEATS = [3, 1.5, 0.75, 0.375] as const;

function buildMeasureSpans(
  timeSignatures: readonly TimeSigPoint[],
  defaultTimeSignature: [number, number],
  totalMeasures: number,
  maxBeat: number,
): MeasureSpan[] {
  const defaultBpb = Math.max(
    0.25,
    defaultTimeSignature[0] * (4 / Math.max(1, defaultTimeSignature[1])),
  );
  const sorted = [...timeSignatures].sort((a, b) => a.beat - b.beat);
  const spans: MeasureSpan[] = [];
  let measure = 1;
  let cursorBeat = 0;

  if (sorted.length === 0) {
    while (measure <= totalMeasures || cursorBeat < maxBeat) {
      const endBeat = cursorBeat + defaultBpb;
      spans.push({ measure, startBeat: cursorBeat, endBeat });
      measure += 1;
      cursorBeat = endBeat;
    }
    return spans;
  }

  if (sorted[0].beat > 1e-4) {
    while (cursorBeat < sorted[0].beat - 1e-4) {
      const endBeat = Math.min(sorted[0].beat, cursorBeat + defaultBpb);
      spans.push({ measure, startBeat: cursorBeat, endBeat });
      measure += 1;
      cursorBeat = endBeat;
    }
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const ts = sorted[i];
    const bpb = Math.max(0.25, ts.numerator * (4 / Math.max(1, ts.denominator)));
    const segEnd = i + 1 < sorted.length ? sorted[i + 1].beat : Infinity;
    let firstInSeg = i > 0;

    while (
      Number.isFinite(segEnd)
        ? cursorBeat < segEnd - 1e-4
        : measure <= totalMeasures || cursorBeat < maxBeat
    ) {
      const rawEnd = cursorBeat + bpb;
      const endBeat = Number.isFinite(segEnd) ? Math.min(segEnd, rawEnd) : rawEnd;
      spans.push({
        measure,
        startBeat: cursorBeat,
        endBeat,
        timeSignatureChange: firstInSeg ? [ts.numerator, ts.denominator] : undefined,
      });
      firstInSeg = false;
      measure += 1;
      cursorBeat = endBeat;
    }
  }

  return spans;
}

function isDottedDuration(duration: number): boolean {
  for (let i = 0; i < DOTTED_BEATS.length; i += 1) {
    if (Math.abs(duration - DOTTED_BEATS[i]) < 0.08) return true;
  }
  return false;
}

function ledgerStepsForOffset(stepOffset: number): number[] {
  const steps: number[] = [];
  if (stepOffset <= -2) {
    for (let s = -2; s >= stepOffset; s -= 2) {
      steps.push(s);
    }
  } else if (stepOffset >= 10) {
    for (let s = 10; s <= stepOffset; s += 2) {
      steps.push(s);
    }
  }
  return steps;
}

function computeBaseBeatPx(events: readonly NoteEvent[]): number {
  if (events.length < 2) return 92;
  const onsets = events.map((e) => e.onset).sort((a, b) => a - b);
  const gaps: number[] = [];
  let prev = onsets[0];
  for (let i = 1; i < onsets.length; i += 1) {
    const gap = onsets[i] - prev;
    if (gap > 0.02) {
      gaps.push(gap);
      prev = onsets[i];
    }
  }
  if (gaps.length === 0) return 92;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  let fastCount = 0;
  for (let i = 0; i < gaps.length; i += 1) {
    if (gaps[i] < 0.35) fastCount += 1;
  }
  return median < 0.36 || fastCount / gaps.length >= 0.2 ? 112 : 92;
}

function quantizeWindow(
  scrollLeft: number,
  viewportWidth: number,
  leftMargin: number,
  stickyWidth: number,
  totalBeats: number,
  beatPx: number,
): { startBeat: number; endBeat: number; viewBeat: number } {
  const rawStart = (scrollLeft - leftMargin) / beatPx;
  const rawEnd = (scrollLeft + Math.max(320, viewportWidth) - leftMargin) / beatPx;
  const viewBeat = Math.max(0, (scrollLeft + stickyWidth - leftMargin) / beatPx);
  const startBeat = Math.max(
    0,
    Math.floor((rawStart - BUFFER_BEATS) / WINDOW_QUANT_BEATS) * WINDOW_QUANT_BEATS,
  );
  const endBeat = Math.min(
    totalBeats + BUFFER_BEATS,
    Math.ceil((rawEnd + BUFFER_BEATS) / WINDOW_QUANT_BEATS) * WINDOW_QUANT_BEATS,
  );
  return { startBeat, endBeat: Math.max(startBeat + 16, endBeat), viewBeat };
}

function resolveActiveTimeSig(
  timeSignatures: readonly TimeSigPoint[],
  defaultTimeSig: [number, number],
  measureSpans: readonly MeasureSpan[],
  startBeat: number,
  viewBeat: number,
): [number, number] {
  if (timeSignatures.length === 0) return defaultTimeSig;
  const sorted = [...timeSignatures].sort((a, b) => a.beat - b.beat);
  const bar1End = measureSpans[0]?.endBeat ?? 0;
  const effectiveBeat =
    viewBeat >= bar1End - 1e-4 ? Math.max(startBeat, viewBeat) : startBeat;

  let active = sorted[0];
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].beat <= effectiveBeat + 1e-4) {
      active = sorted[i];
    } else {
      break;
    }
  }
  return [active.numerator, active.denominator];
}

export function GrandStaff({
  score,
  events,
  grades,
  loop,
  getLiveBeat,
  onSeekBeat,
  onPreviewPitch,
  darkMode: _studioDarkMode,
}: GrandStaffProps) {
  const fadeGradId = useId();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const playheadBandRef = useRef<SVGRectElement | null>(null);
  const playheadLineRef = useRef<SVGLineElement | null>(null);
  const playheadCircleRef = useRef<SVGCircleElement | null>(null);
  const pauseAutoFollowUntilRef = useRef<number>(0);
  const dragPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const scrollRafPendingRef = useRef<number>(0);

  const [paperMode, setPaperMode] = useState(true);
  const [showNoteNames, setShowNoteNames] = useState(false);
  const [zoom, setZoom] = useState(1.0);

  const baseBeatPx = useMemo(() => computeBaseBeatPx(score.events), [score.events]);
  const beatPx = Math.round(baseBeatPx * zoom);

  const keySigSf = score.keySignatures[0]?.sf ?? 0;
  const keySigCount = Math.min(7, Math.abs(Math.round(keySigSf)));
  const keySigStartX = 56;
  const timeSigX = keySigStartX + keySigCount * 8.5 + (keySigCount > 0 ? 6 : 0);
  const stickyWidth = Math.round(timeSigX + 32);
  const leftMargin = stickyWidth + 16;

  const totalBeats = useMemo(() => {
    let maxEnd = score.totalBeats || 0;
    for (let i = 0; i < events.length; i += 1) {
      const end = events[i].onset + events[i].duration;
      if (end > maxEnd) maxEnd = end;
    }
    return Math.max(16, maxEnd);
  }, [score.totalBeats, events]);

  const svgWidth = Math.max(760, Math.ceil(leftMargin + totalBeats * beatPx + 72));

  const [visibleWindow, setVisibleWindow] = useState<{
    startBeat: number;
    endBeat: number;
    viewBeat: number;
  }>(() => quantizeWindow(0, 960, leftMargin, stickyWidth, totalBeats, beatPx));

  const syncVisibleWindow = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const next = quantizeWindow(
      el.scrollLeft,
      el.clientWidth,
      leftMargin,
      stickyWidth,
      totalBeats,
      beatPx,
    );
    setVisibleWindow((prev) =>
      prev.startBeat === next.startBeat &&
      prev.endBeat === next.endBeat &&
      Math.abs(prev.viewBeat - next.viewBeat) < 0.25
        ? prev
        : next,
    );
  }, [leftMargin, stickyWidth, totalBeats, beatPx]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    syncVisibleWindow();
    const observer = new ResizeObserver(syncVisibleWindow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncVisibleWindow]);

  const handleScroll = useCallback(() => {
    if (scrollRafPendingRef.current) return;
    scrollRafPendingRef.current = requestAnimationFrame(() => {
      scrollRafPendingRef.current = 0;
      syncVisibleWindow();
    });
  }, [syncVisibleWindow]);

  useEffect(() => {
    return () => {
      if (scrollRafPendingRef.current) {
        cancelAnimationFrame(scrollRafPendingRef.current);
      }
    };
  }, []);

  const pauseAutoFollow = useCallback(() => {
    pauseAutoFollowUntilRef.current = performance.now() + MANUAL_SCROLL_PAUSE_MS;
  }, []);

  const getLiveBeatRef = useRef(getLiveBeat);
  getLiveBeatRef.current = getLiveBeat;
  const leftMarginRef = useRef(leftMargin);
  leftMarginRef.current = leftMargin;
  const stickyWidthRef = useRef(stickyWidth);
  stickyWidthRef.current = stickyWidth;
  const beatPxRef = useRef(beatPx);
  beatPxRef.current = beatPx;

  useEffect(() => {
    let rafId = 0;

    const tick = () => {
      const liveBeat = getLiveBeatRef.current();
      const px = leftMarginRef.current + liveBeat * beatPxRef.current;

      if (playheadBandRef.current) {
        playheadBandRef.current.setAttribute('x', String(px - 8));
      }
      if (playheadLineRef.current) {
        const s = String(px);
        playheadLineRef.current.setAttribute('x1', s);
        playheadLineRef.current.setAttribute('x2', s);
      }
      if (playheadCircleRef.current) {
        playheadCircleRef.current.setAttribute('cx', String(px));
      }

      const container = scrollContainerRef.current;
      if (container && performance.now() >= pauseAutoFollowUntilRef.current) {
        const sticky = stickyWidthRef.current;
        const viewportW = Math.max(120, container.clientWidth - sticky);
        const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
        const targetScroll = Math.max(
          0,
          Math.min(maxScroll, px - sticky - viewportW * 0.20),
        );
        const diff = targetScroll - container.scrollLeft;
        if (Math.abs(diff) <= 40) {
          container.scrollLeft = targetScroll;
        } else if (Math.abs(diff) <= viewportW * 0.85) {
          container.scrollLeft += diff * 0.22;
        } else {
          container.scrollLeft = targetScroll;
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const measureSpans = useMemo(
    () =>
      buildMeasureSpans(
        score.timeSignatures,
        score.timeSignature,
        score.totalMeasures,
        totalBeats,
      ),
    [score.timeSignatures, score.timeSignature, score.totalMeasures, totalBeats],
  );

  const activeTimeSig = useMemo(
    () =>
      resolveActiveTimeSig(
        score.timeSignatures,
        score.timeSignature,
        measureSpans,
        visibleWindow.startBeat,
        visibleWindow.viewBeat,
      ),
    [
      score.timeSignatures,
      score.timeSignature,
      measureSpans,
      visibleWindow.startBeat,
      visibleWindow.viewBeat,
    ],
  );

  const routedEvents = useMemo<RoutedNoteEvent[]>(
    () =>
      events.map((ev) => {
        const displayClef =
          ev.hand === 'R' ? (ev.pitch < 55 ? 'bass' : 'treble') : ev.pitch > 67 ? 'treble' : 'bass';
        return {
          ...ev,
          hand: displayClef === 'treble' ? 'R' : 'L',
          originalHand: ev.hand,
        };
      }),
    [events],
  );

  const staffGroups = useMemo<StaffNoteGroup[]>(
    () => groupStaffEvents(routedEvents) as StaffNoteGroup[],
    [routedEvents],
  );

  const beamingData = useMemo(() => {
    const prepared = staffGroups.map((g) => {
      const clef = g.hand === 'R' ? 'treble' : 'bass';
      return {
        hand: g.hand,
        onset: g.onset,
        notes: g.notes.map((ev) => ({
          id: ev.id,
          duration: ev.duration,
          stepOffset: getStaffYOffset(ev.pitch, clef, ev.preferFlats),
        })),
      };
    });

    const nextOnsets = new Array<number | null>(staffGroups.length).fill(null);
    let nextR: number | null = null;
    let nextL: number | null = null;
    for (let i = staffGroups.length - 1; i >= 0; i -= 1) {
      const g = staffGroups[i];
      if (g.hand === 'R') {
        nextOnsets[i] = nextR;
        nextR = g.onset;
      } else {
        nextOnsets[i] = nextL;
        nextL = g.onset;
      }
    }

    const runs = buildBeamGroups(prepared, measureSpans);
    const runByFirstNoteId = new Map<string, BeamRun>();
    for (let r = 0; r < runs.length; r += 1) {
      const run = runs[r];
      for (let m = 0; m < run.members.length; m += 1) {
        const firstId = run.members[m].noteIds[0];
        if (firstId) runByFirstNoteId.set(firstId, run);
      }
    }

    return { nextOnsets, runs, runByFirstNoteId };
  }, [staffGroups, measureSpans]);

  const { visibleGroups, visibleBeamRuns } = useMemo(() => {
    const beamRunsInWindow = beamingData.runs.filter((run) =>
      run.members.some(
        (m) => m.onset >= visibleWindow.startBeat && m.onset <= visibleWindow.endBeat,
      ),
    );
    const neededFromBeams = new Set<string>();
    for (let r = 0; r < beamRunsInWindow.length; r += 1) {
      const run = beamRunsInWindow[r];
      for (let m = 0; m < run.members.length; m += 1) {
        const firstId = run.members[m].noteIds[0];
        if (firstId) neededFromBeams.add(firstId);
      }
    }

    const groupsOut: Array<{ group: StaffNoteGroup; nextOnsetInHand: number | null }> = [];
    for (let i = 0; i < staffGroups.length; i += 1) {
      const g = staffGroups[i];
      const firstId = g.notes[0]?.id;
      const inWindow = g.onset >= visibleWindow.startBeat && g.onset <= visibleWindow.endBeat;
      if (!inWindow && (!firstId || !neededFromBeams.has(firstId))) {
        if (g.onset > visibleWindow.endBeat + 2) break;
        continue;
      }
      groupsOut.push({ group: g, nextOnsetInHand: beamingData.nextOnsets[i] });
    }

    return { visibleGroups: groupsOut, visibleBeamRuns: beamRunsInWindow };
  }, [staffGroups, beamingData, visibleWindow.startBeat, visibleWindow.endBeat]);

  const laidOutByFirstNoteId = useMemo(() => {
    const map = new Map<string, LaidOutGroupEntry>();
    for (let i = 0; i < visibleGroups.length; i += 1) {
      const { group, nextOnsetInHand } = visibleGroups[i];
      const firstId = group.notes[0]?.id;
      if (!firstId) continue;

      const clef = group.hand === 'R' ? 'treble' : 'bass';
      const baseBottomY = clef === 'treble' ? TREBLE_BOTTOM_Y : BASS_BOTTOM_Y;
      const prepared: PreparedNote[] = group.notes.map((ev) => ({
        ...ev,
        stepOffset: getStaffYOffset(ev.pitch, clef, ev.preferFlats),
      }));
      const beamRun = beamingData.runByFirstNoteId.get(firstId);
      const laidOut = layoutStaffGroup(prepared, beamRun?.stemUp) as {
        stemUp: boolean;
        stemX: number;
        notes: LaidOutNote[];
      };

      const baseX = leftMargin + group.onset * beatPx + 18;
      const drawn: DrawnNote[] = laidOut.notes.map((note) => ({
        ...note,
        cx: baseX + note.dx,
        cy: baseBottomY - note.stepOffset * STEP_PX,
      }));

      const topY = Math.min(...drawn.map((n) => n.cy));
      const bottomY = Math.max(...drawn.map((n) => n.cy));
      const stemX = baseX + laidOut.stemX;

      map.set(firstId, {
        group,
        groupKey: `${group.hand}-${group.onset}-${firstId}`,
        stemUp: laidOut.stemUp,
        stemX,
        drawn,
        topY,
        bottomY,
        stemDx: laidOut.stemX,
        nextOnsetInHand,
      });
    }
    return map;
  }, [visibleGroups, beamingData.runByFirstNoteId, leftMargin, beatPx]);

  const visibleMeasures = useMemo(
    () =>
      measureSpans.filter(
        (m) => m.endBeat >= visibleWindow.startBeat && m.startBeat <= visibleWindow.endBeat,
      ),
    [measureSpans, visibleWindow.startBeat, visibleWindow.endBeat],
  );

  const loopBounds = useMemo(() => {
    if (!loop.enabled) return null;
    const startSpan = measureSpans.find((m) => m.measure === loop.startMeasure);
    const endSpan = measureSpans.find((m) => m.measure === loop.endMeasure);
    const defaultBpb = Math.max(
      0.25,
      score.timeSignature[0] * (4 / Math.max(1, score.timeSignature[1])),
    );
    const startBeat = startSpan
      ? startSpan.startBeat
      : Math.max(0, (loop.startMeasure - 1) * defaultBpb);
    const endBeat = endSpan
      ? endSpan.endBeat
      : Math.max(startBeat + defaultBpb, loop.endMeasure * defaultBpb);
    return {
      x: leftMargin + startBeat * beatPx,
      width: Math.max(beatPx, (endBeat - startBeat) * beatPx),
    };
  }, [
    loop.enabled,
    loop.startMeasure,
    loop.endMeasure,
    measureSpans,
    score.timeSignature,
    leftMargin,
    beatPx,
  ]);

  const handleSvgClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if (dragPointerStartRef.current) {
        const dx = e.clientX - dragPointerStartRef.current.x;
        const dy = e.clientY - dragPointerStartRef.current.y;
        dragPointerStartRef.current = null;
        if (dx * dx + dy * dy > 25) return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const beat = Math.max(0, Math.min(totalBeats, (x - leftMargin) / beatPx));
      onSeekBeat(beat);
    },
    [leftMargin, totalBeats, beatPx, onSeekBeat],
  );

  const bgHex = paperMode ? '#faf7f0' : '#1c1917';
  const staffStroke = paperMode ? '#1c1917' : '#78716c';
  const staffOpacity = paperMode ? 0.3 : 0.6;
  const barlineStroke = paperMode ? '#1c1917' : '#78716c';
  const barlineOpacity = paperMode ? 0.42 : 0.78;
  const inkHex = paperMode ? '#1c1917' : '#e7e5e4';
  const ledgerStroke = paperMode ? '#1c1917' : '#a8a29e';
  const ledgerOpacity = paperMode ? 0.72 : 0.85;
  const measureLabelFill = paperMode ? '#57534e' : '#a8a29e';
  const rhHex = paperMode ? '#c2410c' : '#fb923c';
  const lhHex = paperMode ? '#0369a1' : '#38bdf8';

  const keySigSymbol = keySigSf >= 0 ? '♯' : '♭';
  const trebleKeySteps = keySigSf >= 0 ? TREBLE_SHARP_STEPS : TREBLE_FLAT_STEPS;
  const bassKeySteps = keySigSf >= 0 ? BASS_SHARP_STEPS : BASS_FLAT_STEPS;

  const initialBeat = getLiveBeat();
  const initialPlayheadX = leftMargin + initialBeat * beatPx;

  const adjustZoom = (delta: number) => {
    setZoom((prev) => {
      const next = Math.round((prev + delta) * 10) / 10;
      return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    });
  };

  return (
    <div
      className={[
        'w-full overflow-hidden rounded-2xl border shadow-inner transition-colors',
        paperMode
          ? 'border-stone-300/90 bg-[#faf7f0] text-stone-800'
          : 'border-stone-800 bg-[#1c1917] text-stone-200',
      ].join(' ')}
    >
      <div
        className={[
          'flex h-8 items-center justify-between gap-2 border-b px-3 text-[11px]',
          paperMode
            ? 'border-stone-300/75 bg-[#f3efe6] text-stone-700'
            : 'border-stone-800 bg-stone-900 text-stone-300',
        ].join(' ')}
      >
        <div className="min-w-0 truncate font-mono font-semibold">
          {score.keySignature} · {activeTimeSig[0]}/{activeTimeSig[1]}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowNoteNames((prev) => !prev)}
            className={[
              'rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold transition',
              showNoteNames
                ? 'border-amber-500/70 bg-amber-500/20 text-amber-600 dark:text-amber-300'
                : paperMode
                  ? 'border-stone-300 bg-white/70 text-stone-600 hover:bg-white'
                  : 'border-stone-700 bg-stone-800 text-stone-300 hover:bg-stone-700',
            ].join(' ')}
            title="Toggle note pitch labels"
          >
            ABC
          </button>

          <button
            type="button"
            onClick={() => setPaperMode((prev) => !prev)}
            className={[
              'rounded-md border px-2 py-0.5 text-[10px] font-semibold transition',
              paperMode
                ? 'border-stone-300 bg-white/80 text-stone-800 hover:bg-white'
                : 'border-stone-700 bg-stone-800 text-stone-200 hover:bg-stone-700',
            ].join(' ')}
            title="Toggle Paper / Dark staff theme"
          >
            {paperMode ? 'Paper' : 'Dark'}
          </button>

          <div
            className={[
              'inline-flex items-center rounded-md border',
              paperMode ? 'border-stone-300 bg-white/70' : 'border-stone-700 bg-stone-800',
            ].join(' ')}
          >
            <button
              type="button"
              onClick={() => adjustZoom(-ZOOM_STEP)}
              disabled={zoom <= MIN_ZOOM + 1e-4}
              aria-label="Zoom out notation"
              className="px-1.5 py-0.5 font-mono text-[11px] font-bold disabled:opacity-35"
            >
              -
            </button>
            <span className="px-1 font-mono text-[10px] tabular-nums">{zoom.toFixed(1)}x</span>
            <button
              type="button"
              onClick={() => adjustZoom(ZOOM_STEP)}
              disabled={zoom >= MAX_ZOOM - 1e-4}
              aria-label="Zoom in notation"
              className="px-1.5 py-0.5 font-mono text-[11px] font-bold disabled:opacity-35"
            >
              +
            </button>
          </div>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={pauseAutoFollow}
        onTouchStart={pauseAutoFollow}
        onPointerDown={(e) => {
          dragPointerStartRef.current = { x: e.clientX, y: e.clientY };
          pauseAutoFollow();
        }}
        style={{ scrollBehavior: 'auto' }}
        className="w-full overflow-x-auto overscroll-x-contain touch-pan-x"
      >
        <div className="relative" style={{ width: svgWidth, height: SVG_HEIGHT }}>
          <svg
            width={svgWidth}
            height={SVG_HEIGHT}
            onClick={handleSvgClick}
            className="block select-none cursor-pointer"
          >
            {loopBounds && (
              <g>
                <rect
                  x={loopBounds.x}
                  y={18}
                  width={loopBounds.width}
                  height={SVG_HEIGHT - 36}
                  rx={8}
                  fill={paperMode ? 'rgba(217, 119, 6, 0.09)' : 'rgba(217, 119, 6, 0.13)'}
                  stroke="#d97706"
                  strokeDasharray="4 4"
                />
                <path
                  d={`M ${loopBounds.x} 24 L ${loopBounds.x} 16 L ${loopBounds.x + loopBounds.width} 16 L ${loopBounds.x + loopBounds.width} 24`}
                  fill="none"
                  stroke="#d97706"
                  strokeWidth={2}
                />
              </g>
            )}

            {STAFF_LINE_INDICES.map((lineIdx) => (
              <g key={lineIdx}>
                <line
                  x1={stickyWidth - 8}
                  y1={TREBLE_BOTTOM_Y - lineIdx * 10}
                  x2={svgWidth - 20}
                  y2={TREBLE_BOTTOM_Y - lineIdx * 10}
                  stroke={staffStroke}
                  strokeOpacity={staffOpacity}
                  strokeWidth={1}
                />
                <line
                  x1={stickyWidth - 8}
                  y1={BASS_BOTTOM_Y - lineIdx * 10}
                  x2={svgWidth - 20}
                  y2={BASS_BOTTOM_Y - lineIdx * 10}
                  stroke={staffStroke}
                  strokeOpacity={staffOpacity}
                  strokeWidth={1}
                />
              </g>
            ))}

            {visibleMeasures.map((m) => {
              const x = leftMargin + m.startBeat * beatPx;
              const isFinal = m.measure === measureSpans.length;
              return (
                <g key={m.measure}>
                  <line
                    x1={x}
                    y1={TREBLE_BOTTOM_Y - 40}
                    x2={x}
                    y2={BASS_BOTTOM_Y}
                    stroke={barlineStroke}
                    strokeOpacity={barlineOpacity}
                    strokeWidth={isFinal ? 2 : 1.1}
                  />
                  <text
                    x={x + 6}
                    y={30}
                    fill={measureLabelFill}
                    fontSize="10"
                    fontWeight="700"
                  >
                    Bar {m.measure}
                  </text>
                  {m.timeSignatureChange && (
                    <g>
                      <text
                        x={x + 6}
                        y={TREBLE_BOTTOM_Y - 24}
                        fill={inkHex}
                        fontSize="13"
                        fontWeight="bold"
                        fontFamily="Georgia, serif"
                      >
                        {m.timeSignatureChange[0]}
                      </text>
                      <text
                        x={x + 6}
                        y={TREBLE_BOTTOM_Y - 6}
                        fill={inkHex}
                        fontSize="13"
                        fontWeight="bold"
                        fontFamily="Georgia, serif"
                      >
                        {m.timeSignatureChange[1]}
                      </text>
                      <text
                        x={x + 6}
                        y={BASS_BOTTOM_Y - 24}
                        fill={inkHex}
                        fontSize="13"
                        fontWeight="bold"
                        fontFamily="Georgia, serif"
                      >
                        {m.timeSignatureChange[0]}
                      </text>
                      <text
                        x={x + 6}
                        y={BASS_BOTTOM_Y - 6}
                        fill={inkHex}
                        fontSize="13"
                        fontWeight="bold"
                        fontFamily="Georgia, serif"
                      >
                        {m.timeSignatureChange[1]}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {measureSpans.length > 0 &&
              measureSpans[measureSpans.length - 1].endBeat >= visibleWindow.startBeat &&
              measureSpans[measureSpans.length - 1].endBeat <= visibleWindow.endBeat && (
                <line
                  x1={leftMargin + measureSpans[measureSpans.length - 1].endBeat * beatPx}
                  y1={TREBLE_BOTTOM_Y - 40}
                  x2={leftMargin + measureSpans[measureSpans.length - 1].endBeat * beatPx}
                  y2={BASS_BOTTOM_Y}
                  stroke={barlineStroke}
                  strokeOpacity={barlineOpacity}
                  strokeWidth={2.5}
                />
              )}

            {visibleBeamRuns.map((run) => {
              const memberEntries = run.members
                .map((member) => {
                  const firstId = member.noteIds[0];
                  const laid = firstId ? laidOutByFirstNoteId.get(firstId) : undefined;
                  return laid ? { member, laid } : null;
                })
                .filter((x): x is NonNullable<typeof x> => x !== null);

              if (memberEntries.length < 2) return null;

              const baseBottomY = run.hand === 'R' ? TREBLE_BOTTOM_Y : BASS_BOTTOM_Y;
              const beamLine = computeBeamLine(
                memberEntries.map(({ member, laid }) => ({
                  onset: member.onset,
                  minStepOffset: member.minStepOffset,
                  maxStepOffset: member.maxStepOffset,
                  stemDx: laid.stemDx,
                })),
                run.stemUp,
                beatPx,
                leftMargin,
                baseBottomY,
                STEP_PX,
                STEM_LEN,
              );

              const firstStemX = memberEntries[0].laid.stemX;
              const lastStemX = memberEntries[memberEntries.length - 1].laid.stemX;
              const inwardOffset = run.stemUp ? 4.8 : -4.8;

              const secondarySegments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
              let idx = 0;
              while (idx < memberEntries.length) {
                if (memberEntries[idx].member.flagCount !== 2) {
                  idx += 1;
                  continue;
                }
                let endIdx = idx;
                while (
                  endIdx + 1 < memberEntries.length &&
                  memberEntries[endIdx + 1].member.flagCount === 2
                ) {
                  endIdx += 1;
                }
                if (endIdx > idx) {
                  const x1 = memberEntries[idx].laid.stemX - 0.65;
                  const x2 = memberEntries[endIdx].laid.stemX + 0.65;
                  secondarySegments.push({
                    x1,
                    y1: beamLine.stemYForMember(x1) + inwardOffset,
                    x2,
                    y2: beamLine.stemYForMember(x2) + inwardOffset,
                  });
                } else {
                  const cx = memberEntries[idx].laid.stemX;
                  const pointRight = idx === 0;
                  const sx1 = pointRight ? cx : cx - 7;
                  const sx2 = pointRight ? cx + 7 : cx;
                  secondarySegments.push({
                    x1: sx1,
                    y1: beamLine.stemYForMember(sx1) + inwardOffset,
                    x2: sx2,
                    y2: beamLine.stemYForMember(sx2) + inwardOffset,
                  });
                }
                idx = endIdx + 1;
              }

              const runKey = `${run.hand}-${run.measure}-${run.beatGroup}-${memberEntries[0].laid.groupKey}`;

              return (
                <g key={runKey} className="pointer-events-none">
                  {memberEntries.map(({ laid }) => {
                    const beamY = beamLine.stemYForMember(laid.stemX);
                    const anchorY = run.stemUp ? laid.bottomY : laid.topY;
                    return (
                      <line
                        key={laid.groupKey}
                        x1={laid.stemX}
                        y1={anchorY}
                        x2={laid.stemX}
                        y2={beamY}
                        stroke={inkHex}
                        strokeWidth={1.35}
                      />
                    );
                  })}

                  <line
                    x1={firstStemX - 0.65}
                    y1={beamLine.stemYForMember(firstStemX - 0.65)}
                    x2={lastStemX + 0.65}
                    y2={beamLine.stemYForMember(lastStemX + 0.65)}
                    stroke={inkHex}
                    strokeWidth={3.2}
                    strokeLinecap="butt"
                  />

                  {secondarySegments.map((seg, sIdx) => (
                    <line
                      key={sIdx}
                      x1={seg.x1}
                      y1={seg.y1}
                      x2={seg.x2}
                      y2={seg.y2}
                      stroke={inkHex}
                      strokeWidth={2.4}
                      strokeLinecap="butt"
                    />
                  ))}
                </g>
              );
            })}

            {visibleGroups.map(({ group }) => {
              const firstId = group.notes[0]?.id;
              const laid = firstId ? laidOutByFirstNoteId.get(firstId) : undefined;
              if (!laid) return null;

              const baseBottomY = group.hand === 'R' ? TREBLE_BOTTOM_Y : BASS_BOTTOM_Y;
              const isBeamed = beamingData.runByFirstNoteId.has(firstId);
              const showStem = laid.drawn.some((n) => n.duration < 3.75);
              const minDuration = Math.min(...laid.drawn.map((n) => n.duration));
              const displayDuration = effectiveDisplayDuration(
                group.onset,
                minDuration,
                laid.nextOnsetInHand,
              );
              const flagCount = flagCountForDuration(displayDuration);
              const stemTopY = laid.stemUp ? laid.topY - STEM_LEN : laid.topY;
              const stemBottomY = laid.stemUp ? laid.bottomY : laid.bottomY + STEM_LEN;

              return (
                <g key={laid.groupKey}>
                  {!isBeamed && showStem && (
                    <line
                      x1={laid.stemX}
                      y1={stemTopY}
                      x2={laid.stemX}
                      y2={stemBottomY}
                      stroke={inkHex}
                      strokeWidth={1.35}
                    />
                  )}

                  {!isBeamed &&
                    showStem &&
                    flagCount > 0 &&
                    Array.from({ length: flagCount }).map((_, fIdx) => {
                      if (laid.stemUp) {
                        const fy = stemTopY + fIdx * 4.5;
                        return (
                          <path
                            key={fIdx}
                            d={`M ${laid.stemX} ${fy} C ${laid.stemX + 5} ${fy + 3}, ${laid.stemX + 6} ${fy + 7}, ${laid.stemX + 3.5} ${fy + 11}`}
                            fill="none"
                            stroke={inkHex}
                            strokeWidth={1.5}
                            strokeLinecap="round"
                          />
                        );
                      }
                      const fy = stemBottomY - fIdx * 4.5;
                      return (
                        <path
                          key={fIdx}
                          d={`M ${laid.stemX} ${fy} C ${laid.stemX + 5} ${fy - 3}, ${laid.stemX + 6} ${fy - 7}, ${laid.stemX + 3.5} ${fy - 11}`}
                          fill="none"
                          stroke={inkHex}
                          strokeWidth={1.5}
                          strokeLinecap="round"
                        />
                      );
                    })}

                  {laid.drawn.map((ev, noteIdx) => {
                    const grade = grades[ev.id];
                    const isHollow = ev.duration >= 1.75;
                    const dotted = isDottedDuration(ev.duration);
                    const ledgerSteps = ledgerStepsForOffset(ev.stepOffset);
                    const accidentalX = ev.cx - 12 - ev.accidentalLane * 8;

                    let noteColor = ev.originalHand === 'R' ? rhHex : lhHex;
                    if (grade?.status === 'hit') noteColor = '#059669';
                    if (grade?.status === 'miss') noteColor = '#be123c';

                    const dotY = Math.abs(ev.stepOffset) % 2 === 0 ? ev.cy - 2.5 : ev.cy;
                    const pitchLabel = `${ev.step}${ev.alter > 0 ? '#' : ev.alter < 0 ? 'b' : ''}`;
                    const labelOpposite =
                      laid.drawn.length === 1 ||
                      (laid.stemUp ? noteIdx === 0 : noteIdx === laid.drawn.length - 1);
                    const labelX = labelOpposite
                      ? ev.cx
                      : laid.stemUp
                        ? ev.cx + 13
                        : ev.cx - 13;
                    const labelY = labelOpposite
                      ? !showStem || laid.stemUp
                        ? ev.cy + 13
                        : ev.cy - 7.5
                      : ev.cy + 3;

                    return (
                      <g
                        key={ev.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSeekBeat(ev.onset);
                          onPreviewPitch?.(ev.pitch);
                        }}
                        className="cursor-pointer"
                      >
                        {ledgerSteps.map((step) => (
                          <line
                            key={step}
                            x1={ev.cx - 9.5}
                            y1={baseBottomY - step * STEP_PX}
                            x2={ev.cx + 9.5}
                            y2={baseBottomY - step * STEP_PX}
                            stroke={ledgerStroke}
                            strokeOpacity={ledgerOpacity}
                            strokeWidth={1.25}
                          />
                        ))}

                        {ev.alter !== 0 && (
                          <text
                            x={accidentalX}
                            y={ev.cy + 4}
                            fill={noteColor}
                            fontSize="12.5"
                            fontWeight="700"
                            fontFamily="Georgia, serif"
                          >
                            {ev.alter > 0 ? '♯' : '♭'}
                          </text>
                        )}

                        <ellipse
                          cx={ev.cx}
                          cy={ev.cy}
                          rx={5.4}
                          ry={3.9}
                          transform={`rotate(-18 ${ev.cx} ${ev.cy})`}
                          fill={isHollow ? bgHex : noteColor}
                          stroke={noteColor}
                          strokeWidth={isHollow ? 1.75 : 1}
                        />

                        {dotted && (
                          <circle cx={ev.cx + 9} cy={dotY} r={1.9} fill={noteColor} />
                        )}

                        {showNoteNames && (
                          <text
                            x={labelX}
                            y={labelY}
                            fill={noteColor}
                            fontSize="8.5"
                            fontWeight="700"
                            textAnchor="middle"
                            className="pointer-events-none select-none"
                          >
                            {pitchLabel}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            <g className="pointer-events-none">
              <rect
                ref={playheadBandRef}
                x={initialPlayheadX - 8}
                y={18}
                width={16}
                height={SVG_HEIGHT - 36}
                rx={4}
                fill="rgba(16, 185, 129, 0.08)"
              />
              <line
                ref={playheadLineRef}
                x1={initialPlayheadX}
                y1={20}
                x2={initialPlayheadX}
                y2={SVG_HEIGHT - 18}
                stroke="#059669"
                strokeWidth={2.5}
              />
              <circle ref={playheadCircleRef} cx={initialPlayheadX} cy={20} r={4.5} fill="#059669" />
            </g>
          </svg>

          <div
            style={{
              position: 'sticky',
              left: 0,
              width: stickyWidth,
              height: SVG_HEIGHT,
              marginTop: -SVG_HEIGHT,
            }}
            className="pointer-events-none z-10"
          >
            <svg width={stickyWidth} height={SVG_HEIGHT} className="block">
              <defs>
                <linearGradient id={fadeGradId} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor={bgHex} stopOpacity="1" />
                  <stop offset="86%" stopColor={bgHex} stopOpacity="1" />
                  <stop offset="100%" stopColor={bgHex} stopOpacity="0" />
                </linearGradient>
              </defs>

              <rect x={0} y={0} width={stickyWidth} height={SVG_HEIGHT} fill={`url(#${fadeGradId})`} />

              {STAFF_LINE_INDICES.map((lineIdx) => (
                <g key={lineIdx}>
                  <line
                    x1={16}
                    y1={TREBLE_BOTTOM_Y - lineIdx * 10}
                    x2={stickyWidth - 10}
                    y2={TREBLE_BOTTOM_Y - lineIdx * 10}
                    stroke={staffStroke}
                    strokeOpacity={staffOpacity}
                    strokeWidth={1}
                  />
                  <line
                    x1={16}
                    y1={BASS_BOTTOM_Y - lineIdx * 10}
                    x2={stickyWidth - 10}
                    y2={BASS_BOTTOM_Y - lineIdx * 10}
                    stroke={staffStroke}
                    strokeOpacity={staffOpacity}
                    strokeWidth={1}
                  />
                </g>
              ))}

              <line
                x1={16}
                y1={TREBLE_BOTTOM_Y - 40}
                x2={16}
                y2={BASS_BOTTOM_Y}
                stroke={inkHex}
                strokeWidth={2.5}
              />
              <text x={22} y={TREBLE_BOTTOM_Y - 8} fill={inkHex} fontSize="34" fontFamily="Georgia, serif">
                𝄞
              </text>
              <text x={22} y={BASS_BOTTOM_Y - 12} fill={inkHex} fontSize="28" fontFamily="Georgia, serif">
                𝄢
              </text>

              {Array.from({ length: keySigCount }).map((_, idx) => {
                const x = keySigStartX + idx * 8.5;
                const trebleStep = trebleKeySteps[idx];
                const bassStep = bassKeySteps[idx];
                return (
                  <g key={idx}>
                    <text
                      x={x}
                      y={TREBLE_BOTTOM_Y - trebleStep * STEP_PX + 4}
                      fill={inkHex}
                      fontSize="13"
                      fontWeight="700"
                      fontFamily="Georgia, serif"
                    >
                      {keySigSymbol}
                    </text>
                    <text
                      x={x}
                      y={BASS_BOTTOM_Y - bassStep * STEP_PX + 4}
                      fill={inkHex}
                      fontSize="13"
                      fontWeight="700"
                      fontFamily="Georgia, serif"
                    >
                      {keySigSymbol}
                    </text>
                  </g>
                );
              })}

              <text
                x={timeSigX}
                y={TREBLE_BOTTOM_Y - 24}
                fill={inkHex}
                fontSize="15"
                fontWeight="bold"
                fontFamily="Georgia, serif"
              >
                {activeTimeSig[0]}
              </text>
              <text
                x={timeSigX}
                y={TREBLE_BOTTOM_Y - 6}
                fill={inkHex}
                fontSize="15"
                fontWeight="bold"
                fontFamily="Georgia, serif"
              >
                {activeTimeSig[1]}
              </text>
              <text
                x={timeSigX}
                y={BASS_BOTTOM_Y - 24}
                fill={inkHex}
                fontSize="15"
                fontWeight="bold"
                fontFamily="Georgia, serif"
              >
                {activeTimeSig[0]}
              </text>
              <text
                x={timeSigX}
                y={BASS_BOTTOM_Y - 6}
                fill={inkHex}
                fontSize="15"
                fontWeight="bold"
                fontFamily="Georgia, serif"
              >
                {activeTimeSig[1]}
              </text>
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

export default GrandStaff;
