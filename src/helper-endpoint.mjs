import { LOOPBACK_HELPER, PAGES_ORIGIN } from '../shared/musescore-contract.mjs';

export const HELPER_ORIGIN_KEY = 'maestro-helper-origin';

export function parseHelperOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && loopback) return url.origin;
  return null;
}

export function helperCandidates(pageOrigin, storedOrigin) {
  const list = [];
  const stored = parseHelperOrigin(storedOrigin);
  if (stored) list.push(stored);
  list.push('');
  if (pageOrigin === PAGES_ORIGIN && !list.includes(LOOPBACK_HELPER)) {
    list.push(LOOPBACK_HELPER);
  }
  return list;
}

export function helperApiUrl(origin, path) {
  if (!origin) return path;
  return new URL(path, `${origin}/`).href;
}
