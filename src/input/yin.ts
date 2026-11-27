export type YinOptions = {
  minFreq?: number;
  maxFreq?: number;
  threshold?: number;
  rmsGate?: number;
};

export type YinResult = {
  freq: number;
  clarity: number;
  rms: number;
};

export function detectPitchYin(
  buffer: Float32Array,
  sampleRate: number,
  options?: YinOptions,
): YinResult | null {
  if (buffer.length === 0 || sampleRate <= 0) return null;

  const minFreq = options?.minFreq ?? 27;
  const maxFreq = options?.maxFreq ?? 4250;
  const threshold = options?.threshold ?? 0.15;
  const rmsGate = options?.rmsGate ?? 0.012;

  let sumSq = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i];
    sumSq += sample * sample;
  }
  const rms = Math.sqrt(sumSq / buffer.length);
  if (!Number.isFinite(rms) || rms < rmsGate) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(Math.floor(buffer.length / 2), Math.ceil(sampleRate / minFreq));
  if (maxLag <= minLag + 2) return null;

  const windowSize = Math.min(Math.floor(buffer.length / 2), buffer.length - maxLag);
  if (windowSize <= 0) return null;

  const diff = new Float32Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau += 1) {
    let sum = 0;
    for (let j = 0; j < windowSize; j += 1) {
      const delta = buffer[j] - buffer[j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  const cmndf = new Float32Array(maxLag + 1);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag; tau += 1) {
    runningSum += diff[tau];
    cmndf[tau] = runningSum > 0 ? (diff[tau] * tau) / runningSum : 1;
  }

  let bestTau = -1;
  for (let tau = minLag; tau <= maxLag; tau += 1) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 <= maxLag && cmndf[tau + 1] < cmndf[tau]) {
        tau += 1;
      }
      bestTau = tau;
      break;
    }
  }

  if (bestTau === -1) {
    let minTau = minLag;
    let minVal = cmndf[minLag];
    for (let tau = minLag + 1; tau <= maxLag; tau += 1) {
      if (cmndf[tau] < minVal) {
        minVal = cmndf[tau];
        minTau = tau;
      }
    }
    if (minVal >= 0.24) return null;
    bestTau = minTau;
  }

  const bestVal = cmndf[bestTau];
  let refinedTau = bestTau;
  if (bestTau > 0 && bestTau < maxLag) {
    const s0 = cmndf[bestTau - 1];
    const s1 = cmndf[bestTau];
    const s2 = cmndf[bestTau + 1];
    const denom = 2 * (s0 - 2 * s1 + s2);
    if (Math.abs(denom) > 1e-12) {
      const shift = (s0 - s2) / denom;
      if (shift >= -1 && shift <= 1) {
        refinedTau = bestTau + shift;
      }
    }
  }

  if (refinedTau <= 0) return null;
  return {
    freq: sampleRate / refinedTau,
    clarity: Math.max(0, Math.min(1, 1 - bestVal)),
    rms,
  };
}

export type PitchOnsetTracker = {
  process(
    reading: { midi: number; rms: number } | null,
    timeMs: number,
  ): { triggerMidi: number | null; activeMidi: number | null };
};

const CONFIRM_FRAMES = 2;
const SILENCE_RELEASE_MS = 100;
const REATTACK_MIN_INTERVAL_MS = 140;
const REATTACK_RMS_RATIO = 1.75;
const REATTACK_MIN_RMS = 0.025;

export function createPitchOnsetTracker(): PitchOnsetTracker {
  let activeMidi: number | null = null;
  let candidateMidi: number | null = null;
  let candidateCount = 0;
  let lastTriggerTimeMs = -Infinity;
  let minRmsSinceTrigger = Infinity;
  let nullSinceMs: number | null = null;

  return {
    process(reading, timeMs) {
      if (reading === null) {
        candidateMidi = null;
        candidateCount = 0;
        if (nullSinceMs === null) {
          nullSinceMs = timeMs;
        }
        if (timeMs - nullSinceMs >= SILENCE_RELEASE_MS) {
          activeMidi = null;
          minRmsSinceTrigger = Infinity;
        }
        return { triggerMidi: null, activeMidi };
      }

      nullSinceMs = null;

      if (reading.midi === activeMidi) {
        candidateMidi = null;
        candidateCount = 0;
        if (reading.rms < minRmsSinceTrigger) {
          minRmsSinceTrigger = reading.rms;
        }
        if (
          timeMs - lastTriggerTimeMs >= REATTACK_MIN_INTERVAL_MS &&
          reading.rms >= REATTACK_MIN_RMS &&
          reading.rms >= minRmsSinceTrigger * REATTACK_RMS_RATIO
        ) {
          lastTriggerTimeMs = timeMs;
          minRmsSinceTrigger = reading.rms;
          return { triggerMidi: reading.midi, activeMidi };
        }
        return { triggerMidi: null, activeMidi };
      }

      if (candidateMidi === reading.midi) {
        candidateCount += 1;
      } else {
        candidateMidi = reading.midi;
        candidateCount = 1;
      }

      if (candidateCount >= CONFIRM_FRAMES) {
        activeMidi = reading.midi;
        candidateMidi = null;
        candidateCount = 0;
        lastTriggerTimeMs = timeMs;
        minRmsSinceTrigger = reading.rms;
        return { triggerMidi: activeMidi, activeMidi };
      }

      return { triggerMidi: null, activeMidi };
    },
  };
}
