import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
  chordColumns,
  groupStaffEvents,
  layoutStaffGroup,
  octaveShiftForWindow,
} from '../src/staff-layout.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;
let engineModule;
let geomModule;

async function loadModules() {
  if (!viteServer) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    });
    engineModule = await viteServer.ssrLoadModule('/src/practice/engine.ts');
    geomModule = await viteServer.ssrLoadModule('/src/components/piano-geometry.ts');
  }
  return { engineModule, geomModule };
}

after(async () => {
  if (viteServer) await viteServer.close();
});

test('practice modes describe Wait, Tempo, and Listen behavior', async () => {
  const {
    engineModule: { PRACTICE_MODES },
  } = await loadModules();

  assert.deepEqual(
    PRACTICE_MODES.map((mode) => mode.id),
    ['wait', 'tempo', 'listen'],
  );
  assert.match(PRACTICE_MODES[0].hint, /press|keys/i);
  assert.match(PRACTICE_MODES[1].hint, /keep up|time/i);
  assert.match(PRACTICE_MODES[2].hint, /listen/i);
  for (const mode of PRACTICE_MODES) {
    assert.ok(mode.hint.length > 20);
    assert.ok(mode.idle.length > 8);
  }
});

test('formatNextChip stays compact for single notes and multi-note chords', async () => {
  const {
    engineModule: { formatNextChip },
  } = await loadModules();

  const chord = ['C4', 'E4', 'G4', 'B4', 'D5', 'F5'].map((pitchName) => ({ pitchName }));
  assert.equal(formatNextChip([], true), '—');
  assert.equal(formatNextChip([], false), 'Next —');
  assert.equal(formatNextChip(chord.slice(0, 1), true), 'C4');
  assert.equal(formatNextChip(chord, true), 'C4+5');
  assert.ok(formatNextChip(chord, true).length < formatNextChip(chord, false).length);
  assert.equal(formatNextChip(chord, false), 'Next C4 +5');
  assert.ok(!formatNextChip(chord, true).includes('F5'));
});

test('chord seconds step aside and thirds stay in line', () => {
  assert.deepEqual(chordColumns([0, 1, 3], true), [0, 12, 0]);
  assert.deepEqual(chordColumns([0, 1, 2, 3], false), [0, -12, 0, -12]);
  const group = groupStaffEvents([
    { id: 'a', hand: 'R', onset: 4, pitch: 64 },
    { id: 'b', hand: 'R', onset: 4.02, pitch: 67 },
    { id: 'c', hand: 'L', onset: 4, pitch: 48 },
    { id: 'd', hand: 'R', onset: 5, pitch: 69 },
  ]);
  assert.equal(group.length, 3);
  const rightChord = group.find((item) => item.notes.length === 2);
  assert.deepEqual(
    rightChord.notes.map((note) => note.id),
    ['a', 'b'],
  );
  const laid = layoutStaffGroup([
    { id: 'low', stepOffset: 0, alter: 1 },
    { id: 'second', stepOffset: 1, alter: 1 },
  ]);
  assert.notEqual(laid.notes[0].dx, laid.notes[1].dx);
  assert.notEqual(laid.notes[0].accidentalLane, laid.notes[1].accidentalLane);
});

test('compact keyboard window shifts for off-screen notes and computePianoRange enforces white-key bounds', async () => {
  const {
    geomModule: { computePianoRange },
  } = await loadModules();

  assert.equal(octaveShiftForWindow([60, 64], 0), 0);
  assert.equal(octaveShiftForWindow([36], 0), -1);
  assert.equal(octaveShiftForWindow([76], 0), 1);

  assert.deepEqual(computePianoRange('compact', undefined, undefined, 0), {
    minMidi: 48,
    maxMidi: 72,
  });
  assert.deepEqual(computePianoRange('compact', undefined, undefined, -1), {
    minMidi: 36,
    maxMidi: 60,
  });
});
