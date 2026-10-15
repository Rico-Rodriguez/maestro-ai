import { HELPER_MARK, HELPER_PATH, LIBRARY_PATH, PAGES_ORIGIN } from '../shared/musescore-contract.mjs';
import { fetchScoreMidi } from '../server/musescore.mjs';

const STATUS = {
  'bad-url': 400,
  unavailable: 404,
  'no-midi': 422,
};

function json(body, status, request) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  const origin = request.headers.get('Origin');
  if (origin === PAGES_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', PAGES_ORIGIN);
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function empty(status, request) {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  const origin = request.headers.get('Origin');
  if (origin === PAGES_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', PAGES_ORIGIN);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Accept, Content-Type');
    headers.set('Vary', 'Origin');
  }
  return new Response(null, { status, headers });
}

function toBase64(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function asBytes(value) {
  if (!value) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

function isMidi(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x4d
    && bytes[1] === 0x54
    && bytes[2] === 0x68
    && bytes[3] === 0x64;
}

function payload(row) {
  return {
    title: row.title,
    scoreId: row.score_id,
    midiBase64: toBase64(asBytes(row.midi)),
  };
}

async function readRow(db, scoreId) {
  const row = await db.prepare(
    'SELECT score_id, title, source_url, saved_at, midi FROM scores WHERE score_id = ?',
  ).bind(scoreId).first();
  if (!row || !isMidi(asBytes(row.midi))) return null;
  return row;
}

async function findByUrl(db, rawUrl) {
  const fromPath = /\/scores\/(\d+)\/?$/.exec(new URL(rawUrl).pathname);
  if (fromPath) {
    const byId = await readRow(db, fromPath[1]);
    if (byId) return byId;
  }
  const byUrl = await db.prepare(
    'SELECT score_id, title, source_url, saved_at, midi FROM scores WHERE source_url = ?',
  ).bind(rawUrl).first();
  if (!byUrl || !isMidi(asBytes(byUrl.midi))) return null;
  return byUrl;
}

async function saveScore(db, result, sourceUrl) {
  const savedAt = new Date().toISOString();
  await db.prepare(`
    INSERT INTO scores (score_id, title, source_url, saved_at, midi)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(score_id) DO UPDATE SET
      title = excluded.title,
      source_url = excluded.source_url,
      saved_at = excluded.saved_at,
      midi = excluded.midi
  `).bind(result.scoreId, result.title, sourceUrl, savedAt, result.bytes).run();
}

async function handleHelper(request, env) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return json({ helper: HELPER_MARK }, 200, request);
  }
  if (request.method !== 'POST') return empty(405, request);
  const text = await request.text();
  if (text.length > 2048) return json({ error: 'bad-url' }, 400, request);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.url !== 'string') {
    return json({ error: 'bad-url' }, 400, request);
  }
  const sourceUrl = body.url.trim();
  const cached = await findByUrl(env.DB, sourceUrl);
  if (cached) return json(payload(cached), 200, request);
  const result = await fetchScoreMidi(sourceUrl, request.signal);
  if (!result.ok) return json({ error: result.error }, STATUS[result.error], request);
  await saveScore(env.DB, result, sourceUrl);
  return json({
    title: result.title,
    scoreId: result.scoreId,
    midiBase64: toBase64(result.bytes),
  }, 200, request);
}

async function handleLibrary(request, env, scoreId) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return empty(405, request);
  if (!scoreId) {
    const listed = await env.DB.prepare(
      'SELECT score_id, title, saved_at FROM scores ORDER BY saved_at DESC, title ASC',
    ).all();
    const scores = (listed.results || []).map((row) => ({
      scoreId: row.score_id,
      title: row.title,
      savedAt: row.saved_at,
    }));
    return json({ scores }, 200, request);
  }
  if (!/^\d+$/.test(scoreId)) return empty(404, request);
  const row = await readRow(env.DB, scoreId);
  if (!row) return empty(404, request);
  return json(payload(row), 200, request);
}

async function serveApp(request, env) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  if (pathname === '/maestro-ai' || pathname.startsWith('/maestro-ai/')) {
    pathname = pathname.slice('/maestro-ai'.length) || '/';
  }
  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  return env.ASSETS.fetch(new Request(assetUrl, request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return empty(204, request);
    const path = url.pathname;
    if (path === HELPER_PATH || path === '/api/musescore') {
      try {
        return await handleHelper(request, env);
      } catch {
        return empty(500, request);
      }
    }
    if (path === LIBRARY_PATH || path === `${LIBRARY_PATH}/` || path === '/api/library' || path === '/api/library/') {
      try {
        return await handleLibrary(request, env, '');
      } catch {
        return empty(500, request);
      }
    }
    const libraryPrefix = `${LIBRARY_PATH}/`;
    const shortPrefix = '/api/library/';
    if (path.startsWith(libraryPrefix) || path.startsWith(shortPrefix)) {
      const scoreId = path.startsWith(libraryPrefix)
        ? path.slice(libraryPrefix.length)
        : path.slice(shortPrefix.length);
      try {
        return await handleLibrary(request, env, decodeURIComponent(scoreId));
      } catch {
        return empty(500, request);
      }
    }
    if (!env.ASSETS) return empty(404, request);
    return serveApp(request, env);
  },
};
