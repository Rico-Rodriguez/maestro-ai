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
      const url = performance.getEntriesByType('resource').map((entry) => entry.name)
        .find((name) => name.includes('2946.486ad3c299f217fde22b720134b0a7a9.js'));
      const text = await (await fetch(url)).text();
      const needles = ['slice(0,4)', 'slice(0, 4)', 'substr(0,4)', 'substr(0, 4)', 'jmuse?', '"midi"', 'type:"midi"', 'md5'];
      const found = [];
      for (const needle of needles) {
        let from = 0;
        for (let n = 0; n < 4; n += 1) {
          const at = text.indexOf(needle, from);
          if (at < 0) break;
          found.push({ needle, around: text.slice(Math.max(0, at - 120), at + 80) });
          from = at + needle.length;
        }
      }
      return found;
    })()`,
  },
}));
console.log(JSON.stringify(await done, null, 2));
ws.close();
