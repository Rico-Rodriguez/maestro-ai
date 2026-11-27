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

interface StaffNoteGroup {
  hand: 'R' | 'L';
  onset: number;
  notes: NoteEvent[];
}

interface PreparedNote extends NoteEvent {
  stepOffset: number;
}

interface LaidOutNote extends PreparedNote {
  dx: number;
  accidentalLane: number;
}

const BEAT_PX = 56;
const SVG_HEIGHT = 240;
const TREBLE_BOTTOM_Y = 84;
const BASS_BOTTOM_Y = 180;
const STEP_PX = 5;
const STEM_LEN = 26;
const BUFFER_BEATS = 8;
const WINDOW_QUANT_BEATS = 2;
const MANUAL_SCROLL_PAUSE_MS = 2400;

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

function quantizeWindow(
  scrollLeft: number,
  viewportWidth: number,
  leftMargin: number,
  totalBeats: number,
): { startBeat: number; endBeat: number } {
  const rawStart = (scrollLeft - leftMargin) / BEAT_PX;
  const rawEnd = (scrollLeft + Math.max(320, viewportWidth) - leftMargin) / BEAT_PX;
  const startBeat = Math.max(
    0,
    Math.floor((rawStart - BUFFER_BEATS) / WINDOW_QUANT_BEATS) * WINDOW_QUANT_BEATS,
  );
  const endBeat = Math.min(
    totalBeats + BUFFER_BEATS,
    Math.ceil((rawEnd + BUFFER_BEATS) / WINDOW_QUANT_BEATS) * WINDOW_QUANT_BEATS,
  );
  return { startBeat, endBeat: Math.max(startBeat + 16, endBeat) };
}

export function GrandStaff({
  score,
  events,
  grades,
  loop,
  getLiveBeat,
  onSeekBeat,
  onPreviewPitch,
  darkMode,
}: GrandStaffProps) {
  const fadeGradId = useId();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const playheadLineRef = useRef<SVGLineElement | null>(null);
  const playheadCircleRef = useRef<SVGCircleElement | null>(null);
  const pauseAutoFollowUntilRef = useRef<number>(0);
  const dragPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const scrollRafPendingRef = useRef<number>(0);

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

  const svgWidth = Math.max(760, Math.ceil(leftMargin + totalBeats * BEAT_PX + 72));

  const [visibleWindow, setVisibleWindow] = useState<{ startBeat: number; endBeat: number }>(() =>
    quantizeWindow(0, 960, leftMargin, totalBeats),
  );

  const syncVisibleWindow = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const next = quantizeWindow(el.scrollLeft, el.clientWidth, leftMargin, totalBeats);
    setVisibleWindow((prev) =>
      prev.startBeat === next.startBeat && prev.endBeat === next.endBeat ? prev : next,
    );
  }, [leftMargin, totalBeats]);

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

  useEffect(() => {
    let rafId = 0;

    const tick = () => {
      const liveBeat = getLiveBeatRef.current();
      const px = leftMarginRef.current + liveBeat * BEAT_PX;

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
        const visibleLeft = container.scrollLeft + sticky + viewportW * 0.14;
        const visibleRight = container.scrollLeft + sticky + viewportW * 0.72;

        if (px < visibleLeft || px > visibleRight) {
          const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
          const targetScroll = Math.max(
            0,
            Math.min(maxScroll, px - sticky - viewportW * 0.28),
          );
          const diff = targetScroll - container.scrollLeft;
          if (Math.abs(diff) > viewportW * 0.65) {
            container.scrollLeft = targetScroll;
          } else if (Math.abs(diff) > 1.5) {
            container.scrollLeft += diff * 0.18;
          }
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

  const staffGroups = useMemo<StaffNoteGroup[]>(
    () => groupStaffEvents(events) as StaffNoteGroup[],
    [events],
  );

  const visibleGroups = useMemo(() => {
    const out: StaffNoteGroup[] = [];
    for (let i = 0; i < staffGroups.length; i += 1) {
      const g = staffGroups[i];
      if (g.onset > visibleWindow.endBeat) break;
      if (g.onset >= visibleWindow.startBeat) {
        out.push(g);
      }
    }
    return out;
  }, [staffGroups, visibleWindow.startBeat, visibleWindow.endBeat]);

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
    const startBeat = startSpan ? startSpan.startBeat : Math.max(0, (loop.startMeasure - 1) * defaultBpb);
    const endBeat = endSpan ? endSpan.endBeat : Math.max(startBeat + defaultBpb, loop.endMeasure * defaultBpb);
    return {
      x: leftMargin + startBeat * BEAT_PX,
      width: Math.max(BEAT_PX, (endBeat - startBeat) * BEAT_PX),
    };
  }, [loop.enabled, loop.startMeasure, loop.endMeasure, measureSpans, score.timeSignature, leftMargin]);

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
      const beat = Math.max(0, Math.min(totalBeats, (x - leftMargin) / BEAT_PX));
      onSeekBeat(beat);
    },
    [leftMargin, totalBeats, onSeekBeat],
  );

  const bgHex = darkMode ? '#1c1917' : '#fcfaf5';
  const staffStroke = darkMode ? '#57534e' : '#a8a29e';
  const barlineStroke = darkMode ? '#78716c' : '#a8a29e';
  const clefFill = darkMode ? '#e7e5e4' : '#1c1917';
  const ledgerStroke = darkMode ? '#a8a29e' : '#44403c';
  const measureLabelFill = darkMode ? '#a8a29e' : '#78716c';

  const keySigSymbol = keySigSf >= 0 ? '♯' : '♭';
  const trebleKeySteps = keySigSf >= 0 ? TREBLE_SHARP_STEPS : TREBLE_FLAT_STEPS;
  const bassKeySteps = keySigSf >= 0 ? BASS_SHARP_STEPS : BASS_FLAT_STEPS;

  const initialBeat = getLiveBeat();
  const initialPlayheadX = leftMargin + initialBeat * BEAT_PX;

  return (
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
      className={[
        'w-full overflow-x-auto overscroll-x-contain touch-pan-x rounded-2xl border shadow-inner transition-colors',
        darkMode ? 'bg-stone-900 border-stone-800' : 'bg-[#fcfaf5] border-stone-300/90',
      ].join(' ')}
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
                height={186}
                rx={8}
                fill={darkMode ? 'rgba(217, 119, 6, 0.13)' : 'rgba(217, 119, 6, 0.09)'}
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
                strokeWidth={1}
              />
              <line
                x1={stickyWidth - 8}
                y1={BASS_BOTTOM_Y - lineIdx * 10}
                x2={svgWidth - 20}
                y2={BASS_BOTTOM_Y - lineIdx * 10}
                stroke={staffStroke}
                strokeWidth={1}
              />
            </g>
          ))}

          {visibleMeasures.map((m) => {
            const x = leftMargin + m.startBeat * BEAT_PX;
            const isFinal = m.measure === measureSpans.length;
            return (
              <g key={m.measure}>
                <line
                  x1={x}
                  y1={TREBLE_BOTTOM_Y - 40}
                  x2={x}
                  y2={BASS_BOTTOM_Y}
                  stroke={barlineStroke}
                  strokeWidth={isFinal ? 2 : 1.15}
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
                      y={60}
                      fill={clefFill}
                      fontSize="13"
                      fontWeight="bold"
                      fontFamily="Georgia, serif"
                    >
                      {m.timeSignatureChange[0]}
                    </text>
                    <text
                      x={x + 6}
                      y={78}
                      fill={clefFill}
                      fontSize="13"
                      fontWeight="bold"
                      fontFamily="Georgia, serif"
                    >
                      {m.timeSignatureChange[1]}
                    </text>
                    <text
                      x={x + 6}
                      y={156}
                      fill={clefFill}
                      fontSize="13"
                      fontWeight="bold"
                      fontFamily="Georgia, serif"
                    >
                      {m.timeSignatureChange[0]}
                    </text>
                    <text
                      x={x + 6}
                      y={174}
                      fill={clefFill}
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
                x1={leftMargin + measureSpans[measureSpans.length - 1].endBeat * BEAT_PX}
                y1={TREBLE_BOTTOM_Y - 40}
                x2={leftMargin + measureSpans[measureSpans.length - 1].endBeat * BEAT_PX}
                y2={BASS_BOTTOM_Y}
                stroke={barlineStroke}
                strokeWidth={2.5}
              />
            )}

          {visibleGroups.map((group) => {
            const clef = group.hand === 'R' ? 'treble' : 'bass';
            const baseBottomY = clef === 'treble' ? TREBLE_BOTTOM_Y : BASS_BOTTOM_Y;
            const prepared: PreparedNote[] = group.notes.map((ev) => ({
              ...ev,
              stepOffset: getStaffYOffset(ev.pitch, clef, ev.preferFlats),
            }));
            const laidOut = layoutStaffGroup(prepared) as {
              stemUp: boolean;
              stemX: number;
              notes: LaidOutNote[];
            };
            const baseX = leftMargin + group.onset * BEAT_PX + 18;
            const drawn = laidOut.notes.map((note) => ({
              ...note,
              cx: baseX + note.dx,
              cy: baseBottomY - note.stepOffset * STEP_PX,
            }));

            const showStem = drawn.some((n) => n.duration < 3.75);
            const minDuration = Math.min(...drawn.map((n) => n.duration));
            const flagCount = minDuration < 0.375 ? 2 : minDuration < 1 ? 1 : 0;
            const topY = Math.min(...drawn.map((n) => n.cy));
            const bottomY = Math.max(...drawn.map((n) => n.cy));
            const stemX = baseX + laidOut.stemX;
            const stemTopY = laidOut.stemUp ? topY - STEM_LEN : topY;
            const stemBottomY = laidOut.stemUp ? bottomY : bottomY + STEM_LEN;

            const repGrade = drawn[0] ? grades[drawn[0].id] : undefined;
            const stemColor =
              repGrade?.status === 'hit'
                ? '#059669'
                : repGrade?.status === 'miss'
                  ? '#be123c'
                  : group.hand === 'R'
                    ? darkMode
                      ? '#fb923c'
                      : '#c2410c'
                    : darkMode
                      ? '#38bdf8'
                      : '#0369a1';

            return (
              <g key={`${group.hand}-${group.onset}-${drawn[0]?.id ?? ''}`}>
                {showStem && (
                  <line
                    x1={stemX}
                    y1={stemTopY}
                    x2={stemX}
                    y2={stemBottomY}
                    stroke={stemColor}
                    strokeWidth={1.6}
                  />
                )}

                {showStem &&
                  flagCount > 0 &&
                  Array.from({ length: flagCount }).map((_, fIdx) => {
                    if (laidOut.stemUp) {
                      const fy = stemTopY + fIdx * 5.5;
                      return (
                        <path
                          key={fIdx}
                          d={`M ${stemX} ${fy} C ${stemX + 7} ${fy + 4}, ${stemX + 9} ${fy + 11}, ${stemX + 4} ${fy + 16}`}
                          fill="none"
                          stroke={stemColor}
                          strokeWidth={1.7}
                          strokeLinecap="round"
                        />
                      );
                    }
                    const fy = stemBottomY - fIdx * 5.5;
                    return (
                      <path
                        key={fIdx}
                        d={`M ${stemX} ${fy} C ${stemX + 7} ${fy - 4}, ${stemX + 9} ${fy - 11}, ${stemX + 4} ${fy - 16}`}
                        fill="none"
                        stroke={stemColor}
                        strokeWidth={1.7}
                        strokeLinecap="round"
                      />
                    );
                  })}

                {drawn.map((ev) => {
                  const grade = grades[ev.id];
                  const isHollow = ev.duration >= 1.75;
                  const dotted = isDottedDuration(ev.duration);
                  const ledgerSteps = ledgerStepsForOffset(ev.stepOffset);
                  const accidentalX = ev.cx - 13 - ev.accidentalLane * 8.5;

                  let noteColor =
                    ev.hand === 'R'
                      ? darkMode
                        ? '#fb923c'
                        : '#c2410c'
                      : darkMode
                        ? '#38bdf8'
                        : '#0369a1';
                  if (grade?.status === 'hit') noteColor = '#059669';
                  if (grade?.status === 'miss') noteColor = '#be123c';

                  const dotY = Math.abs(ev.stepOffset) % 2 === 0 ? ev.cy - 2.5 : ev.cy;

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
                          x1={ev.cx - 10}
                          y1={baseBottomY - step * STEP_PX}
                          x2={ev.cx + 10}
                          y2={baseBottomY - step * STEP_PX}
                          stroke={ledgerStroke}
                          strokeWidth={1.3}
                        />
                      ))}

                      {ev.alter !== 0 && (
                        <text
                          x={accidentalX}
                          y={ev.cy + 4}
                          fill={noteColor}
                          fontSize="13"
                          fontWeight="700"
                          fontFamily="Georgia, serif"
                        >
                          {ev.alter > 0 ? '♯' : '♭'}
                        </text>
                      )}

                      <ellipse
                        cx={ev.cx}
                        cy={ev.cy}
                        rx={5.8}
                        ry={4.1}
                        transform={`rotate(-18 ${ev.cx} ${ev.cy})`}
                        fill={isHollow ? bgHex : noteColor}
                        stroke={noteColor}
                        strokeWidth={isHollow ? 1.8 : 1}
                      />

                      {dotted && (
                        <circle cx={ev.cx + 9.5} cy={dotY} r={2} fill={noteColor} />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}

          <g className="pointer-events-none">
            <line
              ref={playheadLineRef}
              x1={initialPlayheadX}
              y1={20}
              x2={initialPlayheadX}
              y2={202}
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
                  strokeWidth={1}
                />
                <line
                  x1={16}
                  y1={BASS_BOTTOM_Y - lineIdx * 10}
                  x2={stickyWidth - 10}
                  y2={BASS_BOTTOM_Y - lineIdx * 10}
                  stroke={staffStroke}
                  strokeWidth={1}
                />
              </g>
            ))}

            <line
              x1={16}
              y1={TREBLE_BOTTOM_Y - 40}
              x2={16}
              y2={BASS_BOTTOM_Y}
              stroke={clefFill}
              strokeWidth={2.5}
            />
            <text x={22} y={76} fill={clefFill} fontSize="34" fontFamily="Georgia, serif">
              𝄞
            </text>
            <text x={22} y={168} fill={clefFill} fontSize="28" fontFamily="Georgia, serif">
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
                    fill={clefFill}
                    fontSize="13"
                    fontWeight="700"
                    fontFamily="Georgia, serif"
                  >
                    {keySigSymbol}
                  </text>
                  <text
                    x={x}
                    y={BASS_BOTTOM_Y - bassStep * STEP_PX + 4}
                    fill={clefFill}
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
              y={60}
              fill={clefFill}
              fontSize="15"
              fontWeight="bold"
              fontFamily="Georgia, serif"
            >
              {score.timeSignature[0]}
            </text>
            <text
              x={timeSigX}
              y={78}
              fill={clefFill}
              fontSize="15"
              fontWeight="bold"
              fontFamily="Georgia, serif"
            >
              {score.timeSignature[1]}
            </text>
            <text
              x={timeSigX}
              y={156}
              fill={clefFill}
              fontSize="15"
              fontWeight="bold"
              fontFamily="Georgia, serif"
            >
              {score.timeSignature[0]}
            </text>
            <text
              x={timeSigX}
              y={174}
              fill={clefFill}
              fontSize="15"
              fontWeight="bold"
              fontFamily="Georgia, serif"
            >
              {score.timeSignature[1]}
            </text>
          </svg>
        </div>
      </div>
    </div>
  );
}

export default GrandStaff;

