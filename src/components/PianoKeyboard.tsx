import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { AudioEngineStatus } from '../audio/piano-engine';
import type { Hand, NoteEvent } from '../music/types';
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
}

const RANGE_OPTIONS: readonly { mode: PianoRangeMode; label: string }[] = [
  { mode: 'auto', label: 'Auto' },
  { mode: '61', label: '61' },
  { mode: '88', label: '88' },
  { mode: 'compact', label: '25' },
];

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

  const renderWhiteKey = (key: KeyGeom) => {
    const isPressed = userPressedNotes.has(key.midi);
    const expectedHand = expectedByMidi.get(key.midi);

    return (
      <div
        key={key.midi}
        ref={(el) => registerKeyNode(key.midi, el)}
        data-midi={key.midi}
        data-user-pressed={isPressed ? 'true' : 'false'}
        style={{
          left: `${key.x * 100}%`,
          width: `${key.width * 100}%`,
        }}
        className={[
          'group absolute top-0 bottom-0 select-none cursor-pointer border-r transition-transform duration-75',
          darkMode ? 'border-stone-400/70' : 'border-stone-300',
          'rounded-b-[5px]',
          'bg-gradient-to-b from-[#faf8f3] via-[#f4f0e6] to-[#e6dfd1]',
          'shadow-[inset_0_-6px_0_rgba(120,113,108,0.22),inset_1px_0_0_rgba(255,255,255,0.8)]',
          'data-[user-pressed=true]:translate-y-[2px]',
          'data-[user-pressed=true]:bg-gradient-to-b data-[user-pressed=true]:from-emerald-100 data-[user-pressed=true]:via-emerald-200 data-[user-pressed=true]:to-emerald-400',
          'data-[user-pressed=true]:shadow-[inset_0_3px_8px_rgba(6,95,70,0.35)]',
          'data-[playback=R]:translate-y-[2px]',
          'data-[playback=R]:bg-gradient-to-b data-[playback=R]:from-amber-100 data-[playback=R]:via-amber-200 data-[playback=R]:to-amber-400',
          'data-[playback=R]:shadow-[inset_0_3px_8px_rgba(180,83,9,0.35)]',
          'data-[playback=L]:translate-y-[2px]',
          'data-[playback=L]:bg-gradient-to-b data-[playback=L]:from-sky-100 data-[playback=L]:via-sky-200 data-[playback=L]:to-sky-400',
          'data-[playback=L]:shadow-[inset_0_3px_8px_rgba(3,105,161,0.35)]',
        ].join(' ')}
      >
        {expectedHand && (
          <span
            className={[
              'pointer-events-none absolute left-1/2 bottom-7 -translate-x-1/2 w-3.5 h-3.5 rounded-full ring-4',
              expectedHand === 'R'
                ? 'bg-amber-500 ring-amber-400/40 shadow-[0_0_12px_rgba(245,158,11,0.8)]'
                : 'bg-sky-500 ring-sky-400/40 shadow-[0_0_12px_rgba(56,189,248,0.8)]',
            ].join(' ')}
          />
        )}
        {key.isC && layout.whiteCount <= 52 && (
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

    return (
      <div
        key={key.midi}
        ref={(el) => registerKeyNode(key.midi, el)}
        data-midi={key.midi}
        data-user-pressed={isPressed ? 'true' : 'false'}
        style={{
          left: `${key.x * 100}%`,
          width: `${key.width * 100}%`,
        }}
        className={[
          'group absolute top-0 h-[61%] z-10 select-none cursor-pointer rounded-b-[4px] transition-transform duration-75',
          'border-x border-b border-black/90',
          'bg-gradient-to-b from-stone-800 via-stone-900 to-black',
          'shadow-[0_4px_6px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-4px_2px_rgba(255,255,255,0.08)]',
          'data-[user-pressed=true]:translate-y-[2px]',
          'data-[user-pressed=true]:bg-gradient-to-b data-[user-pressed=true]:from-emerald-500 data-[user-pressed=true]:via-emerald-700 data-[user-pressed=true]:to-emerald-950',
          'data-[user-pressed=true]:shadow-[0_1px_2px_rgba(0,0,0,0.6),inset_0_2px_6px_rgba(16,185,129,0.55)]',
          'data-[playback=R]:translate-y-[2px]',
          'data-[playback=R]:bg-gradient-to-b data-[playback=R]:from-amber-400 data-[playback=R]:via-amber-600 data-[playback=R]:to-amber-950',
          'data-[playback=R]:shadow-[0_1px_2px_rgba(0,0,0,0.6),inset_0_2px_6px_rgba(245,158,11,0.55)]',
          'data-[playback=L]:translate-y-[2px]',
          'data-[playback=L]:bg-gradient-to-b data-[playback=L]:from-sky-400 data-[playback=L]:via-sky-600 data-[playback=L]:to-sky-950',
          'data-[playback=L]:shadow-[0_1px_2px_rgba(0,0,0,0.6),inset_0_2px_6px_rgba(56,189,248,0.55)]',
        ].join(' ')}
      >
        <div className="pointer-events-none absolute inset-x-[18%] top-1 h-[55%] rounded-b-sm bg-gradient-to-b from-white/15 to-transparent" />
        {expectedHand && (
          <span
            className={[
              'pointer-events-none absolute left-1/2 bottom-3 -translate-x-1/2 w-2.5 h-2.5 rounded-full ring-2',
              expectedHand === 'R'
                ? 'bg-amber-400 ring-amber-300/50 shadow-[0_0_10px_rgba(245,158,11,0.9)]'
                : 'bg-sky-400 ring-sky-300/50 shadow-[0_0_10px_rgba(56,189,248,0.9)]',
            ].join(' ')}
          />
        )}
      </div>
    );
  };

  return (
    <div
      className={[
        'w-full flex flex-col overflow-hidden rounded-b-xl border select-none',
        darkMode ? 'border-stone-800 bg-stone-950' : 'border-stone-300 bg-stone-900',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-gradient-to-b from-stone-900 via-stone-950 to-black border-b border-stone-800 text-stone-200">
        <div className="flex items-center gap-3 min-w-0">
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

        <div className="flex items-center gap-1.5">
          {rangeMode === 'compact' && (
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
      </div>

      <div className="h-[4px] w-full bg-gradient-to-b from-red-950 via-red-800 to-red-950 shadow-[0_2px_4px_rgba(0,0,0,0.6)]" />

      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUpOrCancel}
        onPointerCancel={handlePointerUpOrCancel}
        onLostPointerCapture={handlePointerUpOrCancel}
        className="relative w-full h-36 sm:h-44 touch-none select-none bg-stone-950 overflow-hidden"
      >
        {layout.whiteKeys.map(renderWhiteKey)}
        {layout.blackKeys.map(renderBlackKey)}
      </div>
    </div>
  );
}

export default PianoKeyboard;

