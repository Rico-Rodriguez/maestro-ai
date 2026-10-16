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
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name)
        .filter((name) => name.endsWith('2946.486ad3c299f217fde22b720134b0a7a9.js') || name.endsWith('7712.26757491d28f7325bc3adfd00a50f302.js'));
      const out = [];
      for (const url of urls) {
        const text = await (await fetch(url)).text();
        const at = text.indexOf('Authorization:e');
        out.push({
          file: url.slice(url.lastIndexOf('/') + 1),
          bytes: text.length,
          around: at < 0 ? '' : text.slice(Math.max(0, at - 500), at + 180),
          jmuse: text.includes('jmuse'),
          midi: text.includes('midi'),
        });
      }
      return out;
    })()`,
  },
}));
const value = await done;
console.log(JSON.stringify(value, null, 2));
ws.close();
