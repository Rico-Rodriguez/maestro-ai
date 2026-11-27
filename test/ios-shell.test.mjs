import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { iosIndexHtml } from '../src/ios-viewport.mjs';
import { nativeHttpToResponse, shouldUseNativeScoreFetch } from '../src/score-fetch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SALAMANDER_SAMPLES = [
  'A1.mp3', 'A2.mp3', 'A3.mp3', 'A4.mp3', 'A5.mp3', 'A6.mp3',
  'C1.mp3', 'C2.mp3', 'C3.mp3', 'C4.mp3', 'C5.mp3', 'C6.mp3', 'C7.mp3',
  'Ds1.mp3', 'Ds2.mp3', 'Ds3.mp3', 'Ds4.mp3', 'Ds5.mp3', 'Ds6.mp3',
  'Fs1.mp3', 'Fs2.mp3', 'Fs3.mp3', 'Fs4.mp3', 'Fs5.mp3', 'Fs6.mp3',
];

test('all 25 Salamander mp3 samples exist and are larger than 1000 bytes', () => {
  const dir = path.join(root, 'public', 'audio', 'salamander');
  const entries = fs.readdirSync(dir).filter((name) => name.endsWith('.mp3')).sort();
  assert.equal(entries.length, 25);
  assert.deepEqual(entries, [...SALAMANDER_SAMPLES].sort());

  for (const file of SALAMANDER_SAMPLES) {
    const stat = fs.statSync(path.join(dir, file));
    assert.ok(stat.isFile(), `${file} must be a regular file`);
    assert.ok(stat.size > 1000, `${file} expected > 1000 bytes, got ${stat.size}`);
  }
});

test('shouldUseNativeScoreFetch routes worker API calls on native origin and skips relative or Pages URLs', () => {
  assert.equal(
    shouldUseNativeScoreFetch(
      'https://maestro-ai.rico21r.workers.dev/maestro-ai/api/musescore',
      'https://localhost/',
    ),
    true,
  );
  assert.equal(
    shouldUseNativeScoreFetch(
      'https://maestro-ai.rico21r.workers.dev/maestro-ai/api/library',
      'https://localhost/',
    ),
    true,
  );
  assert.equal(shouldUseNativeScoreFetch('./audio/salamander/C4.mp3', 'https://localhost/'), false);
  assert.equal(shouldUseNativeScoreFetch('/maestro-ai/library/4197961.mid', 'https://localhost/'), false);
  assert.equal(
    shouldUseNativeScoreFetch(
      'https://rico-rodriguez.github.io/maestro-ai/library/4197961.mid',
      'https://localhost/',
    ),
    false,
  );
  assert.equal(
    shouldUseNativeScoreFetch(
      'https://rico-rodriguez.github.io/maestro-ai/index.html',
      'https://rico-rodriguez.github.io/maestro-ai/',
    ),
    false,
  );
});

test('nativeHttpToResponse produces a valid Response with JSON body and headers', async () => {
  const response = nativeHttpToResponse({
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-custom': ['alpha', 'beta'],
    },
    data: { ok: true, items: [1, 2] },
  });

  assert.equal(response instanceof Response, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('x-custom'), 'alpha, beta');
  assert.deepEqual(await response.json(), { ok: true, items: [1, 2] });
});

test('iosIndexHtml adds viewport-fit=cover and user-scalable=no', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const transformed = iosIndexHtml(html);
  assert.ok(transformed.includes('viewport-fit=cover'));
  assert.ok(transformed.includes('user-scalable=no'));
  assert.ok(transformed.includes('maximum-scale=1.0'));
});
