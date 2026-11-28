import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { iosIndexHtml } from '../src/ios-viewport.mjs';
import { nativeHttpToResponse, shouldUseNativeScoreFetch } from '../src/score-fetch.mjs';
import { buildSideloadSource } from '../scripts/update-sideload-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let viteServer;

async function loadTsModule(modulePath) {
  if (!viteServer) {
    viteServer = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    });
  }
  return viteServer.ssrLoadModule(modulePath);
}

after(async () => {
  if (viteServer) await viteServer.close();
});

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
  assert.match(app.versionDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(latest.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
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

test('buildSideloadSource strips fractional seconds and merges/deduplicates existingVersions', () => {
  const existingVersions = Array.from({ length: 11 }, (_, idx) => {
    const num = 42 - idx;
    return {
      version: `1.0.${num}`,
      buildVersion: String(num),
      date: `2026-11-${String(20 - idx).padStart(2, '0')}T04:00:00Z`,
      localizedDescription: `Old ${num}`,
      downloadURL: `https://example.com/MaestroAI-1.0.${num}.ipa`,
      size: 13000000 + num,
      minOSVersion: '15.0',
    };
  });

  const source = buildSideloadSource({
    version: '1.0.42',
    buildVersion: 42,
    date: '2026-11-27T18:45:04.123Z',
    size: 14000000,
    description: 'New 42',
    downloadURL: 'https://example.com/MaestroAI-1.0.42.ipa',
    existingVersions,
  });

  const [app] = source.apps;
  assert.equal(app.versionDate, '2026-11-27T18:45:04Z');
  assert.equal(app.versions.length, 10);
  assert.equal(app.versions[0].version, '1.0.42');
  assert.equal(app.versions[0].date, '2026-11-27T18:45:04Z');
  assert.equal(app.versions[0].localizedDescription, 'New 42');
  assert.equal(app.versions.filter((entry) => entry.version === '1.0.42').length, 1);
  assert.equal(app.versions[1].version, '1.0.41');
  assert.equal(app.versions[9].version, '1.0.33');
});

test('update-sideload-source CLI merges --existing and ignores missing --existing file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-source-'));
  const scriptPath = path.join(root, 'scripts', 'update-sideload-source.mjs');
  const outPath = path.join(tmpDir, 'source.json');
  const missingPath = path.join(tmpDir, 'does-not-exist.json');

  try {
    execFileSync(process.execPath, [
      scriptPath,
      '--version', '1.0.14',
      '--build', '14',
      '--size', '1000',
      '--date', '2026-11-27T18:00:00.500Z',
      '--existing', missingPath,
      '--out', outPath,
    ]);
    const first = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(first.sourceURL, 'https://github.com/Rico-Rodriguez/maestro-ai/releases/latest/download/source.json');
    assert.equal(first.apps[0].versions.length, 1);
    assert.equal(first.apps[0].versionDate, '2026-11-27T18:00:00Z');

    execFileSync(process.execPath, [
      scriptPath,
      '--version', '1.0.15',
      '--build', '15',
      '--size', '2000',
      '--date', '2026-11-27T19:00:00.250Z',
      '--existing', outPath,
      '--out', outPath,
    ]);
    const second = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.deepEqual(
      second.apps[0].versions.map((entry) => entry.version),
      ['1.0.15', '1.0.14'],
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MidiInputController distinguishes auto-probe from interactive reconnect on native MIDI', async () => {
  const { MidiInputController } = await loadTsModule('/src/input/midi-adapter.ts');
  const prevNativeMidi = globalThis.__maestroNativeMidi;
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls = [];
  const inputs = new Map([
    [
      'kb-1',
      {
        id: 'kb-1',
        name: 'Digital Piano',
        manufacturer: 'Roland',
        state: 'connected',
        onmidimessage: null,
      },
    ],
  ]);

  try {
    globalThis.__maestroNativeMidi = true;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        requestMIDIAccess: async (options) => {
          calls.push(options);
          return {
            inputs,
            outputs: new Map(),
            sysexEnabled: false,
            onstatechange: null,
          };
        },
      },
    });

    const controller = new MidiInputController();
    const received = [];
    controller.subscribe((ev) => received.push(ev));

    const probeState = await controller.probeIfPermitted();
    assert.equal(probeState, 'ready');
    assert.deepEqual(calls[0], { sysex: false, presentBluetooth: false });
    assert.equal(controller.getDevices().length, 1);

    const connectState = await controller.connect({ interactive: true });
    assert.equal(connectState, 'ready');
    assert.deepEqual(calls[1], { sysex: false, presentBluetooth: true });

    const input = inputs.get('kb-1');
    input.onmidimessage({ data: Uint8Array.from([0x90, 60, 100]) });
    assert.equal(received.length, 1);
    assert.equal(received[0].kind, 'on');
    assert.equal(received[0].pitch, 60);
    assert.equal(received[0].source, 'midi');

    controller.dispose();
  } finally {
    globalThis.__maestroNativeMidi = prevNativeMidi;
    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('MicInputController uses __maestroNativeMic for level, pitch, note onset, and cleanup', async () => {
  const { MicInputController } = await loadTsModule('/src/input/mic-adapter.ts');
  const prevNativeMic = globalThis.__maestroNativeMic;
  let emitFrame = null;
  let stopCalled = 0;

  try {
    globalThis.__maestroNativeMic = {
      async start(onFrame) {
        emitFrame = onFrame;
        return async () => {
          stopCalled += 1;
        };
      },
    };

    const controller = new MicInputController();
    const levels = [];
    const pitches = [];
    const notes = [];

    await controller.start({
      onLevel: (level) => levels.push(level),
      onPitch: (reading) => pitches.push(reading),
      onNote: (event) => notes.push(event),
      shouldGate: () => false,
    });

    assert.equal(controller.isActive(), true);
    assert.equal(typeof emitFrame, 'function');

    emitFrame({ rms: 0.05, freq: 440, clarity: 0.96 });
    emitFrame({ rms: 0.05, freq: 440, clarity: 0.97 });

    assert.equal(levels.length, 2);
    assert.ok(Math.abs(levels[0] - 0.3) < 1e-6);
    assert.equal(pitches[0]?.name, 'A4');
    assert.equal(pitches[0]?.midi, 69);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, 'on');
    assert.equal(notes[0].pitch, 69);
    assert.equal(notes[0].source, 'mic');

    controller.stop();
    assert.equal(controller.isActive(), false);
    assert.equal(stopCalled, 1);
    assert.equal(notes.some((n) => n.kind === 'off' && n.pitch === 69), true);
  } finally {
    globalThis.__maestroNativeMic = prevNativeMic;
  }
});

test('MaestroNative.swift and Main.storyboard wire native mic, CoreMIDI, and bridge controller', () => {
  const swift = fs.readFileSync(path.join(root, 'ios', 'App', 'App', 'MaestroNative.swift'), 'utf8');
  assert.ok(swift.includes('startMic'));
  assert.ok(swift.includes('stopMic'));
  assert.ok(swift.includes('unsafeSequence'));
  assert.ok(swift.includes('runningStatus'));

  const storyboard = fs.readFileSync(
    path.join(root, 'ios', 'App', 'App', 'Base.lproj', 'Main.storyboard'),
    'utf8',
  );
  assert.ok(storyboard.includes('MaestroBridgeViewController'));
});
