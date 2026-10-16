const PORT = 9477;
const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then((response) => response.json());
const page = tabs.find((tab) => tab.type === 'page' && tab.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
const done = new Promise((resolve) => {
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) resolve(message.result?.result?.value ?? null);
  });
});
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const response = await fetch('/api/jmuse?id=6261339&type=midi&index=0', { headers: { Authorization: 'ed63' } });
      const text = await response.text();
      let info = '';
      try { info = JSON.parse(text)?.info?.url || ''; } catch { info = ''; }
      if (!info) return { status: response.status, sample: text.slice(0, 120) };
      const file = await fetch(info);
      const data = new Uint8Array(await file.arrayBuffer());
      return {
        status: response.status,
        fileStatus: file.status,
        host: new URL(info).host,
        bytes: data.length,
        magic: String.fromCharCode(data[0], data[1], data[2], data[3]),
      };
    })()`,
  },
}));
console.log(JSON.stringify(await done, null, 2));
ws.close();
