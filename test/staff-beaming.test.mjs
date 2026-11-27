import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;
let beamingModule;

async function loadBeamingModule() {
  if (!beamingModule) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    });
    beamingModule = await viteServer.ssrLoadModule('/src/components/staff-beaming.ts');
  }
  return beamingModule;
}

after(async () => {
  if (viteServer) await viteServer.close();
});

test('effectiveDisplayDuration snaps staccato 8ths to 0.5 while preserving true 16ths', async () => {
  const { effectiveDisplayDuration, flagCountForDuration } = await loadBeamingModule();

  const staccatoEighth = effectiveDisplayDuration(0, 0.22, 0.5);
  assert.equal(staccatoEighth, 0.5);
  assert.equal(flagCountForDuration(staccatoEighth), 1);

  const staccatoBeforeRest = effectiveDisplayDuration(1.0, 0.25, 2.0);
  assert.equal(staccatoBeforeRest, 0.5);
  assert.equal(flagCountForDuration(staccatoBeforeRest), 1);

  const trueSixteenth = effectiveDisplayDuration(0, 0.25, 0.25);
  assert.equal(trueSixteenth, 0.25);
  assert.equal(flagCountForDuration(trueSixteenth), 2);

  const finalNote = effectiveDisplayDuration(3.75, 0.25, null);
  assert.equal(finalNote, 0.25);
  assert.equal(flagCountForDuration(finalNote), 2);

  assert.equal(flagCountForDuration(0.5), 1);
  assert.equal(flagCountForDuration(1.0), 0);
});

test('buildBeamGroups groups within beats, separates hands, and respects measure boundaries', async () => {
  const { buildBeamGroups } = await loadBeamingModule();

  const measureSpans = [
    { measure: 1, startBeat: 0, endBeat: 4 },
    { measure: 2, startBeat: 4, endBeat: 8 },
  ];

  const groups = [
    // Beat 1 RH: two staccato 8ths -> single beam run with flagCount 1
    { hand: 'R', onset: 0, notes: [{ id: 'r1', duration: 0.25, stepOffset: 1 }] },
    { hand: 'R', onset: 0.5, notes: [{ id: 'r2', duration: 0.25, stepOffset: 2 }] },
    // Beat 1 LH at same onsets -> separate LH beam run with stemUp=false (extreme step 7)
    { hand: 'L', onset: 0, notes: [{ id: 'l1', duration: 0.5, stepOffset: 5 }] },
    { hand: 'L', onset: 0.5, notes: [{ id: 'l2', duration: 0.5, stepOffset: 7 }] },
    // Beat 2 RH: four true 16ths -> one 4-note beam run
    { hand: 'R', onset: 1.0, notes: [{ id: 'r3', duration: 0.25, stepOffset: 2 }] },
    { hand: 'R', onset: 1.25, notes: [{ id: 'r4', duration: 0.25, stepOffset: 3 }] },
    { hand: 'R', onset: 1.5, notes: [{ id: 'r5', duration: 0.25, stepOffset: 4 }] },
    { hand: 'R', onset: 1.75, notes: [{ id: 'r6', duration: 0.25, stepOffset: 5 }] },
    // Across barline (3.5 in m1, 4.0 in m2) -> neither should beam together
    { hand: 'R', onset: 3.5, notes: [{ id: 'r7', duration: 0.5, stepOffset: 2 }] },
    { hand: 'R', onset: 4.0, notes: [{ id: 'r8', duration: 0.5, stepOffset: 3 }] },
    // Quarter note at 4.5 breaks any run
    { hand: 'R', onset: 4.5, notes: [{ id: 'r9', duration: 1.0, stepOffset: 2 }] },
  ];

  const runs = buildBeamGroups(groups, measureSpans);
  assert.equal(runs.length, 3);

  const rhBeat1 = runs.find((r) => r.hand === 'R' && r.measure === 1 && r.beatGroup === 0);
  assert.ok(rhBeat1);
  assert.equal(rhBeat1.members.length, 2);
  assert.equal(rhBeat1.stemUp, true);
  assert.equal(rhBeat1.members[0].flagCount, 1);

  const rhBeat2 = runs.find((r) => r.hand === 'R' && r.measure === 1 && r.beatGroup === 1);
  assert.ok(rhBeat2);
  assert.equal(rhBeat2.members.length, 4);
  assert.equal(rhBeat2.stemUp, true); // extreme step 2 has dist 2 vs step 5 dist 1
  assert.equal(rhBeat2.members[0].flagCount, 2);

  const lhBeat1 = runs.find((r) => r.hand === 'L' && r.measure === 1 && r.beatGroup === 0);
  assert.ok(lhBeat1);
  assert.equal(lhBeat1.members.length, 2);
  assert.equal(lhBeat1.stemUp, false);

  assert.equal(
    runs.some((r) => r.members.some((m) => m.noteIds.includes('r7') || m.noteIds.includes('r8'))),
    false,
  );
});

test('computeBeamLine enforces minimum stem clearance and bounded slope', async () => {
  const { computeBeamLine } = await loadBeamingModule();

  const beatPx = 100;
  const leftMargin = 90;
  const baseBottomY = 86;
  const stepPx = 5;
  const minStemLen = 26;

  // Steep ascending run with middle bulge
  const upMembers = [
    { onset: 0, minStepOffset: 0, maxStepOffset: 0 },
    { onset: 0.25, minStepOffset: 6, maxStepOffset: 6 },
    { onset: 0.5, minStepOffset: 10, maxStepOffset: 10 },
  ];
  const upLine = computeBeamLine(upMembers, true, beatPx, leftMargin, baseBottomY, stepPx, minStemLen);
  const dxUp = 0.5 * beatPx;
  const measuredSlopeUp = (upLine.yEnd - upLine.yStart) / dxUp;
  assert.ok(measuredSlopeUp >= -0.18 - 1e-9 && measuredSlopeUp <= 0.18 + 1e-9);

  for (const m of upMembers) {
    const cx = leftMargin + m.onset * beatPx + 18;
    const noteY = baseBottomY - m.maxStepOffset * stepPx;
    const beamY = upLine.stemYForMember(cx);
    assert.ok(
      noteY - beamY >= minStemLen - 1e-9,
      `expected stem clearance >= ${minStemLen}, got ${noteY - beamY}`,
    );
  }

  // Steep descending run with stem down
  const downMembers = [
    { onset: 1.0, minStepOffset: 10, maxStepOffset: 10 },
    { onset: 1.25, minStepOffset: 2, maxStepOffset: 2 },
    { onset: 1.5, minStepOffset: 0, maxStepOffset: 0 },
  ];
  const downLine = computeBeamLine(downMembers, false, beatPx, leftMargin, baseBottomY, stepPx, minStemLen);
  const dxDown = 0.5 * beatPx;
  const measuredSlopeDown = (downLine.yEnd - downLine.yStart) / dxDown;
  assert.ok(measuredSlopeDown >= -0.18 - 1e-9 && measuredSlopeDown <= 0.18 + 1e-9);

  for (const m of downMembers) {
    const cx = leftMargin + m.onset * beatPx + 18;
    const noteY = baseBottomY - m.minStepOffset * stepPx;
    const beamY = downLine.stemYForMember(cx);
    assert.ok(
      beamY - noteY >= minStemLen - 1e-9,
      `expected stem-down clearance >= ${minStemLen}, got ${beamY - noteY}`,
    );
  }
});
