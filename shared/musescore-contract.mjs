export const APP_BASE = '/maestro-ai/';
export const HELPER_PATH = `${APP_BASE}api/musescore`;
export const HELPER_MARK = 'musescore-phone';
export const HELPER_ERRORS = ['bad-url', 'unavailable', 'no-midi'];

const SCORE_URL = /^https?:\/\/(?:(?:s|www)\.)?musescore\.com\/\S+$/;

export function parseScoreUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!SCORE_URL.test(trimmed)) return null;
  return trimmed;
}
