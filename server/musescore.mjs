import { parseScoreUrl } from '../shared/musescore-contract.mjs';
import { readScoreInChrome } from './chrome-score.mjs';

export async function fetchScoreMidi(rawUrl, signal, readPage = readScoreInChrome) {
  const scoreUrl = parseScoreUrl(rawUrl);
  if (!scoreUrl) return { ok: false, error: 'bad-url' };
  if (signal?.aborted) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }

  let page;
  try {
    page = await readPage(scoreUrl, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, error: 'unavailable' };
  }
  if (!page || page.kind === 'unavailable') return { ok: false, error: 'unavailable' };
  if (page.kind !== 'midi') return { ok: false, error: 'no-midi' };
  return {
    ok: true,
    title: page.title,
    scoreId: page.scoreId,
    bytes: page.bytes,
  };
}
