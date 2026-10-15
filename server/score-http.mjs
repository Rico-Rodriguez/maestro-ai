import { createHash } from 'node:crypto';

const TOKEN_SUFFIX = ',%!),';
const PAGE_HEADERS = {
  'User-Agent': 'MaestroPhone/1',
  Accept: 'text/html,application/json',
  'Accept-Language': 'en-US,en;q=0.8',
};

export function midiAuthorization(scoreId) {
  return createHash('md5').update(`${scoreId}midi0${TOKEN_SUFFIX}`).digest('hex').slice(0, 4);
}

function decodeTitle(raw) {
  return raw
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

function scoreIdFromPage(html, pageUrl) {
  return html.match(/musescore:\/\/score\/(\d+)/)?.[1]
    ?? pageUrl.match(/\/scores\/(\d+)/)?.[1]
    ?? '';
}

function titleFromPage(html) {
  const match = html.match(/property="og:title" content="([^"]*)"/)
    ?? html.match(/content="([^"]*)" property="og:title"/);
  if (!match) return '';
  return decodeTitle(match[1]);
}

function isMidi(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x4d
    && bytes[1] === 0x54
    && bytes[2] === 0x68
    && bytes[3] === 0x64;
}

export async function readScoreHttp(pageUrl, signal, fetchImpl = fetch) {
  const page = await fetchImpl(pageUrl, { headers: PAGE_HEADERS, redirect: 'follow', signal });
  if (!page.ok) return { kind: 'unavailable' };
  const html = await page.text();
  const scoreId = scoreIdFromPage(html, pageUrl);
  if (!/^\d+$/.test(scoreId)) return { kind: 'unavailable' };
  const title = titleFromPage(html) || 'Saved score';
  const api = await fetchImpl(
    `https://musescore.com/api/jmuse?id=${scoreId}&type=midi&index=0`,
    {
      headers: {
        ...PAGE_HEADERS,
        Authorization: midiAuthorization(scoreId),
        Referer: pageUrl,
      },
      signal,
    },
  );
  if (!api.ok) return { kind: 'no-midi', title, scoreId };
  let infoUrl = '';
  try {
    infoUrl = (await api.json())?.info?.url || '';
  } catch {
    infoUrl = '';
  }
  if (!infoUrl) return { kind: 'no-midi', title, scoreId };
  const file = await fetchImpl(infoUrl, { headers: PAGE_HEADERS, signal });
  if (!file.ok) return { kind: 'no-midi', title, scoreId };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isMidi(bytes)) return { kind: 'no-midi', title, scoreId };
  return { kind: 'midi', title, scoreId, bytes };
}
