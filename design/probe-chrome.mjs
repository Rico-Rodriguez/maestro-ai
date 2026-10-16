import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pageUrl = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), 'maestro-chrome-'));
const chrome = spawn(
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  [
    '--remote-debugging-port=9333',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    pageUrl,
  ],
  { stdio: 'ignore' },
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const id = 1;
  const result = new Promise((resolve) => {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === id) resolve(message.result);
    });
  });
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true },
  }));
  const value = await result;
  ws.close();
  return value?.result?.value;
}

try {
  let page = null;
  for (let i = 0; i < 20 && !page; i += 1) {
    await delay(500);
    try {
      const tabs = await fetch('http://127.0.0.1:9333/json').then((response) => response.json());
      page = tabs.find((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl);
    } catch {
      page = null;
    }
  }
  if (!page) {
    console.log(JSON.stringify({ ok: false, reason: 'no-tab' }));
    process.exitCode = 1;
  } else {
    const samples = [];
    for (let i = 0; i < 12; i += 1) {
      const title = await evaluate(page.webSocketDebuggerUrl, 'document.title');
      const hasScore = await evaluate(
        page.webSocketDebuggerUrl,
        'document.documentElement.outerHTML.includes("musescore://score/")',
      );
      samples.push({ t: i, title, hasScore });
      if (hasScore) break;
      await delay(1500);
    }
    console.log(JSON.stringify({ ok: true, samples }, null, 2));
  }
} finally {
  chrome.kill();
  await delay(300);
  rmSync(profile, { recursive: true, force: true });
}
