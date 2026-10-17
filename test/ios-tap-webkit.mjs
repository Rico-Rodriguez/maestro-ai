// Run with Playwright's WebKit: node --test test/ios-tap-webkit.mjs
// Not part of npm test. This WebKit build has no longtask entry type, so the
// proof is the pointerdown handler time on the WebKit main thread.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function serve(pageHtml) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/bench.html') {
      res.setHeader('content-type', 'text/html');
      res.end(pageHtml);
      return;
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    res.setHeader('content-type', 'text/javascript');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<button id="anything" type="button">Library</button>
<script type="module">
import { MaestroAudioEngine } from '/src/poteto-audio.mjs';

const blocks = [];
window.Capacitor = { isNativePlatform: () => true };
window.__maestroPrimeAudioSession = () => {
  const started = performance.now();
  while (performance.now() - started < 70) {}
  blocks.push(performance.now() - started);
  return Promise.resolve();
};

const longTasks = [];
try {
  new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      if (entry.duration >= 50) longTasks.push({ start: entry.startTime, duration: entry.duration });
    });
  }).observe({ entryTypes: ['longtask'] });
} catch { /* longtask is not in every WebKit build */ }

function oldTap() {
  window.__maestroPrimeAudioSession(false);
  window.__maestroPrimeAudioSession(false);
  window.__maestroPrimeAudioSession(false);
}

const engine = new MaestroAudioEngine();
engine.ctx = {
  state: 'running',
  sampleRate: 48000,
  currentTime: 0,
  destination: {},
  resume: () => Promise.resolve(),
};
engine.unlocked = true;

const button = document.querySelector('#anything');
let mode = 'fixed';
button.addEventListener('pointerdown', () => {
  if (mode === 'old') oldTap();
  else engine.unlockFromGesture();
}, true);

window.__tapBench = async (nextMode, taps) => {
  mode = nextMode;
  blocks.length = 0;
  const mark = performance.now();
  const samples = [];
  for (let i = 0; i < taps; i += 1) {
    const started = performance.now();
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    samples.push(performance.now() - started);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const end = performance.now();
  return {
    samples,
    blocks: blocks.length,
    longTasks: longTasks
      .filter((entry) => entry.start < end && entry.start + entry.duration > mark)
      .map((entry) => entry.duration),
  };
};
</script>
`;

test('WebKit: the old per-tap session calls block, the fixed path stays under a frame', async () => {
  const server = await serve(PAGE);
  const port = server.address().port;
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/bench.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.__tapBench === 'function');
    const oldRun = await page.evaluate(() => window.__tapBench('old', 4));
    const fixed = await page.evaluate(() => window.__tapBench('fixed', 8));
    const supported = await page.evaluate(() => PerformanceObserver.supportedEntryTypes || []);
    const oldWorst = Math.max(...oldRun.samples);
    const fixedWorst = Math.max(...fixed.samples);
    console.log(JSON.stringify({
      supported,
      oldWorst: Number(oldWorst.toFixed(1)),
      oldSamples: oldRun.samples.map((ms) => Number(ms.toFixed(1))),
      oldLongTasks: oldRun.longTasks.map((ms) => Number(ms.toFixed(1))),
      oldBlocks: oldRun.blocks,
      fixedWorst: Number(fixedWorst.toFixed(1)),
      fixedSamples: fixed.samples.map((ms) => Number(ms.toFixed(1))),
      fixedLongTasks: fixed.longTasks.map((ms) => Number(ms.toFixed(1))),
      fixedBlocks: fixed.blocks,
    }));
    assert.ok(oldWorst >= 50, `expected the old path to block, worst tap was ${oldWorst.toFixed(1)} ms`);
    assert.equal(oldRun.blocks, 12);
    assert.ok(fixedWorst < 16, `fixed tap took ${fixedWorst.toFixed(1)} ms`);
    assert.equal(fixed.blocks, 0);
    if (supported.includes('longtask')) {
      assert.ok(oldRun.longTasks.some((duration) => duration >= 50), `old path produced no long task: ${oldRun.longTasks.join(',')}`);
      assert.equal(fixed.longTasks.filter((duration) => duration >= 50).length, 0);
    }
  } finally {
    await browser.close();
    server.close();
  }
});
