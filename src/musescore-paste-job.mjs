import { parseScoreUrl } from '../shared/musescore-contract.mjs';

export function initialJob() {
  return {
    paste: { phase: 'probing' },
    receipts: {},
    nextAttempt: 1,
  };
}

function asScoreUrl(raw) {
  return parseScoreUrl(raw);
}

export function claimPaste(job, raw) {
  const phase = job.paste.phase;
  if (phase === 'probing' || phase === 'helper-off' || phase === 'fetching') {
    return { request: null, job };
  }
  const url = asScoreUrl(raw);
  if (!url) {
    return {
      request: null,
      job: {
        ...job,
        paste: { phase: 'failed', reason: { kind: 'bad-url' } },
      },
    };
  }
  const attempt = job.nextAttempt;
  return {
    request: { url, attempt },
    job: {
      ...job,
      paste: { phase: 'fetching', url, attempt },
      nextAttempt: attempt + 1,
    },
  };
}

export function settlePaste(job, result) {
  if (job.paste.phase !== 'fetching' || job.paste.attempt !== result.attempt) {
    return { job, opened: null };
  }
  if (result.kind === 'helper-off') {
    return {
      job: { ...job, paste: { phase: 'helper-off' } },
      opened: null,
    };
  }
  if (result.kind === 'rejected') {
    return {
      job: { ...job, paste: { phase: 'failed', reason: result.reason } },
      opened: null,
    };
  }
  const receipt = {
    songId: result.opened.song.id,
    title: result.opened.song.title,
    kept: result.opened.kept,
    dropped: result.opened.dropped,
  };
  return {
    job: {
      ...job,
      paste: { phase: 'imported', receipt },
      receipts: { ...job.receipts, [receipt.songId]: receipt },
    },
    opened: result.opened,
  };
}

export function applyProbe(job, found) {
  if (job.paste.phase !== 'probing') return job;
  return {
    ...job,
    paste: found ? { phase: 'idle' } : { phase: 'helper-off' },
  };
}

export function beginProbe(job) {
  if (job.paste.phase !== 'helper-off') return job;
  return { ...job, paste: { phase: 'probing' } };
}

export function practiceCutSentence(kept, dropped) {
  if (dropped > 0) return `Kept ${kept}. Dropped ${dropped}.`;
  return `${kept} notes.`;
}
