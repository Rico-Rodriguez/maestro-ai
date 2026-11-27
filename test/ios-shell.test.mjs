import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { iosIndexHtml } from '../src/ios-viewport.mjs';
import { nativeHttpToResponse, shouldUseNativeScoreFetch } from '../src/score-fetch.mjs';
import { buildSideloadSource } from '../scripts/update-sideload-source.mjs';

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

test('public/icon-1024.png exists and is larger than 1000 bytes', () => {
  const stat = fs.statSync(path.join(root, 'public', 'icon-1024.png'));
  assert.ok(stat.isFile());
  assert.ok(stat.size > 1000, `icon-1024.png expected > 1000 bytes, got ${stat.size}`);
});

test('public/source.json is valid AltStore/SideStore source JSON', () => {
  const raw = fs.readFileSync(path.join(root, 'public', 'source.json'), 'utf8');
  const source = JSON.parse(raw);

  assert.equal(source.identifier, 'com.rico.maestroai.source');
  assert.deepEqual(source.featuredApps, ['com.rico.maestroai']);
  assert.equal(source.apps.length, 1);

  const [app] = source.apps;
  assert.equal(app.bundleIdentifier, 'com.rico.maestroai');
  assert.equal(app.category, 'music');
  assert.ok(typeof app.version === 'string' && app.version.length > 0);
  assert.ok(Number.isFinite(app.size) && app.size > 0);
  assert.ok(Array.isArray(app.versions) && app.versions.length >= 1);

  const [latest] = app.versions;
  assert.equal(latest.version, app.version);
  assert.equal(latest.downloadURL, app.downloadURL);
  assert.equal(latest.size, app.size);
  assert.equal(latest.minOSVersion, '15.0');
  assert.ok(typeof latest.buildVersion === 'string' && latest.buildVersion.length > 0);
  assert.ok(!Number.isNaN(Date.parse(latest.date)));
});

test('buildSideloadSource formats all required AltStore v2 fields', () => {
  const source = buildSideloadSource({
    version: '1.0.42',
    buildVersion: 42,
    date: '2026-11-27T04:00:00Z',
    size: 14000000,
    description: 'Build 42 notes',
    downloadURL: 'https://example.com/MaestroAI.ipa',
    iconURL: 'https://example.com/icon-1024.png',
    sourceURL: 'https://example.com/source.json',
  });

  assert.equal(source.name, 'Maestro AI');
  assert.equal(source.subtitle, 'Interactive Piano Studio');
  assert.equal(source.iconURL, 'https://example.com/icon-1024.png');
  assert.equal(source.sourceURL, 'https://example.com/source.json');
  assert.equal(source.identifier, 'com.rico.maestroai.source');
  assert.equal(source.tintColor, '#D97706');
  assert.deepEqual(source.featuredApps, ['com.rico.maestroai']);
  assert.deepEqual(source.news, []);

  const [app] = source.apps;
  assert.equal(app.name, 'Maestro AI');
  assert.equal(app.bundleIdentifier, 'com.rico.maestroai');
  assert.equal(app.developerName, 'Rico Rodriguez');
  assert.equal(app.iconURL, 'https://example.com/icon-1024.png');
  assert.equal(app.version, '1.0.42');
  assert.equal(app.versionDate, '2026-11-27T04:00:00Z');
  assert.equal(app.versionDescription, 'Build 42 notes');
  assert.equal(app.downloadURL, 'https://example.com/MaestroAI.ipa');
  assert.equal(app.size, 14000000);
  assert.deepEqual(app.appPermissions, {
    entitlements: [],
    privacy: {
      NSMicrophoneUsageDescription: 'Maestro AI listens to acoustic piano notes.',
      NSBluetoothAlwaysUsageDescription: 'Maestro AI connects to Bluetooth MIDI keyboards.',
    },
  });

  assert.deepEqual(app.versions, [
    {
      version: '1.0.42',
      buildVersion: '42',
      date: '2026-11-27T04:00:00Z',
      localizedDescription: 'Build 42 notes',
      downloadURL: 'https://example.com/MaestroAI.ipa',
      size: 14000000,
      minOSVersion: '15.0',
    },
  ]);
});
