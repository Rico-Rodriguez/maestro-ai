import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { AudioEngineStatus } from '../audio/piano-engine';
import type { Hand, NoteEvent } from '../music/types';
import {
  getKeyStickerColor,
  getRainbowNoteStyle,
  type ColorMode,
} from './note-colors';
import type { KeyGeom, PianoLayout, PianoRangeMode } from './piano-geometry';

export interface PianoKeyboardProps {
  layout: PianoLayout;
  rangeMode: PianoRangeMode;
  onRangeModeChange: (mode: PianoRangeMode) => void;
  octaveShift: number;
  onOctaveShift: (delta: number) => void;
  userPressedNotes: Set<number>;
  expectedNotes: NoteEvent[];
  getPlaybackPitches: () => Map<number, Hand>;
  getPlaybackSustain: () => boolean;
  userSustainDown: boolean;
  audioStatus: AudioEngineStatus;
  onNoteOn: (pitch: number, velocity: number) => void;
  onNoteOff: (pitch: number) => void;
  darkMode: boolean;
  colorMode?: ColorMode;
  showKeyStickers?: boolean;
  flushTop?: boolean;
  hideControls?: boolean;
}

const RANGE_OPTIONS: readonly { mode: PianoRangeMode; label: string }[] = [
  { mode: 'kid', label: 'Big 15' },
  { mode: 'compact', label: '25' },
  { mode: 'auto', label: 'Auto' },
  { mode: '61', label: '61' },
  { mode: '88', label: '88' },
];

const RAINBOW_DOT_CLASSES = [
  'bg-red-500',
  'bg-orange-500',
  'bg-yellow-400',
  'bg-green-500',
  'bg-cyan-500',
  'bg-blue-500',
  'bg-purple-500',
] as const;

function formatSoundBadge(status: AudioEngineStatus): {
  text: string;
  tone: 'ready' | 'loading' | 'idle';
} {
  if (!status.unlocked || status.state !== 'running') {
    return { text: 'Tap a key to enable sound', tone: 'idle' };
  }
  if (status.usingFallback) {
    return {
      text: `Loading piano (${status.samplesLoaded}/${status.samplesTotal}) · Synth active`,
      tone: 'loading',
    };
  }
  if (status.voice === 'electric-piano') {
    return { text: 'Electric Piano', tone: 'ready' };
  }
  return { text: 'Concert Grand · Ready', tone: 'ready' };
}

function computeStrikeVelocity(keyEl: Element, clientY: number): number {
  const rect = keyEl.getBoundingClientRect();
  if (rect.height <= 0) return 90;
  const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  return Math.round(55 + ratio * 63);
}

function findMidiElementAt(clientX: number, clientY: number): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const target = document.elementFromPoint(clientX, clientY);
  if (!target) return null;
  return target.closest<HTMLElement>('[data-midi]');
}

function BeaconStarIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="#ffffff" aria-hidden="true">
      <polygon points="12,2.2 14.9,8.4 21.7,9.2 16.6,13.9 18,20.7 12,17.3 6,20.7 7.4,13.9 2.3,9.2 9.1,8.4" />
    </svg>
  );
}

export function PianoKeyboard({
  layout,
  rangeMode,
  onRangeModeChange,
  octaveShift,
  onOctaveShift,
  userPressedNotes,
  expectedNotes,
  getPlaybackPitches,
  getPlaybackSustain,
  userSustainDown,
  audioStatus,
  onNoteOn,
  onNoteOff,
  darkMode,
  colorMode = 'rainbow',
  showKeyStickers = true,
  flushTop = false,
  hideControls = false,
}: PianoKeyboardProps) {
  const keyNodesRef = useRef<Map<number, HTMLElement>>(new Map());
  const sustainPillRef = useRef<HTMLDivElement | null>(null);
  const activePointersRef = useRef<Map<number, number>>(new Map());

  const getPlaybackPitchesRef = useRef(getPlaybackPitches);
  getPlaybackPitchesRef.current = getPlaybackPitches;
  const getPlaybackSustainRef = useRef(getPlaybackSustain);
  getPlaybackSustainRef.current = getPlaybackSustain;
  const onNoteOnRef = useRef(onNoteOn);
  onNoteOnRef.current = onNoteOn;
  const onNoteOffRef = useRef(onNoteOff);
  onNoteOffRef.current = onNoteOff;

  const expectedByMidi = useMemo(() => {
    const map = new Map<number, Hand>();
    for (const note of expectedNotes) {
      if (!map.has(note.pitch)) {
        map.set(note.pitch, note.hand);
      }
    }
    return map;
  }, [expectedNotes]);

  const soundBadge = formatSoundBadge(audioStatus);

  const registerKeyNode = useCallback((midi: number, el: HTMLElement | null) => {
    if (el) {
      keyNodesRef.current.set(midi, el);
    } else {
      keyNodesRef.current.delete(midi);
    }
  }, []);

  useEffect(() => {
    const prevPitches = new Map<number, Hand>();
    let prevSustain = false;
    let rafId = 0;

    const tick = () => {
      const nextPitches = getPlaybackPitchesRef.current();

      for (const [midi] of prevPitches) {
        if (!nextPitches.has(midi)) {
          const el = keyNodesRef.current.get(midi);
          if (el) el.removeAttribute('data-playback');
          prevPitches.delete(midi);
        }
      }

      for (const [midi, hand] of nextPitches) {
        if (prevPitches.get(midi) !== hand) {
          const el = keyNodesRef.current.get(midi);
          if (el) el.setAttribute('data-playback', hand);
          prevPitches.set(midi, hand);
        }
      }

      const nextSustain = getPlaybackSustainRef.current();
      if (nextSustain !== prevSustain) {
        prevSustain = nextSustain;
        if (sustainPillRef.current) {
          sustainPillRef.current.setAttribute(
            'data-playback-sustain',
            nextSustain ? 'true' : 'false',
          );
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      for (const [midi] of prevPitches) {
        const el = keyNodesRef.current.get(midi);
        if (el) el.removeAttribute('data-playback');
      }
      if (sustainPillRef.current) {
        sustainPillRef.current.setAttribute('data-playback-sustain', 'false');
      }
    };
  }, [layout]);

  useEffect(() => {
    const pointers = activePointersRef.current;
    return () => {
      const heldMidis = new Set<number>();
      for (const midi of pointers.values()) {
        if (midi >= 0) heldMidis.add(midi);
      }
      pointers.clear();
      for (const midi of heldMidis) {
        onNoteOffRef.current(midi);
      }
    };
  }, []);

  const isMidiHeldByOtherPointer = useCallback((midi: number, excludePointerId: number): boolean => {
    for (const [pid, activeMidi] of activePointersRef.current) {
      if (pid !== excludePointerId && activeMidi === midi) {
        return true;
      }
    }
    return false;
  }, []);

  const releasePointer = useCallback(
    (pointerId: number) => {
      const prevMidi = activePointersRef.current.get(pointerId);
      activePointersRef.current.delete(pointerId);
      if (prevMidi !== undefined && prevMidi >= 0 && !isMidiHeldByOtherPointer(prevMidi, pointerId)) {
        onNoteOffRef.current(prevMidi);
      }
    },
    [isMidiHeldByOtherPointer],
  );

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events where pointer capture is unavailable
    }

    const hitEl =
      findMidiElementAt(e.clientX, e.clientY) ??
      (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-midi]') : null);
    if (!hitEl) return;

    const midi = Number(hitEl.dataset.midi);
    if (!Number.isFinite(midi)) return;

    const velocity = computeStrikeVelocity(hitEl, e.clientY);
    activePointersRef.current.set(e.pointerId, midi);
    if (e.pointerType !== 'mouse') {
      globalThis.__maestroHaptic?.('LIGHT');
    }
    onNoteOnRef.current(midi, velocity);
  }, []);

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!activePointersRef.current.has(e.pointerId)) return;

      const hitEl = findMidiElementAt(e.clientX, e.clientY);
      const nextMidi = hitEl ? Number(hitEl.dataset.midi) : -1;
      const validNext = Number.isFinite(nextMidi) && nextMidi >= 0 ? nextMidi : -1;
      const prevMidi = activePointersRef.current.get(e.pointerId) ?? -1;

      if (validNext === prevMidi) return;

      if (prevMidi >= 0 && !isMidiHeldByOtherPointer(prevMidi, e.pointerId)) {
        onNoteOffRef.current(prevMidi);
      }

      activePointersRef.current.set(e.pointerId, validNext);

      if (validNext >= 0 && hitEl) {
        const velocity = computeStrikeVelocity(hitEl, e.clientY);
        if (e.pointerType !== 'mouse') {
          globalThis.__maestroHaptic?.('LIGHT');
        }
        onNoteOnRef.current(validNext, velocity);
      }
    },
    [isMidiHeldByOtherPointer],
  );

  const handlePointerUpOrCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!activePointersRef.current.has(e.pointerId)) return;
      releasePointer(e.pointerId);
    },
    [releasePointer],
  );

  const isRainbow = colorMode === 'rainbow';
  const showOctaveButtons = (rangeMode === 'kid' || rangeMode === 'compact') && !hideControls;

  const renderWhiteKey = (key: KeyGeom) => {
    const isPressed = userPressedNotes.has(key.midi);
    const expectedHand = expectedByMidi.get(key.midi);
    const sticker = getKeyStickerColor(key.midi);
    const rainbow = getRainbowNoteStyle(key.midi);
    const showAllStickers = showKeyStickers && layout.whiteCount <= 22;
    const showCOnlySticker = showKeyStickers && layout.whiteCount > 22 && layout.whiteCount <= 42 && key.isC;
    const showCompactCLabel = !showAllStickers && !showCOnlySticker && key.isC && layout.whiteCount <= 52;
    const isLargeKey = layout.whiteCount <= 12;

    const keyStyle: CSSProperties & Record<`--${string}`, string> = {
      left: `${key.x * 100}%`,
      width: `${key.width * 100}%`,
      '--key-fill': sticker.bg,
      '--key-from': rainbow.keyBgFrom,
      '--key-via': rainbow.keyBgVia,
      '--key-to': rainbow.keyBgTo,
      '--key-glow': rainbow.glow,
    };

    return (
      <div
        key={key.midi}
        ref={(el) => registerKeyNode(key.midi, el)}
        data-midi={key.midi}
        data-user-pressed={isPressed ? 'true' : 'false'}
        style={keyStyle}
        className={[
          'group absolute top-0 bottom-0 select-none cursor-pointer border-r transition-transform duration-75',
          darkMode ? 'border-stone-400/70' : 'border-amber-200/90',
          'rounded-b-xl',
          'bg-gradient-to-b from-[#fffdf9] via-[#faf6ec] to-[#ece4d4]',
          'shadow-[inset_0_-7px_0_rgba(120,113,108,0.2),inset_1px_0_0_rgba(255,255,255,0.85)]',
          'data-[user-pressed=true]:translate-y-[2px]',
          'data-[playback=R]:translate-y-[2px]',
          'data-[playback=L]:translate-y-[2px]',
          isRainbow
            ? [
                'piano-key-rainbow',
                expectedHand ? 'piano-key-expected' : '',
              ]
                .filter(Boolean)
                .join(' ')
            : [
                'data-[user-pressed=true]:bg-gradient-to-b data-[user-pressed=true]:from-emerald-100 data-[user-pressed=true]:via-emerald-200 data-[user-pressed=true]:to-emerald-400',
                'data-[user-pressed=true]:shadow-[inset_0_3px_8px_rgba(6,95,70,0.35)]',
                'data-[playback=R]:bg-gradient-to-b data-[playback=R]:from-amber-100 data-[playback=R]:via-amber-200 data-[playback=R]:to-amber-400',
                'data-[playback=R]:shadow-[inset_0_3px_8px_rgba(180,83,9,0.35)]',
                'data-[playback=L]:bg-gradient-to-b data-[playback=L]:from-sky-100 data-[playback=L]:via-sky-200 data-[playback=L]:to-sky-400',
                'data-[playback=L]:shadow-[inset_0_3px_8px_rgba(3,105,161,0.35)]',
              ].join(' '),
        ].join(' ')}
      >
        {expectedHand && (
          <span
            style={
              isRainbow
                ? {
                    backgroundColor: rainbow.stickerBg,
                    boxShadow: `0 0 16px ${rainbow.glow}, 0 0 0 4px ${rainbow.top}66`,
                  }
                : undefined
            }
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 flex items-center justify-center rounded-full animate-bounce z-[5]',
              showAllStickers
                ? isLargeKey
                  ? 'bottom-[52px] sm:bottom-14'
                  : 'bottom-9 sm:bottom-10'
                : 'bottom-7',
              isLargeKey ? 'w-6 h-6 sm:w-7 sm:h-7' : 'w-4 h-4',
              isRainbow
                ? 'ring-2 ring-white'
                : expectedHand === 'R'
                  ? 'bg-amber-500 ring-4 ring-amber-400/40 shadow-[0_0_12px_rgba(245,158,11,0.8)]'
                  : 'bg-sky-500 ring-4 ring-sky-400/40 shadow-[0_0_12px_rgba(56,189,248,0.8)]',
            ].join(' ')}
          >
            <span
              style={isRainbow ? { backgroundColor: rainbow.top } : undefined}
              className={[
                'absolute inset-0 rounded-full animate-ping opacity-60',
                !isRainbow && (expectedHand === 'R' ? 'bg-amber-400' : 'bg-sky-400'),
              ]
                .filter(Boolean)
                .join(' ')}
            />
            <BeaconStarIcon
              className={isLargeKey ? 'relative w-3.5 h-3.5 sm:w-4 sm:h-4' : 'relative w-2.5 h-2.5'}
            />
          </span>
        )}

        {showAllStickers && (
          <span
            style={isRainbow ? { backgroundColor: sticker.bg, color: sticker.text } : undefined}
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-2.5 flex items-center justify-center rounded-full font-display font-bold tracking-tight shadow-sm',
              isLargeKey
                ? 'w-9 h-9 sm:w-11 sm:h-11 text-sm sm:text-base'
                : 'w-5 h-5 sm:w-6 sm:h-6 text-[10px] sm:text-[11px]',
              isRainbow
                ? 'ring-2 ring-white/90'
                : 'bg-stone-200/90 text-stone-700 border border-stone-300/80',
            ].join(' ')}
          >
            {sticker.shortLabel}
          </span>
        )}

        {showCOnlySticker && (
          <span
            style={isRainbow ? { backgroundColor: sticker.bg, color: sticker.text } : undefined}
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-1.5 px-1 py-0.5 rounded-full text-[9px] font-bold leading-none tracking-tight shadow-sm',
              isRainbow ? '' : 'bg-stone-200/90 text-stone-600',
            ].join(' ')}
          >
            C
          </span>
        )}

        {showCompactCLabel && (
          <span className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-[10px] font-semibold tracking-tight text-stone-500">
            {key.label}
          </span>
        )}
      </div>
    );
  };

  const renderBlackKey = (key: KeyGeom) => {
    const isPressed = userPressedNotes.has(key.midi);
    const expectedHand = expectedByMidi.get(key.midi);
    const sticker = getKeyStickerColor(key.midi);
    const rainbow = getRainbowNoteStyle(key.midi);
    const showBlackSticker = showKeyStickers && layout.whiteCount <= 16;

    const keyStyle: CSSProperties & Record<`--${string}`, string> = {
      left: `${key.x * 100}%`,
      width: `${key.width * 100}%`,
      '--key-fill': sticker.bg,
      '--key-from': rainbow.keyBgFrom,
      '--key-via': rainbow.keyBgVia,
      '--key-to': rainbow.keyBgTo,
      '--key-glow': rainbow.glow,
    };

    return (
      <div
        key={key.midi}
        ref={(el) => registerKeyNode(key.midi, el)}
        data-midi={key.midi}
        data-user-pressed={isPressed ? 'true' : 'false'}
        style={keyStyle}
        className={[
          'group absolute top-0 h-[61%] z-10 select-none cursor-pointer rounded-b-lg transition-transform duration-75',
          'border-x border-b border-black/90',
          'bg-gradient-to-b from-stone-800 via-stone-900 to-black',
          'shadow-[0_4px_6px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-4px_2px_rgba(255,255,255,0.08)]',
          'data-[user-pressed=true]:translate-y-[2px]',
          'data-[playback=R]:translate-y-[2px]',
          'data-[playback=L]:translate-y-[2px]',
          isRainbow
            ? [
                'piano-key-rainbow-black',
                expectedHand ? 'piano-key-expected-black' : '',
              ]
                .filter(Boolean)
                .join(' ')
            : [
                'data-[user-pressed=true]:bg-gradient-to-b data-[user-pressed=true]:from-emerald-500 data-[user-pressed=true]:via-emerald-700 data-[user-pressed=true]:to-emerald-950',
                'data-[user-pressed=true]:shadow-[0_1px_2px_rgba(0,0,0,0.6),inset_0_2px_6px_rgba(16,185,129,0.55)]',
                'data-[playback=R]:bg-gradient-to-b data-[playback=R]:from-amber-400 data-[playback=R]:via-amber-600 data-[playback=R]:to-amber-950',
                'data-[playback=R]:shadow-[0_1px_2px_rgba(0,0,0,0.6),inset_0_2px_6px_rgba(245,158,11,0.55)]',
                'data-[playback=L]:bg-gradient-to-b data-[playback=L]:from-sky-400 data-[playback=L]:via-sky-600 data-[playback=L]:to-sky-950',
                'data-[playback=L]:shadow-[0_1px_2px_rgba(0,0,0,0.6),inset_0_2px_6px_rgba(56,189,248,0.55)]',
              ].join(' '),
        ].join(' ')}
      >
        <div className="pointer-events-none absolute inset-x-[18%] top-1 h-[55%] rounded-b-sm bg-gradient-to-b from-white/15 to-transparent" />
        {expectedHand && (
          <span
            style={
              isRainbow
                ? {
                    backgroundColor: rainbow.stickerBg,
                    boxShadow: `0 0 10px ${rainbow.glow}, 0 0 0 3px ${rainbow.top}66`,
                  }
                : undefined
            }
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 flex items-center justify-center w-4 h-4 rounded-full animate-bounce',
              showBlackSticker ? 'bottom-7' : 'bottom-3',
              isRainbow
                ? 'ring-2 ring-white/90'
                : expectedHand === 'R'
                  ? 'bg-amber-400 ring-2 ring-amber-300/50 shadow-[0_0_10px_rgba(245,158,11,0.9)]'
                  : 'bg-sky-400 ring-2 ring-sky-300/50 shadow-[0_0_10px_rgba(56,189,248,0.9)]',
            ].join(' ')}
          >
            <span
              style={isRainbow ? { backgroundColor: rainbow.top } : undefined}
              className={[
                'absolute inset-0 rounded-full animate-ping opacity-60',
                !isRainbow && (expectedHand === 'R' ? 'bg-amber-400' : 'bg-sky-400'),
              ]
                .filter(Boolean)
                .join(' ')}
            />
            <BeaconStarIcon className="relative w-2.5 h-2.5" />
          </span>
        )}
        {showBlackSticker && (
          <span
            style={isRainbow ? { backgroundColor: sticker.bg, color: sticker.text } : undefined}
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-1.5 px-1 py-0.5 rounded text-[8px] sm:text-[9px] font-bold leading-none tracking-tight',
              isRainbow ? 'ring-1 ring-white/30' : 'bg-stone-700/90 text-stone-100',
            ].join(' ')}
          >
            {sticker.shortLabel}
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      className={[
        'w-full flex flex-col overflow-hidden select-none',
        flushTop ? 'rounded-b-xl border-x border-b' : 'rounded-b-xl border',
        darkMode ? 'border-stone-800 bg-stone-950' : 'border-stone-300 bg-stone-900',
      ].join(' ')}
    >
      {!flushTop && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-gradient-to-b from-stone-900 via-stone-950 to-black border-b border-stone-800 text-stone-200">
          <div className="flex items-center gap-3 min-w-0">
            {isRainbow ? (
              <div className="flex items-center gap-1" title="ChromaNotes Rainbow Colors">
                {RAINBOW_DOT_CLASSES.map((cls) => (
                  <span key={cls} className={`w-2 h-2 rounded-full ${cls}`} />
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wide">
                <span className="inline-flex items-center gap-1 text-amber-300">
                  <span className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.8)]" />
                  R
                </span>
                <span className="inline-flex items-center gap-1 text-sky-300">
                  <span className="w-2 h-2 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.8)]" />
                  L
                </span>
              </div>
            )}

            <div
              ref={sustainPillRef}
              data-user-sustain={userSustainDown ? 'true' : 'false'}
              data-playback-sustain="false"
              className={[
                'px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors',
                'border-stone-700 bg-stone-900/90 text-stone-400',
                'data-[user-sustain=true]:border-amber-400/70 data-[user-sustain=true]:bg-amber-500/20 data-[user-sustain=true]:text-amber-200 data-[user-sustain=true]:shadow-[0_0_10px_rgba(245,158,11,0.35)]',
                'data-[playback-sustain=true]:border-amber-400/70 data-[playback-sustain=true]:bg-amber-500/20 data-[playback-sustain=true]:text-amber-200 data-[playback-sustain=true]:shadow-[0_0_10px_rgba(245,158,11,0.35)]',
              ].join(' ')}
            >
              Sustain
            </div>

            <div
              className={[
                'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border truncate',
                soundBadge.tone === 'ready'
                  ? 'border-emerald-700/60 bg-emerald-950/60 text-emerald-300'
                  : soundBadge.tone === 'loading'
                    ? 'border-amber-700/60 bg-amber-950/60 text-amber-200'
                    : 'border-stone-700 bg-stone-900 text-stone-300',
              ].join(' ')}
            >
              <span
                className={[
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  soundBadge.tone === 'ready'
                    ? 'bg-emerald-400'
                    : soundBadge.tone === 'loading'
                      ? 'bg-amber-400 animate-pulse'
                      : 'bg-stone-500',
                ].join(' ')}
              />
              <span className="truncate">{soundBadge.text}</span>
            </div>
          </div>

          {!hideControls && (
            <div className="flex items-center gap-1.5">
              {showOctaveButtons && (
                <div className="flex items-center gap-1 mr-1">
                  <button
                    type="button"
                    disabled={octaveShift <= -2}
                    onClick={() => onOctaveShift(-1)}
                    className="px-2 py-0.5 rounded text-[11px] font-semibold bg-stone-800 hover:bg-stone-700 disabled:opacity-40 disabled:pointer-events-none text-stone-200 border border-stone-700"
                  >
                    -8va
                  </button>
                  <button
                    type="button"
                    disabled={octaveShift >= 3}
                    onClick={() => onOctaveShift(1)}
                    className="px-2 py-0.5 rounded text-[11px] font-semibold bg-stone-800 hover:bg-stone-700 disabled:opacity-40 disabled:pointer-events-none text-stone-200 border border-stone-700"
                  >
                    +8va
                  </button>
                </div>
              )}

              <div className="inline-flex items-center rounded-lg bg-stone-900 p-0.5 border border-stone-800">
                {RANGE_OPTIONS.map((opt) => {
                  const active = rangeMode === opt.mode;
                  return (
                    <button
                      key={opt.mode}
                      type="button"
                      onClick={() => onRangeModeChange(opt.mode)}
                      className={[
                        'px-2 py-0.5 rounded-md text-[11px] font-semibold transition-colors',
                        active
                          ? 'bg-amber-500 text-stone-950 shadow-sm'
                          : 'text-stone-400 hover:text-stone-200',
                      ].join(' ')}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="relative w-full">
        <div
          className={
            !darkMode && isRainbow
              ? 'h-[6px] w-full bg-gradient-to-r from-rose-300 via-amber-300 via-emerald-300 via-sky-300 to-purple-300 shadow-[0_2px_4px_rgba(0,0,0,0.12)]'
              : 'h-[4px] w-full bg-gradient-to-b from-red-950 via-red-800 to-red-950 shadow-[0_2px_4px_rgba(0,0,0,0.6)]'
          }
        />

        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUpOrCancel}
          onPointerCancel={handlePointerUpOrCancel}
          onLostPointerCapture={handlePointerUpOrCancel}
          className="relative w-full h-40 sm:h-48 touch-none select-none bg-stone-950 overflow-hidden"
        >
          {layout.whiteKeys.map(renderWhiteKey)}
          {layout.blackKeys.map(renderBlackKey)}
        </div>
      </div>
    </div>
  );
}

export default PianoKeyboard;

