import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = mkdtempSync(join(tmpdir(), 'maestro-chrome-'));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--remote-debugging-port=9333',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  'https://musescore.com/user/30544023/scores/6261339',
], { stdio: 'ignore' });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const result = new Promise((resolve) => {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) resolve(message.result);
    });
  });
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  }));
  const value = await result;
  ws.close();
  return value?.result?.value ?? value?.exceptionDetails?.exception?.description ?? value?.exceptionDetails?.text ?? null;
}

try {
  let page = null;
  for (let i = 0; i < 20 && !page; i += 1) {
    await delay(400);
    try {
      const tabs = await fetch('http://127.0.0.1:9333/json').then((response) => response.json());
      page = tabs.find((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl);
    } catch {
      page = null;
    }
  }
  if (!page) throw new Error('no-tab');
  let ready = false;
  for (let i = 0; i < 15 && !ready; i += 1) {
    ready = await evaluate(page.webSocketDebuggerUrl, 'document.documentElement.outerHTML.includes("musescore://score/")');
    if (!ready) await delay(700);
  }
  const report = await evaluate(page.webSocketDebuggerUrl, `(async () => {
    const entries = performance.getEntriesByType('resource').map((entry) => entry.name);
    const timeUrl = entries.find((name) => name.includes('time.jsonp'));
    const spaceUrl = entries.find((name) => name.includes('space.jsonp'));
    const timeText = timeUrl ? (await (await fetch(timeUrl)).text()).slice(0, 280) : '';
    const spaceText = spaceUrl ? (await (await fetch(spaceUrl)).text()).slice(0, 280) : '';
    return { timeUrl: Boolean(timeUrl), spaceUrl: Boolean(spaceUrl), timeText, spaceText };
  })()`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  chrome.kill();
  await delay(300);
  rmSync(profile, { recursive: true, force: true });
}
