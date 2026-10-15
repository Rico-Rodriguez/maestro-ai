import { useEffect, useRef, useState } from 'react';
import { HELPER_ERRORS, HELPER_MARK, HELPER_PATH } from '../shared/musescore-contract.mjs';
import {
  applyProbe,
  beginProbe,
  claimPaste,
  initialJob,
  practiceCutSentence,
  settlePaste,
} from './musescore-paste-job.mjs';

const FAIL_TEXT = {
  'bad-url': 'Paste a full MuseScore link. A bare id is not a score link.',
  unavailable: 'That score is private, missing, or needs a login. This helper stores no login.',
  'no-midi': 'MuseScore did not return MIDI for that score.',
  empty: 'That MIDI file has no playable notes.',
  'timed-out': 'The helper did not answer. Try the link again.',
};

const OFF_TEXT = 'MuseScore paste is off on this page. Open Maestro from the phone helper on your Wi-Fi.';

function midiBuffer(base64) {
  let binary;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  if (bytes.length < 4) return null;
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'MThd') return null;
  return bytes.buffer;
}

async function probeHelper(signal) {
  try {
    const response = await fetch(HELPER_PATH, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) return false;
    const body = await response.json();
    return Boolean(body && body.helper === HELPER_MARK);
  } catch {
    return false;
  }
}

async function runPaste(request, deps) {
  const { attempt, signal, url } = request;
  try {
    const response = await fetch(HELPER_PATH, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({ url }),
      signal,
    });
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) return { attempt, kind: 'helper-off' };
    let body;
    try {
      body = await response.json();
    } catch {
      return { attempt, kind: 'helper-off' };
    }
    if (!body || typeof body !== 'object') return { attempt, kind: 'helper-off' };
    const hasError = Object.prototype.hasOwnProperty.call(body, 'error');
    const hasMidi = Object.prototype.hasOwnProperty.call(body, 'midiBase64');
    if (hasError && hasMidi) return { attempt, kind: 'helper-off' };
    if (hasError && !hasMidi && HELPER_ERRORS.includes(body.error)) {
      return { attempt, kind: 'rejected', reason: { kind: body.error } };
    }
    if (typeof body.title === 'string' && typeof body.midiBase64 === 'string') {
      const bytes = midiBuffer(body.midiBase64);
      if (!bytes) return { attempt, kind: 'rejected', reason: { kind: 'no-midi' } };
      const read = deps.readMidi(bytes, `${body.title}.mid`);
      if (read.ok) {
        return {
          attempt,
          kind: 'ready',
          opened: { song: read.song, kept: read.kept, dropped: read.dropped },
        };
      }
      if (read.reason === 'empty') {
        return { attempt, kind: 'rejected', reason: { kind: 'empty' } };
      }
      return { attempt, kind: 'rejected', reason: { kind: 'no-midi' } };
    }
    return { attempt, kind: 'helper-off' };
  } catch {
    if (signal.aborted && signal.reason === 'timed-out') {
      return { attempt, kind: 'rejected', reason: { kind: 'timed-out' } };
    }
    return { attempt, kind: 'helper-off' };
  }
}

function statusLine(paste) {
  if (paste.phase === 'fetching') return 'Fetching MIDI.';
  if (paste.phase === 'imported') {
    const { title, kept, dropped } = paste.receipt;
    return `Opened ${title}. ${practiceCutSentence(kept, dropped)}`;
  }
  if (paste.phase === 'failed') return FAIL_TEXT[paste.reason.kind];
  return null;
}

function PasteField({ paste, draft, darkMode, onDraft, onSubmit, onCheckAgain }) {
  const tone = darkMode ? 'text-stone-300' : 'text-stone-600';
  if (paste.phase === 'probing') {
    return (
      <p className={`mt-4 text-xs font-semibold ${tone}`} aria-live="polite">
        Checking the phone helper.
      </p>
    );
  }
  if (paste.phase === 'helper-off') {
    return (
      <div className="mt-4 space-y-2">
        <p className={`text-xs font-semibold ${tone}`} aria-live="polite">
          {OFF_TEXT}
        </p>
        <button
          type="button"
          onClick={onCheckAgain}
          className={`px-3 py-2 rounded-xl border text-xs font-bold transition ${
            darkMode
              ? 'bg-stone-800 border-stone-700 text-stone-200'
              : 'bg-stone-100 border-stone-200 text-stone-700 hover:bg-stone-200'
          }`}
        >
          Check again
        </button>
      </div>
    );
  }

  const canSubmit = paste.phase === 'idle' || paste.phase === 'imported' || paste.phase === 'failed';
  const status = statusLine(paste);
  const statusTone = paste.phase === 'failed'
    ? (darkMode ? 'text-rose-300' : 'text-rose-600')
    : paste.phase === 'imported'
      ? (darkMode ? 'text-emerald-300' : 'text-emerald-700')
      : paste.phase === 'fetching'
        ? (darkMode ? 'text-amber-300' : 'text-amber-700')
        : tone;

  return (
    <form
      className="mt-4 space-y-2"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      {status ? (
        <p className={`text-xs font-semibold ${statusTone}`} aria-live="polite">
          {status}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://musescore.com/..."
          aria-label="MuseScore link"
          value={draft}
          disabled={paste.phase === 'fetching'}
          onChange={(event) => onDraft(event.target.value)}
          className={`min-w-[16rem] flex-1 rounded-xl px-3 py-2 text-xs border focus:outline-none ${
            darkMode
              ? 'bg-stone-950 border-stone-800 text-stone-200 placeholder:text-stone-500'
              : 'bg-stone-50 border-stone-200 text-stone-800'
          }`}
        />
        <button
          type="submit"
          disabled={!canSubmit}
          className="px-4 py-2.5 rounded-xl bg-orange-700 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-orange-700 text-white font-bold text-xs sm:text-sm shadow-sm transition"
        >
          Open in practice
        </button>
      </div>
    </form>
  );
}

export function useMuseScorePaste({ darkMode, readMidi, onOpen }) {
  const [job, setJob] = useState(() => initialJob());
  const [draft, setDraft] = useState('');
  const jobRef = useRef(job);
  const readMidiRef = useRef(readMidi);
  const onOpenRef = useRef(onOpen);
  const disposedRef = useRef(false);
  const fetchAbortRef = useRef(null);
  const probeAbortRef = useRef(null);
  const probeGen = useRef(0);

  readMidiRef.current = readMidi;
  onOpenRef.current = onOpen;

  function commit(next) {
    jobRef.current = next;
    setJob(next);
  }

  function beginFetch() {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort('timed-out'), 20000);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return controller.signal;
  }

  async function runProbe() {
    const generation = probeGen.current + 1;
    probeGen.current = generation;
    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;
    const found = await probeHelper(controller.signal);
    if (disposedRef.current || generation !== probeGen.current) return;
    commit(applyProbe(jobRef.current, found));
  }

  useEffect(() => {
    disposedRef.current = false;
    runProbe();
    return () => {
      disposedRef.current = true;
      probeAbortRef.current?.abort();
      fetchAbortRef.current?.abort('left');
    };
  }, []);

  async function submit(raw) {
    const claim = claimPaste(jobRef.current, raw);
    commit(claim.job);
    if (!claim.request) return;
    const signal = beginFetch();
    const result = await runPaste(
      { url: claim.request.url, attempt: claim.request.attempt, signal },
      { readMidi: (bytes, filename) => readMidiRef.current(bytes, filename) },
    );
    if (disposedRef.current) return;
    const settled = settlePaste(jobRef.current, result);
    commit(settled.job);
    if (settled.opened) onOpenRef.current(settled.opened.song);
  }

  function onCheckAgain() {
    const next = beginProbe(jobRef.current);
    commit(next);
    if (next.paste.phase !== 'probing') return;
    runProbe();
  }

  return {
    field: (
      <PasteField
        paste={job.paste}
        draft={draft}
        darkMode={darkMode}
        onDraft={setDraft}
        onSubmit={submit}
        onCheckAgain={onCheckAgain}
      />
    ),
    cutLabel(songId) {
      const receipt = job.receipts[songId];
      if (!receipt) return null;
      return practiceCutSentence(receipt.kept, receipt.dropped);
    },
  };
}
