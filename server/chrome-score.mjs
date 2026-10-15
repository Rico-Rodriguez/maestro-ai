import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9477;
const PROFILE = join(dirname(fileURLToPath(import.meta.url)), 'chrome-profile');

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
  if (!report?.ready) return { kind: 'unavailable' };
  if (!/^\d+$/.test(report.scoreId || '')) return { kind: 'unavailable' };
  if (report.kind === 'no-midi') {
    return { kind: 'no-midi', title: report.title, scoreId: report.scoreId };
  }
  const bytes = Uint8Array.from(atob(report.base64), (char) => char.charCodeAt(0));
  if (classifyDownload(bytes) === 'midi') {
    return { kind: 'midi', title: report.title, scoreId: report.scoreId, bytes };
  }
  return { kind: 'login', title: report.title, scoreId: report.scoreId };
}

const READ_SCORE = `(async () => {
  const data = window.UGAPP && window.UGAPP.store && window.UGAPP.store.page && window.UGAPP.store.page.data;
  const score = data && data.score;
  if (!score || score.id == null) return { ready: false };
  const list = Array.isArray(data.type_download_list) ? data.type_download_list : [];
  const midi = list.find((item) => item && item.type === 'mid' && typeof item.authorized_url === 'string');
  if (!midi) {
    return { ready: true, kind: 'no-midi', title: String(score.title || ''), scoreId: String(score.id) };
  }
  const response = await fetch(midi.authorized_url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return {
    ready: true,
    kind: 'file',
    title: String(score.title || ''),
    scoreId: String(score.id),
    base64: btoa(binary),
  };
})()`;

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
