import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;
let yinModule;

async function loadYinModule() {
  if (!yinModule) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    });
    yinModule = await viteServer.ssrLoadModule('/src/input/yin.ts');
  }
  return yinModule;
}

after(async () => {
  if (viteServer) await viteServer.close();
});

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function makeSineBuffer(freq, sampleRate, length) {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    buf[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return buf;
}

function makePianoHarmonicBuffer(freq, sampleRate, length) {
  const buf = new Float32Array(length);
  const nyquist = sampleRate / 2;
  const partials = [
    [1, 0.55],
    [2, 0.28],
    [3, 0.14],
    [4, 0.08],
  ];
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    let sample = 0;
    for (const [mult, amp] of partials) {
      if (freq * mult < nyquist) {
        sample += amp * Math.sin(2 * Math.PI * freq * mult * t);
      }
    }
    buf[i] = sample;
  }
  return buf;
}

function centsError(detectedFreq, targetFreq) {
  return Math.abs(1200 * Math.log2(detectedFreq / targetFreq));
}

test('detectPitchYin achieves >= 95% accuracy within 25 cents across all 88 piano keys for sine and harmonic tones', async () => {
  const { detectPitchYin } = await loadYinModule();
  const sampleRate = 48000;
  const bufferSize = 4096;
  const totalNotes = 108 - 21 + 1;

  let sineAccurate = 0;
  let harmonicAccurate = 0;

  for (let midi = 21; midi <= 108; midi += 1) {
    const expectedFreq = midiToFreq(midi);

    const sineRes = detectPitchYin(makeSineBuffer(expectedFreq, sampleRate, bufferSize), sampleRate);
    if (sineRes && centsError(sineRes.freq, expectedFreq) <= 25) {
      sineAccurate += 1;
    }

    const harmRes = detectPitchYin(
      makePianoHarmonicBuffer(expectedFreq, sampleRate, bufferSize),
      sampleRate,
    );
    if (harmRes && centsError(harmRes.freq, expectedFreq) <= 25) {
      harmonicAccurate += 1;
    }
  }

  const sineAccuracy = sineAccurate / totalNotes;
  const harmonicAccuracy = harmonicAccurate / totalNotes;

  assert.ok(
    sineAccuracy >= 0.95,
    `expected sine accuracy >= 95%, got ${(sineAccuracy * 100).toFixed(1)}% (${sineAccurate}/${totalNotes})`,
  );
  assert.ok(
    harmonicAccuracy >= 0.95,
    `expected harmonic accuracy >= 95%, got ${(harmonicAccuracy * 100).toFixed(1)}% (${harmonicAccurate}/${totalNotes})`,
  );

  assert.equal(detectPitchYin(new Float32Array(bufferSize), sampleRate), null);
});

test('createPitchOnsetTracker triggers on pitch changes and RMS re-attacks without double-firing on sustain', async () => {
  const { createPitchOnsetTracker } = await loadYinModule();
  const tracker = createPitchOnsetTracker();

  // First frame of C4 confirms candidate; second frame triggers.
  assert.deepEqual(tracker.process({ midi: 60, rms: 0.08 }, 0), {
    triggerMidi: null,
    activeMidi: null,
  });
  assert.deepEqual(tracker.process({ midi: 60, rms: 0.08 }, 20), {
    triggerMidi: 60,
    activeMidi: 60,
  });

  // Steady sustain does not double-fire.
  assert.deepEqual(tracker.process({ midi: 60, rms: 0.07 }, 60), {
    triggerMidi: null,
    activeMidi: 60,
  });
  assert.deepEqual(tracker.process({ midi: 60, rms: 0.03 }, 120), {
    triggerMidi: null,
    activeMidi: 60,
  });

  // RMS jump after decay and >= 140ms interval triggers re-attack on same pitch.
  assert.deepEqual(tracker.process({ midi: 60, rms: 0.09 }, 200), {
    triggerMidi: 60,
    activeMidi: 60,
  });

  // Pitch change requires 2 confirmation frames then triggers E4.
  assert.deepEqual(tracker.process({ midi: 64, rms: 0.08 }, 240), {
    triggerMidi: null,
    activeMidi: 60,
  });
  assert.deepEqual(tracker.process({ midi: 64, rms: 0.08 }, 260), {
    triggerMidi: 64,
    activeMidi: 64,
  });
});
