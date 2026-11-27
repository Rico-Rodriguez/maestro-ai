import { frequencyToNote } from '../music/pitch';
import type { MicPitchReading, NoteInput } from './types';
import { createPitchOnsetTracker, detectPitchYin } from './yin';

const FRAME_INTERVAL_MS = 33;
const NOTE_HOLD_MS = 280;
const MAX_CENTS_FOR_NOTE = 35;

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

export type MicControllerOptions = {
  onPitch: (reading: MicPitchReading | null) => void;
  onNote: (event: NoteInput) => void;
  shouldGate: () => boolean;
  audioContext?: AudioContext;
};

export class MicInputController {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private ownsContext = false;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;
  private pendingOffTimers = new Map<number, number>();
  private currentOptions: MicControllerOptions | null = null;
  private epoch = 0;

  isActive(): boolean {
    return this.analyser !== null;
  }

  async start(opts: MicControllerOptions): Promise<void> {
    this.stop();
    const callEpoch = this.epoch;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Microphone unavailable');
      error.name = 'NotFoundError';
      throw error;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        channelCount: 1,
      },
    });

    if (callEpoch !== this.epoch) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const ctx = opts.audioContext ?? new AudioContext();
    const ownsContext = !opts.audioContext;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    if (callEpoch !== this.epoch) {
      stream.getTracks().forEach((track) => track.stop());
      if (ownsContext) {
        ctx.close().catch(() => {});
      }
      return;
    }

    const sourceNode = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    sourceNode.connect(analyser);

    this.stream = stream;
    this.audioContext = ctx;
    this.ownsContext = ownsContext;
    this.sourceNode = sourceNode;
    this.analyser = analyser;
    this.currentOptions = opts;

    const buffer = new Float32Array(analyser.fftSize);
    const tracker = createPitchOnsetTracker();
    let lastSampleMs = -Infinity;

    const tick = () => {
      if (callEpoch !== this.epoch || !this.analyser || !this.audioContext) return;
      this.rafId = requestAnimationFrame(tick);

      const now = performance.now();
      if (now - lastSampleMs < FRAME_INTERVAL_MS) return;
      lastSampleMs = now;

      this.analyser.getFloatTimeDomainData(buffer);
      const yin = detectPitchYin(buffer, this.audioContext.sampleRate);
      const reading = yin ? toPitchReading(yin.freq, yin.clarity) : null;
      opts.onPitch(reading);

      const gated = opts.shouldGate();
      const trackerInput =
        !gated && yin && reading && Math.abs(reading.centsOff) < MAX_CENTS_FOR_NOTE
          ? { midi: reading.midi, rms: yin.rms }
          : null;
      const { triggerMidi } = tracker.process(trackerInput, now);
      if (triggerMidi === null || !yin) return;

      const existingTimer = this.pendingOffTimers.get(triggerMidi);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        this.pendingOffTimers.delete(triggerMidi);
      }

      const velocity = Math.max(55, Math.min(110, Math.round(64 + yin.rms * 250)));
      opts.onNote({ kind: 'on', pitch: triggerMidi, velocity, source: 'mic', timeMs: now });

      const offTimer = window.setTimeout(() => {
        this.pendingOffTimers.delete(triggerMidi);
        if (callEpoch !== this.epoch) return;
        opts.onNote({ kind: 'off', pitch: triggerMidi, source: 'mic', timeMs: performance.now() });
      }, NOTE_HOLD_MS);
      this.pendingOffTimers.set(triggerMidi, offTimer);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.epoch += 1;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    const opts = this.currentOptions;
    this.pendingOffTimers.forEach((timerId, pitch) => {
      window.clearTimeout(timerId);
      opts?.onNote({ kind: 'off', pitch, source: 'mic', timeMs: performance.now() });
    });
    this.pendingOffTimers.clear();

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this.analyser = null;

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
