import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SALAMANDER_BASE_URL, SALAMANDER_SAMPLE_MAP } from '../src/poteto-audio.mjs';
import { nativeHttpToResponse, shouldUseNativeScoreFetch } from '../src/score-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCORE = 'https://maestro-ai.rico21r.workers.dev';

test('piano samples are copied into the app instead of loaded from a CDN', () => {
  assert.equal(SALAMANDER_BASE_URL, 'audio/salamander/');
  assert.equal(SALAMANDER_BASE_URL.includes('tonejs.github.io'), false);
  const files = Object.values(SALAMANDER_SAMPLE_MAP);
  assert.equal(files.length, 25);
  files.forEach((file) => {
    const full = path.join(ROOT, 'public', SALAMANDER_BASE_URL, file);
    assert.equal(fs.existsSync(full), true, full);
    assert.ok(fs.statSync(full).size > 1000, full);
  });
});

test('only the score service leaves the web view for native HTTP', () => {
  const page = 'https://localhost/';
  assert.equal(
    shouldUseNativeScoreFetch(`${SCORE}/maestro-ai/api/musescore`, page),
    true,
  );
  assert.equal(
    shouldUseNativeScoreFetch(`${SCORE}/maestro-ai/api/library`, page),
    true,
  );
  assert.equal(shouldUseNativeScoreFetch('audio/salamander/C4.mp3', page), false);
  assert.equal(shouldUseNativeScoreFetch('/assets/index.js', page), false);
  assert.equal(
    shouldUseNativeScoreFetch('https://rico-rodriguez.github.io/maestro-ai/', page),
    false,
  );
  assert.equal(
    shouldUseNativeScoreFetch(`${SCORE}/maestro-ai/api/musescore`, SCORE),
    false,
  );
});

test('native score responses stay readable by the existing fetch callers', async () => {
  const response = nativeHttpToResponse({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    data: { helper: 'musescore-phone' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), { helper: 'musescore-phone' });
});
