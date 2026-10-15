import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLibrary, scoreIdFromUrl } from '../server/library.mjs';

const MIDI = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06]);
const HOWL = 'https://musescore.com/user/16006641/scores/4197961';

async function withLibrary(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'maestro-library-'));
  const library = createLibrary(dir);
  try {
    await run(library, dir);
  } finally {
    library.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('scoreIdFromUrl reads the scores path and ignores other links', () => {
  assert.equal(scoreIdFromUrl(HOWL), '4197961');
  assert.equal(scoreIdFromUrl('https://musescore.com/user/16006641'), null);
  assert.equal(scoreIdFromUrl('not a url'), null);
});

test('a saved score is listed once and opens without the original bytes changing', async () => {
  await withLibrary(async (library) => {
    const saved = await library.save({
      scoreId: '4197961',
      title: "Merry-Go-Round of Life: Howl's Moving Castle Piano Tutorial",
      sourceUrl: HOWL,
      bytes: MIDI,
    });
    assert.equal(saved.scoreId, '4197961');
    const again = await library.save({
      scoreId: '4197961',
      title: "Merry-Go-Round of Life: Howl's Moving Castle Piano Tutorial",
      sourceUrl: HOWL,
      bytes: MIDI,
    });
    const rows = await library.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, again.title);
    const opened = await library.findByUrl(HOWL);
    assert.equal(opened.scoreId, '4197961');
    assert.deepEqual(Array.from(opened.bytes), Array.from(MIDI));
  });
});

test('a second score stays beside the first', async () => {
  await withLibrary(async (library) => {
    await library.save({
      scoreId: '4197961',
      title: 'Howl',
      sourceUrl: HOWL,
      bytes: MIDI,
    });
    await library.save({
      scoreId: '6261339',
      title: 'Minuet in G Major',
      sourceUrl: 'https://musescore.com/user/30544023/scores/6261339',
      bytes: MIDI,
    });
    const rows = await library.list();
    assert.deepEqual(rows.map((row) => row.scoreId).sort(), ['4197961', '6261339']);
  });
});

test('a saved score is still there after the folder is opened again', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maestro-library-'));
  try {
    const first = createLibrary(dir);
    await first.save({
      scoreId: '4197961',
      title: 'Howl',
      sourceUrl: HOWL,
      bytes: MIDI,
    });
    first.close();
    await rm(path.join(dir, '4197961.mid'), { force: true });
    await rm(path.join(dir, 'index.json'), { force: true });
    const second = createLibrary(dir);
    const opened = await second.findByUrl(HOWL);
    const rows = await second.list();
    second.close();
    assert.equal(opened.title, 'Howl');
    assert.deepEqual(Array.from(opened.bytes), Array.from(MIDI));
    assert.deepEqual(rows.map((row) => row.scoreId), ['4197961']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an older index.json catalog is kept in the database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maestro-library-'));
  try {
    await writeFile(path.join(dir, '4197961.mid'), MIDI);
    await writeFile(path.join(dir, 'index.json'), JSON.stringify({
      4197961: {
        scoreId: '4197961',
        title: 'Howl',
        sourceUrl: HOWL,
        savedAt: '2026-10-15T04:02:28.053Z',
      },
    }));
    const library = createLibrary(dir);
    const opened = await library.read('4197961');
    library.close();
    assert.equal(opened.title, 'Howl');
    assert.equal(opened.savedAt, '2026-10-15T04:02:28.053Z');
    assert.deepEqual(Array.from(opened.bytes), Array.from(MIDI));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a non-midi payload is not stored', async () => {
  await withLibrary(async (library) => {
    const saved = await library.save({
      scoreId: '1',
      title: 'Nope',
      sourceUrl: 'https://musescore.com/user/1/scores/1',
      bytes: Uint8Array.from([0x3c, 0x21, 0x44, 0x4f]),
    });
    assert.equal(saved, null);
    assert.deepEqual(await library.list(), []);
  });
});
