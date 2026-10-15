import { SCORE_ORIGIN } from '../shared/musescore-contract.mjs';

export function helperCandidates(pageOrigin) {
  const list = [];
  if (SCORE_ORIGIN) {
    try {
      const origin = new URL(SCORE_ORIGIN).origin;
      if (origin !== pageOrigin) list.push(origin);
    } catch {
      // A bad configured origin is ignored. Same-origin is still tried.
    }
  }
  list.push('');
  return list;
}

export function helperApiUrl(origin, path) {
  if (!origin) return path;
  return new URL(path, `${origin}/`).href;
}
