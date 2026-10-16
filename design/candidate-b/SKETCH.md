# Candidate B — MuseScore paste import (Import Gateway)

MIDI-only MuseScore URL import for Maestro phone practice. One discriminated-union job state, a browser **Import Gateway** facade, and a Node helper that owns the jmuse protocol. The browser remains the only song builder via `parseStandardMidiFile`.

---

## Problem

Maestro’s import card today accepts local files; Safari on a phone cannot call `musescore.com/api/jmuse` from Maestro’s origin. A small same-origin Node helper (started by `npm run phone`) performs the page scrape, salt discovery, two-step authorization, and MIDI byte download. GitHub Pages ships static `dist/` only, so paste import must **fail closed** with an explicit helper-off UI, not a silent network error.

Constraints that fix the shape: no userscript/WebMscore port; server returns **MIDI bytes + title only**; existing `parseStandardMidiFile` (with a narrow return-type extension for note counts) builds the song; the 96-note cap must surface **kept** and **dropped** counts; one import job state machine (idle | fetching | imported | failed), not parallel booleans; do not extend the fake PDF/audio upload path.

---

## Usage (caller's view)

### Import card (Library & Import tab)

The platform file keeps orchestration wiring; the card is a leaf component driven by one state value and one dispatch function.

```tsx
// src/maestro_ai_platform.tsx (inside renderRepertoireAndImport)

import { MuseScorePasteCard } from './musescore/import-ui';
import {
  createMuseScoreImportState,
  museScoreImportReducer,
} from './musescore/import-gateway';

// component body:
const [museScoreImport, dispatchMuseScore] = useReducer(
  museScoreImportReducer,
  undefined,
  createMuseScoreImportState,
);

<MuseScorePasteCard
  state={museScoreImport}
  onDraftUrlChange={(url) => dispatchMuseScore({ type: 'draft', url })}
  onSubmit={() => dispatchMuseScore({ type: 'submit' })}
  onDismiss={() => dispatchMuseScore({ type: 'reset' })}
  onRunImport={(url) =>
    runMuseScorePasteImport(url, {
      helper: resolveMuseScoreHelper(),
      transport: postMusescoreMidi,
      parseMidi: parseStandardMidiFile,
      onProgress: (phase) => dispatchMuseScore({ type: 'progress', phase }),
      onImported: ({ song, notesKept, notesDropped, title }) => {
        setSongs((prev) => [song, ...prev]);
        handleSelectSong(song.id, 'practice');
        dispatchMuseScore({
          type: 'imported',
          title,
          notesKept,
          notesDropped,
          songId: song.id,
        });
      },
      onFailed: (reason) => dispatchMuseScore({ type: 'failed', reason }),
    })
  }
/>
```

`MuseScorePasteCard` renders:

- When `helper.mode === 'off'`: disabled paste field, copy explaining GitHub Pages / start `npm run phone` on LAN.
- When `idle`: URL text field + Import button (enabled only if `isMusescorePageUrl(draft)`).
- When `fetching`: spinner + “Fetching MIDI from MuseScore…”.
- When `imported`: success line with title, `notesKept`, and `notesDropped` (e.g. “Kept 96 notes, dropped 214”).
- When `failed`: short `reason` + retry (returns to idle preserving draft).

### Call site 1 — React handler (gateway entry)

```ts
// src/musescore/import-gateway.ts

export async function runMuseScorePasteImport(
  rawInput: string,
  deps: MuseScoreImportDeps,
): Promise<void> {
  const url = normalizeMusescoreUrl(rawInput);
  if (!url) {
    deps.onFailed('Paste a full musescore.com score link.');
    return;
  }
  if (deps.helper.mode === 'off') {
    deps.onFailed('MuseScore import needs the local phone helper.');
    return;
  }
  deps.onProgress('fetching');
  let payload: MusescoreMidiPayload;
  try {
    payload = await deps.transport(url, deps.helper);
  } catch (err) {
    deps.onFailed(toUserReason(err));
    return;
  }
  deps.onProgress('parsing');
  let ingest: MidiIngestResult;
  try {
    ingest = deps.parseMidi(payload.midi, `${sanitizeFilename(payload.title)}.mid`);
  } catch (err) {
    deps.onFailed(toUserReason(err));
    return;
  }
  deps.onImported({
    song: ingest.song,
    title: payload.title,
    notesKept: ingest.notesKept,
    notesDropped: ingest.notesDropped,
  });
}
```

Double-submit: `submit` while `fetching` is a no-op in the reducer (idempotent).

### Call site 2 — `POST /api/musescore` (phone helper)

```js
// scripts/phone-server.mjs

import { fetchMusescoreMidi } from './musescore/fetch-musescore.mjs';

async function handleMusescorePost(req, res) {
  const body = await readJsonBody(req, { maxBytes: 8_192 });
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  try {
    const payload = await fetchMusescoreMidi(url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      title: payload.title,
      midiBase64: Buffer.from(payload.midi).toString('base64'),
    }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: toPlainError(err) }));
  }
}
```

Browser transport parses wire JSON once at the boundary:

```ts
// src/musescore/transport.ts

export async function postMusescoreMidi(
  url: string,
  helper: MuseScoreHelperConfig,
): Promise<MusescoreMidiPayload> {
  const res = await fetch(`${helper.apiBase}/api/musescore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const wire = await res.json();
  if (!res.ok) throw new MuseScoreFetchError(wire.error ?? 'Import failed.');
  return {
    title: wire.title,
    midi: base64ToArrayBuffer(wire.midiBase64),
  };
}
```

---

## Module map

| Module | Owns | Public to app |
|--------|------|----------------|
| `src/musescore/index.ts` | Re-exports only | `MuseScorePasteCard`, gateway types, `runMuseScorePasteImport`, `resolveMuseScoreHelper` |
| `src/musescore/import-ui.tsx` | Paste card presentation | `MuseScorePasteCard` |
| `src/musescore/import-gateway.ts` | Job reducer + orchestration | reducer, `runMuseScorePasteImport`, URL normalize/validate |
| `src/musescore/import-types.ts` | Discriminated union state + events | types only |
| `src/musescore/transport.ts` | HTTP wire → `MusescoreMidiPayload` | `postMusescoreMidi` |
| `src/musescore/helper-config.ts` | off vs same-origin detection | `resolveMuseScoreHelper`, `MuseScoreHelperConfig` |
| `scripts/phone-server.mjs` | Static `dist/` + route table | none (CLI entry via `npm run phone`) |
| `scripts/musescore/fetch-musescore.mjs` | Full jmuse fetch pipeline | `fetchMusescoreMidi` (Node only) |
| `scripts/musescore/jmuse-auth.mjs` | Salt cache, md5 auth, jmuse GET | internal to fetch module |
| `scripts/musescore/page-meta.mjs` | Score id + title from HTML | internal |
| `src/maestro_ai_platform.tsx` | Existing MIDI parser (extended return) | `parseStandardMidiFile` signature change |

**Not added:** dependency on `dl-librescore` package, Express, userscript hooks, MusicXML/MP3 paths, Vite proxy as the primary phone story.

`package.json` scripts (sketch):

```json
{
  "scripts": {
    "phone": "node scripts/phone-server.mjs"
  }
}
```

Build-time for Pages (sketch): `VITE_MUSESCORE_HELPER=off` in the deploy workflow. Local phone build uses default `same-origin`.

---

## Shape

### Data structures first

```ts
// src/musescore/import-types.ts

export type MuseScoreHelperMode = 'off' | 'same-origin';

export type MuseScoreHelperConfig =
  | { mode: 'off'; reason: string }
  | { mode: 'same-origin'; apiBase: '' };

export type MuseScoreImportState =
  | { status: 'idle'; draftUrl: string }
  | { status: 'fetching'; url: string; phase: 'fetching' | 'parsing' }
  | {
      status: 'imported';
      title: string;
      notesKept: number;
      notesDropped: number;
      songId: string;
    }
  | { status: 'failed'; reason: string; draftUrl: string };

export type MuseScoreImportEvent =
  | { type: 'draft'; url: string }
  | { type: 'submit' }
  | { type: 'progress'; phase: 'fetching' | 'parsing' }
  | {
      type: 'imported';
      title: string;
      notesKept: number;
      notesDropped: number;
      songId: string;
    }
  | { type: 'failed'; reason: string }
  | { type: 'reset' };

/** Domain payload after HTTP boundary parse — no jmuse fields. */
export type MusescoreMidiPayload = {
  title: string;
  midi: ArrayBuffer;
};

export type MidiIngestResult = {
  song: Song;
  notesKept: number;
  notesDropped: number;
};

export type MuseScoreImportDeps = {
  helper: MuseScoreHelperConfig;
  transport: (url: string, helper: MuseScoreHelperConfig) => Promise<MusescoreMidiPayload>;
  parseMidi: (buf: ArrayBuffer, filename: string) => MidiIngestResult;
  onProgress: (phase: 'fetching' | 'parsing') => void;
  onImported: (result: {
    song: Song;
    title: string;
    notesKept: number;
    notesDropped: number;
  }) => void;
  onFailed: (reason: string) => void;
};
```

```ts
// src/maestro_ai_platform.tsx — parser boundary extension

const MAESTRO_NOTE_CAP = 96;

function parseStandardMidiFile(
  arrayBuffer: ArrayBuffer,
  filename?: string,
): MidiIngestResult {
  throw new Error('not implemented');
  // Pseudocode:
  // const parsedNotes = /* existing track walk */;
  // const total = parsedNotes.length;
  // const sliced = parsedNotes.slice(0, MAESTRO_NOTE_CAP);
  // return { song: buildSongFromEvents({ ... rawNotes: sliced }), notesKept: sliced.length, notesDropped: Math.max(0, total - sliced.length) };
}
```

File upload call site becomes `const { song } = parseStandardMidiFile(buf, file.name)`; optional to show counts later.

### Gateway + reducer (single state owner)

```ts
// src/musescore/import-gateway.ts

export function createMuseScoreImportState(): MuseScoreImportState {
  throw new Error('not implemented');
}

export function museScoreImportReducer(
  state: MuseScoreImportState,
  event: MuseScoreImportEvent,
): MuseScoreImportState {
  throw new Error('not implemented');
  // Invariants:
  // - submit from idle with valid URL → fetching
  // - submit while fetching → state unchanged
  // - failed/imported → draft preserved on failed only
  // - reset → idle with '' draft
}

export function normalizeMusescoreUrl(raw: string): string | null {
  throw new Error('not implemented');
  // ^https?://(?:(?:s|www)\.)?musescore\.com/\S+$
  // trim, reject bare numeric ids
}

export function isMusescorePageUrl(url: string): boolean {
  throw new Error('not implemented');
}

export function runMuseScorePasteImport(
  rawInput: string,
  deps: MuseScoreImportDeps,
): Promise<void> {
  throw new Error('not implemented');
}
```

```ts
// src/musescore/helper-config.ts

export function resolveMuseScoreHelper(): MuseScoreHelperConfig {
  throw new Error('not implemented');
  // if import.meta.env.VITE_MUSESCORE_HELPER === 'off' → { mode: 'off', reason: '...' }
  // else → { mode: 'same-origin', apiBase: '' }
}
```

```tsx
// src/musescore/import-ui.tsx

export function MuseScorePasteCard(props: {
  state: MuseScoreImportState;
  onDraftUrlChange: (url: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
  onRunImport: (url: string) => void;
}): JSX.Element {
  throw new Error('not implemented');
}
```

### Node helper (protocol depth hidden from browser)

```js
// scripts/musescore/page-meta.mjs

/** @returns {{ scoreId: string, title: string }} */
export function parseScorePageMeta(html) {
  throw new Error('not implemented');
  // meta al:ios:url → musescore://score/DIGITS
  // meta og:title
}

export function assertMusescorePageUrl(url) {
  throw new Error('not implemented');
}
```

```js
// scripts/musescore/jmuse-auth.mjs

/** Process-lifetime salt cache. */
let cachedSalt = null;

export async function discoverSalt(scorePageUrl, fetchImpl) {
  throw new Error('not implemented');
  // GET page → find build/*.js URLs → GET first matching bundle → substr(0,4) literal
}

export function buildAuthorization(scoreId, salt) {
  throw new Error('not implemented');
  // md5(`${scoreId}midi0${salt}`).slice(0, 4) — no Bearer
}

export async function getJmuseMidiDownloadUrl(scoreId, fetchImpl) {
  throw new Error('not implemented');
  // Try discovered salt; if jmuse !ok, retry salt '9654,4e' only once more; no third attempt, no player click
  // GET https://musescore.com/api/jmuse?id=&type=midi&index=0 → JSON info.url
}
```

```js
// scripts/musescore/fetch-musescore.mjs

/**
 * @param {string} pageUrl
 * @returns {Promise<{ title: string, midi: Uint8Array }>}
 */
export async function fetchMusescoreMidi(pageUrl) {
  throw new Error('not implemented');
  // assertMusescorePageUrl → GET page → parseScorePageMeta → getJmuseMidiDownloadUrl → GET bytes
  // Login-required / private scores: fail closed with plain Error message, no cookie jar
}
```

```js
// scripts/phone-server.mjs

const PORT = process.env.PORT ?? 4173;
const HOST = '0.0.0.0';

export function createPhoneServer() {
  throw new Error('not implemented');
  // serve dist/ static; POST /api/musescore → handleMusescorePost; 404 otherwise
}
```

### Flow (three hops, three files)

```text
Paste → runMuseScorePasteImport (gateway)
     → postMusescoreMidi (transport)
     → phone-server → fetchMusescoreMidi (Node)
     → parseStandardMidiFile (existing parser, extended result)
     → setSongs + practice
```

### Load-bearing decisions

| Decision | Rationale (principle) |
|----------|------------------------|
| **Import Gateway** with injected `transport` + `parseMidi` | **Boundary discipline** — UI tests and platform wiring swap deps without touching jmuse. **Minimize reader load** — one async function to read for the happy path. |
| Reducer owns `MuseScoreImportState` | **Model the domain** — illegal combinations (fetching + error flag) unrepresentable. **Make operations idempotent** — duplicate submit ignored. |
| `MusescoreMidiPayload` vs wire JSON | **Encode lessons in structure** — jmuse/`info.url` never cross into React types. |
| Parser returns `MidiIngestResult` | **Single source of truth** for the 96-note cap; paste path must not re-count events differently from file MIDI. |
| `scripts/musescore/*` not importable from Vite | **Importable internals** — build fails if `src/` imports Node helper. |
| Two auth attempts only (dynamic salt, then `9654,4e`) | Matches grounding; server never runs browser token sniffer. |
| `VITE_MUSESCORE_HELPER=off` on Pages + disabled UI | **Experience first** — fail closed with explanation, not CORS console noise. |

### Interface depth

**Public browser surface (6 exports from `src/musescore/index.ts`):** `MuseScorePasteCard`, `createMuseScoreImportState`, `museScoreImportReducer`, `runMuseScorePasteImport`, `resolveMuseScoreHelper`, `isMusescorePageUrl`.

**Hidden behind that surface:** jmuse authorization, bundle salt scraping, md5, base64 on wire, reducer transition table details, HTML meta regexes.

Callers never choose salts, indices, or MIME strategies. They pass a URL and receive practice mode with visible note counts.

### Red flag screening (pre-synthesis)

| Flag | Verdict |
|------|---------|
| Shallow module | Gateway + fetch module are deep; UI is thin presentation only. |
| Information leakage | jmuse types confined to `scripts/musescore/*`; wire JSON parsed in `transport.ts` only. |
| Temporal decomposition | Not split into load/validate/transform packages; ownership is gateway vs fetch vs parser. |
| Pass-through | `transport.ts` adapts wire→domain; HTTP handler adapts JSON→bytes. No bare re-exports. |
| Split ownership | One reducer for import job; platform owns `songs` but only gateway events mutate import state. |
| Two ways | Single path: POST `/api/musescore` — no Vite proxy, no browser jmuse. |
| Importable internals | Node scripts are outside `src/`; no barrel re-export of jmuse helpers. |
| Hand-synced list | States are one union; events enumerated once in `import-types.ts`. |

---

## Synthesis decision

Independent **candidate B**. Arena not run in this runner. Proposed as base when the team wants a **facade gateway + injected ports**, explicit helper mode, and Node fetch isolated under `scripts/musescore/` without adding framework dependencies to the phone server.

---

## Tradeoffs accepted

- We accept **base64 JSON** for MIDI over the LAN in exchange for a **single JSON error shape** and simple iPhone debugging (no multipart parser in the phone script).
- We accept a **`parseStandardMidiFile` return-type change** in exchange for **one note-cap accounting** shared by file upload and MuseScore paste.
- We accept **`VITE_MUSESCORE_HELPER` baked at build time** in exchange for **zero runtime probe latency** on GitHub Pages; wrong env still shows off-mode if set to `off`.
- We accept **no shared code between Node and browser** for URL regex in exchange for **zero risk of bundling Node md5 into the client** (duplicate one-line pattern in gateway + `page-meta`).

---

## Alternatives considered

1. **Monolithic `useMusescoreImport` hook** colocated in `maestro_ai_platform.tsx` with inline `fetch` and booleans (`isLoading`, `error`). Rejected: violates the chosen state machine, encourages parallel booleans, and exposes jmuse error strings at the UI layer (**shallow interface**, **split ownership**).

2. **Vite dev-server proxy to musescore.com** (no `phone-server`, reuse `vite preview` proxy). Rejected: GitHub Pages cannot proxy; introduces a **second way** to import that agents will copy for local dev but phones cannot use (**two ways to do one task**).

3. **Server returns a Maestro `Song` JSON** built from MIDI on Node. Rejected: grounding requires the **browser parser as the only song builder**; would duplicate note-cap logic server-side (**information leakage** of ingest rules).

4. **Import `dl-librescore` as a dependency** in the helper. Rejected: pulls userscript/network-auth paths and browser assumptions; grounding forbids porting that surface area. A **minimal jmuse-only excerpt** under `scripts/musescore/` is smaller and fail-closed.

5. **Shared isomorphic `fetchMusescoreMidi` imported from `src/`** with conditional `globalThis.window`. Rejected: **importable internals** risk and accidental client bundle bloat; Node stays out of Vite graph entirely.

---

## Open questions and risks

- Should file MIDI upload success copy also show `notesDropped` when `notesDropped > 0`, for consistency with paste, or only the MuseScore card?
- MuseScore HTML or bundle layout changes could break salt regex; do we want a single integration test against a recorded HTML fixture in `scripts/musescore/` (no live network in CI)?
- For `npm run phone`, should the script run `vite build` first or require a prebuilt `dist/` (operator ergonomics vs fail-fast)?

---

## Next implementation step

Add `src/musescore/import-types.ts` and extend `parseStandardMidiFile` to return `MidiIngestResult`, then implement `museScoreImportReducer` and a stub `MuseScorePasteCard` wired in `renderRepertoireAndImport` before any Node networking.

---

## Type sketch index (signatures only)

All bodies `throw new Error('not implemented')` unless marked pseudocode above.

```ts
// Errors
export class MuseScoreFetchError extends Error {
  constructor(message: string);
}

export function toUserReason(err: unknown): string;
export function toPlainError(err: unknown): string;
export function sanitizeFilename(title: string): string;
export function base64ToArrayBuffer(b64: string): ArrayBuffer;

// transport.ts
export function postMusescoreMidi(
  url: string,
  helper: MuseScoreHelperConfig,
): Promise<MusescoreMidiPayload>;

// index.ts — public barrel
export {
  MuseScorePasteCard,
  createMuseScoreImportState,
  museScoreImportReducer,
  runMuseScorePasteImport,
  resolveMuseScoreHelper,
  isMusescorePageUrl,
};
export type {
  MuseScoreImportState,
  MuseScoreImportEvent,
  MuseScoreHelperConfig,
  MusescoreMidiPayload,
  MidiIngestResult,
};
```

```js
// scripts/phone-server.mjs
export function createPhoneServer(options?: { port?: number; host?: string; distDir?: string }): http.Server;
export function startPhoneServer(): void;

// scripts/musescore/fetch-musescore.mjs
export async function fetchMusescoreMidi(pageUrl: string): Promise<{ title: string; midi: Uint8Array }>;

// scripts/musescore/jmuse-auth.mjs
export async function discoverSalt(scorePageUrl: string, fetchImpl: typeof fetch): Promise<string | null>;
export function buildAuthorization(scoreId: string, salt: string): string;
export async function getJmuseMidiDownloadUrl(scoreId: string, fetchImpl: typeof fetch): Promise<string>;

// scripts/musescore/page-meta.mjs
export function assertMusescorePageUrl(url: string): void;
export function parseScorePageMeta(html: string): { scoreId: string; title: string };
```
