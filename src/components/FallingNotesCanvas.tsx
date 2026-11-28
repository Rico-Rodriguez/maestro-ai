import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteEvent, TimeSigPoint } from '../music/types';
import type { PracticeGrade } from '../practice/engine';
import {
  getKeyStickerColor,
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

interface BloomBurst {
  x: number;
  y: number;
  age: number;
  duration: number;
  color: string;
  maxScale: number;
}

interface DriftingPetal {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  age: number;
  duration: number;
  color: string;
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
const MAX_PETALS = 60;
const PETAL_GRAVITY = 140;
const OCTAVE_WATERMARKS = new Set(['C2', 'C3', 'C4', 'C5', 'C6']);

const SPEED_OPTIONS = [
  { id: 'slow', label: 'Slow', beats: 8 },
  { id: 'normal', label: 'Normal', beats: 6 },
  { id: 'fast', label: 'Fast', beats: 4.2 },
] as const;

const PALETTE_HIT: NotePalette = {
  top: '#16a34a',
  bottom: '#16a34a',
  border: 'rgba(255, 255, 255, 0.7)',
  glow: 'rgba(22, 163, 74, 0.25)',
  stickerBg: '#16a34a',
  stickerText: '#ffffff',
};

const PALETTE_MISS: NotePalette = {
  top: '#dc2626',
  bottom: '#dc2626',
  border: 'rgba(255, 255, 255, 0.7)',
  glow: 'rgba(220, 38, 38, 0.25)',
  stickerBg: '#dc2626',
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

function drawFivePetalFlower(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  alpha = 1,
): void {
  if (alpha <= 0 || radius <= 0.5) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.translate(cx, cy);
  const petalDist = radius * 0.52;
  const petalRx = radius * 0.44;
  const petalRy = radius * 0.3;

  ctx.fillStyle = color;
  for (let p = 0; p < 5; p += 1) {
    const angle = (p * Math.PI * 2) / 5 - Math.PI / 2;
    ctx.save();
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(petalDist, 0, petalRx, petalRy, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = '#fff6d6';
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1.5, radius * 0.28), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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
    const blooms: BloomBurst[] = [];
    const petals: DriftingPetal[] = [];
    const celebratedHitIds = new Set<string>();
    let prevActiveIds = new Set<string>();
    let prevSortedRef = stateRef.current.indexedEvents.sorted;
    let prevLiveBeat = 0;
    let hasAdvancedBeat = false;
    let lastFrameMs = performance.now();

    const spawnBloom = (x: number, y: number, color: string, maxScale: number) => {
      blooms.push({
        x,
        y,
        age: 0,
        duration: 0.65,
        color,
        maxScale,
      });
    };

    const spawnHitPetals = (x: number, y: number, w: number, color: string) => {
      for (let k = 0; k < 6; k += 1) {
        if (petals.length >= MAX_PETALS) {
          petals.shift();
        }
        const spread = (k - 2.5) / 2.5;
        petals.push({
          x: x + w * (0.3 + Math.random() * 0.4),
          y: y - 2,
          vx: spread * 48 + (Math.random() - 0.5) * 24,
          vy: -(60 + Math.random() * 50),
          rot: Math.random() * Math.PI * 2,
          vrot: (Math.random() - 0.5) * 6,
          age: 0,
          duration: 0.9,
          color,
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
          celebratedHitIds.clear();
          prevActiveIds = new Set<string>();
          hasAdvancedBeat = false;
        }
        if (liveBeat > prevLiveBeat + 1e-4) {
          hasAdvancedBeat = true;
        }
        prevLiveBeat = liveBeat;

        const strikeOffset = isFlushBottom ? FLUSH_STRIKE_OFFSET_PX : STRIKE_OFFSET_PX;
        const strikeY = Math.max(24, height - strikeOffset);
        const pxPerBeat = Math.max(8, strikeY / activeLookahead);
        const tailBeats = strikeOffset / pxPerBeat + 0.5;
        const visibleMinBeat = liveBeat - tailBeats;
        const visibleMaxBeat = liveBeat + activeLookahead + 0.75;

        const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
        bgGrad.addColorStop(0, isDark ? '#17131a' : '#fdf3ef');
        bgGrad.addColorStop(1, isDark ? '#1f1a22' : '#fbf7f2');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = isDark ? 'rgba(0, 0, 0, 0.3)' : 'rgba(42, 29, 34, 0.035)';
        for (let i = 0; i < activeLayout.blackKeys.length; i += 1) {
          const bk = activeLayout.blackKeys[i];
          ctx.fillRect(bk.x * width, 0, bk.width * width, strikeY);
        }

        ctx.lineWidth = 1;
        ctx.font = '500 10px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        for (let i = 0; i < activeLayout.whiteKeys.length; i += 1) {
          const wk = activeLayout.whiteKeys[i];
          const pc = ((wk.midi % 12) + 12) % 12;
          const x = Math.round(wk.x * width) + 0.5;
          ctx.strokeStyle = isDark
            ? pc === 0
              ? 'rgba(243, 234, 240, 0.14)'
              : 'rgba(243, 234, 240, 0.06)'
            : pc === 0
              ? 'rgba(42, 29, 34, 0.14)'
              : 'rgba(42, 29, 34, 0.06)';
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, strikeY);
          ctx.stroke();

          if (!suppressChrome && wk.isC && OCTAVE_WATERMARKS.has(wk.label)) {
            ctx.fillStyle = isDark ? 'rgba(243, 234, 240, 0.36)' : 'rgba(42, 29, 34, 0.42)';
            ctx.fillText(wk.label, x + 4, 6);
          }
        }

        const startMeasureIdx = Math.max(0, lowerBoundMeasure(mData.lines, visibleMinBeat) - 1);
        ctx.font = '500 10px Nunito, ui-rounded, system-ui, sans-serif';
        ctx.textAlign = 'left';

        const drawMeasureWithSubBeats = (measureNum: number, beat: number, nextBeat: number) => {
          ctx.strokeStyle = isDark ? 'rgba(243, 234, 240, 0.05)' : 'rgba(42, 29, 34, 0.05)';
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
          ctx.strokeStyle = isDark ? 'rgba(243, 234, 240, 0.12)' : 'rgba(42, 29, 34, 0.12)';
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
              ctx.fillStyle = isDark ? 'rgba(42, 36, 48, 0.92)' : 'rgba(42, 29, 34, 0.78)';
              ctx.fill();
              ctx.fillStyle = isDark ? '#f3eaf0' : '#fffdfb';
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
            ctx.save();
            ctx.globalAlpha = 0.08;
            ctx.fillStyle = palette.stickerBg;
            ctx.fillRect(geom.x * width, 0, geom.width * width, strikeY);
            ctx.restore();
          }
        }

        const whiteBars: DrawableBar[] = [];
        const blackBars: DrawableBar[] = [];
        const nextActiveIds = new Set<string>();
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
            nextActiveIds.add(ev.id);
          }

          if (grade?.status === 'hit' && !celebratedHitIds.has(ev.id)) {
            celebratedHitIds.add(ev.id);
            spawnBloom(barX + barW / 2, strikeY, palette.stickerBg, 1.0);
            spawnHitPetals(barX, strikeY, barW, palette.stickerBg);
          } else if (
            hasAdvancedBeat &&
            isActive &&
            !prevActiveIds.has(ev.id) &&
            !celebratedHitIds.has(ev.id) &&
            grade?.status !== 'hit'
          ) {
            spawnBloom(barX + barW / 2, strikeY, palette.stickerBg, 0.7);
          }

          const bar: DrawableBar = { ev, barX, barW, clampedTop, barH, palette, isActive };
          if (geom.isBlack) {
            blackBars.push(bar);
          } else {
            whiteBars.push(bar);
          }
        }
        prevActiveIds = nextActiveIds;

        const drawNoteBar = ({ ev, barX, barW, clampedTop, barH, palette }: DrawableBar) => {
          const radius = Math.min(barW / 2, 14, barH / 2);

          traceRoundedRect(ctx, barX, clampedTop + 2, barW, barH, radius);
          ctx.fillStyle = 'rgba(42, 29, 34, 0.1)';
          ctx.fill();

          traceRoundedRect(ctx, barX, clampedTop, barW, barH, radius);
          ctx.fillStyle = palette.stickerBg;
          ctx.fill();

          ctx.save();
          traceRoundedRect(ctx, barX, clampedTop, barW, barH, radius);
          ctx.clip();
          const hlRx = Math.max(1, barW * 0.36);
          const hlRy = Math.max(1, Math.min(barH * 0.16, 4.5));
          const hlY = clampedTop + Math.min(barH * 0.22, hlRy + 2.5);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
          ctx.beginPath();
          ctx.ellipse(barX + barW / 2, hlY, hlRx, hlRy, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          if (activeShowLabels && barW >= 10 && barH >= 12) {
            const labelText =
              activeColorMode === 'rainbow'
                ? getKeyStickerColor(ev.pitch).shortLabel
                : barW >= 20 && barH >= 14
                  ? ev.pitchName
                  : ev.pitchName.replace(/-?\d+$/, '');
            const fontSize = barW >= 28 ? 13 : barW >= 20 ? 11 : 9.5;
            const centerY = Math.max(
              clampedTop + Math.min(barH / 2, 14),
              Math.min(clampedTop + barH / 2, strikeY - 11),
            );
            ctx.font = `600 ${fontSize}px Nunito, ui-rounded, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = palette.stickerText;
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
          for (let i = 0; i < activeExpectedPitches.length; i += 1) {
            const pitch = activeExpectedPitches[i];
            if (seenPointer.has(pitch)) continue;
            seenPointer.add(pitch);
            const geom = activeLayout.byMidi.get(pitch);
            if (!geom) continue;

            const palette = resolvePalette(pitch, 'R');
            const cx = (geom.x + geom.width / 2) * width;
            drawFivePetalFlower(ctx, cx, strikeY - 10, 8, palette.stickerBg, 1);
          }
        }

        traceRoundedRect(ctx, 0, strikeY - 1.5, width, 3, 1.5);
        ctx.fillStyle = isDark ? 'rgba(240, 101, 149, 0.35)' : 'rgba(214, 51, 108, 0.35)';
        ctx.fill();

        const drawOffscreenPill = (pitch: number, side: 'left' | 'right') => {
          const palette = resolvePalette(pitch, 'R');
          const shortLabel = getKeyStickerColor(pitch).shortLabel;
          const label = side === 'left' ? `\u2190 ${shortLabel}` : `${shortLabel} \u2192`;
          ctx.save();
          ctx.font = '600 11px Nunito, ui-rounded, system-ui, sans-serif';
          const textW = ctx.measureText(label).width;
          const pillH = 24;
          const pillW = Math.ceil(textW + 16);
          const pillX = side === 'left' ? 8 : width - pillW - 8;
          const pillY = Math.max(4, strikeY - 10 - pillH);

          traceRoundedRect(ctx, pillX, pillY, pillW, pillH, 10);
          ctx.fillStyle = palette.stickerBg;
          ctx.fill();

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

        if (blooms.length > 0) {
          for (let i = blooms.length - 1; i >= 0; i -= 1) {
            const b = blooms[i];
            b.age += dt;
            const t = b.age / b.duration;
            if (t >= 1) {
              blooms.splice(i, 1);
              continue;
            }
            const scaleProgress =
              t < 0.45
                ? 0.3 + (1.15 - 0.3) * (1 - Math.pow(1 - t / 0.45, 3))
                : 1.15 + (1.0 - 1.15) * ((t - 0.45) / 0.55);
            const alpha = t < 0.35 ? 1 : Math.max(0, 1 - (t - 0.35) / 0.65);
            drawFivePetalFlower(ctx, b.x, b.y - 6, 14 * scaleProgress * b.maxScale, b.color, alpha);
          }
        }

        if (petals.length > 0) {
          ctx.save();
          for (let i = petals.length - 1; i >= 0; i -= 1) {
            const p = petals[i];
            p.age += dt;
            if (p.age >= p.duration) {
              petals.splice(i, 1);
              continue;
            }
            p.vy += PETAL_GRAVITY * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.rot += p.vrot * dt;

            const alpha = Math.max(0, 1 - p.age / p.duration);
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.ellipse(0, 0, 4.5, 2.6, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
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
            'flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs',
            darkMode
              ? 'border-[#f3eaf0]/[0.08] bg-[#1f1a22] text-[#b9a9b4]'
              : 'border-[#2a1d22]/[0.08] bg-[#fffdfb] text-[#6b5560]',
          ].join(' ')}
        >
          <div className="flex items-center gap-2">
            <div
              className={[
                'inline-flex items-center rounded-[8px] p-0.5',
                darkMode ? 'bg-[#2a2430]' : 'bg-[#f6ebe6]',
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
                      'rounded-[6px] px-2 py-0.5 text-[11px] font-medium transition-colors duration-150',
                      active
                        ? darkMode
                          ? 'bg-[#1f1a22] text-[#f3eaf0]'
                          : 'bg-[#fffdfb] text-[#2a1d22]'
                        : darkMode
                          ? 'text-[#b9a9b4] hover:text-[#f3eaf0]'
                          : 'text-[#6b5560] hover:text-[#2a1d22]',
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
                    'rounded-[6px] border px-2 py-0.5 font-mono text-[11px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none',
                    darkMode
                      ? 'border-[#f3eaf0]/[0.08] bg-[#2a2430] text-[#f3eaf0] hover:bg-[#352d3c]'
                      : 'border-[#2a1d22]/[0.08] bg-[#f6ebe6] text-[#2a1d22] hover:bg-[#ede0da]',
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
                    'rounded-[6px] border px-2 py-0.5 font-mono text-[11px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none',
                    darkMode
                      ? 'border-[#f3eaf0]/[0.08] bg-[#2a2430] text-[#f3eaf0] hover:bg-[#352d3c]'
                      : 'border-[#2a1d22]/[0.08] bg-[#f6ebe6] text-[#2a1d22] hover:bg-[#ede0da]',
                  ].join(' ')}
                  title="Shift keyboard up an octave"
                >
                  +8va
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {onColorModeChange && (
              <div
                className={[
                  'inline-flex items-center rounded-[8px] p-0.5',
                  darkMode ? 'bg-[#2a2430]' : 'bg-[#f6ebe6]',
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
                        'rounded-[6px] px-2 py-0.5 text-[11px] font-medium transition-colors duration-150',
                        active
                          ? darkMode
                            ? 'bg-[#1f1a22] text-[#f3eaf0]'
                            : 'bg-[#fffdfb] text-[#2a1d22]'
                          : darkMode
                            ? 'text-[#b9a9b4] hover:text-[#f3eaf0]'
                            : 'text-[#6b5560] hover:text-[#2a1d22]',
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
                'rounded-[6px] border px-2 py-0.5 font-mono text-[11px] font-medium transition-colors duration-150',
                showLabels
                  ? darkMode
                    ? 'border-[#f06595]/60 bg-[#f06595]/15 text-[#f06595]'
                    : 'border-[#d6336c]/50 bg-[#d6336c]/10 text-[#d6336c]'
                  : darkMode
                    ? 'border-[#f3eaf0]/[0.08] bg-[#2a2430] text-[#b9a9b4] hover:text-[#f3eaf0]'
                    : 'border-[#2a1d22]/[0.08] bg-[#f6ebe6] text-[#6b5560] hover:text-[#2a1d22]',
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
