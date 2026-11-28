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

const RAINBOW_DOT_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#a855f7',
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
      text: `Loading piano (${status.samplesLoaded}/${status.samplesTotal})`,
      tone: 'loading',
    };
  }
  if (status.voice === 'electric-piano') {
    return { text: 'Electric Piano', tone: 'ready' };
  }
  return { text: 'Concert Grand', tone: 'ready' };
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
          darkMode ? 'border-[#1f1b16]/50' : 'border-[#1f1b16]/12',
          'rounded-b-[8px]',
          'bg-gradient-to-b from-[#fdfbf7] via-[#f9f6ef] to-[#efeae0]',
          'shadow-[inset_0_-5px_0_rgba(31,27,22,0.08),inset_1px_0_0_rgba(255,255,255,0.75)]',
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
                'data-[user-pressed=true]:bg-gradient-to-b data-[user-pressed=true]:from-[#dcfce7] data-[user-pressed=true]:to-[#86efac]',
                'data-[user-pressed=true]:shadow-[inset_0_2px_6px_rgba(22,163,74,0.22)]',
                'data-[playback=R]:bg-gradient-to-b data-[playback=R]:from-[#fef3c7] data-[playback=R]:to-[#fcd34d]',
                'data-[playback=R]:shadow-[inset_0_2px_6px_rgba(180,83,9,0.22)]',
                'data-[playback=L]:bg-gradient-to-b data-[playback=L]:from-[#e0f2fe] data-[playback=L]:to-[#7dd3fc]',
                'data-[playback=L]:shadow-[inset_0_2px_6px_rgba(3,105,161,0.22)]',
              ].join(' '),
        ].join(' ')}
      >
        {expectedHand && (
          <span
            style={isRainbow ? { backgroundColor: rainbow.stickerBg } : undefined}
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full ring-2 ring-white z-[5]',
              showAllStickers
                ? isLargeKey
                  ? 'bottom-12 sm:bottom-14'
                  : 'bottom-9 sm:bottom-10'
                : 'bottom-7',
              isLargeKey ? 'w-3 h-3' : 'w-2.5 h-2.5',
              isRainbow
                ? ''
                : expectedHand === 'R'
                  ? 'bg-[#d97706]'
                  : 'bg-[#0284c7]',
            ].join(' ')}
          />
        )}

        {showAllStickers && (
          <span
            style={isRainbow ? { backgroundColor: sticker.bg, color: sticker.text } : undefined}
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-2.5 flex items-center justify-center rounded-full font-semibold ring-1 ring-black/10',
              isLargeKey
                ? 'w-8 h-8 sm:w-9 sm:h-9 text-xs sm:text-sm'
                : 'w-5 h-5 sm:w-6 sm:h-6 text-[10px] sm:text-[11px]',
              isRainbow
                ? ''
                : 'bg-[#efe9df] text-[#1f1b16]',
            ].join(' ')}
          >
            {sticker.shortLabel}
          </span>
        )}

        {showCOnlySticker && (
          <span
            style={isRainbow ? { backgroundColor: sticker.bg, color: sticker.text } : undefined}
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-2 px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none ring-1 ring-black/10',
              isRainbow ? '' : 'bg-[#efe9df] text-[#5e554a]',
            ].join(' ')}
          >
            C
          </span>
        )}

        {showCompactCLabel && (
          <span className="pointer-events-none absolute inset-x-0 bottom-2 text-center font-mono text-[10px] font-medium text-[#7b7266]">
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
          'group absolute top-0 h-[61%] z-10 select-none cursor-pointer rounded-b-[6px] transition-transform duration-75',
          'border-x border-b border-[#12110f]',
          'bg-gradient-to-b from-[#2c2824] via-[#211e1b] to-[#171512]',
          'shadow-[0_3px_5px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.14)]',
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
                'data-[user-pressed=true]:bg-gradient-to-b data-[user-pressed=true]:from-[#22c55e] data-[user-pressed=true]:to-[#15803d]',
                'data-[playback=R]:bg-gradient-to-b data-[playback=R]:from-[#f59e0b] data-[playback=R]:to-[#b45309]',
                'data-[playback=L]:bg-gradient-to-b data-[playback=L]:from-[#38bdf8] data-[playback=L]:to-[#0369a1]',
              ].join(' '),
        ].join(' ')}
      >
        <div className="pointer-events-none absolute inset-x-[18%] top-1 h-[55%] rounded-b-[4px] bg-gradient-to-b from-white/10 to-transparent" />
        {expectedHand && (
          <span
            style={isRainbow ? { backgroundColor: rainbow.stickerBg } : undefined}
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full ring-2 ring-white',
              showBlackSticker ? 'bottom-7' : 'bottom-3',
              isRainbow
                ? ''
                : expectedHand === 'R'
                  ? 'bg-[#d97706]'
                  : 'bg-[#0284c7]',
            ].join(' ')}
          />
        )}
        {showBlackSticker && (
          <span
            style={isRainbow ? { backgroundColor: sticker.bg, color: sticker.text } : undefined}
            className={[
              'pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-1.5 px-1 py-0.5 rounded-[4px] text-[9px] font-semibold leading-none ring-1 ring-black/20',
              isRainbow ? '' : 'bg-[#262421] text-[#efe9de]',
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
        flushTop ? '' : 'rounded-[16px] border',
        !flushTop && (darkMode ? 'border-[#efe9de]/[0.08] bg-[#1c1a18]' : 'border-[#1f1b16]/[0.08] bg-[#fdfbf7]'),
      ].join(' ')}
    >
      {!flushTop && (
        <div
          className={[
            'flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b text-xs',
            darkMode
              ? 'bg-[#1c1a18] border-[#efe9de]/[0.08] text-[#efe9de]'
              : 'bg-[#fdfbf7] border-[#1f1b16]/[0.08] text-[#1f1b16]',
          ].join(' ')}
        >
          <div className="flex items-center gap-3 min-w-0">
            {isRainbow ? (
              <div className="flex items-center gap-1" title="ChromaNotes colors">
                {RAINBOW_DOT_COLORS.map((hex) => (
                  <span
                    key={hex}
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2.5 text-xs font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#d97706]" />
                  R
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#0284c7]" />
                  L
                </span>
              </div>
            )}

            <div
              ref={sustainPillRef}
              data-user-sustain={userSustainDown ? 'true' : 'false'}
              data-playback-sustain="false"
              className={[
                'px-2 py-0.5 rounded-[6px] text-[11px] font-medium border transition-colors duration-150',
                darkMode
                  ? 'border-[#efe9de]/[0.08] bg-[#262421] text-[#8a847a] data-[user-sustain=true]:border-[#e07047]/60 data-[user-sustain=true]:text-[#e07047] data-[playback-sustain=true]:border-[#e07047]/60 data-[playback-sustain=true]:text-[#e07047]'
                  : 'border-[#1f1b16]/[0.08] bg-[#efe9df] text-[#7b7266] data-[user-sustain=true]:border-[#c85a32]/50 data-[user-sustain=true]:text-[#c85a32] data-[playback-sustain=true]:border-[#c85a32]/50 data-[playback-sustain=true]:text-[#c85a32]',
              ].join(' ')}
            >
              Sustain
            </div>

            <div
              className={[
                'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-[6px] text-[11px] font-medium border truncate',
                darkMode
                  ? 'border-[#efe9de]/[0.08] bg-[#262421] text-[#aaa398]'
                  : 'border-[#1f1b16]/[0.08] bg-[#efe9df] text-[#5e554a]',
              ].join(' ')}
            >
              <span
                className={[
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  soundBadge.tone === 'ready'
                    ? darkMode
                      ? 'bg-[#4cc38a]'
                      : 'bg-[#16a34a]'
                    : soundBadge.tone === 'loading'
                      ? darkMode
                        ? 'bg-[#e07047]'
                        : 'bg-[#c85a32]'
                      : darkMode
                        ? 'bg-[#8a847a]'
                        : 'bg-[#7b7266]',
                ].join(' ')}
              />
              <span className="truncate">{soundBadge.text}</span>
            </div>
          </div>

          {!hideControls && (
            <div className="flex items-center gap-2">
              {showOctaveButtons && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={octaveShift <= -2}
                    onClick={() => onOctaveShift(-1)}
                    className={[
                      'px-2 py-0.5 rounded-[6px] font-mono text-[11px] font-medium border transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none',
                      darkMode
                        ? 'border-[#efe9de]/[0.08] bg-[#262421] text-[#efe9de] hover:bg-[#2f2c28]'
                        : 'border-[#1f1b16]/[0.08] bg-[#efe9df] text-[#1f1b16] hover:bg-[#e5dfd4]',
                    ].join(' ')}
                  >
                    -8va
                  </button>
                  <button
                    type="button"
                    disabled={octaveShift >= 3}
                    onClick={() => onOctaveShift(1)}
                    className={[
                      'px-2 py-0.5 rounded-[6px] font-mono text-[11px] font-medium border transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none',
                      darkMode
                        ? 'border-[#efe9de]/[0.08] bg-[#262421] text-[#efe9de] hover:bg-[#2f2c28]'
                        : 'border-[#1f1b16]/[0.08] bg-[#efe9df] text-[#1f1b16] hover:bg-[#e5dfd4]',
                    ].join(' ')}
                  >
                    +8va
                  </button>
                </div>
              )}

              <div
                className={[
                  'inline-flex items-center rounded-[8px] p-0.5',
                  darkMode ? 'bg-[#262421]' : 'bg-[#efe9df]',
                ].join(' ')}
              >
                {RANGE_OPTIONS.map((opt) => {
                  const active = rangeMode === opt.mode;
                  return (
                    <button
                      key={opt.mode}
                      type="button"
                      onClick={() => onRangeModeChange(opt.mode)}
                      className={[
                        'px-2 py-0.5 rounded-[6px] text-[11px] font-medium transition-colors duration-150',
                        active
                          ? darkMode
                            ? 'bg-[#1c1a18] text-[#efe9de]'
                            : 'bg-[#fdfbf7] text-[#1f1b16]'
                          : darkMode
                            ? 'text-[#aaa398] hover:text-[#efe9de]'
                            : 'text-[#5e554a] hover:text-[#1f1b16]',
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
            darkMode
              ? 'h-[4px] w-full bg-[#2b201c]'
              : 'h-[4px] w-full bg-[#3d2b24]'
          }
        />

        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUpOrCancel}
          onPointerCancel={handlePointerUpOrCancel}
          onLostPointerCapture={handlePointerUpOrCancel}
          className="kid-piano-keys relative w-full h-40 sm:h-48 touch-none select-none bg-[#161513] overflow-hidden"
        >
          {layout.whiteKeys.map(renderWhiteKey)}
          {layout.blackKeys.map(renderBlackKey)}
        </div>
      </div>
    </div>
  );
}

export default PianoKeyboard;
