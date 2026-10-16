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
    if (message.id === 1) resolve(message.result?.result?.value ?? message.result);
  });
});
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      async function one(type, order) {
        const url = order === 'index-first'
          ? '/api/jmuse?id=6261339&index=0&type=' + type
          : '/api/jmuse?id=6261339&type=' + type + '&index=0';
        const response = await fetch(url);
        const text = await response.text();
        let info = '';
        try { info = JSON.parse(text)?.info?.url || ''; } catch { info = ''; }
        let magic = '';
        let bytes = 0;
        let fileStatus = 0;
        if (info) {
          const file = await fetch(info);
          fileStatus = file.status;
          const data = new Uint8Array(await file.arrayBuffer());
          bytes = data.length;
          magic = String.fromCharCode(data[0] || 0, data[1] || 0, data[2] || 0, data[3] || 0);
        }
        return { type, order, status: response.status, hasUrl: Boolean(info), host: info ? new URL(info).host : '', fileStatus, bytes, magic, sample: info ? '' : text.slice(0, 100) };
      }
      return [
        await one('mp3', 'index-first'),
        await one('midi', 'index-first'),
        await one('midi', 'type-first'),
      ];
    })()`,
  },
}));
console.log(JSON.stringify(await done, null, 2));
ws.close();
