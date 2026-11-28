import {
  CacheStorage,
  ElectricPiano,
  Reverb,
  SplendidGrandPiano,
  getElectricPianoNames,
  type StopFn,
} from 'smplr';

export type InstrumentVoice = 'grand-piano' | 'electric-piano' | 'warm-upright';
export type AudioSource = 'user' | 'playback';

export type AudioEngineStatus = {
  state: AudioContextState | 'closed';
  unlocked: boolean;
  voice: InstrumentVoice;
  samplesLoaded: number;
  samplesTotal: number;
  usingFallback: boolean;
  playbackSounding: boolean;
};

type AudioSessionType =
  | 'auto'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'ambient'
  | 'play-and-record';

interface NavigatorWithAudioSession extends Navigator {
  audioSession?: { type: AudioSessionType };
}

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

type VoiceEntry = {
  midi: number;
  source: AudioSource;
  stopFn: StopFn;
};

type FallbackVoice = {
  midi: number;
  startedAt: number;
  releasing: boolean;
  stop: (whenSec?: number) => void;
  steal: (whenSec: number) => void;
};

const SILENT_WAV_BASE64 =
  'UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
const SILENT_WAV_URI = `data:audio/wav;base64,${SILENT_WAV_BASE64}`;

const CACHE_NAME = 'maestro-piano-v1';
const REVERB_MIX = 0.2;
const UPRIGHT_LPF_HZ = 2600;
const MAX_FALLBACK_VOICES = 32;
const FALLBACK_DAMPER_TAU_SEC = 0.045;
const FALLBACK_STEAL_TAU_SEC = 0.006;
const PLAYBACK_ECHO_TAIL_SEC = 0.35;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function selectElectricPianoName(): string {
  const names = getElectricPianoNames();
  if (names.includes('WurlitzerEP200')) return 'WurlitzerEP200';
  if (names.includes('CP80')) return 'CP80';
  return names[0] ?? 'CP80';
}

export class PianoAudioEngine {
  private ctx: AudioContext | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private pianoFilter: BiquadFilterNode | null = null;
  private reverb: Reverb | null = null;

  private storage = CacheStorage(CACHE_NAME);
  private grandPiano: SplendidGrandPiano | null = null;
  private electricPiano: ElectricPiano | null = null;
  private grandReverbAttached = false;
  private epReverbAttached = false;

  private grandLoaded = 0;
  private grandTotal = 0;
  private grandReady = false;
  private epLoaded = 0;
  private epTotal = 0;
  private epReady = false;

  private voice: InstrumentVoice = 'grand-piano';
  private volume = 0.85;
  private recording = false;
  private unlocked = false;
  private disposed = false;

  private silentAudioEl: HTMLAudioElement | null = null;
  private statusListeners = new Set<(status: AudioEngineStatus) => void>();

  private activeVoices: Record<AudioSource, Map<number, VoiceEntry[]>> = {
    user: new Map(),
    playback: new Map(),
  };
  private sustainedVoices: Record<AudioSource, VoiceEntry[]> = {
    user: [],
    playback: [],
  };
  private sustainDown: Record<AudioSource, boolean> = {
    user: false,
    playback: false,
  };

  private fallbackVoices: FallbackVoice[] = [];
  private playbackTailUntilCtxTime = -Infinity;
  private playbackTailTimer: ReturnType<typeof setTimeout> | null = null;
  private nextStopId = 1;

  ensureContext(): AudioContext {
    if (this.ctx && this.ctx.state !== 'closed') {
      return this.ctx;
    }

    this.disposed = false;
    void this.applyAudioSession();

    const AudioCtx =
      typeof window !== 'undefined'
        ? window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext
        : globalThis.AudioContext;

    if (!AudioCtx) {
      throw new Error('Web Audio API is unavailable');
    }

    const ctx = new AudioCtx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 16;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.25;

    const masterGain = ctx.createGain();
    masterGain.gain.value = this.volume;

    const pianoFilter = ctx.createBiquadFilter();
    pianoFilter.type = 'lowpass';
    pianoFilter.Q.value = 0.7;
    pianoFilter.frequency.value = this.getGrandFilterCutoff(ctx);

    pianoFilter.connect(compressor);
    compressor.connect(masterGain);
    masterGain.connect(ctx.destination);

    this.compressor = compressor;
    this.masterGain = masterGain;
    this.pianoFilter = pianoFilter;

    const reverb = new Reverb(ctx);
    reverb.connect(compressor);
    this.reverb = reverb;

    ctx.onstatechange = () => {
      if (this.ctx !== ctx) return;
      this.unlocked = ctx.state === 'running';
      this.emitStatus();
    };

    this.initGrandPiano(ctx, pianoFilter, reverb);
    if (this.voice === 'electric-piano') {
      this.ensureElectricPiano(ctx, compressor, reverb);
    }

    this.emitStatus();
    return ctx;
  }

  async unlockFromGesture(): Promise<boolean> {
    await this.applyAudioSession();
    let ctx: AudioContext;
    try {
      ctx = this.ensureContext();
    } catch {
      this.emitStatus();
      return false;
    }

    this.kickHtmlSilence();
    this.kickSilentBuffer(ctx);

    try {
      await ctx.resume();
    } catch {
      // Keep the Web Audio pipeline intact so a subsequent user tap can complete resume.
    }

    this.unlocked = ctx.state === 'running';
    this.emitStatus();
    return this.unlocked;
  }

  noteOn(
    midi: number,
    velocity = 90,
    whenSec?: number,
    source: AudioSource = 'user',
  ): void {
    let ctx: AudioContext;
    try {
      ctx = this.ensureContext();
    } catch {
      return;
    }

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const pitch = clamp(Math.round(midi), 0, 127);
    const vel = clamp(Math.round(velocity), 1, 127);
    const time = whenSec !== undefined ? Math.max(ctx.currentTime, whenSec) : ctx.currentTime;

    this.stopSustainedForPitch(pitch, time, source);

    const inst = this.getReadyInstrumentForVoice();
    // Unique stopId isolates smplr voice stops from subsequent or overlapping voices on the same pitch.
    const stopId = `${source}:${pitch}:${this.nextStopId++}`;
    const stopFn = inst
      ? inst.start({ note: pitch, velocity: vel, time, stopId })
      : this.startFallbackVoice(ctx, pitch, vel, time);

    const entry: VoiceEntry = { midi: pitch, source, stopFn };
    const list = this.activeVoices[source].get(pitch);
    if (list) {
      list.push(entry);
    } else {
      this.activeVoices[source].set(pitch, [entry]);
    }

    if (source === 'playback') {
      this.clearPlaybackTailTimer();
      this.emitStatus();
    }
  }

  noteOff(
    midi: number,
    whenSec?: number,
    source: AudioSource = 'user',
  ): void {
    if (!this.ctx || this.ctx.state === 'closed') return;

    const pitch = clamp(Math.round(midi), 0, 127);
    const list = this.activeVoices[source].get(pitch);
    if (!list || list.length === 0) return;

    const entry = list.shift()!;
    if (list.length === 0) {
      this.activeVoices[source].delete(pitch);
    }

    const time = whenSec !== undefined ? Math.max(this.ctx.currentTime, whenSec) : this.ctx.currentTime;

    if (this.sustainDown[source]) {
      this.sustainedVoices[source].push(entry);
      return;
    }

    entry.stopFn(time);
    if (source === 'playback') {
      this.markPlaybackReleaseTail(time);
    }
  }

  setSustain(
    down: boolean,
    whenSec?: number,
    source: AudioSource = 'user',
  ): void {
    this.sustainDown[source] = down;
    if (down || !this.ctx || this.ctx.state === 'closed') return;

    const time = whenSec !== undefined ? Math.max(this.ctx.currentTime, whenSec) : this.ctx.currentTime;
    const held = this.sustainedVoices[source];
    if (held.length === 0) return;

    for (let i = 0; i < held.length; i += 1) {
      held[i].stopFn(time);
    }
    this.sustainedVoices[source] = [];

    if (source === 'playback') {
      this.markPlaybackReleaseTail(time);
    }
  }

  stopAllPlayback(whenSec?: number): void {
    const ctx = this.ctx;
    const time =
      ctx && ctx.state !== 'closed'
        ? whenSec !== undefined
          ? Math.max(ctx.currentTime, whenSec)
          : ctx.currentTime
        : undefined;

    let stoppedAny = false;

    for (const list of this.activeVoices.playback.values()) {
      for (let i = 0; i < list.length; i += 1) {
        list[i].stopFn(time);
        stoppedAny = true;
      }
    }
    this.activeVoices.playback.clear();

    const sustained = this.sustainedVoices.playback;
    for (let i = 0; i < sustained.length; i += 1) {
      sustained[i].stopFn(time);
      stoppedAny = true;
    }
    this.sustainedVoices.playback = [];
    this.sustainDown.playback = false;

    if (stoppedAny && time !== undefined) {
      this.markPlaybackReleaseTail(time);
    } else {
      this.emitStatus();
    }
  }

  stopAll(): void {
    this.stopAllPlayback();

    const ctx = this.ctx;
    const time = ctx && ctx.state !== 'closed' ? ctx.currentTime : undefined;

    for (const list of this.activeVoices.user.values()) {
      for (let i = 0; i < list.length; i += 1) {
        list[i].stopFn(time);
      }
    }
    this.activeVoices.user.clear();

    const sustained = this.sustainedVoices.user;
    for (let i = 0; i < sustained.length; i += 1) {
      sustained[i].stopFn(time);
    }
    this.sustainedVoices.user = [];
    this.sustainDown.user = false;

    try {
      this.grandPiano?.stop();
    } catch {
      // Ignore if disposed
    }
    try {
      this.electricPiano?.stop();
    } catch {
      // Ignore if disposed
    }
  }

  playMetronomeClick(isDownbeat: boolean, whenSec?: number): void {
    let ctx: AudioContext;
    try {
      ctx = this.ensureContext();
    } catch {
      return;
    }

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const time = whenSec !== undefined ? Math.max(ctx.currentTime, whenSec) : ctx.currentTime;
    const dest = this.masterGain ?? ctx.destination;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isDownbeat ? 1200 : 820, time);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(isDownbeat ? 0.26 : 0.16, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.048);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(time);
    osc.stop(time + 0.055);
  }

  isPlaybackSounding(): boolean {
    if (this.activeVoices.playback.size > 0 || this.sustainedVoices.playback.length > 0) {
      return true;
    }
    if (!this.ctx || this.ctx.state === 'closed') {
      return false;
    }
    return this.ctx.currentTime < this.playbackTailUntilCtxTime;
  }

  setVoice(voice: InstrumentVoice): void {
    if (this.voice === voice) return;
    this.voice = voice;

    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.pianoFilter) {
        const cutoff = this.getGrandFilterCutoff(this.ctx);
        this.pianoFilter.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.015);
      }
      if (voice === 'electric-piano' && this.compressor && this.reverb) {
        this.ensureElectricPiano(this.ctx, this.compressor, this.reverb);
      }
    }

    this.emitStatus();
  }

  setVolume(vol01: number): void {
    this.volume = clamp(vol01, 0, 1);
    if (this.ctx && this.ctx.state !== 'closed' && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015);
    }
  }

  async setRecordingSession(recording: boolean): Promise<void> {
    if (this.recording === recording) return;
    this.recording = recording;
    await this.applyAudioSession();
  }

  getContext(): AudioContext | null {
    return this.ctx;
  }

  getStatus(): AudioEngineStatus {
    const usingEp = this.voice === 'electric-piano';
    const loaded = usingEp ? this.epLoaded : this.grandLoaded;
    const total = usingEp ? this.epTotal : this.grandTotal;
    const ready = usingEp ? this.epReady : this.grandReady;

    return {
      state: this.ctx ? this.ctx.state : 'closed',
      unlocked: this.unlocked,
      voice: this.voice,
      samplesLoaded: loaded,
      samplesTotal: total,
      usingFallback: !(ready && loaded > 0),
      playbackSounding: this.isPlaybackSounding(),
    };
  }

  subscribeStatus(cb: (status: AudioEngineStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.getStatus());
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.stopAll();
    this.clearPlaybackTailTimer();

    try {
      this.grandPiano?.dispose();
    } catch {
      // Ignore
    }
    try {
      this.electricPiano?.dispose();
    } catch {
      // Ignore
    }

    this.grandPiano = null;
    this.electricPiano = null;
    this.grandReverbAttached = false;
    this.epReverbAttached = false;

    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.onstatechange = null;
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.compressor = null;
    this.masterGain = null;
    this.pianoFilter = null;
    this.reverb = null;
    this.unlocked = false;
    this.emitStatus();
  }

  private getGrandFilterCutoff(ctx: AudioContext): number {
    if (this.voice === 'warm-upright') {
      return UPRIGHT_LPF_HZ;
    }
    return Math.min(20000, ctx.sampleRate * 0.45);
  }

  private initGrandPiano(
    ctx: AudioContext,
    destination: AudioNode,
    reverb: Reverb,
  ): void {
    if (this.grandPiano) return;

    const piano = SplendidGrandPiano(ctx, {
      storage: this.storage,
      destination,
      volume: 112,
      onLoadProgress: (progress) => {
        if (this.grandPiano !== piano || this.disposed) return;
        this.grandLoaded = progress.loaded;
        this.grandTotal = progress.total;
        this.emitStatus();
      },
    });
    this.grandPiano = piano;

    this.attachReverb(ctx, piano, reverb, 'grand');

    piano.ready
      .then(() => {
        if (this.grandPiano !== piano || this.disposed) return;
        this.grandReady = true;
        this.grandLoaded = piano.loadProgress.loaded;
        this.grandTotal = piano.loadProgress.total;
        this.emitStatus();
      })
      .catch(() => {
        if (this.grandPiano !== piano || this.disposed) return;
        this.grandReady = false;
        this.emitStatus();
      });
  }

  private ensureElectricPiano(
    ctx: AudioContext,
    destination: AudioNode,
    reverb: Reverb,
  ): void {
    if (this.electricPiano) return;

    const ep = ElectricPiano(ctx, {
      instrument: selectElectricPianoName(),
      storage: this.storage,
      destination,
      volume: 112,
      onLoadProgress: (progress) => {
        if (this.electricPiano !== ep || this.disposed) return;
        this.epLoaded = progress.loaded;
        this.epTotal = progress.total;
        this.emitStatus();
      },
    });
    this.electricPiano = ep;

    this.attachReverb(ctx, ep, reverb, 'ep');

    ep.ready
      .then(() => {
        if (this.electricPiano !== ep || this.disposed) return;
        this.epReady = true;
        this.epLoaded = ep.loadProgress.loaded;
        this.epTotal = ep.loadProgress.total;
        this.emitStatus();
      })
      .catch(() => {
        if (this.electricPiano !== ep || this.disposed) return;
        this.epReady = false;
        this.emitStatus();
      });
  }

  private attachReverb(
    ctx: AudioContext,
    inst: SplendidGrandPiano | ElectricPiano,
    reverb: Reverb,
    which: 'grand' | 'ep',
  ): void {
    const alreadyAttached =
      which === 'grand' ? this.grandReverbAttached : this.epReverbAttached;
    if (alreadyAttached) return;

    const attach = (r: Reverb) => {
      if (this.ctx !== ctx || this.disposed || !r.isReady) return;
      if (which === 'grand' && this.grandReverbAttached) return;
      if (which === 'ep' && this.epReverbAttached) return;

      try {
        inst.output.addEffect('reverb', r, REVERB_MIX);
        if (which === 'grand') {
          this.grandReverbAttached = true;
        } else {
          this.epReverbAttached = true;
        }
      } catch {
        // Instrument disposed before reverb resolved
      }
    };

    if (reverb.isReady) {
      attach(reverb);
    } else {
      reverb.ready().then(attach).catch(() => {});
    }
  }

  private getReadyInstrumentForVoice(): SplendidGrandPiano | ElectricPiano | null {
    if (this.voice === 'electric-piano') {
      if (this.electricPiano && this.epReady && this.epLoaded > 0) {
        return this.electricPiano;
      }
      return null;
    }

    if (this.grandPiano && this.grandReady && this.grandLoaded > 0) {
      return this.grandPiano;
    }
    return null;
  }

  private stopSustainedForPitch(
    midi: number,
    whenSec: number,
    source: AudioSource,
  ): void {
    const sustained = this.sustainedVoices[source];
    if (sustained.length === 0) return;

    const remaining: VoiceEntry[] = [];
    for (let i = 0; i < sustained.length; i += 1) {
      const entry = sustained[i];
      if (entry.midi === midi) {
        entry.stopFn(whenSec);
      } else {
        remaining.push(entry);
      }
    }
    this.sustainedVoices[source] = remaining;
  }

  private startFallbackVoice(
    ctx: AudioContext,
    midi: number,
    velocity: number,
    startTime: number,
  ): StopFn {
    if (this.fallbackVoices.length >= MAX_FALLBACK_VOICES) {
      let victimIndex = this.fallbackVoices.findIndex((v) => v.releasing);
      if (victimIndex < 0) victimIndex = 0;
      const [victim] = this.fallbackVoices.splice(victimIndex, 1);
      victim.steal(startTime);
    }

    const freq = midiToFrequency(midi);
    const normVel = clamp(velocity / 127, 0.08, 1);
    const decaySec = clamp(4.2 * Math.pow(2, (60 - midi) / 28), 0.65, 5.5);

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0.0001, startTime);
    voiceGain.gain.linearRampToValueAtTime(normVel * 0.34, startTime + 0.004);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, startTime + decaySec);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    const nyquistLimit = ctx.sampleRate * 0.45;
    const voiceCeiling = this.voice === 'warm-upright' ? UPRIGHT_LPF_HZ : nyquistLimit;
    const startCutoff = Math.min(voiceCeiling, freq * (2.6 + normVel * 6.5));
    const tailCutoff = Math.min(voiceCeiling, Math.max(220, freq * (1.1 + normVel * 0.9)));
    filter.frequency.setValueAtTime(startCutoff, startTime);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(80, tailCutoff),
      startTime + Math.min(1.2, decaySec * 0.55),
    );

    const dest = this.compressor ?? ctx.destination;
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(clamp(((midi - 60) / 48) * 0.5, -0.55, 0.55), startTime);
      voiceGain.connect(filter);
      filter.connect(panner);
      panner.connect(dest);
    } else {
      voiceGain.connect(filter);
      filter.connect(dest);
    }

    const partials: Array<{ ratio: number; type: OscillatorType; amp: number; detune: number }> = [
      { ratio: 1, type: 'triangle', amp: 0.72, detune: -1.1 },
      { ratio: 1, type: 'sine', amp: 0.52, detune: 1.1 },
      { ratio: 2.0006, type: 'sine', amp: 0.24, detune: 0.4 },
      { ratio: 3.0018, type: 'sine', amp: 0.09, detune: -0.7 },
    ];

    const oscs: OscillatorNode[] = [];
    const maxStopTime = startTime + decaySec + 0.06;

    for (let i = 0; i < partials.length; i += 1) {
      const p = partials[i];
      const pFreq = freq * p.ratio;
      if (pFreq > nyquistLimit) continue;

      const osc = ctx.createOscillator();
      const pGain = ctx.createGain();
      osc.type = p.type;
      osc.frequency.setValueAtTime(pFreq, startTime);
      osc.detune.setValueAtTime(p.detune, startTime);

      const pDecay = decaySec / (1 + i * 0.45);
      pGain.gain.setValueAtTime(p.amp, startTime);
      pGain.gain.exponentialRampToValueAtTime(0.0001, startTime + pDecay);

      osc.connect(pGain);
      pGain.connect(voiceGain);
      osc.start(startTime);
      osc.stop(maxStopTime);
      oscs.push(osc);
    }

    let ended = false;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      const idx = this.fallbackVoices.indexOf(voice);
      if (idx >= 0) this.fallbackVoices.splice(idx, 1);
      try {
        voiceGain.disconnect();
      } catch {
        // Already disconnected
      }
    };

    if (oscs[0]) {
      oscs[0].onended = cleanup;
    }

    const releaseWithTau = (when: number | undefined, tauSec: number, tailSec: number) => {
      if (ended) return;
      voice.releasing = true;
      const t = when !== undefined ? Math.max(ctx.currentTime, when) : ctx.currentTime;
      try {
        voiceGain.gain.cancelScheduledValues(t);
        voiceGain.gain.setTargetAtTime(0.0001, t, tauSec);
        const stopAt = t + tailSec;
        for (let i = 0; i < oscs.length; i += 1) {
          oscs[i].stop(stopAt);
        }
      } catch {
        cleanup();
      }
    };

    const voice: FallbackVoice = {
      midi,
      startedAt: startTime,
      releasing: false,
      stop: (when?: number) => releaseWithTau(when, FALLBACK_DAMPER_TAU_SEC, 0.22),
      steal: (when: number) => releaseWithTau(when, FALLBACK_STEAL_TAU_SEC, 0.03),
    };

    this.fallbackVoices.push(voice);
    return (when?: number) => {
      voice.stop(when);
    };
  }

  private markPlaybackReleaseTail(releaseAudioTime: number): void {
    const tailEnd = releaseAudioTime + PLAYBACK_ECHO_TAIL_SEC;
    if (tailEnd > this.playbackTailUntilCtxTime) {
      this.playbackTailUntilCtxTime = tailEnd;
    }
    this.schedulePlaybackTailTimer();
    this.emitStatus();
  }

  private clearPlaybackTailTimer(): void {
    if (this.playbackTailTimer !== null) {
      clearTimeout(this.playbackTailTimer);
      this.playbackTailTimer = null;
    }
  }

  private schedulePlaybackTailTimer(): void {
    this.clearPlaybackTailTimer();
    if (!this.ctx || this.ctx.state === 'closed') return;
    const remainingMs = Math.max(
      0,
      Math.ceil((this.playbackTailUntilCtxTime - this.ctx.currentTime) * 1000) + 16,
    );
    this.playbackTailTimer = setTimeout(() => {
      this.playbackTailTimer = null;
      this.emitStatus();
    }, remainingMs);
  }

  private async applyAudioSession(): Promise<void> {
    if (typeof navigator !== 'undefined') {
      const nav = navigator as NavigatorWithAudioSession;
      if (nav.audioSession) {
        try {
          nav.audioSession.type = this.recording ? 'play-and-record' : 'playback';
        } catch {
          // Unsupported audioSession value
        }
      }
    }
    await globalThis.__maestroPrimeAudioSession?.(this.recording)?.catch?.(() => {});
  }

  private kickHtmlSilence(): void {
    if (typeof document === 'undefined' || !document.body) return;
    if (!this.silentAudioEl) {
      const el = document.createElement('audio');
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      el.preload = 'auto';
      el.src = SILENT_WAV_URI;
      el.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none';
      document.body.appendChild(el);
      this.silentAudioEl = el;
    }
    try {
      this.silentAudioEl.currentTime = 0;
      const pending = this.silentAudioEl.play();
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {});
      }
    } catch {
      // Next gesture can retry
    }
  }

  private kickSilentBuffer(ctx: AudioContext): void {
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // Context resume still runs
    }
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return;
    const snapshot = this.getStatus();
    for (const cb of this.statusListeners) {
      cb(snapshot);
    }
  }
}

export const pianoEngine = new PianoAudioEngine();

if (typeof window !== 'undefined') {
  globalThis.__maestroResumeAudio = () => {
    void pianoEngine.unlockFromGesture();
  };
}
