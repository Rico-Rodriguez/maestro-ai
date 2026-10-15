import puppeteer from '@cloudflare/puppeteer';
import { midiAuthorization } from '../server/score-http.mjs';

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
    const token = midiAuthorization(report.scoreId);
    const file = await page.evaluate(async (scoreId, auth) => {
      const response = await fetch(`/api/jmuse?id=${scoreId}&type=midi&index=0`, {
        headers: { Authorization: auth },
      });
      const text = await response.text();
      let info = '';
      try {
        info = JSON.parse(text)?.info?.url || '';
      } catch {
        info = '';
      }
      if (!info) return { ok: false };
      const downloaded = await fetch(info);
      const bytes = new Uint8Array(await downloaded.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { ok: true, base64: btoa(binary) };
    }, report.scoreId, token);
    if (!file?.ok) return { ok: false, error: 'no-midi' };
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
