import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_BASE, HELPER_ERRORS, HELPER_MARK, HELPER_PATH } from '../shared/musescore-contract.mjs';
import { fetchScoreMidi } from './musescore.mjs';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const MAX_BODY = 2048;

const HTTP_STATUS = {
  'bad-url': 400,
  unavailable: 404,
  'no-midi': 422,
};

for (const code of HELPER_ERRORS) {
  if (typeof HTTP_STATUS[code] !== 'number') {
    throw new Error(`missing HTTP status for ${code}`);
  }
}

const FILE_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
};

function statusFor(error) {
  return HTTP_STATUS[error];
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendEmpty(res, status) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end();
}

function readJson(req) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(text));
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

function distFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { status: 400 };
  }
  if (!decoded.startsWith(APP_BASE)) return { status: 404 };
  const rel = decoded.slice(APP_BASE.length);
  if (rel.includes('\0')) return { status: 400 };
  const abs = path.resolve(DIST, rel);
  const relative = path.relative(DIST, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { status: 400 };
  if (rel === '' || rel.endsWith('/')) return { file: path.join(abs, 'index.html') };
  return { file: abs };
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendEmpty(res, 405);
    return;
  }
  const target = distFile(pathname);
  if (!target.file) {
    sendEmpty(res, target.status);
    return;
  }
  let real;
  try {
    real = await fs.promises.realpath(target.file);
  } catch {
    sendEmpty(res, 404);
    return;
  }
  let relative = path.relative(DIST, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendEmpty(res, 400);
    return;
  }
  const stat = await fs.promises.stat(real).catch(() => null);
  if (stat && stat.isDirectory()) {
    real = path.join(real, 'index.html');
    relative = path.relative(DIST, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      sendEmpty(res, 400);
      return;
    }
  }
  let data;
  try {
    data = await fs.promises.readFile(real);
  } catch {
    sendEmpty(res, 404);
    return;
  }
  const type = FILE_TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function handleHelper(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, { helper: HELPER_MARK });
    return;
  }
  if (req.method !== 'POST') {
    sendEmpty(res, 405);
    return;
  }
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, statusFor('bad-url'), { error: 'bad-url' });
    return;
  }
  try {
    const result = await fetchScoreMidi(body.url, ac.signal);
    if (!result.ok) {
      sendJson(res, statusFor(result.error), { error: result.error });
      return;
    }
    sendJson(res, 200, {
      title: result.title,
      midiBase64: Buffer.from(result.bytes).toString('base64'),
    });
  } catch {
    if (!res.writableEnded) res.end();
  }
}

function requestPath(req) {
  const raw = req.url || '/';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

const server = http.createServer((req, res) => {
  const pathname = requestPath(req);
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendEmpty(res, 400);
    return;
  }
  if (decoded === HELPER_PATH) {
    handleHelper(req, res).catch(() => {
      if (!res.writableEnded) sendEmpty(res, 500);
    });
    return;
  }
  serveStatic(req, res, pathname).catch(() => {
    if (!res.writableEnded) sendEmpty(res, 500);
  });
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, '0.0.0.0', () => {
  const hosts = new Set(['127.0.0.1']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) {
        hosts.add(entry.address);
      }
    }
  }
  for (const host of hosts) {
    console.log(`Maestro phone helper at http://${host}:${port}${APP_BASE}`);
  }
});
