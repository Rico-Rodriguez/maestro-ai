import type { NoteInput } from './types';

const CODE_TO_BASE_MIDI: Record<string, number> = {
  KeyZ: 48,
  KeyS: 49,
  KeyX: 50,
  KeyD: 51,
  KeyC: 52,
  KeyV: 53,
  KeyG: 54,
  KeyB: 55,
  KeyH: 56,
  KeyN: 57,
  KeyJ: 58,
  KeyM: 59,
  KeyQ: 60,
  Digit2: 61,
  KeyW: 62,
  Digit3: 63,
  KeyE: 64,
  KeyR: 65,
  Digit5: 66,
  KeyT: 67,
  Digit6: 68,
  KeyY: 69,
  Digit7: 70,
  KeyU: 71,
  KeyI: 72,
  Digit9: 73,
  KeyO: 74,
  Digit0: 75,
  KeyP: 76,
  BracketLeft: 77,
  Equal: 78,
  BracketRight: 79,
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export type KeyboardInputOptions = {
  octaveShift: () => number;
  onNote: (e: NoteInput) => void;
  onTogglePlay: () => void;
  onShiftOctave: (delta: number) => void;
};

export function attachKeyboardInput(opts: KeyboardInputOptions): () => void {
  const activePitches = new Map<string, number>();
  const activeSustainCodes = new Set<string>();

  const releaseAll = () => {
    const timeMs = performance.now();
    activePitches.forEach((pitch) => {
      opts.onNote({ kind: 'off', pitch, source: 'kbd', timeMs });
    });
    activePitches.clear();

    if (activeSustainCodes.size > 0) {
      activeSustainCodes.clear();
      opts.onNote({ kind: 'sustain', down: false, source: 'kbd', timeMs });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) {
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      opts.onTogglePlay();
      return;
    }

    if (e.code === 'Comma') {
      opts.onShiftOctave(-1);
      return;
    }

    if (e.code === 'Period') {
      opts.onShiftOctave(1);
      return;
    }

    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (!activeSustainCodes.has(e.code)) {
        const wasDown = activeSustainCodes.size > 0;
        activeSustainCodes.add(e.code);
        if (!wasDown) {
          opts.onNote({ kind: 'sustain', down: true, source: 'kbd', timeMs: performance.now() });
        }
      }
      return;
    }

    const baseMidi = CODE_TO_BASE_MIDI[e.code];
    if (baseMidi === undefined || activePitches.has(e.code)) return;

    const pitch = baseMidi + opts.octaveShift() * 12;
    if (pitch < 0 || pitch > 127) return;

    activePitches.set(e.code, pitch);
    opts.onNote({ kind: 'on', pitch, velocity: 92, source: 'kbd', timeMs: performance.now() });
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (activeSustainCodes.delete(e.code) && activeSustainCodes.size === 0) {
        opts.onNote({ kind: 'sustain', down: false, source: 'kbd', timeMs: performance.now() });
      }
      return;
    }

    const pitch = activePitches.get(e.code);
    if (pitch === undefined) return;

    activePitches.delete(e.code);
    opts.onNote({ kind: 'off', pitch, source: 'kbd', timeMs: performance.now() });
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      releaseAll();
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', releaseAll);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    releaseAll();
  };
}
