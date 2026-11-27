import { useEffect, useMemo, useRef } from 'react';
import type { NoteEvent, TimeSigPoint } from '../music/types';
import type { PracticeGrade } from '../practice/engine';
import type { PianoLayout } from './piano-geometry';

export interface FallingNotesCanvasProps {
  events: NoteEvent[];
  layout: PianoLayout;
  timeSignatures: TimeSigPoint[];
  defaultBeatsPerMeasure: number;
  grades: Record<string, PracticeGrade>;
  getLiveBeat: () => number;
  darkMode: boolean;
}

interface MeasureLine {
  measure: number;
  beat: number;
}

interface NotePalette {
  top: string;
  bottom: string;
  border: string;
  glow: string;
}

const LOOKAHEAD_BEATS = 5.5;
const STRIKE_OFFSET_PX = 8;

const PALETTE_R: NotePalette = {
  top: '#fbbf24',
  bottom: '#c2410c',
  border: 'rgba(254, 243, 199, 0.45)',
  glow: 'rgba(245, 158, 11, 0.72)',
};

const PALETTE_L: NotePalette = {
  top: '#7dd3fc',
  bottom: '#0369a1',
  border: 'rgba(224, 242, 254, 0.45)',
  glow: 'rgba(56, 189, 248, 0.72)',
};

const PALETTE_HIT: NotePalette = {
  top: '#34d399',
  bottom: '#047857',
  border: 'rgba(209, 250, 229, 0.55)',
  glow: 'rgba(16, 185, 129, 0.78)',
};

const PALETTE_MISS: NotePalette = {
  top: '#fb7185',
  bottom: '#be123c',
  border: 'rgba(255, 228, 230, 0.4)',
  glow: 'rgba(244, 63, 94, 0.7)',
};

function buildMeasureLines(
  timeSignatures: readonly TimeSigPoint[],
  defaultBeatsPerMeasure: number,
  maxBeat: number,
): { lines: MeasureLine[]; tailBpb: number } {
  const safeDefault = Math.max(0.25, defaultBeatsPerMeasure || 4);
  const sorted = [...timeSignatures].sort((a, b) => a.beat - b.beat);
  const lines: MeasureLine[] = [];
  let measure = 1;
  let cursorBeat = 0;

  if (sorted.length === 0) {
    while (cursorBeat <= maxBeat) {
      lines.push({ measure, beat: cursorBeat });
      measure += 1;
      cursorBeat += safeDefault;
    }
    return { lines, tailBpb: safeDefault };
  }

  if (sorted[0].beat > 1e-4) {
    const firstEnd = sorted[0].beat;
    while (cursorBeat < firstEnd - 1e-4 && cursorBeat <= maxBeat) {
      lines.push({ measure, beat: cursorBeat });
      measure += 1;
      cursorBeat += safeDefault;
    }
    cursorBeat = firstEnd;
  }

  let tailBpb = safeDefault;
  for (let i = 0; i < sorted.length; i += 1) {
    const ts = sorted[i];
    const bpb = Math.max(0.25, ts.numerator * (4 / Math.max(1, ts.denominator)));
    tailBpb = bpb;
    const segEnd = i + 1 < sorted.length ? sorted[i + 1].beat : maxBeat;
    let beat = Math.max(cursorBeat, ts.beat);
    while (beat <= segEnd + 1e-4 && beat <= maxBeat) {
      lines.push({ measure, beat });
      measure += 1;
      beat += bpb;
    }
    cursorBeat = beat;
  }

  return { lines, tailBpb };
}

function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function lowerBoundOnset(sortedEvents: readonly NoteEvent[], targetBeat: number): number {
  let lo = 0;
  let hi = sortedEvents.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedEvents[mid].onset < targetBeat) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function lowerBoundMeasure(lines: readonly MeasureLine[], targetBeat: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].beat < targetBeat) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function FallingNotesCanvas({
  events,
  layout,
  timeSignatures,
  defaultBeatsPerMeasure,
  grades,
  getLiveBeat,
  darkMode,
}: FallingNotesCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

  const indexedEvents = useMemo(() => {
    const sorted = [...events].sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
    let maxDuration = 4;
    let maxEndBeat = 32;
    for (let i = 0; i < sorted.length; i += 1) {
      const ev = sorted[i];
      if (ev.duration > maxDuration) maxDuration = ev.duration;
      const end = ev.onset + ev.duration;
      if (end > maxEndBeat) maxEndBeat = end;
    }
    return { sorted, maxDuration, maxEndBeat };
  }, [events]);

  const measureIndex = useMemo(
    () => buildMeasureLines(timeSignatures, defaultBeatsPerMeasure, indexedEvents.maxEndBeat + 32),
    [timeSignatures, defaultBeatsPerMeasure, indexedEvents.maxEndBeat],
  );

  const stateRef = useRef({
    indexedEvents,
    measureIndex,
    layout,
    grades,
    getLiveBeat,
    darkMode,
  });
  stateRef.current = {
    indexedEvents,
    measureIndex,
    layout,
    grades,
    getLiveBeat,
    darkMode,
  };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const updateSize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      sizeRef.current = { width, height, dpr };
      const targetW = Math.max(1, Math.round(width * dpr));
      const targetH = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    window.addEventListener('resize', updateSize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;

    const draw = () => {
      const { width, height, dpr } = sizeRef.current;
      if (width > 0 && height > 0) {
        const currentDpr = Math.max(1, window.devicePixelRatio || 1);
        if (currentDpr !== dpr) {
          sizeRef.current.dpr = currentDpr;
          canvas.width = Math.max(1, Math.round(width * currentDpr));
          canvas.height = Math.max(1, Math.round(height * currentDpr));
        }

        const activeDpr = sizeRef.current.dpr;
        ctx.setTransform(activeDpr, 0, 0, activeDpr, 0, 0);

        const {
          indexedEvents: evData,
          measureIndex: mData,
          layout: activeLayout,
          grades: activeGrades,
          getLiveBeat: readBeat,
          darkMode: isDark,
        } = stateRef.current;

        const liveBeat = readBeat();
        const strikeY = Math.max(24, height - STRIKE_OFFSET_PX);
        const pxPerBeat = Math.max(28, strikeY / LOOKAHEAD_BEATS);
        const tailBeats = STRIKE_OFFSET_PX / pxPerBeat + 0.5;
        const visibleMinBeat = liveBeat - tailBeats;
        const visibleMaxBeat = liveBeat + LOOKAHEAD_BEATS + 0.75;

        const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
        if (isDark) {
          bgGrad.addColorStop(0, '#070b14');
          bgGrad.addColorStop(1, '#0f172a');
        } else {
          bgGrad.addColorStop(0, '#f5f2eb');
          bgGrad.addColorStop(1, '#e7e2d7');
        }
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = isDark ? 'rgba(2, 6, 23, 0.42)' : 'rgba(28, 25, 23, 0.06)';
        for (let i = 0; i < activeLayout.blackKeys.length; i += 1) {
          const bk = activeLayout.blackKeys[i];
          ctx.fillRect(bk.x * width, 0, bk.width * width, strikeY);
        }

        ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.14)' : 'rgba(120, 113, 108, 0.18)';
        ctx.lineWidth = 1;
        for (let i = 0; i < activeLayout.whiteKeys.length; i += 1) {
          const wk = activeLayout.whiteKeys[i];
          if (!wk.isC) continue;
          const x = Math.round(wk.x * width) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, strikeY);
          ctx.stroke();
        }

        const startMeasureIdx = Math.max(0, lowerBoundMeasure(mData.lines, visibleMinBeat) - 1);
        ctx.font = '600 10px ui-sans-serif, system-ui, -apple-system, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';

        const drawMeasureLine = (measureNum: number, beat: number) => {
          const y = strikeY - (beat - liveBeat) * pxPerBeat;
          if (y < 0 || y > strikeY + 2) return;
          const crispY = Math.round(y) + 0.5;
          ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.18)' : 'rgba(120, 113, 108, 0.22)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, crispY);
          ctx.lineTo(width, crispY);
          ctx.stroke();

          ctx.fillStyle = isDark ? 'rgba(148, 163, 184, 0.6)' : 'rgba(87, 83, 78, 0.68)';
          ctx.fillText(`Bar ${measureNum}`, 8, crispY - 3);
        };

        for (let i = startMeasureIdx; i < mData.lines.length; i += 1) {
          const m = mData.lines[i];
          if (m.beat > visibleMaxBeat) break;
          drawMeasureLine(m.measure, m.beat);
        }

        const lastKnown = mData.lines[mData.lines.length - 1];
        if (lastKnown && visibleMaxBeat > lastKnown.beat) {
          let extraMeasure = lastKnown.measure + 1;
          let extraBeat = lastKnown.beat + mData.tailBpb;
          while (extraBeat <= visibleMaxBeat) {
            if (extraBeat >= visibleMinBeat) {
              drawMeasureLine(extraMeasure, extraBeat);
            }
            extraMeasure += 1;
            extraBeat += mData.tailBpb;
          }
        }

        const activeBursts: Array<{ x: number; w: number; palette: NotePalette }> = [];
        const startEventIdx = lowerBoundOnset(
          evData.sorted,
          visibleMinBeat - evData.maxDuration - 0.5,
        );

        ctx.font = '700 10px ui-sans-serif, system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        for (let i = startEventIdx; i < evData.sorted.length; i += 1) {
          const ev = evData.sorted[i];
          if (ev.onset > visibleMaxBeat) break;
          const noteEnd = ev.onset + ev.duration;
          if (noteEnd < visibleMinBeat) continue;

          const geom = activeLayout.byMidi.get(ev.pitch);
          if (!geom) continue;

          const colX = geom.x * width;
          const colW = geom.width * width;
          const inset = Math.min(1.5, colW * 0.08);
          const barX = colX + inset;
          const barW = Math.max(3, colW - inset * 2);

          const rawBottom = strikeY - (ev.onset - liveBeat) * pxPerBeat;
          const rawTop = strikeY - (noteEnd - liveBeat) * pxPerBeat;
          const clampedTop = Math.max(-4, rawTop);
          const clampedBottom = Math.min(height + 4, rawBottom);
          const barH = Math.max(6, clampedBottom - clampedTop);

          const grade = activeGrades[ev.id];
          let palette = ev.hand === 'R' ? PALETTE_R : PALETTE_L;
          if (grade?.status === 'hit') palette = PALETTE_HIT;
          else if (grade?.status === 'miss') palette = PALETTE_MISS;

          const isActive = ev.onset <= liveBeat && noteEnd >= liveBeat;
          if (isActive) {
            activeBursts.push({ x: colX, w: colW, palette });
          }

          const grad = ctx.createLinearGradient(0, clampedTop, 0, clampedTop + barH);
          grad.addColorStop(0, palette.top);
          grad.addColorStop(1, palette.bottom);

          ctx.save();
          if (isActive) {
            ctx.shadowColor = palette.glow;
            ctx.shadowBlur = 12;
          }
          traceRoundedRect(ctx, barX, clampedTop, barW, barH, 5);
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.restore();

          ctx.strokeStyle = palette.border;
          ctx.lineWidth = 1;
          traceRoundedRect(ctx, barX + 0.5, clampedTop + 0.5, Math.max(1, barW - 1), Math.max(1, barH - 1), 4.5);
          ctx.stroke();

          if (barW >= 20 && barH >= 18) {
            const labelY = Math.min(clampedBottom - 4, strikeY - 4);
            if (labelY - clampedTop >= 12) {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
              ctx.fillText(ev.pitchName, barX + barW / 2, labelY, barW - 4);
            }
          }
        }

        const strikeGlow = ctx.createLinearGradient(0, strikeY - 14, 0, height);
        strikeGlow.addColorStop(0, 'rgba(245, 158, 11, 0)');
        strikeGlow.addColorStop(0.7, isDark ? 'rgba(251, 191, 36, 0.16)' : 'rgba(217, 119, 6, 0.14)');
        strikeGlow.addColorStop(1, isDark ? 'rgba(251, 191, 36, 0.3)' : 'rgba(217, 119, 6, 0.22)');
        ctx.fillStyle = strikeGlow;
        ctx.fillRect(0, strikeY - 14, width, height - (strikeY - 14));

        ctx.strokeStyle = isDark ? 'rgba(251, 191, 36, 0.72)' : 'rgba(217, 119, 6, 0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, strikeY);
        ctx.lineTo(width, strikeY);
        ctx.stroke();

        for (let i = 0; i < activeBursts.length; i += 1) {
          const burst = activeBursts[i];
          const burstH = 44;
          const cx = burst.x + burst.w / 2;
          const rad = ctx.createRadialGradient(
            cx,
            strikeY,
            1,
            cx,
            strikeY - 10,
            Math.max(burst.w * 1.15, burstH),
          );
          rad.addColorStop(0, burst.palette.glow);
          rad.addColorStop(0.45, burst.palette.border);
          rad.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = rad;
          ctx.fillRect(
            burst.x - burst.w * 0.35,
            strikeY - burstH,
            burst.w * 1.7,
            burstH + STRIKE_OFFSET_PX,
          );

          ctx.fillStyle = '#ffffff';
          ctx.fillRect(burst.x + 1, strikeY - 1.5, Math.max(2, burst.w - 2), 3);
        }
      }

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden select-none">
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}

export default FallingNotesCanvas;

