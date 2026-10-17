import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MaestroAudioEngine } from '../src/poteto-audio.mjs';
import {
  GRAND_CREDIT,
  GRAND_HALL_CREDIT,
  GRAND_MANIFEST,
  GRAND_NOTE_COUNT,
  grandReleaseSeconds,
  grandSampleJobs,
  layerForVelocity,
  nearestGrandNote,
  pianoOutputRoute,
} from '../src/grand-piano.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAND = path.join(ROOT, 'ios', 'audio', 'grand');

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

test('the iOS grand uses six velocity layers on every minor third', () => {
  assert.equal(GRAND_MANIFEST.notes.length, 30);
  assert.deepEqual(GRAND_MANIFEST.layers, [28, 46, 64, 84, 104, 127]);
  assert.equal(GRAND_NOTE_COUNT, 180);
  assert.equal(GRAND_MANIFEST.releases.length, 88);
  let previous = 18;
  GRAND_MANIFEST.notes.forEach((note) => {
    assert.ok(note.midi - previous <= 3, `${note.midi} is more than a minor third from ${previous}`);
    assert.equal(note.files.length, 6);
    previous = note.midi;
  });
  assert.equal(GRAND_MANIFEST.notes[0].midi, 21);
  assert.equal(GRAND_MANIFEST.notes.at(-1).midi, 108);
  assert.equal(nearestGrandNote(61).midi, 60);
  assert.equal(nearestGrandNote(62).midi, 63);
  assert.equal(layerForVelocity(20).index, 0);
  assert.equal(layerForVelocity(28).index, 0);
  assert.equal(layerForVelocity(29).index, 1);
  assert.equal(layerForVelocity(90).index, 4);
  assert.equal(layerForVelocity(127).index, 5);
  assert.ok(layerForVelocity(100).gain > layerForVelocity(85).gain);
  assert.ok(grandReleaseSeconds(21) > grandReleaseSeconds(96));
  assert.match(GRAND_CREDIT, /Alexander Holm/);
  assert.match(GRAND_CREDIT, /CC BY 3\.0/);
  assert.match(GRAND_HALL_CREDIT, /CC0/);
});

test('bundled grand audio stays under 60 MB and is not the pages mp3 set', () => {
  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        bytes += fs.statSync(full).size;
        files += 1;
      }
    }
  };
  walk(GRAND);
  assert.ok(bytes < 60 * 1024 * 1024, `grand audio is ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  assert.ok(bytes > 4 * 1024 * 1024);
  grandSampleJobs().forEach((job) => {
    const full = path.join(GRAND, job.file);
    assert.equal(fs.existsSync(full), true, full);
    assert.ok(fs.statSync(full).size > 400, full);
  });
  const credits = fs.readFileSync(path.join(GRAND, 'CREDITS.txt'), 'utf8');
  assert.match(credits, /Alexander Holm/);
  assert.match(credits, /creativecommons\.org\/licenses\/by\/3\.0/);
  assert.match(credits, /CC0/);
  assert.ok(files > 200);
  const pages = fs.readdirSync(path.join(ROOT, 'public', 'audio', 'salamander'));
  assert.equal(pages.length, 25);
  assert.ok(pages.every((name) => name.endsWith('.mp3')));
});

test('the native piano uses the hall bus and a key release does not touch the session', () => {
  assert.equal(pianoOutputRoute({ native: true, potetoMode: false, forcePotato: false }), 'hall');
  assert.equal(pianoOutputRoute({ native: false, potetoMode: false, forcePotato: false }), 'desktop');
  assert.equal(pianoOutputRoute({ native: true, potetoMode: false, forcePotato: true }), 'direct');
  withNative(() => {
    const calls = [];
    globalThis.__maestroPrimeAudioSession = () => {
      calls.push('session');
      return Promise.resolve();
    };
    const engine = new MaestroAudioEngine();
    engine.ctx = {
      state: 'running',
      currentTime: 1,
      sampleRate: 48000,
      destination: {},
    };
    engine.unlocked = true;
    engine.releaseNote(60);
    engine.setSustain(true);
    engine.setSustain(true);
    engine.setSustain(false);
    assert.equal(calls.length, 0);
    assert.equal(engine.sustainDown, false);
  });
});
