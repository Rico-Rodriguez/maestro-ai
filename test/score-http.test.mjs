import assert from 'node:assert/strict';
import test from 'node:test';
import { midiAuthorization, readScoreHttp } from '../server/score-http.mjs';

const HOWL = 'https://musescore.com/user/16006641/scores/4197961';
const MIDI = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]);

function fakeFetch(routes) {
  return async (url) => {
    const target = String(url);
    const route = routes.find((item) => target.includes(item.match));
    if (!route) return new Response('missing', { status: 404 });
    return route.response();
  };
}

test('the score token stays the four characters the page expects', () => {
  assert.equal(midiAuthorization('6261339'), 'ed63');
});

test('a score page with a midi file returns those bytes', async () => {
  const html = '<meta property="og:title" content="Howl&#039;s Moving Castle">'
    + '<meta property="al:ios:url" content="musescore://score/4197961">';
  const result = await readScoreHttp(HOWL, undefined, fakeFetch([
    {
      match: '/api/jmuse',
      response: () => new Response(JSON.stringify({ info: { url: 'https://cdn.example/howl.mid' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    },
    {
      match: 'cdn.example',
      response: () => new Response(MIDI, { status: 200 }),
    },
    {
      match: 'musescore.com',
      response: () => new Response(html, { status: 200 }),
    },
  ]));
  assert.equal(result.kind, 'midi');
  assert.equal(result.scoreId, '4197961');
  assert.equal(result.title, "Howl's Moving Castle");
  assert.deepEqual(Array.from(result.bytes), Array.from(MIDI));
});

test('a blocked score page is unavailable', async () => {
  const result = await readScoreHttp(HOWL, undefined, async () => new Response('nope', { status: 403 }));
  assert.deepEqual(result, { kind: 'unavailable' });
});
