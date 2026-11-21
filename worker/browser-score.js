import puppeteer from '@cloudflare/puppeteer';
import { midiAuthorization, rememberSalt, saltCandidates } from '../server/score-http.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMidi(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x4d
    && bytes[1] === 0x54
    && bytes[2] === 0x68
    && bytes[3] === 0x64;
}

export async function readScoreWithBrowser(browserBinding, pageUrl) {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let report = { ready: false };
    for (let i = 0; i < 20; i += 1) {
      report = await page.evaluate(() => {
        const score = window.UGAPP
          && window.UGAPP.store
          && window.UGAPP.store.page
          && window.UGAPP.store.page.data
          && window.UGAPP.store.page.data.score;
        if (!score || score.id == null) return { ready: false };
        return { ready: true, title: String(score.title || ''), scoreId: String(score.id) };
      });
      if (report?.ready && /^\d+$/.test(report.scoreId || '')) break;
      await delay(1000);
    }
    if (!report?.ready || !/^\d+$/.test(report.scoreId || '')) {
      return { ok: false, error: 'unavailable' };
    }
    const pullMidi = async (salt) => page.evaluate(async (scoreId, auth) => {
      const response = await fetch(`/api/jmuse?id=${scoreId}&type=midi&index=0`, {
        headers: { Authorization: auth },
      });
      const text = await response.text();
      if (text.trim().startsWith('<')) return { ok: false, blocked: true };
      let info = '';
      try {
        info = JSON.parse(text)?.info?.url || '';
      } catch {
        info = '';
      }
      if (!info) return { ok: false };
      const downloaded = await fetch(info);
      if (!downloaded.ok) return { ok: false };
      const bytes = new Uint8Array(await downloaded.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { ok: true, base64: btoa(binary) };
    }, report.scoreId, midiAuthorization(report.scoreId, salt));

    let file = null;
    let blocked = false;
    const trySalts = async (salts) => {
      for (const salt of salts) {
        file = await pullMidi(salt);
        if (file?.ok) {
          rememberSalt(salt);
          return true;
        }
        if (file?.blocked) {
          blocked = true;
          return false;
        }
      }
      return false;
    };

    let found = await trySalts(saltCandidates());
    if (!found && !blocked) {
      const discovered = await page.evaluate(async () => {
        const urls = [...document.querySelectorAll('script[src],link[href]')]
          .map((node) => node.src || node.href)
          .filter((src) => src && src.includes('/static/public/build/'))
          .slice(0, 12);
        for (const url of urls) {
          const name = url.slice(url.lastIndexOf('/') + 1);
          if (name.startsWith('vendor')) continue;
          try {
            const text = await (await fetch(url)).text();
            const match = text.match(/"([^"\\]{1,80})"\)\s*\.\s*(?:substr|substring|slice)\(\s*0\s*,\s*4\s*\)/);
            if (match) return match[1];
          } catch { /* the next chunk may hold the salt */ }
        }
        return '';
      });
      if (discovered) found = await trySalts([discovered]);
    }
    if (!file?.ok) return { ok: false, error: blocked ? 'unavailable' : 'no-midi' };
    const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
    if (!isMidi(bytes)) return { ok: false, error: 'no-midi' };
    return {
      ok: true,
      title: report.title || 'Saved score',
      scoreId: report.scoreId,
      bytes,
    };
  } finally {
    await browser.close();
  }
}
