import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;
let midiModule;

async function loadMidiModule() {
  if (!midiModule) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    });
    midiModule = await viteServer.ssrLoadModule('/src/music/midi-parser.ts');
  }
  return midiModule;
}

after(async () => {
  if (viteServer) await viteServer.close();
});

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test('parses public/library/4197961.mid with full fidelity, tempo/time/key changes, pedals, and unquantized onsets', async () => {
  const { parseStandardMidiFile, beatToSeconds, secondsToBeat } = await loadMidiModule();
  const bytes = await fs.readFile(path.join(root, 'public/library/4197961.mid'));
  const opened = parseStandardMidiFile(toArrayBuffer(bytes), '4197961.mid');
  const { song } = opened;

  assert.equal(opened.kept, 2346);
  assert.equal(opened.dropped, 0);
  assert.equal(song.events.length, 2346);

  assert.ok(song.tempos.length > 40, `expected > 40 tempo changes, got ${song.tempos.length}`);
  const bpms = song.tempos.map((t) => t.bpm);
  const minBpm = Math.min(...bpms);
  const maxBpm = Math.max(...bpms);
  assert.ok(minBpm >= 75 && minBpm <= 85, `expected min BPM near 80, got ${minBpm}`);
  assert.ok(maxBpm >= 155 && maxBpm <= 165, `expected max BPM near 160, got ${maxBpm}`);

  assert.ok(
    song.timeSignatures.length > 5,
    `expected > 5 time signatures, got ${song.timeSignatures.length}`,
  );
  assert.equal(song.pedals.length, 300);

  assert.equal(song.keySignature, 'Bb Major');
  assert.equal(song.keySignatures[0].preferFlats, true);

  assert.ok(song.events.some((ev) => ev.hand === 'R'), 'expected right-hand notes');
  assert.ok(song.events.some((ev) => ev.hand === 'L'), 'expected left-hand notes');

  const hasOffGrid = song.events.some(
    (ev) => Math.abs(ev.onset * 4 - Math.round(ev.onset * 4)) > 1e-4,
  );
  assert.equal(hasOffGrid, true, 'expected unquantized onset values off the 0.25-beat grid');

  for (const beat of [0, 4.5, 32, 120.75, song.totalBeats * 0.75]) {
    const sec = beatToSeconds(song, beat);
    const roundTrip = secondsToBeat(song, sec);
    assert.ok(
      Math.abs(roundTrip - beat) < 1e-6,
      `beatToSeconds/secondsToBeat round-trip failed at beat ${beat}: got ${roundTrip}`,
    );
  }
});

test('parses Frozen 2 Show Yourself MIDI preserving all 1,187 notes including cross-channel overlaps', async () => {
  const { parseStandardMidiFile } = await loadMidiModule();
  const filename =
    "Show_Yourself_(from_Disney's_Frozen_2)_-_Idina_Menzel_and_Evan_Rachel_Wood_(Easy_Piano).mid";
  const bytes = await fs.readFile(path.join(root, 'src', filename));
  const opened = parseStandardMidiFile(toArrayBuffer(bytes), filename);

  assert.equal(opened.kept, 1187);
  assert.equal(opened.dropped, 0);
  assert.equal(opened.song.events.length, 1187);

  // Verify overlapping same-pitch notes across tracks/channels are preserved.
  const events = opened.song.events;
  let overlappingSamePitch = 0;
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      if (events[j].onset >= events[i].onset + events[i].duration) break;
      if (events[j].pitch === events[i].pitch && events[j].track !== events[i].track) {
        overlappingSamePitch += 1;
      }
    }
  }
  assert.ok(
    overlappingSamePitch > 0,
    `expected overlapping same-pitch notes across tracks, got ${overlappingSamePitch}`,
  );
});

test('rejects invalid header with midi-bad and empty tracks with midi-empty', async () => {
  const { parseStandardMidiFile } = await loadMidiModule();

  const badBytes = Uint8Array.from([0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x00]);
  assert.throws(
    () => parseStandardMidiFile(badBytes.buffer, 'bad.mid'),
    (error) => error instanceof Error && error.code === 'midi-bad',
  );

  // Valid MThd (format 0, 1 track, 480 ppq) with an empty MTrk (End of Track only).
  const emptyTrackMidi = Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
    0x00, 0x00, 0x00, 0x04,
    0x00, 0xff, 0x2f, 0x00,
  ]);
  assert.throws(
    () => parseStandardMidiFile(emptyTrackMidi.buffer, 'empty.mid'),
    (error) => error instanceof Error && error.code === 'midi-empty',
  );
});
