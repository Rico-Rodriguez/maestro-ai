// Poteto mode keeps iPhone and iPad sound on a short, direct path.
// Safari can show the tab speaker icon while Web Audio is still silent:
// the context was opened before a tap, the silent switch treats Web Audio
// like the ringer, or a heavy sample graph stalls the audio thread.
// The fix is a user-gesture unlock plus oscillators straight to the speakers.

export const SILENT_WAV_BASE64 = 'UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

export const SILENT_WAV_URI = `data:audio/wav;base64,${SILENT_WAV_BASE64}`;

export const SALAMANDER_SAMPLE_MAP = {
  24: 'C1.mp3', 27: 'Ds1.mp3', 30: 'Fs1.mp3', 33: 'A1.mp3',
  36: 'C2.mp3', 39: 'Ds2.mp3', 42: 'Fs2.mp3', 45: 'A2.mp3',
  48: 'C3.mp3', 51: 'Ds3.mp3', 54: 'Fs3.mp3', 57: 'A3.mp3',
  60: 'C4.mp3', 63: 'Ds4.mp3', 66: 'Fs4.mp3', 69: 'A4.mp3',
  72: 'C5.mp3', 75: 'Ds5.mp3', 78: 'Fs5.mp3', 81: 'A5.mp3',
  84: 'C6.mp3', 87: 'Ds6.mp3', 90: 'Fs6.mp3', 93: 'A6.mp3',
  96: 'C7.mp3',
};
// Document-relative so GitHub Pages (/maestro-ai/) and the iOS bundle (/) both resolve.
export const SALAMANDER_BASE_URL = 'audio/salamander/';
const SAMPLE_COUNT = Object.keys(SALAMANDER_SAMPLE_MAP).length;

export function primeNativeAudioSession(recording) {
  const hook = globalThis.__maestroPrimeAudioSession;
  if (typeof hook !== 'function') return Promise.resolve(false);
  try {
    return Promise.resolve(hook(Boolean(recording))).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function isIosLike(nav = typeof navigator === 'undefined' ? undefined : navigator) {
  if (!nav) return false;
  const ua = nav.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1;
}

export function isCapacitorNative() {
  const cap = globalThis.Capacitor;
  return Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

// Safari on iPhone keeps the short oscillator. The Capacitor app plays the
// bundled Salamander samples, same as the desktop site.
export function usesSimplePiano(nav) {
  if (isCapacitorNative()) return false;
  return isIosLike(nav);
}

export function audioSessionType({ recording = false } = {}) {
  return recording ? 'play-and-record' : 'playback';
}

export function applyAudioSession(nav, options) {
  const session = nav && nav.audioSession;
  if (!session) return false;
  const type = audioSessionType(options);
  try {
    session.type = type;
    return true;
  } catch {
    return false;
  }
}

export function silentWavBytes() {
  const binary = atob(SILENT_WAV_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isSilentWav(bytes) {
  if (!bytes || bytes.length < 44) return false;
  const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  return head === 'RIFF' && wave === 'WAVE';
}

export function detectPitch(buf, sampleRate) {
  const n = buf.length;
  if (!n || !sampleRate) return -1;
  let rms = 0;
  for (let i = 0; i < n; i += 1) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.018) return -1;

  const minLag = Math.max(2, Math.floor(sampleRate / 1400));
  const maxLag = Math.min(n - 2, Math.floor(sampleRate / 60));
  if (maxLag <= minLag) return -1;

  const values = new Float32Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i += 2) sum += buf[i] * buf[i + lag];
    values[lag] = sum;
    if (sum > best) best = sum;
  }
  if (best <= 0) return -1;

  const threshold = best * 0.9;
  let lag = minLag;
  while (lag <= maxLag && values[lag] < threshold) lag += 1;
  while (lag < maxLag && values[lag + 1] > values[lag]) lag += 1;
  if (lag <= 0) return -1;
  return sampleRate / lag;
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function frequencyToNote(freq) {
  if (!freq || freq <= 20) return null;
  const floatMidi = 69 + 12 * Math.log2(freq / 440);
  const rounded = Math.round(floatMidi);
  if (rounded < 21 || rounded > 108) return null;
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(rounded / 12) - 1;
  return {
    midi: rounded,
    name: `${names[rounded % 12]}${octave}`,
    freq: Math.round(freq * 10) / 10,
    centsOff: Math.round((floatMidi - rounded) * 100),
  };
}

function safeExpRamp(param, value, time) {
  const level = Math.max(0.0001, value);
  try {
    param.exponentialRampToValueAtTime(level, time);
  } catch {
    try { param.linearRampToValueAtTime(level, time); } catch { /* already stopped */ }
  }
}

export class MaestroAudioEngine {
  constructor() {
    this.ctx = null;
    this.instrument = 'grand-piano';
    this.volume = 0.85;
    this.micStream = null;
    this.analyser = null;
    this.micRaf = null;
    this.compressor = null;
    this.reverbNode = null;
    this.output = null;
    this.sampleBuffers = new Map();
    this.encodedSamples = new Map();
    this.fetchStarted = false;
    this.decoding = false;
    this.decodeAgain = false;
    this.samplesLoadedCount = 0;
    this.onSampleStatusChange = null;
    this.onStatus = null;
    this.potetoMode = usesSimplePiano();
    this.forcePotato = false;
    this.unlocked = false;
    this.stalled = false;
    this.silentEl = null;
    this.voices = [];
  }

  statusSnapshot() {
    return {
      running: this.ctx?.state === 'running',
      unlocked: this.unlocked,
      stalled: this.stalled,
      poteto: this.potetoMode || this.forcePotato,
      state: this.ctx?.state || 'closed',
    };
  }

  emitStatus() {
    if (this.onStatus) this.onStatus(this.statusSnapshot());
  }

  noteStall() {
    if (this.stalled) return;
    this.stalled = true;
    if (!isCapacitorNative()) this.forcePotato = true;
    this.unlocked = false;
    this.emitStatus();
  }

  primeSession(recording = false) {
    if (typeof navigator === 'undefined') return Promise.resolve(false);
    const active = recording || Boolean(this.micStream);
    const webOk = applyAudioSession(navigator, { recording: active });
    return primeNativeAudioSession(active).then(() => webOk);
  }

  closeContext() {
    const ctx = this.ctx;
    this.ctx = null;
    this.output = null;
    this.compressor = null;
    this.reverbNode = null;
    this.sampleBuffers.clear();
    this.samplesLoadedCount = 0;
    this.decoding = false;
    this.voices = [];
    this.unlocked = false;
    if (this.analyser) this.analyser = null;
    if (ctx && ctx.state !== 'closed') {
      ctx.onstatechange = null;
      ctx.close().catch(() => {});
    }
    this.onSampleStatusChange?.(0, SAMPLE_COUNT);
  }

  ensureContext() {
    this.potetoMode = usesSimplePiano();
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    this.primeSession(false);
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio is unavailable');
    this.ctx = new AudioCtx({ latencyHint: 'interactive' });

    if (this.potetoMode || this.forcePotato || isCapacitorNative()) {
      this.output = this.ctx.destination;
    } else {
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 16;
      this.compressor.ratio.value = 3;
      this.compressor.attack.value = 0.002;
      this.compressor.release.value = 0.25;
      this.reverbNode = this.createSoundboardReverb(this.ctx);
      const reverbGain = this.ctx.createGain();
      reverbGain.gain.value = 0.18;
      this.compressor.connect(this.ctx.destination);
      this.compressor.connect(this.reverbNode);
      this.reverbNode.connect(reverbGain);
      reverbGain.connect(this.ctx.destination);
      this.output = this.compressor;
    }

    this.ctx.onstatechange = () => {
      const state = this.ctx?.state;
      if (state === 'suspended' || state === 'interrupted') {
        this.unlocked = false;
        this.ctx?.resume?.().catch(() => {});
      } else if (state === 'running') {
        this.unlocked = true;
        this.stalled = false;
      }
      this.emitStatus();
    };
    return this.ctx;
  }

  init() {
    return this.ensureContext();
  }

  kickHtmlSilence() {
    if (typeof document === 'undefined') return;
    if (!this.silentEl) {
      const el = document.createElement('audio');
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.playsInline = true;
      el.preload = 'auto';
      el.src = SILENT_WAV_URI;
      el.setAttribute('style', 'position:fixed;width:0;height:0;opacity:0;pointer-events:none');
      document.body.appendChild(el);
      this.silentEl = el;
    }
    try {
      this.silentEl.currentTime = 0;
      const pending = this.silentEl.play();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* the next tap can try again */ }
  }

  kickSilentBuffer(ctx) {
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
    } catch { /* unlock still tries resume() */ }
  }

  unlockFromGesture() {
    this.potetoMode = usesSimplePiano();
    this.preloadAcousticSamples();
    this.primeSession(false);
    if (this.stalled) {
      if (!isCapacitorNative()) this.forcePotato = true;
      this.stalled = false;
      this.closeContext();
    }
    let ctx;
    try {
      ctx = this.ensureContext();
    } catch {
      this.emitStatus();
      return Promise.resolve(false);
    }
    if (ctx.state === 'running' && this.unlocked) {
      this.emitStatus();
      return Promise.resolve(true);
    }
    this.kickHtmlSilence();
    this.kickSilentBuffer(ctx);
    let resumePromise;
    try {
      resumePromise = ctx.resume();
    } catch {
      resumePromise = Promise.resolve();
    }
    return Promise.resolve(resumePromise)
      .then(() => {
        const running = ctx.state === 'running';
        this.unlocked = running;
        if (running) this.decodeQueuedSamples();
        this.emitStatus();
        return running;
      })
      .catch(() => {
        this.emitStatus();
        return false;
      });
  }

  async preloadAcousticSamples() {
    this.potetoMode = usesSimplePiano();
    if (this.potetoMode || (this.forcePotato && !isCapacitorNative()) || this.fetchStarted) return;
    this.fetchStarted = true;
    const entries = Object.entries(SALAMANDER_SAMPLE_MAP);
    await Promise.allSettled(entries.map(async ([midiStr, file]) => {
      try {
        const res = await fetch(`${SALAMANDER_BASE_URL}${file}`);
        if (!res.ok) return;
        this.encodedSamples.set(parseInt(midiStr, 10), await res.arrayBuffer());
        if (this.ctx && this.ctx.state === 'running') this.decodeQueuedSamples();
      } catch { /* oscillator fallback covers a failed sample */ }
    }));
  }

  async decodeQueuedSamples() {
    if (this.potetoMode || (this.forcePotato && !isCapacitorNative()) || !this.ctx || this.ctx.state !== 'running') return;
    if (this.decoding) {
      this.decodeAgain = true;
      return;
    }
    this.decoding = true;
    const ctx = this.ctx;
    const pending = [...this.encodedSamples.entries()].sort(
      (a, b) => Math.abs(a[0] - 60) - Math.abs(b[0] - 60)
    );
    for (const [midi, encoded] of pending) {
      if (this.ctx !== ctx || this.sampleBuffers.has(midi)) continue;
      try {
        const audioBuf = await ctx.decodeAudioData(encoded.slice(0));
        if (!audioBuf || audioBuf.length < 8 || this.ctx !== ctx) continue;
        this.sampleBuffers.set(midi, audioBuf);
        this.samplesLoadedCount = this.sampleBuffers.size;
        this.onSampleStatusChange?.(this.samplesLoadedCount, SAMPLE_COUNT);
      } catch { /* keep the modeled piano for this key */ }
    }
    this.decoding = false;
    if (this.decodeAgain) {
      this.decodeAgain = false;
      this.decodeQueuedSamples();
    }
  }

  findClosestSample(midi) {
    if (this.sampleBuffers.size === 0) return null;
    let closestMidi = null;
    let minDiff = Infinity;
    for (const sampleMidi of this.sampleBuffers.keys()) {
      const diff = Math.abs(midi - sampleMidi);
      if (diff < minDiff) {
        minDiff = diff;
        closestMidi = sampleMidi;
      }
    }
    if (closestMidi === null) return null;
    return { baseMidi: closestMidi, buffer: this.sampleBuffers.get(closestMidi) };
  }

  createSoundboardReverb(ctx) {
    const length = Math.floor(ctx.sampleRate * 1.65);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch += 1) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i += 1) {
        const decay = Math.exp(-i / (ctx.sampleRate * 0.42));
        data[i] = (Math.random() * 2 - 1) * decay * 0.45;
      }
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse;
    return convolver;
  }

  trackVoice(node) {
    this.voices.push(node);
    const cap = this.potetoMode || this.forcePotato ? 16 : 32;
    while (this.voices.length > cap) {
      const old = this.voices.shift();
      try { old.stop(); } catch { /* already ended */ }
    }
    node.onended = () => {
      const index = this.voices.indexOf(node);
      if (index >= 0) this.voices.splice(index, 1);
    };
  }

  playPotato(ctx, midi, durationSec, velocity) {
    const now = ctx.currentTime;
    const freq = midiToFrequency(midi);
    const normVel = Math.max(0.22, Math.min(1, velocity / 127));
    const dur = Math.max(0.22, Math.min(Number(durationSec) || 0.5, 2.4));
    const peak = normVel * this.volume * 0.62;
    const partials = [
      { ratio: 1, type: 'triangle', amp: 0.85 },
      { ratio: 2, type: 'sine', amp: 0.2 },
    ];
    partials.forEach((partial) => {
      if (freq * partial.ratio > ctx.sampleRate * 0.45) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = partial.type;
      osc.frequency.setValueAtTime(freq * partial.ratio, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(peak * partial.amp, now + 0.012);
      gain.gain.linearRampToValueAtTime(0.0001, now + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + dur + 0.03);
      this.trackVoice(osc);
    });
  }

  playSample(ctx, sampleMatch, midi, durationSec, velocity, direct) {
    const now = ctx.currentTime;
    const normVel = Math.max(0.18, Math.min(1, velocity / 127));
    const src = ctx.createBufferSource();
    src.buffer = sampleMatch.buffer;
    const rate = Math.pow(2, (midi - sampleMatch.baseMidi) / 12);
    src.playbackRate.setValueAtTime(Number.isFinite(rate) && rate > 0 ? rate : 1, now);
    const gain = ctx.createGain();
    const peak = normVel * this.volume * (direct ? 0.9 : 0.95);
    const hold = Math.max(0.25, Math.min(Number(durationSec) || 0.6, 3.2));
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.008);
    gain.gain.linearRampToValueAtTime(0.0001, now + hold + 0.28);
    if (direct) {
      src.connect(gain);
    } else {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(Math.min(18000, 1400 + normVel * 14000), now);
      src.connect(filter);
      filter.connect(gain);
    }
    gain.connect(direct ? ctx.destination : (this.output || ctx.destination));
    src.start(now);
    src.stop(now + hold + 0.36);
    this.trackVoice(src);
  }

  playModeled(ctx, midi, durationSec, velocity) {
    const now = ctx.currentTime;
    const freq = midiToFrequency(midi);
    const normVel = Math.max(0.18, Math.min(1, velocity / 127));
    const peakGain = normVel * this.volume * 0.42;
    const registerDecayScale = Math.max(0.45, Math.min(1.9, (88 - midi) / 36));
    const effectiveSustain = Math.max(durationSec, 0.42) * registerDecayScale;
    const dest = this.output || ctx.destination;

    const noteBus = ctx.createGain();
    noteBus.connect(dest);

    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    const initialCutoff = Math.min(12000, freq * (3.8 + normVel * 4.5));
    const tailCutoff = Math.max(280, freq * 1.4);
    bodyFilter.frequency.setValueAtTime(initialCutoff, now);
    bodyFilter.frequency.linearRampToValueAtTime(tailCutoff, now + Math.min(0.85, effectiveSustain * 0.7));
    bodyFilter.Q.value = 0.65;
    bodyFilter.connect(noteBus);

    if (this.instrument === 'electric-rhodes') {
      const fund = ctx.createOscillator();
      const tine = ctx.createOscillator();
      const tineGain = ctx.createGain();
      fund.type = 'sine';
      tine.type = 'sine';
      fund.frequency.setValueAtTime(freq, now);
      tine.frequency.setValueAtTime(freq * 7, now);
      tineGain.gain.setValueAtTime(0.15 * normVel, now);
      safeExpRamp(tineGain.gain, 0.001, now + 0.18);
      fund.connect(bodyFilter);
      tine.connect(tineGain);
      tineGain.connect(bodyFilter);
      fund.start(now);
      tine.start(now);
      fund.stop(now + effectiveSustain + 0.3);
      tine.stop(now + 0.22);
      this.trackVoice(fund);
    } else if (this.instrument === 'warm-strings') {
      [-6, 0, 6].forEach((det) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now);
        osc.detune.setValueAtTime(det, now);
        g.gain.value = 0.24;
        osc.connect(g);
        g.connect(bodyFilter);
        osc.start(now);
        osc.stop(now + effectiveSustain + 0.35);
        this.trackVoice(osc);
      });
    } else {
      const partials = [
        { ratio: 1, amp: 1, type: 'sine', detune: -1.2 },
        { ratio: 1, amp: 0.65, type: 'triangle', detune: 1.2 },
        { ratio: 2.0005, amp: 0.28, type: 'sine', detune: 0.4 },
        { ratio: 3.0015, amp: 0.11, type: 'sine', detune: -0.8 },
      ];
      partials.forEach((p, idx) => {
        const partialFreq = freq * p.ratio;
        if (partialFreq > ctx.sampleRate * 0.45) return;
        const osc = ctx.createOscillator();
        const pGain = ctx.createGain();
        osc.type = p.type;
        osc.frequency.setValueAtTime(partialFreq, now);
        osc.detune.setValueAtTime(p.detune, now);
        pGain.gain.setValueAtTime(p.amp, now);
        safeExpRamp(pGain.gain, 0.001, now + effectiveSustain / (1 + idx * 0.5) + 0.25);
        osc.connect(pGain);
        pGain.connect(bodyFilter);
        osc.start(now);
        osc.stop(now + effectiveSustain / (1 + idx * 0.5) + 0.28);
        this.trackVoice(osc);
      });
    }

    const attackSec = this.instrument === 'warm-strings' ? 0.065 : 0.005;
    noteBus.gain.setValueAtTime(0.0001, now);
    noteBus.gain.linearRampToValueAtTime(peakGain, now + attackSec);
    noteBus.gain.linearRampToValueAtTime(peakGain * 0.55, now + attackSec + 0.09);
    noteBus.gain.linearRampToValueAtTime(0.0001, now + effectiveSustain + 0.32);
  }

  playNote(midi, durationSec = 0.65, velocity = 90) {
    this.potetoMode = usesSimplePiano();
    let ctx;
    try {
      ctx = this.ensureContext();
    } catch {
      return false;
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    try {
      if (!isCapacitorNative() && (this.forcePotato || (this.potetoMode && this.instrument === 'grand-piano'))) {
        this.playPotato(ctx, midi, durationSec, velocity);
        return ctx.state === 'running';
      }
      if (this.instrument === 'grand-piano') {
        const sample = this.findClosestSample(midi);
        if (sample && sample.buffer.length > 8) {
          this.playSample(ctx, sample, midi, durationSec, velocity, isCapacitorNative());
          return ctx.state === 'running';
        }
      }
      this.playModeled(ctx, midi, durationSec, velocity);
      return ctx.state === 'running';
    } catch {
      try {
        this.playPotato(ctx, midi, durationSec, velocity);
      } catch { /* nothing else to try */ }
      return false;
    }
  }

  playMetronomeClick(isDownbeat = false) {
    let ctx;
    try {
      ctx = this.ensureContext();
    } catch {
      return;
    }
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isDownbeat ? 1150 : 780, now);
      gain.gain.setValueAtTime(0.18 * this.volume, now);
      gain.gain.linearRampToValueAtTime(0.0001, now + 0.055);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.06);
    } catch { /* a missed click should not stop the score */ }
  }

  async startMicrophone(onPitchDetected) {
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new Error('No microphone');
      error.name = 'NotFoundError';
      throw error;
    }
    this.potetoMode = usesSimplePiano();
    await this.primeSession(true);
    const streamPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        channelCount: 1,
      },
    });
    const ctx = this.ensureContext();
    this.kickHtmlSilence();
    this.kickSilentBuffer(ctx);
    const resumePromise = ctx.resume().catch(() => {});
    this.micStream = await streamPromise;
    await resumePromise;
    this.kickHtmlSilence();
    try { await ctx.resume(); } catch { /* speaker route was still requested */ }
    this.unlocked = ctx.state === 'running';
    this.emitStatus();

    const source = ctx.createMediaStreamSource(this.micStream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    const buffer = new Float32Array(this.analyser.fftSize);
    let lastReport;
    let frame = 0;
    const loop = () => {
      if (!this.analyser) return;
      this.micRaf = requestAnimationFrame(loop);
      frame += 1;
      if (frame % 2) return;
      this.analyser.getFloatTimeDomainData(buffer);
      const freq = detectPitch(buffer, ctx.sampleRate);
      const pitchInfo = freq > 0 ? frequencyToNote(freq) : null;
      const token = pitchInfo ? pitchInfo.midi : null;
      if (token === lastReport) return;
      lastReport = token;
      onPitchDetected(pitchInfo);
    };
    this.micRaf = requestAnimationFrame(loop);
  }

  stopMicrophone() {
    if (this.micRaf) cancelAnimationFrame(this.micRaf);
    this.micRaf = null;
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    this.analyser = null;
    this.primeSession(false);
  }
}
