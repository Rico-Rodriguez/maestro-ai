import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;
let geomModule;
let colorsModule;

async function ensureViteServer() {
  if (!viteServer) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    });
  }
  return viteServer;
}

async function loadGeomModule() {
  if (!geomModule) {
    const server = await ensureViteServer();
    geomModule = await server.ssrLoadModule('/src/components/piano-geometry.ts');
  }
  return geomModule;
}

async function loadColorsModule() {
  if (!colorsModule) {
    const server = await ensureViteServer();
    colorsModule = await server.ssrLoadModule('/src/components/note-colors.ts');
  }
  return colorsModule;
}

after(async () => {
  if (viteServer) await viteServer.close();
});

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

function isWhite(midi) {
  return !BLACK_PCS.has(((midi % 12) + 12) % 12);
}

test('computePianoRange handles 88, 61, compact, and auto modes with white-key bounds and >= 25-semitone span', async () => {
  const { computePianoRange } = await loadGeomModule();

  assert.deepEqual(computePianoRange('88'), { minMidi: 21, maxMidi: 108 });
  assert.deepEqual(computePianoRange('61'), { minMidi: 36, maxMidi: 96 });

  const compactDefault = computePianoRange('compact', undefined, undefined, 0);
  assert.equal(isWhite(compactDefault.minMidi), true);
  assert.equal(isWhite(compactDefault.maxMidi), true);
  assert.deepEqual(compactDefault, { minMidi: 48, maxMidi: 72 });

  const compactShifted = computePianoRange('compact', undefined, undefined, 1);
  assert.deepEqual(compactShifted, { minMidi: 60, maxMidi: 84 });

  const autoNarrow = computePianoRange('auto', 61, 63);
  assert.equal(isWhite(autoNarrow.minMidi), true);
  assert.equal(isWhite(autoNarrow.maxMidi), true);
  assert.ok(
    autoNarrow.maxMidi - autoNarrow.minMidi >= 25,
    `expected >= 25-semitone span, got ${autoNarrow.maxMidi - autoNarrow.minMidi}`,
  );

  const autoWide = computePianoRange('auto', 37, 94);
  assert.equal(isWhite(autoWide.minMidi), true);
  assert.equal(isWhite(autoWide.maxMidi), true);
  assert.ok(autoWide.minMidi <= 37);
  assert.ok(autoWide.maxMidi >= 94);
  assert.ok(autoWide.maxMidi - autoWide.minMidi >= 25);
});

test('buildPianoLayout places every black key inside [0, 1] near the boundary between its adjacent white keys', async () => {
  const { buildPianoLayout } = await loadGeomModule();

  for (const [minMidi, maxMidi] of [
    [21, 108],
    [36, 96],
    [48, 72],
  ]) {
    const layout = buildPianoLayout(minMidi, maxMidi);
    assert.ok(layout.blackKeys.length > 0);

    for (const bk of layout.blackKeys) {
      assert.ok(bk.x >= 0, `black key ${bk.midi} has x < 0: ${bk.x}`);
      assert.ok(
        bk.x + bk.width <= 1 + 1e-12,
        `black key ${bk.midi} exceeds 1: ${bk.x + bk.width}`,
      );

      const lowerWhite = layout.byMidi.get(bk.midi - 1);
      const upperWhite = layout.byMidi.get(bk.midi + 1);
      assert.ok(lowerWhite && !lowerWhite.isBlack, `missing lower white key for ${bk.midi}`);
      assert.ok(upperWhite && !upperWhite.isBlack, `missing upper white key for ${bk.midi}`);

      const boundary = upperWhite.x;
      assert.ok(bk.x > lowerWhite.x, `black key ${bk.midi} left edge should be > lower white x`);
      assert.ok(
        bk.x < boundary && bk.x + bk.width > boundary,
        `black key ${bk.midi} [${bk.x}, ${bk.x + bk.width}] should straddle white boundary ${boundary}`,
      );
    }
  }
});

test('computePianoRange handles kid mode with giant 15-key C4..D5 white-key bounds and octave shifts', async () => {
  const { computePianoRange, buildPianoLayout } = await loadGeomModule();

  const kidDefault = computePianoRange('kid', undefined, undefined, 0);
  assert.deepEqual(kidDefault, { minMidi: 60, maxMidi: 74 });
  assert.equal(isWhite(kidDefault.minMidi), true);
  assert.equal(isWhite(kidDefault.maxMidi), true);

  const kidLayout = buildPianoLayout(kidDefault.minMidi, kidDefault.maxMidi);
  assert.equal(kidLayout.whiteCount, 9);
  assert.equal(kidLayout.allKeys.length, 15);

  assert.deepEqual(computePianoRange('kid', undefined, undefined, -1), { minMidi: 48, maxMidi: 62 });
  assert.deepEqual(computePianoRange('kid', undefined, undefined, 1), { minMidi: 72, maxMidi: 86 });
  assert.deepEqual(computePianoRange('kid', undefined, undefined, -4), { minMidi: 24, maxMidi: 38 });
  assert.deepEqual(computePianoRange('kid', undefined, undefined, 4), { minMidi: 96, maxMidi: 108 });
});

test('autoOctaveShiftForPitches keeps current shift when covered and shifts toward out-of-range targets', async () => {
  const { autoOctaveShiftForPitches } = await loadGeomModule();

  assert.equal(autoOctaveShiftForPitches([], 0, 'kid'), 0);
  assert.equal(autoOctaveShiftForPitches([60, 64, 67], 0, 'kid'), 0);
  // Keeps current shift when at least one expected pitch is already inside
  assert.equal(autoOctaveShiftForPitches([60, 79], 0, 'kid'), 0);

  // Out-of-range lower and higher targets shift cleanly in kid and compact modes
  assert.equal(autoOctaveShiftForPitches([53], 0, 'kid'), -1);
  assert.equal(autoOctaveShiftForPitches([79], 0, 'kid'), 1);
  assert.equal(autoOctaveShiftForPitches([38, 43], 0, 'kid'), -2);
  assert.equal(autoOctaveShiftForPitches([88, 92], 0, 'kid'), 2);
  assert.equal(autoOctaveShiftForPitches([78], 0, 'compact'), 1);
  assert.equal(autoOctaveShiftForPitches([44], 0, 'compact'), -1);
  assert.equal(autoOctaveShiftForPitches([36], 0, 'compact'), -2);
});

test('getNotePalette and getKeyStickerColor return ChromaNotes rainbow colors and crisp hands palettes', async () => {
  const { getNotePalette, getKeyStickerColor } = await loadColorsModule();

  const cRainbow = getNotePalette(60, 'R', 'rainbow');
  assert.equal(cRainbow.top, '#f87171');
  assert.equal(cRainbow.bottom, '#dc2626');
  assert.equal(cRainbow.stickerBg, '#ef4444');

  const eRainbow = getNotePalette(64, 'L', 'rainbow');
  assert.equal(eRainbow.top, '#fde047');
  assert.equal(eRainbow.stickerText, '#422006');

  const fSharpRainbow = getNotePalette(66, 'R', 'rainbow');
  assert.equal(fSharpRainbow.border, '#fef3c7');
  assert.notEqual(fSharpRainbow.top, getNotePalette(65, 'R', 'rainbow').top);

  const rhWhite = getNotePalette(60, 'R', 'hands');
  const lhWhite = getNotePalette(60, 'L', 'hands');
  const rhBlack = getNotePalette(61, 'R', 'hands');
  const lhBlack = getNotePalette(61, 'L', 'hands');
  assert.notEqual(rhWhite.top, lhWhite.top);
  assert.notEqual(rhWhite.top, rhBlack.top);
  assert.notEqual(lhWhite.top, lhBlack.top);

  assert.deepEqual(getKeyStickerColor(60).shortLabel, 'C');
  assert.deepEqual(getKeyStickerColor(61).shortLabel, 'C#');
  assert.deepEqual(getKeyStickerColor(71).shortLabel, 'B');
});

test('measureAtBeat tracks bar numbers consistently across time-signature changes', async () => {
  const { measureAtBeat } = await loadColorsModule();

  // No time signature overrides -> uses defaultBeatsPerMeasure
  assert.equal(measureAtBeat([], 4, 0), 1);
  assert.equal(measureAtBeat([], 4, 3.9), 1);
  assert.equal(measureAtBeat([], 4, 4), 2);
  assert.equal(measureAtBeat([], 3, 6), 3);

  // Changes from 4/4 at beat 0 -> 3/4 at beat 8 -> 6/8 (3 quarter beats) at beat 14
  const timeSigs = [
    { tick: 0, beat: 0, numerator: 4, denominator: 4 },
    { tick: 3840, beat: 8, numerator: 3, denominator: 4 },
    { tick: 6720, beat: 14, numerator: 6, denominator: 8 },
  ];
  assert.equal(measureAtBeat(timeSigs, 4, 0), 1);
  assert.equal(measureAtBeat(timeSigs, 4, 4), 2);
  assert.equal(measureAtBeat(timeSigs, 4, 7.5), 2);
  assert.equal(measureAtBeat(timeSigs, 4, 8), 3);
  assert.equal(measureAtBeat(timeSigs, 4, 11), 4);
  assert.equal(measureAtBeat(timeSigs, 4, 14), 5);
  assert.equal(measureAtBeat(timeSigs, 4, 17), 6);

  // Time signature starting after beat 0 uses defaultBeatsPerMeasure for the prefix
  const delayedSig = [{ tick: 1920, beat: 4, numerator: 3, denominator: 4 }];
  assert.equal(measureAtBeat(delayedSig, 4, 2), 1);
  assert.equal(measureAtBeat(delayedSig, 4, 4), 2);
  assert.equal(measureAtBeat(delayedSig, 4, 7), 3);
});

test('chooseSmartRangeMode adapts to score span, viewport width, input device, and mode', async () => {
  const { chooseSmartRangeMode } = await loadGeomModule();

  assert.equal(
    chooseSmartRangeMode({ viewportWidth: 1024, mode: 'wait', hasExternalInput: false }),
    'kid',
  );
  assert.equal(
    chooseSmartRangeMode({
      minPitch: 60,
      maxPitch: 74,
      viewportWidth: 1024,
      mode: 'wait',
      hasExternalInput: true,
    }),
    'kid',
  );
  assert.equal(
    chooseSmartRangeMode({
      minPitch: 36,
      maxPitch: 84,
      viewportWidth: 844,
      mode: 'wait',
      hasExternalInput: false,
    }),
    'auto',
  );
  assert.equal(
    chooseSmartRangeMode({
      minPitch: 36,
      maxPitch: 84,
      viewportWidth: 1024,
      mode: 'wait',
      hasExternalInput: false,
    }),
    'auto',
  );
  assert.equal(
    chooseSmartRangeMode({
      minPitch: 36,
      maxPitch: 84,
      viewportWidth: 390,
      mode: 'wait',
      hasExternalInput: true,
    }),
    'auto',
  );
  assert.equal(
    chooseSmartRangeMode({
      minPitch: 36,
      maxPitch: 84,
      viewportWidth: 390,
      mode: 'listen',
      hasExternalInput: false,
    }),
    'auto',
  );
  assert.equal(
    chooseSmartRangeMode({
      minPitch: 36,
      maxPitch: 84,
      viewportWidth: 390,
      mode: 'wait',
      hasExternalInput: false,
    }),
    'compact',
  );
  assert.equal(
    chooseSmartRangeMode({
      minPitch: 55,
      maxPitch: 76,
      viewportWidth: 390,
      mode: 'tempo',
      hasExternalInput: false,
    }),
    'compact',
  );
});

test('initialOctaveShiftForScore centers cleanly on opening pitches', async () => {
  const { initialOctaveShiftForScore } = await loadGeomModule();

  assert.equal(initialOctaveShiftForScore(48, 84, 'kid', [60, 64, 67]), 0);
  assert.equal(initialOctaveShiftForScore(48, 84, 'kid', [48, 52, 55]), -1);
  assert.equal(initialOctaveShiftForScore(48, 84, 'kid', [72, 76, 79]), 1);
  assert.equal(initialOctaveShiftForScore(36, 84, 'compact', [36, 40, 43, 48]), -1);
  assert.equal(initialOctaveShiftForScore(36, 84, 'compact', [62, 65, 69, 72, 79]), 1);
  assert.equal(initialOctaveShiftForScore(48, 72, 'compact', [60, 64]), 0);
  assert.equal(initialOctaveShiftForScore(74, 82, 'compact'), 1);
});
