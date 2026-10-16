import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9477;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'chrome-profile');
const PAGE = 'https://musescore.com/user/30544023/scores/6261339';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tabs() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`);
  if (!response.ok) return null;
  return response.json();
}

let chrome = null;
try {
  if (!await tabs().catch(() => null)) {
    mkdirSync(PROFILE, { recursive: true });
    chrome = spawn(CHROME, [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      'about:blank',
    ], { stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 40 && !await tabs().catch(() => null); i += 1) await delay(200);
  }
  const page = (await tabs()).find((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let next = 1;
  const pending = new Map();
  const interesting = [];
  const requests = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    const url = message.params?.request?.url || message.params?.response?.url || '';
    if (!/jmuse|midi|\.mid|time\.jsonp|scoredata/i.test(url)) return;
    if (message.method === 'Network.requestWillBeSent') {
      const headers = message.params.request.headers || {};
      const auth = headers.Authorization || headers.authorization || '';
      requests.set(message.params.requestId, {
        url: url.split('?')[0],
        query: url.includes('?') ? url.slice(url.indexOf('?') + 1, url.indexOf('?') + 80) : '',
        authLength: String(auth).length,
        authIs4Hex: /^[0-9a-f]{4}$/.test(String(auth)),
        names: Object.keys(headers),
      });
    }
    if (message.method === 'Network.responseReceived') {
      interesting.push({
        requestId: message.params.requestId,
        status: message.params.response.status,
        mime: message.params.response.mimeType,
      });
    }
  });
  const send = (method, params) => {
    const id = next;
    next += 1;
    const done = new Promise((resolve) => pending.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    return done;
  };
  await send('Network.enable');
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 24 && interesting.length === 0; i += 1) await delay(500);
  await delay(2000);
  const rows = [];
  for (const hit of interesting) {
    const request = requests.get(hit.requestId) || {};
    const row = { status: hit.status, mime: hit.mime, url: request.url, query: request.query, authLength: request.authLength, authIs4Hex: request.authIs4Hex };
    if (String(request.url).includes('jmuse') || String(request.query).includes('midi') || hit.mime.includes('midi') || hit.mime.includes('json')) {
      const body = await send('Network.getResponseBody', { requestId: hit.requestId });
      const raw = body.result?.body || '';
      let host = '';
      try {
        const info = JSON.parse(raw)?.info?.url;
        if (info) host = new URL(info).host;
      } catch {
        host = '';
      }
      row.host = host;
      row.sample = raw.slice(0, 180).replace(/\s+/g, ' ');
    }
    rows.push(row);
  }
  const resources = await send('Runtime.evaluate', {
    expression: `performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /jmuse|\\.mid|midi|mscz|mxl/i.test(name))`,
    returnByValue: true,
  });
  console.log(JSON.stringify({
    count: interesting.length,
    resources: resources.result?.result?.value ?? resources.result,
    rows,
  }, null, 2));
  ws.close();
} finally {
  chrome?.kill();
}
