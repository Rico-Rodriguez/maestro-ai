const PORT = 9477;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then((response) => response.json());
const page = tabs.find((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl);
if (!page) {
  console.log(JSON.stringify({ error: 'no-tab' }));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
let next = 1;
const pending = new Map();
const hits = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  const url = message.params?.request?.url || message.params?.response?.url || '';
  if (!url || !/jmuse|midi|\.mid|mp3|mscz|mxl|audio/i.test(url)) return;
  if (message.method === 'Network.responseReceived') {
    const headers = {};
    hits.push({
      status: message.params.response.status,
      mime: message.params.response.mimeType,
      url: url.slice(0, 180),
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
const search = await send('Runtime.evaluate', {
  expression: `(async () => {
    const scripts = [...document.scripts].map((script) => script.src).filter((src) => src.includes('/static/public/build/musescore'));
    const found = [];
    for (const url of scripts) {
      const text = await (await fetch(url)).text();
      for (const needle of ['jmuse', 'api/jmuse', 'type=midi', '.mid']) {
        const at = text.indexOf(needle);
        if (at < 0) continue;
        found.push({
          file: url.slice(url.lastIndexOf('/') + 1),
          needle,
          around: text.slice(Math.max(0, at - 50), at + 90).replace(/[A-Za-z0-9_$]{18,}/g, '…'),
        });
      }
    }
    const button = document.querySelector('#scorePlayButton, button[title="Toggle Play"], button[aria-label="Toggle Play"]');
    if (button) button.click();
    return { scripts: scripts.length, found, clicked: Boolean(button), title: document.title };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
await delay(4000);
console.log(JSON.stringify({
  search: search.result?.result?.value ?? search.result,
  hits,
}, null, 2));
ws.close();
