import { createHash } from 'node:crypto';
import { parseScoreUrl } from '../shared/musescore-contract.mjs';

const USER_AGENT = 'MaestroPhone/1';
const FALLBACK_SALT = '9654,4e';
const SCRIPT_URL = /https:\/\/musescore\.com\/static\/public\/build\/musescore[^\s"'<>]*\.js/g;
const SALT_CALL = /["']([^"']+)["']\)\.substr\(\s*0\s*,\s*4\s*\)/;

let saltCell = null;
let saltFlight = null;

function authToken(page, salt) {
  return createHash('md5').update(`${page.id}midi0${salt}`).digest('hex').slice(0, 4);
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? '';
}

function metaContent(html, property) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (attribute(tag, 'property') !== property) continue;
    const content = attribute(tag, 'content');
    if (content !== null) return content;
  }
  return null;
}

function decodeTitle(value) {
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    '#39': "'",
  };
  return value.replace(/&(#39|amp|lt|gt|quot|apos);/gi, (entity, name) => {
    return entities[name.toLowerCase()] ?? entity;
  });
}

function readScorePage(html) {
  const iosUrl = metaContent(html, 'al:ios:url');
  const rawTitle = metaContent(html, 'og:title');
  if (!iosUrl || rawTitle === null) return null;
  const idMatch = /musescore:\/\/score\/(\d+)/.exec(iosUrl);
  if (!idMatch) return null;
  const title = decodeTitle(rawTitle).trim();
  if (!title) return null;
  return { id: Number(idMatch[1]), title };
}

function scriptUrls(html) {
  return (html.match(SCRIPT_URL) ?? []).filter((url) => {
    try {
      return new URL(url).pathname.includes('/20');
    } catch {
      return false;
    }
  });
}

async function discoverSalt(pageHtml, signal) {
  for (const scriptUrl of scriptUrls(pageHtml)) {
    if (signal.aborted) throw signal.reason;
    let response;
    try {
      response = await fetch(scriptUrl, {
        signal,
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      continue;
    }
    if (!response.ok) continue;
    const found = SALT_CALL.exec(await response.text());
    if (found) return found[1];
  }
  return null;
}

function snapshotSalt(pageHtml, signal) {
  if (typeof saltCell === 'string') return Promise.resolve(saltCell);
  if (!saltFlight) {
    saltFlight = discoverSalt(pageHtml, signal)
      .then((found) => {
        if (typeof found === 'string' && found !== '') saltCell = found;
        return saltCell;
      })
      .finally(() => {
        saltFlight = null;
      });
  }
  return saltFlight;
}

async function requestMidiUrl(page, salt, signal) {
  const endpoint = `https://musescore.com/api/jmuse?id=${page.id}&type=midi&index=0`;
  let response;
  try {
    response = await fetch(endpoint, {
      signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Authorization: authToken(page, salt),
      },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
  if (!response.ok) return null;
  try {
    const body = await response.json();
    const infoUrl = body && body.info && body.info.url;
    return typeof infoUrl === 'string' ? infoUrl : null;
  } catch {
    return null;
  }
}

function isMidiHeader(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x4d
    && bytes[1] === 0x54
    && bytes[2] === 0x68
    && bytes[3] === 0x64;
}

async function downloadMidi(infoUrl, signal) {
  if (!infoUrl.startsWith('https://')) return null;
  let response;
  try {
    response = await fetch(infoUrl, {
      signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!isMidiHeader(bytes)) return null;
  return bytes;
}

export async function fetchScoreMidi(rawUrl, signal) {
  const scoreUrl = parseScoreUrl(rawUrl);
  if (!scoreUrl) return { ok: false, error: 'bad-url' };

  let response;
  try {
    response = await fetch(scoreUrl, {
      signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, error: 'unavailable' };
  }
  if (!response.ok) return { ok: false, error: 'unavailable' };

  const html = await response.text();
  const page = readScorePage(html);
  if (!page) return { ok: false, error: 'unavailable' };

  const salt = await snapshotSalt(html, signal);
  let infoUrl = null;
  if (typeof salt === 'string' && salt !== '') {
    infoUrl = await requestMidiUrl(page, salt, signal);
    if (!infoUrl && saltCell === salt) saltCell = null;
  }
  if (!infoUrl && salt !== FALLBACK_SALT) {
    infoUrl = await requestMidiUrl(page, FALLBACK_SALT, signal);
  }
  if (!infoUrl) return { ok: false, error: 'unavailable' };

  const bytes = await downloadMidi(infoUrl, signal);
  if (!bytes) return { ok: false, error: 'no-midi' };
  return { ok: true, title: page.title, bytes };
}
