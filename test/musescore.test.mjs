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

const SCORE = 'https://musescore.com/user/9292486/scores/2086216';
const VENDOR = 'https://musescore.com/static/public/build/musescore.2026/20/vendor.js';
const APP_SCRIPT = 'https://musescore.com/static/public/build/musescore.2026/20/app.js';
const JMUSE = 'https://musescore.com/api/jmuse?id=2086216&type=midi&index=0';
const MIDI_BYTES = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06]);

function scoreHtml() {
  return [
    '<meta content="musescore://score/2086216" property="al:ios:url">',
    '<meta property="og:title" content="Rock &amp; Roll&#39;s">',
    `<script src="${VENDOR}"></script>`,
    `<script src="${APP_SCRIPT}"></script>`,
  ].join('');
}

function installFetch(route) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = init.headers || {};
    calls.push({ url, headers });
    const response = await route(url, headers);
    return response ?? new Response('missing', { status: 599 });
  };
  return calls;
}

function assertUpstream(calls) {
  for (const call of calls) {
    assert.equal(call.headers['User-Agent'], 'MaestroPhone/1');
    assert.equal(Object.hasOwn(call.headers, 'Cookie'), false);
    if (!call.url.startsWith('https://musescore.com/api/jmuse')) {
      assert.equal(Object.hasOwn(call.headers, 'Authorization'), false);
    }
  }
}

async function withFetch(route, run) {
  const previous = globalThis.fetch;
  const calls = installFetch(route);
  const nonce = Math.random().toString(16).slice(2);
  const loaded = await import(`../server/musescore.mjs?isolate=${nonce}`);
  try {
    return await run(calls, loaded.fetchScoreMidi);
  } finally {
    globalThis.fetch = previous;
  }
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

test('fetchScoreMidi refuses a bad link before any request', async () => {
  await withFetch(async () => new Response('no', { status: 500 }), async (calls, fetchScoreMidi) => {
    const result = await fetchScoreMidi('nope', new AbortController().signal);
    assert.deepEqual(result, { ok: false, error: 'bad-url' });
    assert.deepEqual(calls, []);
  });
});

test('a 403 score page is unavailable and is not requested again', async () => {
  await withFetch(async () => new Response('blocked', { status: 403 }), async (calls, fetchScoreMidi) => {
    const result = await fetchScoreMidi(SCORE, new AbortController().signal);
    assert.deepEqual(result, { ok: false, error: 'unavailable' });
    assert.deepEqual(calls.map((call) => call.url), [SCORE]);
    assertUpstream(calls);
  });
});

test('a failed discovered salt tries the fallback salt once', async () => {
  await withFetch(async (url, headers) => {
    if (url === SCORE) return new Response(scoreHtml(), { status: 200 });
    if (url === VENDOR) return new Response('webpackChunk = [];', { status: 200 });
    if (url === APP_SCRIPT) return new Response('var s = ("abcdef").substr(0, 4);', { status: 200 });
    if (url === JMUSE && headers.Authorization === '62fc') return new Response('no', { status: 403 });
    if (url === JMUSE && headers.Authorization === 'ae2b') {
      return Response.json({ info: { url: 'https://cdn.example/score.mid' } });
    }
    if (url === 'https://cdn.example/score.mid') return new Response(MIDI_BYTES, { status: 200 });
    return new Response('missing', { status: 599 });
  }, async (calls, fetchScoreMidi) => {
    const result = await fetchScoreMidi(SCORE, new AbortController().signal);
    assert.equal(result.ok, true);
    assert.equal(result.title, "Rock & Roll's");
    assert.deepEqual(Array.from(result.bytes), Array.from(MIDI_BYTES));
    assert.deepEqual(
      calls.map((call) => call.url),
      [SCORE, VENDOR, APP_SCRIPT, JMUSE, JMUSE, 'https://cdn.example/score.mid'],
    );
    assert.equal(calls[3].headers.Authorization, '62fc');
    assert.equal(calls[4].headers.Authorization, 'ae2b');
    assertUpstream(calls);
  });
});

test('a later build script supplies the salt when the first chunk has none', async () => {
  await withFetch(async (url, headers) => {
    if (url === SCORE) return new Response(scoreHtml(), { status: 200 });
    if (url === VENDOR) return new Response('webpackChunk = [];', { status: 200 });
    if (url === APP_SCRIPT) return new Response('var s = ("abcdef").substr(0, 4);', { status: 200 });
    if (url === JMUSE && headers.Authorization === '62fc') {
      return Response.json({ info: { url: 'https://cdn.example/score.mid' } });
    }
    if (url === 'https://cdn.example/score.mid') return new Response(MIDI_BYTES, { status: 200 });
    return new Response('missing', { status: 599 });
  }, async (calls, fetchScoreMidi) => {
    const result = await fetchScoreMidi(SCORE, new AbortController().signal);
    assert.equal(result.ok, true);
    assert.equal(result.title, "Rock & Roll's");
    assert.deepEqual(Array.from(result.bytes), Array.from(MIDI_BYTES));
    assert.deepEqual(calls.map((call) => call.url), [SCORE, VENDOR, APP_SCRIPT, JMUSE, 'https://cdn.example/score.mid']);
    assert.equal(calls[3].headers.Authorization, '62fc');
    assertUpstream(calls);
  });
});

test('an info url that is not https does not leave the helper', async () => {
  await withFetch(async (url) => {
    if (url === SCORE) return new Response(scoreHtml(), { status: 200 });
    if (url === VENDOR || url === APP_SCRIPT) return new Response('var s = ("abcdef").substr(0, 4);', { status: 200 });
    if (url === JMUSE) return Response.json({ info: { url: 'http://cdn.example/score.mid' } });
    return new Response('missing', { status: 599 });
  }, async (calls, fetchScoreMidi) => {
    const result = await fetchScoreMidi(SCORE, new AbortController().signal);
    assert.deepEqual(result, { ok: false, error: 'no-midi' });
    assert.equal(calls.filter((call) => call.url === JMUSE).length, 1);
    assert.equal(calls.some((call) => call.url.startsWith('http://')), false);
  });
});

test('a body that does not start with MThd is no-midi', async () => {
  await withFetch(async (url) => {
    if (url === SCORE) return new Response(scoreHtml(), { status: 200 });
    if (url === VENDOR || url === APP_SCRIPT) return new Response('var s = ("abcdef").substr(0, 4);', { status: 200 });
    if (url === JMUSE) return Response.json({ info: { url: 'https://cdn.example/score.mid' } });
    if (url === 'https://cdn.example/score.mid') return new Response('HELLO', { status: 200 });
    return new Response('missing', { status: 599 });
  }, async (calls, fetchScoreMidi) => {
    const result = await fetchScoreMidi(SCORE, new AbortController().signal);
    assert.deepEqual(result, { ok: false, error: 'no-midi' });
    assert.equal(calls.filter((call) => call.url === JMUSE).length, 1);
  });
});

test('a page with no salt tries only the fallback', async () => {
  const html = [
    '<meta property="al:ios:url" content="musescore://score/2086216">',
    '<meta content="Plain" property="og:title">',
  ].join('');
  await withFetch(async (url, headers) => {
    if (url === SCORE) return new Response(html, { status: 200 });
    if (url === JMUSE && headers.Authorization === 'ae2b') {
      return Response.json({ info: { url: 'https://cdn.example/score.mid' } });
    }
    if (url === 'https://cdn.example/score.mid') return new Response(MIDI_BYTES, { status: 200 });
    return new Response('extra', { status: 500 });
  }, async (calls, fetchScoreMidi) => {
    const result = await fetchScoreMidi(SCORE, new AbortController().signal);
    assert.equal(result.ok, true);
    assert.equal(result.title, 'Plain');
    assert.deepEqual(calls.map((call) => call.url), [SCORE, JMUSE, 'https://cdn.example/score.mid']);
    assert.equal(calls[1].headers.Authorization, 'ae2b');
  });
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
  assert.equal(practiceCutSentence(40, 0), 'Kept 40. Dropped 0.');
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

test('two failed jmuse replies stop after the fallback', async () => {
  await withFetch(async (url) => {
    if (url === SCORE) return new Response(scoreHtml(), { status: 200 });
    if (url === VENDOR || url === APP_SCRIPT) return new Response('var s = ("abcdef").substr(0, 4);', { status: 200 });
    if (url === JMUSE) return new Response('no', { status: 403 });
    return new Response('extra', { status: 500 });
  }, async (calls, fetchScoreMidi) => {
    const result = await fetchScoreMidi(SCORE, new AbortController().signal);
    assert.deepEqual(result, { ok: false, error: 'unavailable' });
    const jmuse = calls.filter((call) => call.url === JMUSE);
    assert.deepEqual(jmuse.map((call) => call.headers.Authorization), ['62fc', 'ae2b']);
  });
});
