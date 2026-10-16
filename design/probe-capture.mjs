import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pageUrl = 'https://musescore.com/user/30544023/scores/6261339';
const profile = mkdtempSync(join(tmpdir(), 'maestro-chrome-'));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--remote-debugging-port=9333',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  'about:blank',
], { stdio: 'ignore' });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  const requests = new Map();
  const found = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/api/jmuse')) {
      const headers = message.params.request.headers;
      const auth = headers.Authorization || headers.authorization || '';
      requests.set(message.params.requestId, {
        url: message.params.request.url,
        authLength: auth.length,
        authIs4Hex: /^[0-9a-f]{4}$/.test(auth),
        headerNames: Object.keys(headers),
      });
    }
    if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/api/jmuse')) {
      found.push({
        requestId: message.params.requestId,
        status: message.params.response.status,
        mime: message.params.response.mimeType,
      });
    }
  });
  function send(method, params) {
    const id = nextId;
    nextId += 1;
    const result = new Promise((resolve) => pending.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    return result;
  }
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__maestroJmuse = [];
      const record = (url, status, names, auth, body) => {
        if (!String(url).includes('jmuse')) return;
        window.__maestroJmuse.push({ url: String(url), status, names, authLength: String(auth || '').length, authIs4Hex: /^[0-9a-f]{4}$/.test(String(auth || '')), body: String(body).slice(0, 240) });
      };
      const original = window.fetch;
      window.fetch = async function (...args) {
        const response = await original.apply(this, args);
        const url = String(args[0] && args[0].url || args[0] || '');
        if (url.includes('jmuse')) {
          const headers = args[1] && args[1].headers ? args[1].headers : {};
          const names = headers instanceof Headers ? [...headers.keys()] : Object.keys(headers);
          const auth = headers instanceof Headers ? (headers.get('Authorization') || '') : (headers.Authorization || headers.authorization || '');
          record(url, response.status, names, auth, await response.clone().text());
        }
        return response;
      };
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__maestroUrl = url;
        return open.call(this, method, url, ...rest);
      };
      const setHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        this.__maestroHeaders = this.__maestroHeaders || {};
        this.__maestroHeaders[name] = value;
        return setHeader.call(this, name, value);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
          const headers = this.__maestroHeaders || {};
          const auth = headers.Authorization || headers.authorization || '';
          record(this.__maestroUrl, this.status, Object.keys(headers), auth, this.responseText);
        });
        return send.apply(this, args);
      };
    })();`,
  });
  await send('Page.navigate', { url: 'https://musescore.com/user/30544023/scores/6261339' });
  let captured = [];
  for (let i = 0; i < 40 && captured.length === 0; i += 1) {
    await delay(500);
    const read = await send('Runtime.evaluate', {
      expression: 'window.__maestroJmuse || []',
      returnByValue: true,
    });
    captured = read.result?.result?.value || [];
  }
  const resources = await send('Runtime.evaluate', {
    expression: `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('jmuse')).map((entry) => ({ type: entry.initiatorType, name: entry.name.split('?')[0] }))`,
    returnByValue: true,
  });
  console.log(JSON.stringify({
    captured: captured.map((row) => ({
      status: row.status,
      names: row.names,
      authLength: row.authLength,
      authIs4Hex: row.authIs4Hex,
      body: row.body,
      url: String(row.url).split('?')[0],
    })),
    resources: resources.result?.result?.value ?? null,
  }, null, 2));
  ws.close();
} finally {
  chrome.kill();
  await delay(400);
  rmSync(profile, { recursive: true, force: true });
}
