import assert from 'node:assert/strict';
import { createServer } from 'vite';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseScoreUrl } from '../shared/musescore-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;
let parseStandardMidiFile;

async function midiParser() {
  if (!parseStandardMidiFile) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
    });
    const loaded = await viteServer.ssrLoadModule('/src/maestro_ai_platform.tsx');
    parseStandardMidiFile = loaded.parseStandardMidiFile;
  }
  return parseStandardMidiFile;
}

after(async () => {
  if (viteServer) await viteServer.close();
});

function vlq(value) {
  const bytes = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes.reverse();
}

function midiFile(noteCount) {
  const events = [];
  for (let i = 0; i < noteCount; i += 1) {
    const pitch = 60 + (i % 12);
    events.push(0x00, 0x90, pitch, 64, ...vlq(480), 0x80, pitch, 0);
  }
  events.push(0x00, 0xff, 0x2f, 0x00);
  const bytes = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
    (events.length >>> 24) & 0xff,
    (events.length >>> 16) & 0xff,
    (events.length >>> 8) & 0xff,
    events.length & 0xff,
    ...events,
  ];
  return Uint8Array.from(bytes).buffer;
}

test('parseScoreUrl accepts musescore.com, www, and the s host', () => {
  assert.equal(
    parseScoreUrl('https://musescore.com/user/9292486/scores/2086216'),
    'https://musescore.com/user/9292486/scores/2086216',
  );
  assert.equal(
    parseScoreUrl('  http://www.musescore.com/user/9292486/scores/2086216  '),
    'http://www.musescore.com/user/9292486/scores/2086216',
  );
  assert.equal(
    parseScoreUrl('https://s.musescore.com/user/9292486/scores/2086216'),
    'https://s.musescore.com/user/9292486/scores/2086216',
  );
});

test('parseScoreUrl rejects a bare id, the mobile host, and other sites', () => {
  assert.equal(parseScoreUrl('2086216'), null);
  assert.equal(parseScoreUrl('https://m.musescore.com/user/9292486/scores/2086216'), null);
  assert.equal(parseScoreUrl('https://example.com/user/9292486/scores/2086216'), null);
  assert.equal(parseScoreUrl(2086216), null);
  assert.equal(parseScoreUrl(''), null);
});

test('a one-note MIDI file keeps that note', async () => {
  const parse = await midiParser();
  const opened = parse(midiFile(1), 'Scale.mid');
  assert.equal(opened.kept, 1);
  assert.equal(opened.dropped, 0);
  assert.equal(opened.song.events.length, 1);
  assert.equal(opened.song.title, 'Scale');
});

test('ninety-seven notes keep the first ninety-six', async () => {
  const parse = await midiParser();
  const opened = parse(midiFile(97), 'Long.mid');
  assert.equal(opened.kept, 96);
  assert.equal(opened.dropped, 1);
  assert.equal(opened.song.events.length, 96);
});

test('a header that is not MThd throws', async () => {
  const parse = await midiParser();
  const bytes = Uint8Array.from([0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x00]);
  assert.throws(
    () => parse(bytes.buffer, 'bad.mid'),
    (error) => error instanceof Error
      && error.message === 'Invalid MIDI header (Expected MThd).'
      && error.code === 'midi-bad',
  );
});
