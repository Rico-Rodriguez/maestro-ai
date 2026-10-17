import assert from 'node:assert/strict';
import test from 'node:test';
import { MaestroAudioEngine } from '../src/poteto-audio.mjs';

function withNative(run) {
  const previousCap = globalThis.Capacitor;
  const previousHook = globalThis.__maestroPrimeAudioSession;
  globalThis.Capacitor = { isNativePlatform: () => true };
  try {
    return run();
  } finally {
    if (previousCap === undefined) delete globalThis.Capacitor;
    else globalThis.Capacitor = previousCap;
    if (previousHook === undefined) delete globalThis.__maestroPrimeAudioSession;
    else globalThis.__maestroPrimeAudioSession = previousHook;
  }
}

function blockingSession(ms) {
  const calls = [];
  globalThis.__maestroPrimeAudioSession = () => {
    const started = performance.now();
    while (performance.now() - started < ms) { /* AVAudioSession.setActive on the main thread */ }
    calls.push(performance.now() - started);
    return Promise.resolve();
  };
  return calls;
}

test('a running native app does not reconfigure audio on later taps', () => {
  withNative(() => {
    const calls = blockingSession(40);
    const engine = new MaestroAudioEngine();
    engine.ctx = {
      state: 'running',
      sampleRate: 48000,
      currentTime: 0,
      destination: {},
      resume: () => Promise.resolve(),
    };
    engine.unlocked = true;
    const started = performance.now();
    engine.unlockFromGesture();
    engine.unlockFromGesture();
    engine.unlockFromGesture();
    const elapsed = performance.now() - started;
    assert.equal(calls.length, 0);
    assert.ok(elapsed < 16, `tap path took ${elapsed.toFixed(1)} ms`);
  });
});

test('the native session is configured once per mode, not once per tap', () => {
  withNative(() => {
    const calls = blockingSession(30);
    const engine = new MaestroAudioEngine();
    engine.primeSession(false);
    engine.primeSession(false);
    assert.equal(calls.length, 0);
    engine.primeSession(true);
    engine.primeSession(true);
    engine.primeSession(true);
    assert.equal(calls.length, 1);
    const started = performance.now();
    engine.primeSession(true);
    assert.ok(performance.now() - started < 16);
  });
});

test('a phone-call interruption may configure the session again', () => {
  withNative(() => {
    const calls = blockingSession(0);
    const engine = new MaestroAudioEngine();
    globalThis.__maestroResumeAudio();
    globalThis.__maestroResumeAudio();
    assert.equal(calls.length, 2);
  });
});
