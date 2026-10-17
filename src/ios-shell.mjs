import { Capacitor, CapacitorHttp, SystemBars, SystemBarsStyle, registerPlugin } from '@capacitor/core';
import { SCORE_ORIGIN } from '../shared/musescore-contract.mjs';
import { nativeHttpToResponse, shouldUseNativeScoreFetch } from './score-fetch.mjs';

const MaestroAudio = registerPlugin('MaestroAudio');
const MaestroMidi = registerPlugin('MaestroMidi');

function headerMap(input, init) {
  const headers = {};
  const source = new Headers(
    (init && init.headers) || (input && typeof input !== 'string' ? input.headers : undefined),
  );
  source.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

async function readBody(input, init) {
  const body = init && Object.prototype.hasOwnProperty.call(init, 'body')
    ? init.body
    : (input && typeof input !== 'string' ? input.body : undefined);
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  return new Response(body).text();
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function nativeScoreFetch(input, init = {}) {
  const raw = typeof input === 'string' ? input : input.url;
  const absolute = new URL(raw, window.location.href);
  const method = String(
    (init && init.method) || (input && typeof input !== 'string' && input.method) || 'GET',
  ).toUpperCase();
  const signal = (init && init.signal) || (input && typeof input !== 'string' ? input.signal : undefined);
  if (signal && signal.aborted) throw abortError();
  const pending = CapacitorHttp.request({
    url: absolute.href,
    method,
    headers: headerMap(input, init),
    data: await readBody(input, init),
    responseType: 'text',
    connectTimeout: 45000,
    readTimeout: 45000,
  }).then(nativeHttpToResponse);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (response) => {
        signal.removeEventListener('abort', onAbort);
        resolve(response);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function installScoreFetch() {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (!shouldUseNativeScoreFetch(input, window.location.href, SCORE_ORIGIN)) {
      return original(input, init);
    }
    return nativeScoreFetch(input, init);
  };
}

function syncMidiInputs(inputs, list) {
  const seen = new Set();
  (list || []).forEach((row) => {
    if (!row || typeof row.id !== 'string') return;
    seen.add(row.id);
    const existing = inputs.get(row.id);
    if (!existing) {
      inputs.set(row.id, {
        id: row.id,
        name: row.name || 'MIDI keyboard',
        manufacturer: row.manufacturer || 'Generic MIDI',
        state: row.state || 'connected',
        connection: 'open',
        onmidimessage: null,
      });
      return;
    }
    existing.name = row.name || existing.name;
    existing.manufacturer = row.manufacturer || existing.manufacturer;
    existing.state = row.state || 'connected';
  });
  Array.from(inputs.keys()).forEach((id) => {
    if (!seen.has(id)) inputs.delete(id);
  });
}

async function installMidiPolyfill() {
  if (typeof navigator.requestMIDIAccess === 'function') return;
  const inputs = new Map();
  let access = null;
  await MaestroMidi.addListener('message', (event) => {
    const input = inputs.get(event && event.id);
    if (!input || typeof input.onmidimessage !== 'function') return;
    const bytes = event && Array.isArray(event.data) ? event.data : [];
    input.onmidimessage({ data: Uint8Array.from(bytes) });
  });
  await MaestroMidi.addListener('state', (event) => {
    syncMidiInputs(inputs, event && event.inputs);
    if (access && typeof access.onstatechange === 'function') {
      access.onstatechange({ target: access });
    }
  });
  navigator.requestMIDIAccess = function requestMIDIAccess() {
    const presentBluetooth = Boolean(navigator.userActivation && navigator.userActivation.isActive);
    return MaestroMidi.requestAccess({ presentBluetooth }).then((result) => {
      syncMidiInputs(inputs, result && result.inputs);
      if (!access) {
        access = {
          inputs,
          outputs: new Map(),
          sysexEnabled: false,
          onstatechange: null,
        };
      }
      return access;
    });
  };
}

export async function installNativeShell() {
  if (!Capacitor.isNativePlatform()) return;
  installScoreFetch();
  globalThis.__maestroPrimeAudioSession = (recording) => MaestroAudio.setSession({
    recording: Boolean(recording),
  });
  globalThis.__maestroSetSystemBars = (dark) => SystemBars.setStyle({
    style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
  });
  try {
    await globalThis.__maestroPrimeAudioSession(false);
  } catch { /* AppDelegate already opened a playback session */ }
  try {
    await globalThis.__maestroSetSystemBars(false);
  } catch { /* status bar contrast is cosmetic */ }
  try {
    await installMidiPolyfill();
  } catch { /* the Connect button reports MIDI as unavailable */ }
}
