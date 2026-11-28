import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pianoEngine } from '../audio/piano-engine';
import type { NoteInput } from '../input/types';

export function useKidsGuide(voice: boolean, midiSound: boolean) {
  const timers = useRef(new Set<number>());
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const mutedUntil = useRef(0);
  const stop = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    timers.current.clear();
    if (utterance.current) window.speechSynthesis?.cancel();
    utterance.current = null;
    pianoEngine.stopAllPlayback();
  }, []);
  const after = useCallback((ms: number, action: () => void) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      action();
    }, ms);
    timers.current.add(id);
  }, []);
  const speak = useCallback((line: string) => {
    if (!voice || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return;
    if (utterance.current) window.speechSynthesis.cancel();
    const speech = new SpeechSynthesisUtterance(line);
    speech.lang = 'en';
    speech.rate = 0.86;
    const englishVoices = window.speechSynthesis.getVoices().filter((item) => item.localService && item.lang.startsWith('en'));
    const localVoice = englishVoices.find((item) => item.default) ?? englishVoices[0];
    if (localVoice) speech.voice = localVoice;
    speech.onend = speech.onerror = () => {
      if (utterance.current === speech) utterance.current = null;
    };
    utterance.current = speech;
    window.speechSynthesis.speak(speech);
  }, [voice]);
  const note = useCallback((pitch: number, duration = 340, velocity = 66) => {
    pianoEngine.noteOn(pitch, velocity, undefined, 'playback');
    after(duration, () => pianoEngine.noteOff(pitch, undefined, 'playback'));
  }, [after]);
  const suppressMic = useCallback(() => {
    mutedUntil.current = performance.now() + 550;
  }, []);
  const cancelSpeech = useCallback(() => {
    if (utterance.current) window.speechSynthesis?.cancel();
    utterance.current = null;
  }, []);
  const gatesMic = useCallback(() =>
    Boolean(utterance.current) || pianoEngine.isPlaybackSounding() || performance.now() < mutedUntil.current,
  []);
  useEffect(() => {
    const quietWhenHidden = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', quietWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', quietWhenHidden);
      stop();
    };
  }, [stop]);
  return useMemo(() => ({ after, speak, note, stop, cancelSpeech, suppressMic, gatesMic, midiSound }),
    [after, speak, note, stop, cancelSpeech, suppressMic, gatesMic, midiSound]);
}

export type KidsGuide = ReturnType<typeof useKidsGuide>;
export type RegisterInput = (
  listener: ((event: NoteInput) => void) | null,
  micGate: (() => boolean) | null,
) => void;

export function useKidsInput(
  register: RegisterInput,
  guide: KidsGuide,
  onPress: (pitch: number, timeMs: number, source: NoteInput['source']) => void,
  quiet = false,
) {
  const live = useRef(new Map<string, { pitch: number; audible: boolean }>());
  const [held, setHeld] = useState<ReadonlySet<number>>(() => new Set());
  const options = useRef({ onPress, quiet });
  options.current = { onPress, quiet };
  const updateHeld = useCallback(() => {
    setHeld(new Set(Array.from(live.current.values(), ({ pitch }) => pitch)));
  }, []);
  const handle = useCallback((event: NoteInput, pointer?: number) => {
    if (event.kind === 'sustain') {
      if (event.source === 'midi' && guide.midiSound) pianoEngine.setSustain(event.down, undefined, 'user');
      return;
    }
    const id = `${event.source}:${pointer ?? event.pitch}`;
    if (event.kind === 'off') {
      const note = live.current.get(id);
      if (note) {
        live.current.delete(id);
        if (note.audible) {
          pianoEngine.noteOff(note.pitch, undefined, 'user');
          guide.suppressMic();
        }
        updateHeld();
      }
      return;
    }
    if (event.source === 'mic' && guide.gatesMic()) return;
    if (event.source === 'touch') void pianoEngine.unlockFromGesture();
    guide.cancelSpeech();
    const audible = event.source === 'touch' || (event.source === 'midi' && guide.midiSound);
    const previous = live.current.get(id);
    if (previous?.audible) pianoEngine.noteOff(previous.pitch, undefined, 'user');
    live.current.set(id, { pitch: event.pitch, audible });
    updateHeld();
    if (audible) {
      pianoEngine.noteOn(event.pitch, options.current.quiet ? 43 : event.velocity, undefined, 'user');
      guide.suppressMic();
    }
    options.current.onPress(event.pitch, event.timeMs, event.source);
  }, [guide, updateHeld]);

  useEffect(() => {
    register(handle, guide.gatesMic);
    const release = () => {
      live.current.forEach(({ pitch, audible }) => {
        if (audible) pianoEngine.noteOff(pitch, undefined, 'user');
      });
      live.current.clear();
      pianoEngine.setSustain(false, undefined, 'user');
    };
    const blur = () => { release(); updateHeld(); };
    const onVisibility = () => { if (document.hidden) blur(); };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      register(null, null);
      release();
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [register, handle, guide.gatesMic, updateHeld]);

  return { handle, held };
}
