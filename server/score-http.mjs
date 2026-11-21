import { createHash } from 'node:crypto';

// MuseScore signs /api/jmuse with md5(id + type + index + salt).slice(0, 4).
// The salt lives in the current site bundle and changes. The first entry is the
// salt this app last saw work; the rest are older ones worth one more try.
const KNOWN_SALTS = [',%!),', '9654,4e'];
const SCRIPT_URL = /https:\/\/musescore\.com\/static\/public\/build\/musescore[^"'\\\s>]+\.js/g;
const SALT_IN_SCRIPT = /"([^"\\]{1,80})"\)\s*\.\s*(?:substr|substring|slice)\(\s*0\s*,\s*4\s*\)/;

const TOKEN_SUFFIX = KNOWN_SALTS[0];
let learnedSalt = TOKEN_SUFFIX;
let persistedSalt = TOKEN_SUFFIX;

const PAGE_HEADERS = {
  'User-Agent': 'MaestroPhone/1',
  Accept: 'text/html,application/json',
  'Accept-Language': 'en-US,en;q=0.8',
};

export function midiAuthorization(scoreId, salt = TOKEN_SUFFIX) {
  return createHash('md5').update(`${scoreId}midi0${salt}`).digest('hex').slice(0, 4);
}

export function saltFromScript(source) {
  if (typeof source !== 'string') return null;
  const match = source.match(SALT_IN_SCRIPT);
  return match ? match[1] : null;
}

export function scriptUrlsFromPage(html) {
  if (typeof html !== 'string') return [];
  return [...new Set([...html.matchAll(SCRIPT_URL)].map((match) => match[0]))];
}

export function saltCandidates(discovered) {
  const list = [];
  const push = (salt) => {
    if (typeof salt !== 'string' || salt.length === 0 || list.includes(salt)) return;
    list.push(salt);
  };
  push(learnedSalt);
  push(discovered);
  KNOWN_SALTS.forEach(push);
  return list;
}

export function rememberSalt(salt) {
  if (typeof salt !== 'string' || salt.length === 0) return learnedSalt;
  learnedSalt = salt;
  return learnedSalt;
}

export function learnedScoreSalt() {
  return learnedSalt;
}

export function resetScoreAuth() {
  learnedSalt = TOKEN_SUFFIX;
  persistedSalt = TOKEN_SUFFIX;
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

async function discoverSalt(html, fetchImpl, signal) {
  const inline = saltFromScript(html);
  if (inline) return inline;
  const urls = scriptUrlsFromPage(html).slice(0, 8);
  for (const url of urls) {
    if (signal?.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    try {
      const response = await fetchImpl(url, { headers: PAGE_HEADERS, redirect: 'follow', signal });
      if (!response.ok) continue;
      const salt = saltFromScript(await response.text());
      if (salt) return salt;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return null;
}

async function requestMidi(scoreId, pageUrl, salt, fetchImpl, signal) {
  const response = await fetchImpl(
    `https://musescore.com/api/jmuse?id=${scoreId}&type=midi&index=0`,
    {
      headers: {
        ...PAGE_HEADERS,
        Authorization: midiAuthorization(scoreId, salt),
        Referer: pageUrl,
      },
      redirect: 'follow',
      signal,
    },
  );
  const raw = await response.text();
  if (response.status === 429 || response.status >= 500) return { kind: 'unavailable' };
  if (raw.trim().startsWith('<')) return { kind: 'blocked' };
  let infoUrl = '';
  try {
    infoUrl = JSON.parse(raw)?.info?.url || '';
  } catch {
    infoUrl = '';
  }
  if (typeof infoUrl === 'string' && infoUrl.startsWith('https://')) {
    return { kind: 'url', infoUrl, salt };
  }
  if (response.ok) return { kind: 'empty' };
  return { kind: 'auth' };
}

export async function readScoreHttp(pageUrl, signal, fetchImpl = fetch, auth = null) {
  const bag = auth || { salt: learnedSalt, persisted: persistedSalt, shared: true };
  const page = await fetchImpl(pageUrl, { headers: PAGE_HEADERS, redirect: 'follow', signal });
  if (!page.ok) return { kind: 'unavailable' };
  const html = await page.text();
  const scoreId = scoreIdFromPage(html, pageUrl);
  if (!/^\d+$/.test(scoreId)) return { kind: 'unavailable' };
  const title = titleFromPage(html) || 'Saved score';

  const tried = new Set();
  let sawEmpty = false;
  let sawBlocked = false;
  let discovered = null;

  const attempt = async (salt) => {
    if (!salt || tried.has(salt)) return null;
    tried.add(salt);
    const outcome = await requestMidi(scoreId, pageUrl, salt, fetchImpl, signal);
    if (outcome.kind === 'url' || outcome.kind === 'unavailable') return outcome;
    if (outcome.kind === 'blocked') sawBlocked = true;
    if (outcome.kind === 'empty') sawEmpty = true;
    return null;
  };

  let hit = await attempt(bag.salt);
  if (!hit) {
    discovered = await discoverSalt(html, fetchImpl, signal);
    hit = await attempt(discovered);
  }
  if (!hit) {
    for (const salt of KNOWN_SALTS) {
      hit = await attempt(salt);
      if (hit) break;
    }
  }
  if (hit?.kind === 'unavailable') return { kind: 'unavailable' };
  if (!hit) {
    if (sawBlocked && !sawEmpty) return { kind: 'unavailable' };
    return { kind: 'no-midi', title, scoreId };
  }

  if (bag.shared === false) bag.salt = hit.salt;
  else rememberSalt(hit.salt);
  const file = await fetchImpl(hit.infoUrl, { headers: PAGE_HEADERS, redirect: 'follow', signal });
  if (!file.ok) return { kind: 'no-midi', title, scoreId };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isMidi(bytes)) return { kind: 'no-midi', title, scoreId };
  return { kind: 'midi', title, scoreId, bytes, salt: hit.salt };
}

const SALT_KEY = 'jmuse-salt';

export async function hydrateScoreSalt(db) {
  if (!db) return learnedSalt;
  try {
    await db.prepare(
      'CREATE TABLE IF NOT EXISTS helper_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    const row = await db.prepare(
      'SELECT value FROM helper_state WHERE key = ?',
    ).bind(SALT_KEY).first();
    if (row?.value && learnedSalt === TOKEN_SUFFIX) rememberSalt(row.value);
    if (row?.value) persistedSalt = row.value;
  } catch {
    return learnedSalt;
  }
  return learnedSalt;
}

export async function persistScoreSalt(db) {
  if (!db || !learnedSalt || learnedSalt === persistedSalt) return;
  try {
    await db.prepare(
      'CREATE TABLE IF NOT EXISTS helper_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    await db.prepare(
      `INSERT INTO helper_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(SALT_KEY, learnedSalt).run();
    persistedSalt = learnedSalt;
  } catch {
    // The isolate still remembers the salt for the next score.
  }
}
