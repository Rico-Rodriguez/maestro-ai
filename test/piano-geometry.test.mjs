import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;
let geomModule;

async function loadGeomModule() {
  if (!geomModule) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    });
    geomModule = await viteServer.ssrLoadModule('/src/components/piano-geometry.ts');
  }
  return geomModule;
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
