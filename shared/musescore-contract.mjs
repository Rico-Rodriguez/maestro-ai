export const APP_BASE = '/maestro-ai/';
export const HELPER_PATH = `${APP_BASE}api/musescore`;
export const LIBRARY_PATH = `${APP_BASE}api/library`;
export const HELPER_MARK = 'musescore-phone';
export const HELPER_ERRORS = ['bad-url', 'unavailable', 'no-midi'];
export const PAGES_ORIGIN = 'https://rico-rodriguez.github.io';
export const LOOPBACK_HELPER = 'http://127.0.0.1:4173';

const SCORE_URL = /^https?:\/\/(?:(?:s|www)\.)?musescore\.com\/\S+$/;

export function parseScoreUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!SCORE_URL.test(trimmed)) return null;
  return trimmed;
}
