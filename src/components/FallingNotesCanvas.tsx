import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteEvent, TimeSigPoint } from '../music/types';
import type { PracticeGrade } from '../practice/engine';
import {
  getKeyStickerColor,
  getKidNoteHint,
  getNotePalette,
  type ColorMode,
  type NotePalette,
} from './note-colors';
import type { PianoLayout } from './piano-geometry';

export interface FallingNotesCanvasProps {
  events: NoteEvent[];
  layout: PianoLayout;
  timeSignatures: TimeSigPoint[];
  defaultBeatsPerMeasure: number;
  grades: Record<string, PracticeGrade>;
  getLiveBeat: () => number;
  darkMode: boolean;
  colorMode?: ColorMode;
  onColorModeChange?: (mode: ColorMode) => void;
  flushBottom?: boolean;
  hideToolbar?: boolean;
  canShiftOctave?: boolean;
  octaveShift?: number;
  onOctaveShift?: (delta: number) => void;
  expectedPitches?: readonly number[];
  playfulMode?: boolean;
  lookaheadOverride?: number;
}

interface MeasureLine {
  measure: number;
  beat: number;
}

interface SparkleParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  decay: number;
  color: string;
  isStar: boolean;
}

interface DrawableBar {
  ev: NoteEvent;
  barX: number;
  barW: number;
  clampedTop: number;
  barH: number;
  palette: NotePalette;
  isActive: boolean;
}

const STRIKE_OFFSET_PX = 8;
const FLUSH_STRIKE_OFFSET_PX = 2;
const NOTE_TOP_GAP_PX = 2.5;
const ANTICIPATION_BEATS = 0.45;
const MAX_SPARKLE_PARTICLES = 64;
const OCTAVE_WATERMARKS = new Set(['C2', 'C3', 'C4', 'C5', 'C6']);
const TWILIGHT_STARS = [
  { rx: 0.08, ry: 0.12, r: 1.4, phase: 0.2 },
  { rx: 0.19, ry: 0.28, r: 1.1, phase: 1.1 },
  { rx: 0.31, ry: 0.09, r: 1.6, phase: 2.3 },
  { rx: 0.44, ry: 0.22, r: 1.2, phase: 0.7 },
  { rx: 0.57, ry: 0.14, r: 1.5, phase: 3.1 },
  { rx: 0.69, ry: 0.31, r: 1.1, phase: 1.8 },
  { rx: 0.81, ry: 0.11, r: 1.6, phase: 2.6 },
  { rx: 0.92, ry: 0.24, r: 1.3, phase: 0.5 },
  { rx: 0.14, ry: 0.48, r: 1.2, phase: 2.9 },
  { rx: 0.75, ry: 0.44, r: 1.3, phase: 1.4 },
] as const;

const SPEED_OPTIONS = [
  { id: 'slow', label: 'Slow', beats: 8 },
  { id: 'normal', label: 'Normal', beats: 6 },
  { id: 'fast', label: 'Fast', beats: 4.2 },
] as const;

const PALETTE_HIT: NotePalette = {
  top: '#34d399',
  bottom: '#047857',
  border: 'rgba(209, 250, 229, 0.55)',
  glow: 'rgba(16, 185, 129, 0.78)',
  stickerBg: '#10b981',
  stickerText: '#ffffff',
};

const PALETTE_MISS: NotePalette = {
  top: '#fb7185',
  bottom: '#be123c',
  border: 'rgba(255, 228, 230, 0.4)',
  glow: 'rgba(244, 63, 94, 0.7)',
  stickerBg: '#f43f5e',
  stickerText: '#ffffff',
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
    const hasNext = i + 1 < sorted.length;
    const segEnd = hasNext ? sorted[i + 1].beat : maxBeat;
    let beat = Math.max(cursorBeat, ts.beat);
    while ((hasNext ? beat < segEnd - 1e-4 : beat <= maxBeat) && beat <= maxBeat) {
      lines.push({ measure, beat });
      measure += 1;
      beat += bpb;
    }
    cursorBeat = hasNext ? segEnd : beat;
  }

  return { lines, tailBpb };
}

function drawSparkleStar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  const inner = r * 0.38;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + inner, y - inner);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x + inner, y + inner);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - inner, y + inner);
  ctx.lineTo(x - r, y);
  ctx.lineTo(x - inner, y - inner);
  ctx.closePath();
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
  colorMode = 'rainbow',
  onColorModeChange,
  flushBottom = false,
  hideToolbar = false,
  canShiftOctave = false,
  octaveShift = 0,
  onOctaveShift,
  expectedPitches = [],
  playfulMode = colorMode === 'rainbow',
  lookaheadOverride,
}: FallingNotesCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const [lookaheadBeats, setLookaheadBeats] = useState<number>(8);
  const [showLabels, setShowLabels] = useState<boolean>(true);
  const effectiveLookahead = lookaheadOverride ?? lookaheadBeats;

  const indexedEvents = useMemo(() => {
    const sorted = [...events].sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
    const nextOnsetByIndex = new Float64Array(sorted.length);
    const nextByPitch = new Map<number, number>();
    let maxDuration = 4;
    let maxEndBeat = 32;
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const ev = sorted[i];
      nextOnsetByIndex[i] = nextByPitch.get(ev.pitch) ?? Infinity;
      nextByPitch.set(ev.pitch, ev.onset);
      if (ev.duration > maxDuration) maxDuration = ev.duration;
      const end = ev.onset + ev.duration;
      if (end > maxEndBeat) maxEndBeat = end;
    }
    return { sorted, nextOnsetByIndex, maxDuration, maxEndBeat };
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
    lookaheadBeats: effectiveLookahead,
    showLabels,
    colorMode,
    flushBottom,
    hideToolbar,
    expectedPitches,
    playfulMode,
  });
  stateRef.current = {
    indexedEvents,
    measureIndex,
    layout,
    grades,
    getLiveBeat,
    darkMode,
    lookaheadBeats: effectiveLookahead,
    showLabels,
    colorMode,
    flushBottom,
    hideToolbar,
    expectedPitches,
    playfulMode,
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
    const particles: SparkleParticle[] = [];
    let prevActiveIds = new Set<string>();
    const celebratedHitIds = new Set<string>();
    let prevSortedRef = stateRef.current.indexedEvents.sorted;
    let prevLiveBeat = 0;
    let lastFrameMs = performance.now();

    const spawnParticles = (x: number, y: number, w: number, palette: NotePalette, count: number) => {
      for (let k = 0; k < count; k += 1) {
        if (particles.length >= MAX_SPARKLE_PARTICLES) {
          particles.shift();
        }
        particles.push({
          x: x + w * (0.2 + Math.random() * 0.6),
          y: y - Math.random() * 3,
          vx: (Math.random() - 0.5) * 58,
          vy: -(42 + Math.random() * 68),
          size: 2.5 + Math.random() * 3.5,
          alpha: 0.95,
          decay: 1.5 + Math.random() * 0.9,
          color: k % 3 === 0 ? '#ffffff' : palette.top,
          isStar: Math.random() < 0.6,
        });
      }
    };

    const draw = (nowMs: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
      lastFrameMs = nowMs;

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
          lookaheadBeats: activeLookahead,
          showLabels: activeShowLabels,
          colorMode: activeColorMode,
          flushBottom: isFlushBottom,
          hideToolbar: isHideToolbar,
          expectedPitches: activeExpectedPitches,
          playfulMode: isPlayful,
        } = stateRef.current;

        const suppressChrome = isPlayful && isHideToolbar;

        const liveBeat = readBeat();
        if (evData.sorted !== prevSortedRef || liveBeat < prevLiveBeat - 0.5) {
          prevSortedRef = evData.sorted;
          prevActiveIds.clear();
          celebratedHitIds.clear();
        }
        prevLiveBeat = liveBeat;

        const strikeOffset = isFlushBottom ? FLUSH_STRIKE_OFFSET_PX : STRIKE_OFFSET_PX;
        const strikeY = Math.max(24, height - strikeOffset);
        const pxPerBeat = Math.max(8, strikeY / activeLookahead);
        const tailBeats = strikeOffset / pxPerBeat + 0.5;
        const visibleMinBeat = liveBeat - tailBeats;
        const visibleMaxBeat = liveBeat + activeLookahead + 0.75;

        const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
        if (isDark) {
          bgGrad.addColorStop(0, '#141936');
          bgGrad.addColorStop(1, '#1d244c');
        } else {
          bgGrad.addColorStop(0, '#e8f6ff');
          bgGrad.addColorStop(0.55, '#f8fcff');
          bgGrad.addColorStop(1, '#fffdf6');
        }
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);

        if (isDark) {
          for (let i = 0; i < TWILIGHT_STARS.length; i += 1) {
            const star = TWILIGHT_STARS[i];
            const twinkle = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(nowMs * 0.002 + star.phase));
            ctx.fillStyle = `rgba(254, 243, 199, ${twinkle.toFixed(2)})`;
            drawSparkleStar(ctx, star.rx * width, star.ry * strikeY, star.r * 1.8);
            ctx.fill();
          }
        } else {
          for (let i = 0; i < activeLayout.whiteKeys.length; i += 1) {
            const wk = activeLayout.whiteKeys[i];
            const hint = getKidNoteHint(wk.midi);
            ctx.fillStyle = hint.laneTint;
            ctx.fillRect(wk.x * width, 0, wk.width * width, strikeY);
          }
        }

        ctx.fillStyle = isDark ? 'rgba(10, 14, 34, 0.38)' : 'rgba(148, 163, 184, 0.07)';
        for (let i = 0; i < activeLayout.blackKeys.length; i += 1) {
          const bk = activeLayout.blackKeys[i];
          ctx.fillRect(bk.x * width, 0, bk.width * width, strikeY);
        }

        ctx.lineWidth = 1;
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        for (let i = 0; i < activeLayout.whiteKeys.length; i += 1) {
          const wk = activeLayout.whiteKeys[i];
          const pc = ((wk.midi % 12) + 12) % 12;
          const x = Math.round(wk.x * width) + 0.5;
          if (!isDark) {
            ctx.strokeStyle =
              pc === 0 ? 'rgba(148, 163, 184, 0.24)' : 'rgba(148, 163, 184, 0.12)';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, strikeY);
            ctx.stroke();
          } else if (pc === 0 || pc === 5) {
            ctx.strokeStyle =
              pc === 0 ? 'rgba(148, 163, 184, 0.22)' : 'rgba(148, 163, 184, 0.09)';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, strikeY);
            ctx.stroke();
          }

          if (!suppressChrome && wk.isC && OCTAVE_WATERMARKS.has(wk.label)) {
            ctx.fillStyle = isDark ? 'rgba(148, 163, 184, 0.34)' : 'rgba(100, 116, 139, 0.42)';
            ctx.fillText(wk.label, x + 3.5, 6);
          }
        }

        const startMeasureIdx = Math.max(0, lowerBoundMeasure(mData.lines, visibleMinBeat) - 1);
        ctx.font = '600 10px ui-sans-serif, system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'left';

        const drawMeasureWithSubBeats = (measureNum: number, beat: number, nextBeat: number) => {
          ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.08)' : 'rgba(148, 163, 184, 0.1)';
          ctx.lineWidth = 1;
          for (let subBeat = beat + 1; subBeat < nextBeat - 0.05; subBeat += 1) {
            if (subBeat < visibleMinBeat || subBeat > visibleMaxBeat) continue;
            const subY = strikeY - (subBeat - liveBeat) * pxPerBeat;
            if (subY < 0 || subY > strikeY + 1) continue;
            const crispSubY = Math.round(subY) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, crispSubY);
            ctx.lineTo(width, crispSubY);
            ctx.stroke();
          }

          const y = strikeY - (beat - liveBeat) * pxPerBeat;
          if (y < 0 || y > strikeY + 2) return;
          const crispY = Math.round(y) + 0.5;
          ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.2)' : 'rgba(148, 163, 184, 0.22)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, crispY);
          ctx.lineTo(width, crispY);
          ctx.stroke();

          if (!suppressChrome) {
            const barLabel = `Bar ${measureNum}`;
            const textW = ctx.measureText(barLabel).width;
            const pillX = 6;
            const pillW = textW + 10;
            const pillH = 15;
            const pillY = crispY - pillH - 2;
            if (pillY >= 0) {
              traceRoundedRect(ctx, pillX, pillY, pillW, pillH, 4);
              ctx.fillStyle = isDark ? 'rgba(15, 23, 42, 0.84)' : 'rgba(28, 25, 23, 0.72)';
              ctx.fill();
              ctx.fillStyle = isDark ? 'rgba(226, 232, 240, 0.9)' : 'rgba(250, 247, 240, 0.96)';
              ctx.textBaseline = 'middle';
              ctx.fillText(barLabel, pillX + 5, pillY + pillH / 2);
            }
          }
        };

        for (let i = startMeasureIdx; i < mData.lines.length; i += 1) {
          const m = mData.lines[i];
          if (m.beat > visibleMaxBeat) break;
          const nextBeat =
            i + 1 < mData.lines.length ? mData.lines[i + 1].beat : m.beat + mData.tailBpb;
          drawMeasureWithSubBeats(m.measure, m.beat, nextBeat);
        }

        const lastKnown = mData.lines[mData.lines.length - 1];
        if (lastKnown && visibleMaxBeat > lastKnown.beat) {
          let extraMeasure = lastKnown.measure + 1;
          let extraBeat = lastKnown.beat + mData.tailBpb;
          while (extraBeat <= visibleMaxBeat) {
            const nextExtra = extraBeat + mData.tailBpb;
            if (nextExtra >= visibleMinBeat) {
              drawMeasureWithSubBeats(extraMeasure, extraBeat, nextExtra);
            }
            extraMeasure += 1;
            extraBeat = nextExtra;
          }
        }

        const resolvePalette = (
          pitch: number,
          hand: NoteEvent['hand'],
          grade?: PracticeGrade,
        ): NotePalette => {
          if (activeColorMode === 'hands') {
            if (grade?.status === 'hit') return PALETTE_HIT;
            if (grade?.status === 'miss') return PALETTE_MISS;
          }
          return getNotePalette(pitch, hand, activeColorMode);
        };

        if (activeExpectedPitches.length > 0) {
          const seenExpected = new Set<number>();
          for (let i = 0; i < activeExpectedPitches.length; i += 1) {
            const pitch = activeExpectedPitches[i];
            if (seenExpected.has(pitch)) continue;
            seenExpected.add(pitch);
            const geom = activeLayout.byMidi.get(pitch);
            if (!geom) continue;

            const palette = resolvePalette(pitch, 'R');
            const colX = geom.x * width;
            const colW = geom.width * width;
            const beamGrad = ctx.createLinearGradient(0, 0, 0, strikeY);
            beamGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
            beamGrad.addColorStop(0.55, 'rgba(255, 255, 255, 0.04)');
            beamGrad.addColorStop(1, palette.glow);

            ctx.save();
            ctx.globalAlpha = isDark ? 0.24 : 0.2;
            ctx.fillStyle = beamGrad;
            ctx.fillRect(colX, 0, colW, strikeY);
            ctx.restore();
          }
        }

        const spotlightStartIdx = lowerBoundOnset(evData.sorted, liveBeat);
        for (let i = spotlightStartIdx; i < evData.sorted.length; i += 1) {
          const ev = evData.sorted[i];
          if (ev.onset > liveBeat + ANTICIPATION_BEATS) break;
          if (ev.onset <= liveBeat) continue;
          const geom = activeLayout.byMidi.get(ev.pitch);
          if (!geom) continue;

          const palette = resolvePalette(ev.pitch, ev.hand, activeGrades[ev.id]);
          const colX = geom.x * width;
          const colW = geom.width * width;
          const barBottom = Math.min(strikeY, strikeY - (ev.onset - liveBeat) * pxPerBeat);
          if (strikeY > barBottom) {
            const proximity = 1 - (ev.onset - liveBeat) / ANTICIPATION_BEATS;
            const laneGrad = ctx.createLinearGradient(0, barBottom, 0, strikeY);
            laneGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
            laneGrad.addColorStop(1, palette.glow);
            ctx.save();
            ctx.globalAlpha = 0.14 + proximity * 0.28;
            ctx.fillStyle = laneGrad;
            ctx.fillRect(colX, barBottom, colW, strikeY - barBottom);
            ctx.restore();
          }
        }

        const whiteBars: DrawableBar[] = [];
        const blackBars: DrawableBar[] = [];
        const activeBursts: Array<{ x: number; w: number; palette: NotePalette }> = [];
        const currentActiveIds = new Set<string>();
        let offLeftPitch: number | null = null;
        let offRightPitch: number | null = null;
        let offLeftDist = Infinity;
        let offRightDist = Infinity;
        const startEventIdx = lowerBoundOnset(
          evData.sorted,
          visibleMinBeat - evData.maxDuration - 0.5,
        );

        for (let i = startEventIdx; i < evData.sorted.length; i += 1) {
          const ev = evData.sorted[i];
          if (ev.onset > visibleMaxBeat) break;
          const noteEnd = ev.onset + ev.duration;
          if (noteEnd < visibleMinBeat) continue;

          if (ev.pitch < activeLayout.minMidi) {
            const dist = ev.onset <= liveBeat && noteEnd >= liveBeat ? 0 : Math.abs(ev.onset - liveBeat);
            if (offLeftPitch === null || dist < offLeftDist) {
              offLeftPitch = ev.pitch;
              offLeftDist = dist;
            }
          } else if (ev.pitch > activeLayout.maxMidi) {
            const dist = ev.onset <= liveBeat && noteEnd >= liveBeat ? 0 : Math.abs(ev.onset - liveBeat);
            if (offRightPitch === null || dist < offRightDist) {
              offRightPitch = ev.pitch;
              offRightDist = dist;
            }
          }

          const geom = activeLayout.byMidi.get(ev.pitch);
          if (!geom) continue;

          const colX = geom.x * width;
          const colW = geom.width * width;
          const inset = geom.isBlack
            ? Math.min(1.5, colW * 0.08)
            : Math.max(2, colW * 0.12);
          const barX = colX + inset;
          const barW = Math.max(3, colW - inset * 2);

          const rawBottom = strikeY - (ev.onset - liveBeat) * pxPerBeat;
          const rawTop = strikeY - (noteEnd - liveBeat) * pxPerBeat;
          const clampedBottom = Math.min(height + 4, rawBottom);
          if (clampedBottom <= -2) continue;

          const minPillH = activeShowLabels && barW >= 12 ? 16 : 7;
          const nextOnsetBeat = evData.nextOnsetByIndex[i];
          const minAllowedTop = Number.isFinite(nextOnsetBeat)
            ? strikeY - (nextOnsetBeat - liveBeat) * pxPerBeat + NOTE_TOP_GAP_PX
            : -4;
          const desiredTop = Math.min(rawTop + NOTE_TOP_GAP_PX, clampedBottom - minPillH);
          const safeTop = Math.max(minAllowedTop, desiredTop);
          const clampedTop = Math.max(-4, Math.min(clampedBottom - 4, safeTop));
          const barH = Math.max(4, clampedBottom - clampedTop);

          const grade = activeGrades[ev.id];
          const palette = resolvePalette(ev.pitch, ev.hand, grade);

          const isActive = ev.onset <= liveBeat && noteEnd >= liveBeat;
          if (isActive) {
            currentActiveIds.add(ev.id);
            activeBursts.push({ x: colX, w: colW, palette });
            if (!prevActiveIds.has(ev.id)) {
              spawnParticles(barX, strikeY, barW, palette, 4);
            }
          }
          if (grade?.status === 'hit' && !celebratedHitIds.has(ev.id)) {
            celebratedHitIds.add(ev.id);
            spawnParticles(barX, strikeY, barW, palette, 10);
          }

          const bar: DrawableBar = { ev, barX, barW, clampedTop, barH, palette, isActive };
          if (geom.isBlack) {
            blackBars.push(bar);
          } else {
            whiteBars.push(bar);
          }
        }
        prevActiveIds = currentActiveIds;

        const drawNoteBar = ({ ev, barX, barW, clampedTop, barH, palette, isActive }: DrawableBar) => {
          const grad = ctx.createLinearGradient(0, clampedTop, 0, clampedTop + barH);
          grad.addColorStop(0, palette.top);
          grad.addColorStop(1, palette.bottom);
          const radius = Math.min(11, barW * 0.42, barH * 0.45);

          ctx.save();
          if (isActive) {
            ctx.shadowColor = palette.glow;
            ctx.shadowBlur = 14;
          }
          traceRoundedRect(ctx, barX, clampedTop, barW, barH, radius);
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.restore();

          ctx.save();
          traceRoundedRect(ctx, barX, clampedTop, barW, barH, radius);
          ctx.clip();
          ctx.fillStyle = 'rgba(255, 255, 255, 0.34)';
          ctx.fillRect(barX + 2, clampedTop + 1.5, Math.max(0, barW - 4), Math.min(4, barH * 0.25));
          ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.fillRect(barX, clampedTop + barH - 3, barW, 3);
          ctx.restore();

          ctx.strokeStyle = isDark ? palette.border : '#ffffff';
          ctx.lineWidth = isDark ? 1.5 : 2;
          traceRoundedRect(
            ctx,
            barX + 0.5,
            clampedTop + 0.5,
            Math.max(1, barW - 1),
            Math.max(1, barH - 1),
            Math.max(1, radius - 0.5),
          );
          ctx.stroke();

          if (activeShowLabels && barW >= 10 && barH >= 12) {
            const labelText =
              activeColorMode === 'rainbow'
                ? getKeyStickerColor(ev.pitch).shortLabel
                : barW >= 20 && barH >= 14
                  ? ev.pitchName
                  : ev.pitchName.replace(/-?\d+$/, '');
            const isRainbowText = activeColorMode === 'rainbow';
            const fontSize = barW >= 28 ? 13 : barW >= 20 ? 11 : 9.5;
            const centerY = Math.max(
              clampedTop + Math.min(barH / 2, 14),
              Math.min(clampedTop + barH / 2, strikeY - 11),
            );
            ctx.font = isRainbowText
              ? `700 ${fontSize}px Fredoka, ui-rounded, sans-serif`
              : `700 ${Math.min(10, fontSize)}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 2.6;
            ctx.lineJoin = 'round';
            ctx.strokeStyle = 'rgba(12, 10, 9, 0.78)';
            ctx.strokeText(labelText, barX + barW / 2, centerY, barW - 4);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
            ctx.fillText(labelText, barX + barW / 2, centerY, barW - 4);
          }
        };

        for (let i = 0; i < whiteBars.length; i += 1) {
          drawNoteBar(whiteBars[i]);
        }
        for (let i = 0; i < blackBars.length; i += 1) {
          drawNoteBar(blackBars[i]);
        }

        if (activeExpectedPitches.length > 0) {
          const seenPointer = new Set<number>();
          const bounce = Math.abs(Math.sin(nowMs * 0.0055)) * 7;
          for (let i = 0; i < activeExpectedPitches.length; i += 1) {
            const pitch = activeExpectedPitches[i];
            if (seenPointer.has(pitch)) continue;
            seenPointer.add(pitch);
            const geom = activeLayout.byMidi.get(pitch);
            if (!geom) continue;

            const palette = resolvePalette(pitch, 'R');
            const cx = (geom.x + geom.width / 2) * width;
            const colW = geom.width * width;
            const halfW = Math.min(11, Math.max(6, colW * 0.24));
            const tipY = strikeY - 5 - bounce;
            const baseY = tipY - halfW * 1.15;

            ctx.save();
            ctx.shadowColor = palette.glow;
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.moveTo(cx, tipY);
            ctx.lineTo(cx - halfW, baseY);
            ctx.lineTo(cx + halfW, baseY);
            ctx.closePath();
            ctx.fillStyle = palette.top;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(cx, baseY + halfW * 0.36, Math.max(2, halfW * 0.24), 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.restore();
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
            burstH + strikeOffset,
          );

          ctx.fillStyle = '#ffffff';
          ctx.fillRect(burst.x + 1, strikeY - 1.5, Math.max(2, burst.w - 2), 3);
        }

        const drawOffscreenPill = (pitch: number, side: 'left' | 'right') => {
          const palette = resolvePalette(pitch, 'R');
          const shortLabel = getKeyStickerColor(pitch).shortLabel;
          const label = side === 'left' ? `◀ ${shortLabel}` : `${shortLabel} ▶`;
          ctx.save();
          ctx.font = '700 11px Fredoka, ui-rounded, system-ui, sans-serif';
          const textW = ctx.measureText(label).width;
          const pillH = 22;
          const pillW = Math.ceil(textW + 14);
          const pillX = side === 'left' ? 8 : width - pillW - 8;
          const pillY = Math.max(4, strikeY - 10 - pillH);

          ctx.shadowColor = palette.glow;
          ctx.shadowBlur = 12;
          traceRoundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
          ctx.fillStyle = palette.stickerBg;
          ctx.fill();

          ctx.shadowBlur = 0;
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.stroke();

          ctx.fillStyle = palette.stickerText;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, pillX + pillW / 2, pillY + pillH / 2);
          ctx.restore();
        };

        if (offLeftPitch !== null) {
          drawOffscreenPill(offLeftPitch, 'left');
        }
        if (offRightPitch !== null) {
          drawOffscreenPill(offRightPitch, 'right');
        }

        if (particles.length > 0) {
          ctx.save();
          for (let i = particles.length - 1; i >= 0; i -= 1) {
            const p = particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy *= 0.96;
            p.alpha -= p.decay * dt;
            if (p.alpha <= 0) {
              particles.splice(i, 1);
              continue;
            }
            ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));
            ctx.fillStyle = p.color;
            if (p.isStar) {
              drawSparkleStar(ctx, p.x, p.y, p.size);
              ctx.fill();
            } else {
              ctx.beginPath();
              ctx.arc(p.x, p.y, p.size * 0.55, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          ctx.restore();
        }
      }

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div className="flex flex-col w-full h-full overflow-hidden select-none">
      {!hideToolbar && (
        <div
          className={[
            'flex h-8 shrink-0 items-center justify-between gap-2 border-b px-2.5 text-[11px]',
            darkMode
              ? 'border-stone-800 bg-stone-900 text-stone-300'
              : 'border-stone-300/75 bg-[#f3efe6] text-stone-700',
          ].join(' ')}
        >
          <div className="flex items-center gap-1.5">
            <div
              className={[
                'inline-flex items-center rounded-md border p-0.5',
                darkMode ? 'border-stone-700 bg-stone-800' : 'border-stone-300 bg-white/70',
              ].join(' ')}
            >
              {SPEED_OPTIONS.map((opt) => {
                const active = lookaheadBeats === opt.beats;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setLookaheadBeats(opt.beats)}
                    className={[
                      'rounded px-2 py-0.5 text-[10px] font-semibold transition',
                      active
                        ? darkMode
                          ? 'bg-stone-700 text-amber-300 shadow-sm'
                          : 'bg-white text-stone-900 shadow-sm'
                        : darkMode
                          ? 'text-stone-400 hover:text-stone-200'
                          : 'text-stone-600 hover:text-stone-900',
                    ].join(' ')}
                    title={`Show ${opt.beats} beats ahead`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {canShiftOctave && onOctaveShift && (
              <div className="inline-flex items-center gap-1">
                <button
                  type="button"
                  disabled={octaveShift <= -2}
                  onClick={() => onOctaveShift(-1)}
                  className={[
                    'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold transition disabled:opacity-40 disabled:pointer-events-none',
                    darkMode
                      ? 'border-stone-700 bg-stone-800 text-stone-200 hover:bg-stone-700'
                      : 'border-stone-300 bg-white/70 text-stone-700 hover:bg-white',
                  ].join(' ')}
                  title="Shift keyboard down an octave"
                >
                  -8va
                </button>
                <button
                  type="button"
                  disabled={octaveShift >= 3}
                  onClick={() => onOctaveShift(1)}
                  className={[
                    'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold transition disabled:opacity-40 disabled:pointer-events-none',
                    darkMode
                      ? 'border-stone-700 bg-stone-800 text-stone-200 hover:bg-stone-700'
                      : 'border-stone-300 bg-white/70 text-stone-700 hover:bg-white',
                  ].join(' ')}
                  title="Shift keyboard up an octave"
                >
                  +8va
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {onColorModeChange && (
              <div
                className={[
                  'inline-flex items-center rounded-md border p-0.5',
                  darkMode ? 'border-stone-700 bg-stone-800' : 'border-stone-300 bg-white/70',
                ].join(' ')}
              >
                {(['rainbow', 'hands'] as const).map((mode) => {
                  const active = colorMode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => onColorModeChange(mode)}
                      className={[
                        'rounded px-2 py-0.5 text-[10px] font-semibold transition',
                        active
                          ? darkMode
                            ? 'bg-stone-700 text-amber-300 shadow-sm'
                            : 'bg-white text-stone-900 shadow-sm'
                          : darkMode
                            ? 'text-stone-400 hover:text-stone-200'
                            : 'text-stone-600 hover:text-stone-900',
                      ].join(' ')}
                    >
                      {mode === 'rainbow' ? 'Rainbow' : 'Hands'}
                    </button>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowLabels((prev) => !prev)}
              className={[
                'rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold transition',
                showLabels
                  ? darkMode
                    ? 'border-amber-500/70 bg-amber-500/20 text-amber-300'
                    : 'border-amber-500/70 bg-amber-500/20 text-amber-700'
                  : darkMode
                    ? 'border-stone-700 bg-stone-800 text-stone-300 hover:bg-stone-700'
                    : 'border-stone-300 bg-white/70 text-stone-600 hover:bg-white',
              ].join(' ')}
              title="Toggle note pitch labels"
            >
              ABC
            </button>
          </div>
        </div>
      )}

      <div ref={containerRef} className="relative flex-1 min-h-0 w-full overflow-hidden">
        <canvas ref={canvasRef} className="block w-full h-full" />
      </div>
    </div>
  );
}

export default FallingNotesCanvas;

