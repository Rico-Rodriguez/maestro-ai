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
      const scripts = [...document.scripts].map((script) => script.src).filter((src) => src.includes('/static/public/build/musescore'));
      const needles = ['substr(0, 4)', 'substr(0,4)', 'substring(0, 4)', 'substring(0,4)', 'slice(0, 4)', 'slice(0,4)', 'md5', 'Authorization'];
      const found = [];
      for (const url of scripts) {
        const text = await (await fetch(url)).text();
        for (const needle of needles) {
          let from = 0;
          for (let n = 0; n < 3; n += 1) {
            const at = text.indexOf(needle, from);
            if (at < 0) break;
            found.push({
              file: url.slice(url.lastIndexOf('/') + 1),
              needle,
              around: text.slice(Math.max(0, at - 80), at + needle.length + 40).replace(/[A-Za-z0-9_$]{24,}/g, '…'),
            });
            from = at + needle.length;
          }
        }
      }
      return { scripts: scripts.map((url) => url.slice(url.lastIndexOf('/') + 1)), found };
    })()`,
  },
}));
console.log(JSON.stringify(await done, null, 2));
ws.close();
