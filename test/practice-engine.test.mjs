import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;
let engineModule;

async function loadEngineModule() {
  if (!engineModule) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    });
    engineModule = await viteServer.ssrLoadModule('/src/practice/engine.ts');
  }
  return engineModule;
}

after(async () => {
  if (viteServer) await viteServer.close();
});

function makeNote(id, pitch, pitchName, onset, measure, hand = 'R', duration = 1) {
  return {
    id,
    pitch,
    pitchName,
    step: pitchName[0],
    alter: 0,
    octave: Number(pitchName.slice(-1)) || 4,
    preferFlats: false,
    onset,
    duration,
    timeSec: onset * 0.5,
    durationSec: duration * 0.5,
    measure,
    beat: (onset % 4) + 1,
    hand,
    velocity: 90,
    track: 0,
  };
}

function makeTestScore() {
  const events = [
    makeNote('n1', 60, 'C4', 0, 1),
    makeNote('n2', 64, 'E4', 0.02, 1),
    makeNote('n3', 67, 'G4', 2, 1),
    makeNote('n4', 72, 'C5', 4, 2),
    makeNote('n5', 76, 'E5', 6, 2),
  ];
  return {
    id: 'test-score',
    title: 'Test Score',
    composer: 'Tester',
    genre: 'Exercise',
    tempo: 120,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Test',
    totalMeasures: 2,
    totalBeats: 8,
    totalSeconds: 4,
    minPitch: 60,
    maxPitch: 76,
    events,
    pedals: [],
    tempos: [{ tick: 0, beat: 0, timeSec: 0, bpm: 120 }],
    timeSignatures: [{ tick: 0, beat: 0, numerator: 4, denominator: 4 }],
    keySignatures: [{ tick: 0, beat: 0, key: 'C', scale: 'major', sf: 0, preferFlats: false }],
  };
}

test('createPracticeState initializes all stats to 0 and empty', async () => {
  const { createPracticeState } = await loadEngineModule();
  const state = createPracticeState(makeTestScore());

  assert.deepEqual(state.stats, {
    hits: 0,
    misses: 0,
    wrongNotes: 0,
    streak: 0,
    bestStreak: 0,
    offsetsMs: [],
    missesByMeasure: {},
  });
  assert.equal(state.beat, 0);
  assert.equal(state.cursor, 0);
  assert.equal(state.finished, false);
});

test('wait mode clamps at chord onset, requires all chord notes, wraps on loop, and finishes at song end', async () => {
  const { createPracticeState, reducePractice } = await loadEngineModule();
  const score = makeTestScore();

  let state = createPracticeState(score, { mode: 'wait' });
  state = reducePractice(state, { type: 'setRunning', running: true }, score);

  // Ticking when at chord 0 onset (0) keeps beat clamped at 0.
  state = reducePractice(state, { type: 'tick', dtSec: 1 }, score);
  assert.equal(state.beat, 0);
  assert.equal(state.cursor, 0);

  // Playing one note of the 2-note chord does not advance cursor or beat.
  state = reducePractice(state, { type: 'noteOn', pitch: 60 }, score);
  assert.equal(state.cursor, 0);
  assert.equal(state.beat, 0);
  assert.equal(state.stats.hits, 1);

  // Playing the second note completes the chord and advances to chord 1 (onset 2).
  state = reducePractice(state, { type: 'noteOn', pitch: 64 }, score);
  assert.equal(state.cursor, 1);
  assert.equal(state.beat, 2);
  assert.equal(state.stats.hits, 2);

  // Enable loop over measure 1 (beats 0..4) and complete chord 1 -> wraps to beat 0.
  state = reducePractice(
    state,
    { type: 'setLoop', loop: { enabled: true, startMeasure: 1, endMeasure: 1 } },
    score,
  );
  state = reducePractice(state, { type: 'noteOn', pitch: 67 }, score);
  assert.equal(state.beat, 0);
  assert.equal(state.cursor, 0);
  assert.equal(state.finished, false);
  assert.deepEqual(state.grades, {});

  // Disable loop and play through all remaining chords to song end.
  state = reducePractice(state, { type: 'setLoop', loop: { enabled: false } }, score);
  state = reducePractice(state, { type: 'noteOn', pitch: 60 }, score);
  state = reducePractice(state, { type: 'noteOn', pitch: 64 }, score);
  state = reducePractice(state, { type: 'noteOn', pitch: 67 }, score);
  state = reducePractice(state, { type: 'noteOn', pitch: 72 }, score);
  assert.equal(state.finished, false);
  state = reducePractice(state, { type: 'noteOn', pitch: 76 }, score);
  assert.equal(state.finished, true);
  assert.equal(state.running, false);
});

test('tempo mode grades hits within window, marks late misses once, and never mass-misses before seek or loopStart', async () => {
  const { createPracticeState, reducePractice, TEMPO_WINDOW_BEATS } = await loadEngineModule();
  const score = makeTestScore();

  let state = createPracticeState(score, { mode: 'tempo' });
  state = reducePractice(state, { type: 'setRunning', running: true }, score);

  // Hit chord 0 (C4 + E4) within TEMPO_WINDOW_BEATS.
  state = reducePractice(state, { type: 'tick', dtSec: 0.05 }, score); // beat = 0.1
  state = reducePractice(state, { type: 'noteOn', pitch: 60 }, score);
  state = reducePractice(state, { type: 'noteOn', pitch: 64 }, score);
  assert.equal(state.stats.hits, 2);
  assert.equal(state.cursor, 1);

  // Advance past chord 1 onset (2) + TEMPO_WINDOW_BEATS; note n3 is missed once.
  const dtPastWindow = (2 + TEMPO_WINDOW_BEATS + 0.1 - state.beat) / 2;
  state = reducePractice(state, { type: 'tick', dtSec: dtPastWindow }, score);
  assert.equal(state.grades.n3?.status, 'miss');
  assert.equal(state.stats.misses, 1);

  // Another tick before chord 2 does not double-count n3.
  state = reducePractice(state, { type: 'tick', dtSec: 0.1 }, score);
  assert.equal(state.stats.misses, 1);

  // Seeking forward to measure 2 (beat 4) must not mass-miss earlier notes on reset.
  let seekState = createPracticeState(score, { mode: 'tempo' });
  seekState = reducePractice(seekState, { type: 'setRunning', running: true }, score);
  seekState = reducePractice(seekState, { type: 'seek', beat: 4 }, score);
  seekState = reducePractice(seekState, { type: 'tick', dtSec: 0.1 }, score); // beat = 4.2
  assert.equal(seekState.stats.misses, 0);
  assert.equal(seekState.grades.n1, undefined);
  assert.equal(seekState.grades.n2, undefined);
  assert.equal(seekState.grades.n3, undefined);

  // Looping measure 2 (startMeasure = 2, beats 4..8) wraps back to beat 4 without missing measure 1 notes.
  let loopState = createPracticeState(score, { mode: 'tempo' });
  loopState = reducePractice(
    loopState,
    { type: 'setLoop', loop: { enabled: true, startMeasure: 2, endMeasure: 2 } },
    score,
  );
  loopState = reducePractice(loopState, { type: 'setRunning', running: true }, score);
  assert.equal(loopState.beat, 4);
  // Hit measure 2 notes at beat 4 and beat 6, then wrap past beat 8.
  loopState = reducePractice(loopState, { type: 'noteOn', pitch: 72 }, score);
  loopState = reducePractice(loopState, { type: 'tick', dtSec: 1 }, score); // beat = 6
  loopState = reducePractice(loopState, { type: 'noteOn', pitch: 76 }, score);
  loopState = reducePractice(loopState, { type: 'tick', dtSec: 1.1 }, score); // beat >= 8 -> wraps to 4
  assert.ok(loopState.beat >= 4 && loopState.beat < 8);
  assert.equal(loopState.stats.misses, 0);
  assert.equal(loopState.grades.n1, undefined);
  assert.equal(loopState.grades.n2, undefined);
  assert.equal(loopState.grades.n3, undefined);
});

test('listen mode ignores noteOn without adding misses or resetting streak', async () => {
  const { createPracticeState, reducePractice } = await loadEngineModule();
  const score = makeTestScore();

  let state = createPracticeState(score, { mode: 'wait' });
  state = reducePractice(state, { type: 'noteOn', pitch: 60 }, score);
  assert.equal(state.stats.streak, 1);

  state = reducePractice(state, { type: 'setMode', mode: 'listen' }, score);
  const afterWrongPitch = reducePractice(state, { type: 'noteOn', pitch: 61 }, score);

  assert.equal(afterWrongPitch.stats.misses, 0);
  assert.equal(afterWrongPitch.stats.wrongNotes, 0);
  assert.equal(afterWrongPitch.stats.streak, 1);
});
