import assert from 'node:assert/strict';
import { createServer } from 'vite';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyProbe,
  beginProbe,
  claimPaste,
  initialJob,
  practiceCutSentence,
  settlePaste,
} from '../src/musescore-paste-job.mjs';
import { parseScoreUrl } from '../shared/musescore-contract.mjs';
import { classifyDownload, midiAuthorization } from '../server/chrome-score.mjs';
import { fetchScoreMidi } from '../server/musescore.mjs';

const SCORE = 'https://musescore.com/user/30544023/scores/6261339';

const MIDI_BYTES = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06]);

function pageReader(page) {
  return async () => page;
}

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

test('ninety-seven notes stay in the practice song', async () => {
  const parse = await midiParser();
  const opened = parse(midiFile(97), 'Long.mid');
  assert.equal(opened.kept, 97);
  assert.equal(opened.dropped, 0);
  assert.equal(opened.song.events.length, 97);
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

test('fetchScoreMidi refuses a bad link before opening Chrome', async () => {
  let opened = false;
  const result = await fetchScoreMidi('nope', new AbortController().signal, async () => {
    opened = true;
    return { kind: 'unavailable' };
  });
  assert.deepEqual(result, { ok: false, error: 'bad-url' });
  assert.equal(opened, false);
});

test('a Chrome miss is unavailable', async () => {
  const result = await fetchScoreMidi(SCORE, new AbortController().signal, pageReader({ kind: 'unavailable' }));
  assert.deepEqual(result, { ok: false, error: 'unavailable' });
});

test('a MIDI body from the score page is the practice file', async () => {
  const result = await fetchScoreMidi(SCORE, new AbortController().signal, pageReader({
    kind: 'midi',
    title: 'Minuet in G Major',
    scoreId: '6261339',
    bytes: MIDI_BYTES,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.title, 'Minuet in G Major');
  assert.equal(result.scoreId, '6261339');
  assert.equal(classifyDownload(result.bytes), 'midi');
});

test('the public token matches the score page request', () => {
  assert.equal(midiAuthorization('6261339'), 'ed63');
});

test('a score with no MIDI link is no-midi', async () => {
  const result = await fetchScoreMidi(SCORE, new AbortController().signal, pageReader({ kind: 'no-midi' }));
  assert.deepEqual(result, { ok: false, error: 'no-midi' });
});

test('an HTML payload is not a MIDI file', () => {
  const html = Uint8Array.from([0x3c, 0x21, 0x44, 0x4f]);
  assert.equal(classifyDownload(html), 'page');
  assert.equal(classifyDownload(MIDI_BYTES), 'midi');
});

test('claimPaste ignores a second submit while fetching', () => {
  const idle = applyProbe(initialJob(), true);
  const first = claimPaste(idle, 'https://musescore.com/user/1/scores/2');
  const second = claimPaste(first.job, 'https://musescore.com/user/9/scores/9');
  assert.equal(second.request, null);
  assert.equal(second.job, first.job);
  assert.deepEqual(first.request, {
    url: 'https://musescore.com/user/1/scores/2',
    attempt: 1,
  });
  assert.equal(first.job.nextAttempt, 2);
});

test('settlePaste ignores a late attempt', () => {
  const idle = applyProbe(initialJob(), true);
  const claimed = claimPaste(idle, 'https://musescore.com/user/1/scores/2');
  const late = settlePaste(claimed.job, {
    attempt: 99,
    kind: 'ready',
    opened: { song: { id: 'song-1', title: 'Late' }, kept: 1, dropped: 0 },
  });
  assert.equal(late.opened, null);
  assert.equal(late.job, claimed.job);
});

test('settlePaste stores one receipt on the song', () => {
  const idle = applyProbe(initialJob(), true);
  const claimed = claimPaste(idle, 'https://musescore.com/user/1/scores/2');
  const opened = { song: { id: 'song-1', title: 'Night' }, kept: 40, dropped: 0 };
  const settled = settlePaste(claimed.job, { attempt: 1, kind: 'ready', opened });
  assert.equal(settled.opened, opened);
  assert.equal(settled.job.paste.receipt, settled.job.receipts['song-1']);
  assert.deepEqual(settled.job.paste.receipt, {
    songId: 'song-1',
    title: 'Night',
    kept: 40,
    dropped: 0,
  });
  assert.equal(practiceCutSentence(40, 0), '40 notes.');
  assert.equal(practiceCutSentence(40, 2), 'Kept 40. Dropped 2.');
});

test('applyProbe turns probing into idle or helper-off and leaves other phases', () => {
  const probing = initialJob();
  assert.deepEqual(applyProbe(probing, true).paste, { phase: 'idle' });
  assert.deepEqual(applyProbe(probing, false).paste, { phase: 'helper-off' });
  const idle = applyProbe(probing, true);
  assert.equal(applyProbe(idle, false), idle);
  const off = applyProbe(probing, false);
  assert.equal(claimPaste(off, 'https://musescore.com/user/1/scores/2').job, off);
  assert.deepEqual(beginProbe(off).paste, { phase: 'probing' });
  assert.equal(beginProbe(idle), idle);
});
