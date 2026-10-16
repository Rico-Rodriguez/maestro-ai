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
      const urls = [...new Set(performance.getEntriesByType('resource').map((entry) => entry.name))]
        .filter((name) => name.includes('/static/public/build/musescore') && name.includes('.js'));
      const needles = ['Authorization', 'substr', 'substring(0', 'slice(0, 4)', 'slice(0,4)', 'md5'];
      const found = [];
      for (const url of urls) {
        const text = await (await fetch(url)).text();
        for (const needle of needles) {
          const at = text.indexOf(needle);
          if (at < 0) continue;
          found.push({
            file: url.slice(url.lastIndexOf('/') + 1),
            needle,
            around: text.slice(Math.max(0, at - 90), at + 70).replace(/[A-Za-z0-9_$]{24,}/g, '…'),
          });
        }
      }
      return { files: urls.map((url) => url.slice(url.lastIndexOf('/') + 1)), found };
    })()`,
  },
}));
console.log(JSON.stringify(await done, null, 2));
ws.close();
