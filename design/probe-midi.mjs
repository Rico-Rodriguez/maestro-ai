import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pageUrl = process.argv[2];
const headless = process.argv.includes('--headless');
const profile = mkdtempSync(join(tmpdir(), 'maestro-chrome-'));
const args = [
  '--remote-debugging-port=9333',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  pageUrl,
];
if (headless) args.unshift('--headless=new');
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args, { stdio: 'ignore' });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function token(id, salt) {
  return createHash('md5').update(`${id}midi0${salt}`).digest('hex').slice(0, 4);
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
    params: { expression, awaitPromise: true, returnByValue: true },
  }));
  const value = await result;
  ws.close();
  return value?.result?.value ?? value?.exceptionDetails?.text ?? null;
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
  let ready = null;
  for (let i = 0; i < 15; i += 1) {
    ready = await evaluate(page.webSocketDebuggerUrl, `(() => {
      const html = document.documentElement.outerHTML;
      const id = html.match(/musescore:\\/\\/score\\/(\\d+)/)?.[1] ?? '';
      const title = document.querySelector('meta[property="og:title"]')?.content ?? '';
      return { id, title, challenge: document.title.includes('Just a moment') };
    })()`);
    if (ready?.id) break;
    await delay(1000);
  }
  if (!ready?.id) {
    console.log(JSON.stringify({ headless, ready }));
    process.exitCode = 1;
  } else {
  const shape = await evaluate(page.webSocketDebuggerUrl, `(() => {
    const html = document.documentElement.outerHTML;
    const srcs = [...document.scripts].map((script) => script.src).filter(Boolean);
    const links = [...document.querySelectorAll('link')].map((link) => link.href).filter((href) => href.includes('/static/') || href.includes('.js'));
    return {
      htmlBytes: html.length,
      hasSubstr: html.includes('substr'),
      hasBuild: html.includes('/static/public/build'),
      hasJmuse: html.includes('jmuse'),
      srcs: srcs.slice(0, 12),
      links: links.slice(0, 12),
    };
  })()`);
  console.log(JSON.stringify({ shape }, null, 2));
  const discovered = await evaluate(page.webSocketDebuggerUrl, `(async () => {
    const scripts = [...document.scripts].map((script) => script.src).filter((src) => src.includes('/static/public/build/musescore'));
    const hits = [];
    for (const url of scripts) {
      const text = await (await fetch(url)).text();
      const found = text.match(/"([^"]+)"\\)\\.substr\\(0,\\s*4\\)/);
      hits.push({ url: url.slice(url.indexOf('/static/')), bytes: text.length, hit: Boolean(found), captureLength: found ? found[1].length : 0 });
      if (found) return { suffix: found[1], scripts: scripts.length, hits };
    }
    return { suffix: null, scripts: scripts.length, hits };
  })()`);
  const salts = [discovered?.suffix, '9654,4e'].filter(Boolean);
  let located = null;
  for (const salt of salts) {
    const auth = token(ready.id, salt);
    located = await evaluate(page.webSocketDebuggerUrl, `(async () => {
      const response = await fetch('/api/jmuse?id=${ready.id}&type=midi&index=0', { headers: { Authorization: '${auth}' } });
      const text = await response.text();
      let infoUrl = '';
      try { infoUrl = JSON.parse(text)?.info?.url ?? ''; } catch { infoUrl = ''; }
      return { status: response.status, hasUrl: Boolean(infoUrl), infoUrl, sample: infoUrl ? '' : text.slice(0, 160) };
    })()`);
    if (located?.hasUrl) break;
  }
  let midi = null;
  if (located?.infoUrl) {
    midi = await evaluate(page.webSocketDebuggerUrl, `(async () => {
      const response = await fetch(${JSON.stringify(located.infoUrl)});
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        bytes: bytes.length,
        magic: String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]),
      };
    })()`);
  }
  const bundle = await evaluate(page.webSocketDebuggerUrl, `(async () => {
    const html = document.documentElement.outerHTML;
    const around = (text, needle) => {
      const found = [];
      let from = 0;
      for (let i = 0; i < 3; i += 1) {
        const at = text.indexOf(needle, from);
        if (at < 0) break;
        found.push(text.slice(Math.max(0, at - 80), at + 120).replace(/[A-Za-z0-9_$]{20,}/g, '…'));
        from = at + needle.length;
      }
      return found;
    };
    const scripts = [...document.scripts].map((script) => script.src).filter((url) => url.includes('/static/public/build/musescore'));
    const inScripts = [];
    for (const url of scripts) {
      const text = await (await fetch(url)).text();
      if (text.includes('jmuse')) inScripts.push(url.slice(url.lastIndexOf('/') + 1));
    }
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /midi|jmuse|\\.mid|scoredata/i.test(name)).slice(0, 20);
    return { htmlJmuse: around(html, 'jmuse'), inScripts, resources };
  })()`);
  console.log(JSON.stringify({
    headless,
    title: ready.title,
    id: ready.id,
    suffixFound: Boolean(discovered?.suffix),
    locateStatus: located?.status ?? null,
    locateSample: located?.sample ?? '',
    hasUrl: Boolean(located?.hasUrl),
    midi,
    bundle,
  }, null, 2));
  }
} finally {
  chrome.kill();
  await delay(400);
  rmSync(profile, { recursive: true, force: true });
}
