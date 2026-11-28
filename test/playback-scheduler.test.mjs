import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;

async function loadTsModule(modulePath) {
  if (!viteServer) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    });
  }
  return viteServer.ssrLoadModule(modulePath);
}

after(async () => {
  if (viteServer) await viteServer.close();
});

function createFakeAudioContext(initialTime = 0) {
  return {
    currentTime: initialTime,
    state: 'running',
    sampleRate: 44100,
    resume: async () => {},
  };
}

function createRecordingEngine(ctx) {
  const calls = [];
  return {
    calls,
    ensureContext() {
      return ctx;
    },
    getContext() {
      return ctx;
    },
    noteOn(midi, velocity, whenSec, source) {
      calls.push({ type: 'noteOn', midi, velocity, whenSec, source, seq: calls.length });
    },
    noteOff(midi, whenSec, source) {
      calls.push({ type: 'noteOff', midi, whenSec, source, seq: calls.length });
    },
    setSustain() {},
    playMetronomeClick() {},
    stopAllPlayback() {},
  };
}

function makeRepeatedNoteScore() {
  const makeEv = (id, onset, duration) => ({
    id,
    pitch: 60,
    pitchName: 'C4',
    step: 'C',
    alter: 0,
    octave: 4,
    preferFlats: false,
    onset,
    duration,
    timeSec: onset * 0.5,
    durationSec: duration * 0.5,
    measure: 1,
    beat: onset + 1,
    hand: 'R',
    velocity: 90,
    track: 0,
  });

  return {
    id: 'repeat-test',
    title: 'Repeat Test',
    composer: 'Tester',
    genre: 'Exercise',
    tempo: 120,
    timeSignature: [4, 4],
    keySignature: 'C Major',
    sourceFormat: 'Test',
    totalMeasures: 1,
    totalBeats: 2,
    totalSeconds: 1,
    minPitch: 60,
    maxPitch: 60,
    events: [makeEv('n1', 0, 1), makeEv('n2', 1, 1)],
    pedals: [],
    tempos: [{ tick: 0, beat: 0, timeSec: 0, bpm: 120 }],
    timeSignatures: [{ tick: 0, beat: 0, numerator: 4, denominator: 4 }],
    keySignatures: [{ tick: 0, beat: 0, key: 'C', scale: 'major', sf: 0, preferFlats: false }],
  };
}

test('PlaybackScheduler delivers complete noteOn/noteOff pairs and orders touching repeated notes', async () => {
  const { PlaybackScheduler } = await loadTsModule('/src/audio/scheduler.ts');
  const { TODDLER_SONGS, buildToddlerScore } = await loadTsModule('/src/music/toddler-songs.ts');

  const targetIds = ['toddler:twinkle', 'toddler:baby-shark'];
  for (const id of targetIds) {
    const spec = TODDLER_SONGS.find((s) => s.id === id);
    assert.ok(spec, `Missing song spec ${id}`);
    const score = buildToddlerScore(spec);

    const ctx = createFakeAudioContext(0);
    const engine = createRecordingEngine(ctx);
    let ended = false;

    const scheduler = new PlaybackScheduler(engine, {
      score,
      mode: 'listen',
      onEnd: () => {
        ended = true;
      },
    });

    try {
      scheduler.play();
      let steps = 0;
      while (!ended && steps < 5000) {
        ctx.currentTime += 0.025;
        scheduler.tick();
        steps += 1;
      }
      assert.equal(ended, true, `${id} should finish playback`);
    } finally {
      scheduler.dispose();
    }

    const noteOns = engine.calls.filter((c) => c.type === 'noteOn');
    const noteOffs = engine.calls.filter((c) => c.type === 'noteOff');
    assert.equal(noteOns.length, score.events.length, `${id}: every note should get noteOn`);
    assert.equal(noteOffs.length, score.events.length, `${id}: every note should get noteOff`);

    const onQueueByPitch = new Map();
    const offQueueByPitch = new Map();
    for (const c of engine.calls) {
      const target = c.type === 'noteOn' ? onQueueByPitch : offQueueByPitch;
      if (!target.has(c.midi)) target.set(c.midi, []);
      target.get(c.midi).push(c);
    }

    const paired = [];
    const seenByPitch = new Map();
    for (const ev of score.events) {
      const idx = seenByPitch.get(ev.pitch) ?? 0;
      seenByPitch.set(ev.pitch, idx + 1);
      const onCall = onQueueByPitch.get(ev.pitch)?.[idx];
      const offCall = offQueueByPitch.get(ev.pitch)?.[idx];
      assert.ok(onCall, `${id}: missing noteOn for ${ev.id}`);
      assert.ok(offCall, `${id}: missing noteOff for ${ev.id}`);
      assert.ok(offCall.seq > onCall.seq, `${id}: noteOff must follow noteOn for ${ev.id}`);
      paired.push({ ev, onCall, offCall });
    }

    let touchingPairs = 0;
    for (let i = 1; i < paired.length; i += 1) {
      const prev = paired[i - 1];
      const curr = paired[i];
      if (
        prev.ev.pitch === curr.ev.pitch &&
        Math.abs(prev.ev.onset + prev.ev.duration - curr.ev.onset) < 1e-6
      ) {
        touchingPairs += 1;
        assert.ok(
          prev.offCall.seq < curr.onCall.seq,
          `${id}: touching ${curr.ev.pitchName} prev noteOff must precede curr noteOn`,
        );
        assert.ok(
          prev.offCall.whenSec <= curr.onCall.whenSec + 1e-9,
          `${id}: touching ${curr.ev.pitchName} offWhenSec (${prev.offCall.whenSec}) <= onWhenSec (${curr.onCall.whenSec})`,
        );
      }
    }
    assert.ok(touchingPairs > 0, `${id} should exercise touching repeated notes`);
  }
});

test('getActivePlaybackPitches creates a visual re-articulation gap between repeated notes', async () => {
  const { PlaybackScheduler } = await loadTsModule('/src/audio/scheduler.ts');
  const score = makeRepeatedNoteScore();
  const ctx = createFakeAudioContext(0);
  const engine = createRecordingEngine(ctx);

  const scheduler = new PlaybackScheduler(engine, {
    score,
    mode: 'listen',
  });

  try {
    scheduler.play();

    ctx.currentTime = 0.25; // liveBeat = 0.5
    scheduler.tick();
    assert.equal(scheduler.getActivePlaybackPitches().has(60), true);

    ctx.currentTime = 0.485; // liveBeat = 0.97 (inside visual gap 0.94..1.0)
    scheduler.tick();
    assert.equal(scheduler.getActivePlaybackPitches().has(60), false);

    ctx.currentTime = 0.525; // liveBeat = 1.05
    scheduler.tick();
    assert.equal(scheduler.getActivePlaybackPitches().has(60), true);
  } finally {
    scheduler.dispose();
  }
});

test('PianoAudioEngine isolates voices on the same pitch with unique stopId', async () => {
  const { PianoAudioEngine } = await loadTsModule('/src/audio/piano-engine.ts');
  const ctx = createFakeAudioContext(0);
  const startCalls = [];
  const voices = [];

  const stubGrandPiano = {
    start(event) {
      startCalls.push(event);
      const stopId = event.stopId ?? event.note;
      const voice = {
        stopId,
        startTime: event.time ?? 0,
        stoppedAt: null,
      };
      voices.push(voice);

      return (stopTime) => {
        const t = stopTime ?? 0;
        for (const v of voices) {
          if (v.stopId === stopId && (v.stoppedAt === null || t < v.stoppedAt)) {
            v.stoppedAt = t;
          }
        }
      };
    },
    stop() {},
    dispose() {},
  };

  const engine = new PianoAudioEngine();
  Object.assign(engine, {
    ctx,
    grandPiano: stubGrandPiano,
    grandReady: true,
    grandLoaded: 1,
  });

  engine.noteOn(60, 90, 1.0, 'playback');
  engine.noteOn(60, 90, 2.0, 'playback');
  engine.noteOff(60, 2.0, 'playback');

  assert.equal(startCalls.length, 2);
  assert.equal(typeof startCalls[0].stopId, 'string');
  assert.equal(typeof startCalls[1].stopId, 'string');
  assert.notEqual(startCalls[0].stopId, startCalls[1].stopId);
  assert.equal(voices[0].stoppedAt, 2.0);
  assert.equal(voices[1].stoppedAt, null);
  assert.equal(engine.isPlaybackSounding(), true);
});
