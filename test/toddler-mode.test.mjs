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

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

test('all 6 TODDLER_SONGS convert via buildToddlerScore into white-key C4..D5 scores and expose art URLs', async () => {
  const {
    TODDLER_SONGS,
    DEFAULT_TODDLER_SCORE,
    buildToddlerScore,
    findToddlerSongSpec,
    getSongPreviewPitches,
    songArtUrl,
  } = await loadTsModule('/src/music/toddler-songs.ts');

  assert.equal(TODDLER_SONGS.length, 6);
  assert.equal(DEFAULT_TODDLER_SCORE.id, 'toddler:twinkle');
  assert.equal(findToddlerSongSpec('toddler:baby-shark')?.title, 'Baby Shark');
  assert.equal(findToddlerSongSpec('missing'), undefined);

  const expectedArt = new Map([
    ['toddler:twinkle', 'twinkle.jpg'],
    ['toddler:mary', 'mary.jpg'],
    ['toddler:baby-shark', 'baby-shark.jpg'],
    ['toddler:row-boat', 'row-boat.jpg'],
    ['toddler:london-bridge', 'london-bridge.jpg'],
    ['toddler:ode-to-joy', 'ode-to-joy.jpg'],
  ]);

  for (const spec of TODDLER_SONGS) {
    assert.equal('emoji' in spec, false, `${spec.id} must not have emoji property`);
    assert.equal(spec.art, expectedArt.get(spec.id), `${spec.id} art filename mismatch`);
    assert.ok(songArtUrl(spec).endsWith(`/art/songs/${spec.art}`), `${spec.id} songArtUrl mismatch`);
    const previewPitches = getSongPreviewPitches(spec, 6);
    assert.equal(previewPitches.length, 6, `${spec.id} preview must return 6 pitches`);
    for (const pitch of previewPitches) {
      const pc = ((pitch % 12) + 12) % 12;
      assert.equal(BLACK_PCS.has(pc), false, `${spec.id} preview pitch ${pitch} must be white key`);
      assert.ok(pitch >= 60 && pitch <= 74, `${spec.id} preview pitch ${pitch} out of C4..D5`);
    }

    const score = buildToddlerScore(spec);
    assert.equal(score.id, spec.id);
    assert.equal(score.title, spec.title);
    assert.equal(score.tempo, spec.tempo);
    assert.ok(score.events.length > 0, `${spec.id} must have events`);
    assert.ok(score.minPitch >= 60 && score.maxPitch <= 74, `${spec.id} must fit C4..D5`);
    assert.ok(score.totalBeats > 0);
    assert.ok(score.totalMeasures >= 1);
    assert.ok(score.totalSeconds > 0);
    assert.equal(score.tempos.length, 1);
    assert.equal(score.timeSignatures.length, 1);
    assert.equal(score.keySignatures.length, 1);

    let prevOnset = -1;
    for (const ev of score.events) {
      const pc = ((ev.pitch % 12) + 12) % 12;
      assert.equal(BLACK_PCS.has(pc), false, `${spec.id} note ${ev.pitchName} must be white key`);
      assert.ok(ev.pitch >= 60 && ev.pitch <= 74, `${spec.id} pitch ${ev.pitch} out of C4..D5`);
      assert.ok(ev.onset >= prevOnset, `${spec.id} onset must be non-decreasing`);
      assert.ok(ev.duration > 0);
      assert.ok(ev.measure >= 1 && ev.measure <= score.totalMeasures);
      assert.ok(ev.beat >= 1);
      prevOnset = ev.onset;
    }
  }
});

test('deriveKidPrompt covers all mascot moods, avoids exclamation marks and harsh words, and tracks stars/progress', async () => {
  const { DEFAULT_TODDLER_SCORE } = await loadTsModule('/src/music/toddler-songs.ts');
  const {
    createPracticeState,
    reducePractice,
    getExpectedNotes,
  } = await loadTsModule('/src/practice/engine.ts');
  const { deriveKidPrompt } = await loadTsModule('/src/components/kid-feedback.ts');

  const assertCalmPrompt = (prompt) => {
    assert.ok(!prompt.headline.includes('!'), `headline must not contain !: ${prompt.headline}`);
    assert.ok(!prompt.headline.includes('Wrong note'));
    assert.ok(!prompt.headline.includes('Missed'));
    if (prompt.cheerBadge) {
      assert.ok(!prompt.cheerBadge.includes('!'), `cheerBadge must not contain !: ${prompt.cheerBadge}`);
    }
  };

  let state = createPracticeState(DEFAULT_TODDLER_SCORE, { mode: 'wait' });
  const idlePrompt = deriveKidPrompt(state, getExpectedNotes(state));
  assert.equal(idlePrompt.mood, 'happy');
  assert.equal(idlePrompt.headline, 'Tap the red key');
  assert.equal(idlePrompt.targetNote?.letter, 'C');
  assert.equal(idlePrompt.targetNote?.colorName, 'Red');
  assert.equal(idlePrompt.starsEarned, 0);
  assert.equal(idlePrompt.progressRatio, 0);
  assertCalmPrompt(idlePrompt);

  state = reducePractice(state, { type: 'noteOn', pitch: 60 }, DEFAULT_TODDLER_SCORE);
  const cheerPrompt = deriveKidPrompt(state, getExpectedNotes(state));
  assert.equal(cheerPrompt.mood, 'cheering');
  assert.equal(cheerPrompt.headline, 'Next, the red key');
  assert.equal(cheerPrompt.cheerBadge, 'Lovely');
  assert.equal(cheerPrompt.starsEarned, 1);
  assert.ok(cheerPrompt.progressRatio > 0 && cheerPrompt.progressRatio < 1);
  assertCalmPrompt(cheerPrompt);

  state = reducePractice(state, { type: 'noteOn', pitch: 62 }, DEFAULT_TODDLER_SCORE);
  const encouragingPrompt = deriveKidPrompt(state, getExpectedNotes(state));
  assert.equal(encouragingPrompt.mood, 'encouraging');
  assert.equal(encouragingPrompt.headline, 'Try the red key');
  assertCalmPrompt(encouragingPrompt);

  let listenState = createPracticeState(DEFAULT_TODDLER_SCORE, { mode: 'listen' });
  const listenIdlePrompt = deriveKidPrompt(listenState, []);
  assert.equal(listenIdlePrompt.mood, 'happy');
  assert.equal(listenIdlePrompt.headline, 'Press play to hear it');
  assertCalmPrompt(listenIdlePrompt);
  listenState = reducePractice(listenState, { type: 'setRunning', running: true }, DEFAULT_TODDLER_SCORE);
  const dancingPrompt = deriveKidPrompt(listenState, []);
  assert.equal(dancingPrompt.mood, 'dancing');
  assert.equal(dancingPrompt.headline, 'Listen along');
  assertCalmPrompt(dancingPrompt);

  let finishState = createPracticeState(DEFAULT_TODDLER_SCORE, { mode: 'wait' });
  for (const ev of DEFAULT_TODDLER_SCORE.events) {
    finishState = reducePractice(finishState, { type: 'noteOn', pitch: ev.pitch }, DEFAULT_TODDLER_SCORE);
  }
  const celebratingPrompt = deriveKidPrompt(finishState, getExpectedNotes(finishState));
  assert.equal(celebratingPrompt.mood, 'celebrating');
  assert.equal(celebratingPrompt.headline, 'Your garden is full');
  assert.equal(celebratingPrompt.cheerBadge, 'Well played');
  assert.equal(celebratingPrompt.progressRatio, 1);
  assert.equal(celebratingPrompt.starsEarned, DEFAULT_TODDLER_SCORE.events.length);
  assertCalmPrompt(celebratingPrompt);
});

test('getKidNoteHint returns toddler-friendly color names, letters, and lane tints', async () => {
  const { getKidNoteHint } = await loadTsModule('/src/components/note-colors.ts');

  const expectations = [
    [60, 'C', 'Red'],
    [62, 'D', 'Orange'],
    [64, 'E', 'Yellow'],
    [65, 'F', 'Green'],
    [67, 'G', 'Teal'],
    [69, 'A', 'Blue'],
    [71, 'B', 'Purple'],
    [61, 'C#', 'Ruby'],
    [66, 'F#', 'Emerald'],
  ];

  for (const [midi, letter, colorName] of expectations) {
    const hint = getKidNoteHint(midi);
    assert.equal(hint.letter, letter);
    assert.equal(hint.colorName, colorName);
    assert.ok(hint.bg.startsWith('#'));
    assert.ok(hint.text.startsWith('#'));
    assert.ok(hint.laneTint.startsWith('rgba('));
  }
});

test('gardenFromGrades returns hit notes only in ascending onset order with ChromaNote colors', async () => {
  const { gardenFromGrades, getKeyStickerColor } = await loadTsModule('/src/components/note-colors.ts');

  const events = [
    { id: 'n3', pitch: 67, onset: 2 },
    { id: 'n1', pitch: 60, onset: 0 },
    { id: 'n2', pitch: 64, onset: 1 },
    { id: 'n4', pitch: 69, onset: 3 },
  ];
  const grades = {
    n1: { status: 'hit', deltaMs: 0 },
    n2: { status: 'miss', deltaMs: null },
    n3: { status: 'hit', deltaMs: 12 },
  };

  const garden = gardenFromGrades(events, grades);
  assert.deepEqual(garden, [
    { id: 'n1', pitch: 60, color: getKeyStickerColor(60).bg },
    { id: 'n3', pitch: 67, color: getKeyStickerColor(67).bg },
  ]);
});
