import { frequencyToNote } from '../music/pitch';
import type { MicPitchReading, NoteInput } from './types';
import {
  computeRms,
  createPitchOnsetTracker,
  detectPitchYin,
  type PitchOnsetTracker,
} from './yin';

const FRAME_INTERVAL_MS = 33;
const NOTE_HOLD_MS = 280;
const MAX_CENTS_FOR_NOTE = 45;
const MIN_CLARITY_FOR_NOTE = 0.72;

function toPitchReading(freq: number, clarity: number): MicPitchReading | null {
  const note = frequencyToNote(freq);
  if (!note) return null;
  return {
    midi: note.midi,
    name: note.name,
    freq: note.freq,
    centsOff: note.centsOff,
    clarity,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function processMicFrame(
  rms: number,
  freq: number,
  clarity: number,
  nowMs: number,
  opts: MicControllerOptions,
  tracker: PitchOnsetTracker,
  pendingOffTimers: Map<number, ReturnType<typeof setTimeout>>,
  isEpochCurrent: () => boolean,
): void {
  opts.onLevel?.(clamp01(rms * 6));

  const reading = freq > 0 ? toPitchReading(freq, clarity) : null;
  opts.onPitch(reading);

  const gated = opts.shouldGate();
  const trackerInput =
    !gated && reading && reading.clarity >= MIN_CLARITY_FOR_NOTE && Math.abs(reading.centsOff) < MAX_CENTS_FOR_NOTE
      ? { midi: reading.midi, rms }
      : null;
  const { triggerMidi } = tracker.process(trackerInput, nowMs);
  if (triggerMidi === null) return;

  const existingTimer = pendingOffTimers.get(triggerMidi);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
    pendingOffTimers.delete(triggerMidi);
  }

  const velocity = Math.max(55, Math.min(110, Math.round(64 + rms * 250)));
  opts.onNote({ kind: 'on', pitch: triggerMidi, velocity, source: 'mic', timeMs: nowMs });

  const offTimer = setTimeout(() => {
    pendingOffTimers.delete(triggerMidi);
    if (!isEpochCurrent()) return;
    opts.onNote({ kind: 'off', pitch: triggerMidi, source: 'mic', timeMs: performance.now() });
  }, NOTE_HOLD_MS);
  pendingOffTimers.set(triggerMidi, offTimer);
}

export type MicControllerOptions = {
  onPitch: (reading: MicPitchReading | null) => void;
  onNote: (event: NoteInput) => void;
  onLevel?: (level01: number) => void;
  shouldGate: () => boolean;
  audioContext?: AudioContext;
};

export class MicInputController {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private ownsContext = false;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private silentGain: GainNode | null = null;
  private rafId: number | null = null;
  private nativeStop: (() => Promise<void>) | null = null;
  private pendingOffTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private currentOptions: MicControllerOptions | null = null;
  private epoch = 0;

  isActive(): boolean {
    return this.analyser !== null || this.nativeStop !== null;
  }

  async start(opts: MicControllerOptions): Promise<void> {
    this.stop();
    const callEpoch = this.epoch;
    const isCurrent = () => callEpoch === this.epoch;
    const tracker = createPitchOnsetTracker();

    if (globalThis.__maestroNativeMic) {
      this.currentOptions = opts;
      let nativeStop: (() => Promise<void>) | null = null;
      try {
        nativeStop = await globalThis.__maestroNativeMic.start((frame) => {
          if (!isCurrent()) return;
          processMicFrame(
            frame.rms,
            frame.freq,
            frame.clarity,
            performance.now(),
            opts,
            tracker,
            this.pendingOffTimers,
            isCurrent,
          );
        });
      } catch (err) {
        if (isCurrent()) {
          this.currentOptions = null;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (/permission|denied/i.test(message)) {
          const permissionError = new Error(message);
          permissionError.name = 'NotAllowedError';
          throw permissionError;
        }
        throw err;
      }

      if (!isCurrent()) {
        await nativeStop().catch(() => {});
        return;
      }
      this.nativeStop = nativeStop;
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Microphone unavailable');
      error.name = 'NotFoundError';
      throw error;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'OverconstrainedError' || name === 'ConstraintNotSupportedError') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        throw err;
      }
    }

    if (!isCurrent()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const ctx = opts.audioContext ?? new AudioContext();
    const ownsContext = !opts.audioContext;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    if (!isCurrent()) {
      stream.getTracks().forEach((track) => track.stop());
      if (ownsContext) {
        ctx.close().catch(() => {});
      }
      return;
    }

    const sourceNode = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(analyser);
    analyser.connect(silentGain);
    silentGain.connect(ctx.destination);

    this.stream = stream;
    this.audioContext = ctx;
    this.ownsContext = ownsContext;
    this.sourceNode = sourceNode;
    this.analyser = analyser;
    this.silentGain = silentGain;
    this.currentOptions = opts;

    const buffer = new Float32Array(analyser.fftSize);
    let lastSampleMs = -Infinity;

    const tick = () => {
      if (!isCurrent() || !this.analyser || !this.audioContext) return;
      this.rafId = requestAnimationFrame(tick);

      const now = performance.now();
      if (now - lastSampleMs < FRAME_INTERVAL_MS) return;
      lastSampleMs = now;

      this.analyser.getFloatTimeDomainData(buffer);
      const rms = computeRms(buffer);
      const yin = detectPitchYin(buffer, this.audioContext.sampleRate);
      processMicFrame(
        rms,
        yin?.freq ?? 0,
        yin?.clarity ?? 0,
        now,
        opts,
        tracker,
        this.pendingOffTimers,
        isCurrent,
      );
    };

    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.epoch += 1;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.nativeStop) {
      const nativeStop = this.nativeStop;
      this.nativeStop = null;
      void nativeStop().catch(() => {});
    }

    const opts = this.currentOptions;
    this.pendingOffTimers.forEach((timerId, pitch) => {
      clearTimeout(timerId);
      opts?.onNote({ kind: 'off', pitch, source: 'mic', timeMs: performance.now() });
    });
    this.pendingOffTimers.clear();

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.silentGain) {
      this.silentGain.disconnect();
      this.silentGain = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.audioContext && this.ownsContext) {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.ownsContext = false;
    this.currentOptions = null;
  }
}
