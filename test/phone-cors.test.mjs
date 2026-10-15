import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { HELPER_PATH } from '../shared/musescore-contract.mjs';
import { server } from '../server/phone.mjs';

const PAGES = 'https://rico-rodriguez.github.io';

async function listen() {
  if (server.listening) return server.address().port;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

after(() => new Promise((resolve) => {
  if (!server.listening) {
    resolve();
    return;
  }
  server.close(resolve);
}));

test('the published page can preflight and probe the helper', async () => {
  const port = await listen();
  const root = `http://127.0.0.1:${port}`;
  const preflight = await fetch(`${root}${HELPER_PATH}`, {
    method: 'OPTIONS',
    headers: {
      Origin: PAGES,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), PAGES);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

  const probe = await fetch(`${root}${HELPER_PATH}`, {
    headers: { Origin: PAGES, Accept: 'application/json' },
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.headers.get('access-control-allow-origin'), PAGES);
  assert.deepEqual(await probe.json(), { helper: 'musescore-phone' });

  const rejected = await fetch(`${root}${HELPER_PATH}`, {
    method: 'POST',
    headers: {
      Origin: PAGES,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: 'nope' }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.headers.get('access-control-allow-origin'), PAGES);
  assert.deepEqual(await rejected.json(), { error: 'bad-url' });

  const stranger = await fetch(`${root}${HELPER_PATH}`, {
    headers: { Origin: 'https://evil.example', Accept: 'application/json' },
  });
  assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await stranger.json(), { helper: 'musescore-phone' });
});
