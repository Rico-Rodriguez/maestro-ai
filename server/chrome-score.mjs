import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9477;
const PROFILE = join(homedir(), 'AppData', 'Local', 'maestro-phone', 'chrome');

let chromeProcess = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }
}

async function debuggerTabs() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`);
  if (!response.ok) return null;
  return response.json();
}

async function ensureChrome() {
  try {
    if (await debuggerTabs()) return;
  } catch {
    chromeProcess = null;
  }
  mkdirSync(PROFILE, { recursive: true });
  chromeProcess = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    'about:blank',
  ], { stdio: 'ignore' });
  chromeProcess.unref();
  chromeProcess.on('exit', () => {
    chromeProcess = null;
  });
  for (let i = 0; i < 40; i += 1) {
    try {
      if (await debuggerTabs()) return;
    } catch {
      await delay(200);
    }
  }
  throw new Error('chrome-unavailable');
}

function cdp(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    ws.addEventListener('error', () => reject(new Error('chrome-socket')));
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      ws.close();
      if (message.result?.exceptionDetails) {
        reject(new Error('chrome-evaluate'));
        return;
      }
      resolve(message.result?.result?.value ?? message.result ?? null);
    });
  });
}

async function scoreTab() {
  const tabs = await debuggerTabs();
  return tabs?.find((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl) ?? null;
}

const TOKEN_SUFFIX = ',%!),';

export function midiAuthorization(scoreId) {
  return createHash('md5').update(`${scoreId}midi0${TOKEN_SUFFIX}`).digest('hex').slice(0, 4);
}

const READ_SCORE = `(() => {
  const score = window.UGAPP && window.UGAPP.store && window.UGAPP.store.page && window.UGAPP.store.page.data && window.UGAPP.store.page.data.score;
  if (!score || score.id == null) return { ready: false };
  return { ready: true, title: String(score.title || ''), scoreId: String(score.id) };
})()`;

function readMidiSource(scoreId, token) {
  return `(async () => {
    const response = await fetch('/api/jmuse?id=${scoreId}&type=midi&index=0', { headers: { Authorization: '${token}' } });
    const text = await response.text();
    let info = '';
    try { info = JSON.parse(text)?.info?.url || ''; } catch { info = ''; }
    if (!info) return { ok: false };
    const file = await fetch(info);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { ok: true, base64: btoa(binary) };
  })()`;
}

export async function readScoreInChrome(pageUrl, signal) {
  throwIfAborted(signal);
  await ensureChrome();
  throwIfAborted(signal);
  const tab = await scoreTab();
  if (!tab) return { kind: 'unavailable' };
  await cdp(tab.webSocketDebuggerUrl, 'Page.navigate', { url: pageUrl });
  let report = null;
  for (let i = 0; i < 40; i += 1) {
    throwIfAborted(signal);
    report = await cdp(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: READ_SCORE,
      awaitPromise: true,
      returnByValue: true,
    });
    if (report?.ready) break;
    await delay(500);
  }
  if (!report?.ready || !/^\d+$/.test(report.scoreId || '')) return { kind: 'unavailable' };
  const file = await cdp(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: readMidiSource(report.scoreId, midiAuthorization(report.scoreId)),
    awaitPromise: true,
    returnByValue: true,
  });
  if (!file?.ok) return { kind: 'no-midi', title: report.title, scoreId: report.scoreId };
  const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
  if (classifyDownload(bytes) !== 'midi') {
    return { kind: 'no-midi', title: report.title, scoreId: report.scoreId };
  }
  return { kind: 'midi', title: report.title, scoreId: report.scoreId, bytes };
}

export function classifyDownload(bytes) {
  if (
    bytes.length >= 4
    && bytes[0] === 0x4d
    && bytes[1] === 0x54
    && bytes[2] === 0x68
    && bytes[3] === 0x64
  ) {
    return 'midi';
  }
  return 'page';
}
