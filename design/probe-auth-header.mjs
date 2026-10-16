const PORT = 9477;
const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then((response) => response.json());
const page = tabs.find((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
let next = 1;
const pending = new Map();
const rows = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method !== 'Network.requestWillBeSent') return;
  const url = message.params.request.url || '';
  if (!url.includes('/api/jmuse')) return;
  const headers = message.params.request.headers || {};
  const auth = String(headers.Authorization || headers.authorization || '');
  rows.push({
    url: url.replace(/https:\/\/musescore.com/, ''),
    names: Object.keys(headers),
    authLength: auth.length,
    authIs4Hex: /^[0-9a-f]{4}$/.test(auth),
    auth: auth,
    requestId: message.params.requestId,
  });
});
const send = (method, params) => {
  const id = next;
  next += 1;
  const done = new Promise((resolve) => pending.set(id, resolve));
  ws.send(JSON.stringify({ id, method, params }));
  return done;
};
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.reload', { ignoreCache: true });
let sawBlank = false;
for (let i = 0; i < 30; i += 1) {
  const ready = await send('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  });
  const title = ready.result?.result?.value || '';
  if (!String(title).includes('Minuet')) sawBlank = true;
  if (sawBlank && String(title).includes('Minuet')) break;
  await new Promise((resolve) => setTimeout(resolve, 400));
}
await send('Runtime.evaluate', {
  expression: `(() => {
    const button = document.querySelector('#scorePlayButton, button[title="Toggle Play"], button[aria-label="Toggle Play"]');
    if (button) button.click();
    return Boolean(button);
  })()`,
  returnByValue: true,
});
await new Promise((resolve) => setTimeout(resolve, 4000));
for (const row of rows) {
  const body = await send('Network.getResponseBody', { requestId: row.requestId });
  const raw = body.result?.body || '';
  let host = '';
  try {
    const info = JSON.parse(raw)?.info?.url;
    if (info) host = new URL(info).host;
  } catch {
    host = '';
  }
  row.statusSample = raw.slice(0, 80);
  row.host = host;
  delete row.requestId;
}
console.log(JSON.stringify(rows, null, 2));
ws.close();
