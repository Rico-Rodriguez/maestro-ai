import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hydrateScoreSalt,
  learnedScoreSalt,
  midiAuthorization,
  persistScoreSalt,
  readScoreHttp,
  rememberSalt,
  resetScoreAuth,
  saltFromScript,
} from '../server/score-http.mjs';

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

test('a rotated salt is learned from the site script and reused', async () => {
  const bag = { salt: 'stale-salt', persisted: 'stale-salt', shared: false };
  const fresh = 'fresh-salt-2026';
  const script = `https://musescore.com/static/public/build/musescore_es6/app.20.js`;
  const html = `<meta property="og:title" content="Fur Elise">`
    + `<meta property="al:ios:url" content="musescore://score/6486524">`
    + `<script src="${script}"></script>`;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = String(url);
    calls.push({ target, auth: init?.headers?.Authorization || '' });
    if (target.includes('/api/jmuse')) {
      const expected = midiAuthorization('6486524', fresh);
      if (init.headers.Authorization !== expected) {
        return new Response(JSON.stringify({ error: 'bad token' }), { status: 403 });
      }
      return new Response(JSON.stringify({ info: { url: 'https://cdn.example/elise.mid' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (target === script) {
      return new Response(`use("${fresh}").substr(0,4)`, { status: 200 });
    }
    if (target.includes('cdn.example')) return new Response(MIDI, { status: 200 });
    return new Response(html, { status: 200 });
  };

  const first = await readScoreHttp(
    'https://musescore.com/user/35709694/scores/6486524',
    undefined,
    fetchImpl,
    bag,
  );
  assert.equal(first.kind, 'midi');
  assert.equal(first.scoreId, '6486524');
  assert.equal(bag.salt, fresh);
  assert.equal(saltFromScript(`("${fresh}").slice(0, 4)`), fresh);

  const before = calls.length;
  const second = await readScoreHttp(
    'https://musescore.com/user/35709694/scores/6486524',
    undefined,
    fetchImpl,
    bag,
  );
  assert.equal(second.kind, 'midi');
  const again = calls.slice(before);
  assert.equal(again.some((call) => call.target === script), false);
  assert.equal(again.filter((call) => call.target.includes('/api/jmuse')).length, 1);
  assert.equal(again.find((call) => call.target.includes('/api/jmuse')).auth, midiAuthorization('6486524', fresh));
});

test('a challenge page from the midi api is unavailable, not a missing file', async () => {
  resetScoreAuth();
  const html = '<meta property="al:ios:url" content="musescore://score/6486524">';
  const result = await readScoreHttp(
    'https://musescore.com/user/35709694/scores/6486524',
    undefined,
    async (url) => {
      if (String(url).includes('/api/jmuse')) {
        return new Response('<html>Just a moment</html>', { status: 403 });
      }
      return new Response(html, { status: 200 });
    },
  );
  assert.equal(result.kind, 'unavailable');
  resetScoreAuth();
});

test('an empty midi catalog stays no-midi after the known salts', async () => {
  resetScoreAuth();
  const html = '<meta property="al:ios:url" content="musescore://score/6486524">';
  let jmuse = 0;
  const result = await readScoreHttp(
    'https://musescore.com/user/35709694/scores/6486524',
    undefined,
    async (url) => {
      if (String(url).includes('/api/jmuse')) {
        jmuse += 1;
        return new Response(JSON.stringify({ info: {} }), { status: 200 });
      }
      return new Response(html, { status: 200 });
    },
  );
  assert.equal(result.kind, 'no-midi');
  assert.equal(jmuse, 2);
  resetScoreAuth();
});

test('a salt that worked is reloaded after the worker restarts', async () => {
  resetScoreAuth();
  const rows = new Map();
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.includes('INSERT')) rows.set(args[0], args[1]);
            },
            async first() {
              const value = rows.get(args[0]);
              return value ? { value } : null;
            },
          };
        },
        async run() {},
      };
    },
  };
  rememberSalt('kept-salt');
  await persistScoreSalt(db);
  resetScoreAuth();
  assert.equal(learnedScoreSalt(), ',%!),');
  await hydrateScoreSalt(db);
  assert.equal(learnedScoreSalt(), 'kept-salt');
  resetScoreAuth();
});
