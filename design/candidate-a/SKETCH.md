# Candidate A

The paste job lives in one hook on `App`, above the tabs. The phone helper exposes one MIDI fetch. Practice shows the 96-note cut from a receipt stored by song id.

## Problem

A phone user pastes a MuseScore link on the import card and lands in practice with that score as MIDI. Safari cannot call `musescore.com` from Maestro's origin, so `npm run phone` serves `dist/` and `POST /api/musescore` on the same origin. GitHub Pages serves `dist/` with no process, and that copy must refuse the paste with a visible helper-off state.

`parseStandardMidiFile` in `src/maestro_ai_platform.tsx` is the only song builder. It keeps the first 96 notes after sorting and drops the rest without a count. The import card stores `importStatus` as `step`, `success`, and `error` at once, and `renderRepertoireAndImport` unmounts when `handleSelectSong` switches to practice. A paste flag inside that banner would either lie about the cut or vanish before the player could read it.

MusicXML, MSCZ, MP3, PDF, cookies, and the dl-librescore userscript path are out. The helper does not import that project.

## Usage (caller's view)

`App` imports one hook. It does not call `fetch`, and it does not read a salt, a score id, or base64. The hook call sits in `App` after `handleSelectSong`, never inside `renderRepertoireAndImport`.

```tsx
const museScore = useMuseScorePaste({
  darkMode,
  readMidi: readPracticeMidi,
  onOpen: (song) => {
    setSongs((prev) => [song, ...prev]);
    handleSelectSong(song.id, 'practice');
  },
});
```

The import card places the control under the existing file button. The file input and `importStatus` stay as they are.

```tsx
{museScore.field}
```

`renderPracticeView` places the cut under the song `<select>`. `handleSelectSong(..., 'practice')` leaves the card, so this line is where the player sees the numbers.

```tsx
const cut = museScore.cutLabel(currentSong.id);
```

```tsx
{cut ? (
  <p className="px-1 text-xs font-semibold text-stone-600 dark:text-stone-300" aria-live="polite">
    {cut}
  </p>
) : null}
```

`cut` is `Kept 96. Dropped 400.` or `Kept 40. Dropped 0.` Built-in songs get `null` and render nothing.

### React handler

The form inside `museScore.field` calls this file-private handler. `App` does not reimplement it. `onOpen` runs only when a matching attempt produced a song.

```tsx
async function submit(raw: string): Promise<void> {
  // commit writes jobRef before it schedules a render, so a second call in the same turn sees fetching.
  const claim = claimPaste(jobRef.current, raw);
  commit(claim.job);
  if (!claim.request) return;

  const signal = beginFetch(claim.request.attempt);
  const result = await runPaste(
    { url: claim.request.url, attempt: claim.request.attempt, signal },
    { readMidi: readMidiRef.current },
  );
  if (disposedRef.current) return;

  const settled = settlePaste(jobRef.current, result);
  commit(settled.job);
  if (settled.opened) onOpenRef.current(settled.opened.song);
}
```

`readPracticeMidi` is the function `App` passes in. It is the only adapter between the thrown parser and the hook. Success returns `{ ok: true, song, kept, dropped }`. A throw whose `code` is `midi-empty` returns `{ ok: false, reason: 'empty' }`. Any other throw returns `{ ok: false, reason: 'bad' }`.

```tsx
function readPracticeMidi(bytes, filename) {
  throw new Error('not implemented');
}
```

The MIDI file button changes its success path to the new return and keeps its current label. That label still prints `opened.song.events.length` and does not print `dropped`.

```tsx
const opened = parseStandardMidiFile(buf, file.name);
setSongs((prev) => [opened.song, ...prev]);
handleSelectSong(opened.song.id, 'practice');
```

### POST /api/musescore

`server/phone.mjs` is the only HTTP caller. A GET on the same path is the probe. The route does not parse HTML and does not fetch MuseScore itself.

```js
if (url.pathname === HELPER_PATH && req.method === 'GET') {
  sendJson(res, 200, { helper: HELPER_MARK });
  return;
}

if (url.pathname === HELPER_PATH && req.method === 'POST') {
  const body = await readJson(req);
  const result = await fetchScoreMidi(body && body.url, abortSignal);
  if (!result.ok) {
    sendJson(res, statusFor(result.error), { error: result.error });
    return;
  }
  sendJson(res, 200, {
    title: result.title,
    midiBase64: Buffer.from(result.bytes).toString('base64'),
  });
  return;
}
```

`vite.config.ts` imports `APP_BASE` from the same contract module the probe uses.

```ts
import { APP_BASE } from './shared/musescore-contract.mjs';

export default defineConfig({
  plugins: [react()],
  base: APP_BASE,
});
```

## Shape

One `PasteJob` owns the lifecycle. `phase` is `probing`, `helper-off`, `idle`, `fetching`, `imported`, or `failed`. The form is absent during `probing` and `helper-off`, so a Pages load cannot submit. `idle` means the probe saw the helper mark. `failed` means this link was refused and the helper is still on. Those are different facts, so they are different phases, per `principle-model-the-domain` and `principle-type-system-discipline`.

`importStatus` stays the file-upload banner. The paste module does not mention it. Folding the link into `success` and `error` would bring the boolean bag back, and the fake PDF timer would start writing the MIDI receipt.

The hook is mounted for the life of `App`. Tab switches unmount the card and must not abort a fetch that has already been claimed. Unmount of `App` aborts it. Per `principle-redesign-from-first-principles`, the job sits above the tabs because the card is not alive in practice.

Receipts are the cut the player can still see after that navigation. `settlePaste` stores one `Receipt` on the job and also under `receipts[songId]`, the same object. `cutLabel` reads the map. The field reads `paste.receipt` when the phase is `imported`. Title, kept, and dropped are not copied onto the song, and they are not stored a second time as loose numbers. Per `principle-foundational-thinking`.

`PRACTICE_NOTE_CAP` is `96` and lives next to the slice inside `parseStandardMidiFile`. The hook never writes that number. The slice runs after the existing onset and pitch sort, and `dropped` is `parsedNotes.length - keptNotes.length` for that same array. Per `principle-encode-lessons-in-structure`.

The public client export is `useMuseScorePaste`. The public server export is `fetchScoreMidi`. Shared exports are the path, the probe mark, the error-code array, and `parseScoreUrl`. Salt, md5, base64, jmuse, and the phase transitions are file-private. A later edit cannot import them from `App`. Per `principle-laziness-protocol` and `principle-minimize-reader-load`.

`fetchScoreMidi` takes an unknown URL and returns MIDI bytes plus a title, or an error code. It has no `type` argument. `midi` and index `0` are literals inside `authToken` and the jmuse URL. Adding MP3 means changing the function, not passing a new string. `phone.mjs` turns bytes into base64 at the HTTP edge and nowhere else. The client turns base64 back into a fresh `ArrayBuffer` before `readMidi`. Per `principle-boundary-discipline`.

`parseScoreUrl` accepts only `^https?://(?:(?:s|www)\.)?musescore\.com/\S+$`. A bare id fails. The client brands a non-null return as `ScoreUrl` with one cast after that function returns. The server calls the same function on the POST body and does not trust the brand. Invalid JSON, a body over 2048 bytes, and a missing `url` are `bad-url`.

The client treats a probe or POST as helper-off when the `content-type` is not `application/json`, the JSON has both `error` and `midiBase64`, or `fetch` throws a network error. Pages answers those routes with HTML or a 404, so the form stays hidden. The phone sends no CORS headers. Another origin cannot use the helper as a proxy.

`claimPaste` is the only way into `fetching`. The job stores `nextAttempt`. A started request copies that number onto `fetching` and increments `nextAttempt`. A second submit while `fetching` is a no-op. `helper-off` and `probing` ignore the text. A late response whose `attempt` does not match, or whose phase is no longer `fetching`, does not open a song. `beginFetch` aborts the previous controller and aborts this one after 20 seconds with reason `timed-out`. Leaving the site sets `disposedRef` and aborts with reason `left`, and `submit` does not settle after that. The server aborts its upstream fetch when the socket closes. Salt for one request is a string snapshot. A failure clears the cached salt for the next paste and does not change the snapshot already in hand. Per `principle-make-operations-idempotent` and `principle-separate-before-serializing-shared-state`.

Two browser tabs are two hooks. They share no paste job. The Node process shares one salt cell, filled by a single in-flight scrape.

The helper's upstream sequence is fixed. There is no third jmuse request and no player click. No cookies are stored. The User-Agent on those requests is `MaestroPhone/1`.

1. GET the score page.
2. Read the id from `meta[property="al:ios:url"]` with content `musescore://score/DIGITS`, and the title from `og:title`. Accept either attribute order.
3. Find the first build script URL on `musescore.com/static/public/build/musescore` whose path contains `/20` and ends in `.js`. The salt is the entire quoted text in the first `.substr(0, 4)` call. Cache that full string for the process. The 4-character slice happens later, on the md5 hex, not on the salt.
4. `Authorization` is `md5(id + "midi" + "0" + salt)` as hex, sliced to 4, with no Bearer prefix.
5. GET `https://musescore.com/api/jmuse?id=&type=midi&index=0`. If that response is not OK, and the fallback salt `9654,4e` differs from the salt just tried, try the fallback once. If the page had no salt, the fallback is the only try.
6. GET `info.url` only when it starts with `https://`, and send no Authorization header. Return the body only when it starts with `MThd`. Otherwise the result is `no-midi`.

`readScorePage`, `discoverSalt`, `authToken`, `requestMidiUrl`, and `downloadMidi` are private functions in `server/musescore.mjs`. They are not separate modules. The protocol is one body of knowledge, per `principle-model-the-domain`.

The field is the only paste form. `probing` shows "Checking the phone helper." `helper-off` shows "MuseScore paste is off on this page. Open Maestro from the phone helper on your Wi-Fi." and a Check again button that returns to `probing` and runs the same probe. It does not read the text box. `fetching` shows "Fetching MIDI." and disables the box. `failed` shows the sentence for that reason and leaves the box usable. `imported` shows `Opened ${title}.` plus the cut sentence. The box placeholder is `https://musescore.com/...`. The button label is "Open in practice". Status text is `aria-live="polite"`. The draft string lives in the hook so a tab switch does not clear it, and it is not a phase. Per `principle-experience-first`.

Failure sentences live in one map inside the hook file.

- `bad-url` says "Paste a full MuseScore link. A bare id is not a score link."
- `unavailable` says "That score is private, missing, or needs a login. This helper stores no login."
- `no-midi` says "MuseScore did not return MIDI for that score."
- `empty` says "That MIDI file has no playable notes."
- `timed-out` says "The helper did not answer. Try the link again."

`empty` and `timed-out` are client reasons. The server never sends them. `bad` from `readPracticeMidi` becomes `no-midi`.

### Module map

| File | Owns | Exports |
| --- | --- | --- |
| `shared/musescore-contract.mjs` | App base, helper path, probe mark, error codes, score-link grammar | `APP_BASE`, `HELPER_PATH`, `HELPER_MARK`, `HELPER_ERRORS`, `parseScoreUrl` |
| `server/musescore.mjs` | Page, salt, jmuse, MIDI bytes, salt cell | `fetchScoreMidi` |
| `server/phone.mjs` | Bind `0.0.0.0`, static `dist/`, GET and POST | none |
| `src/musescore-paste.tsx` | Paste job, probe, field, cut sentence | `useMuseScorePaste` |
| `src/maestro_ai_platform.tsx` | `PRACTICE_NOTE_CAP`, parser, `readPracticeMidi`, song list | existing `App` |
| `vite.config.ts` | Vite `base` | imports `APP_BASE` |
| `package.json` | `"phone": "vite build && node server/phone.mjs"` | none |

No new npm dependency. The helper uses `node:http`, `node:fs`, `node:path`, `node:os`, and `node:crypto`.

### Types

```ts
type ScoreUrl = string & { readonly __brand: 'ScoreUrl' };

type HelperError = (typeof HELPER_ERRORS)[number];

type FailReason =
  | { kind: HelperError }
  | { kind: 'empty' }
  | { kind: 'timed-out' };

type Receipt = {
  songId: string;
  title: string;
  kept: number;
  dropped: number;
};

type Paste =
  | { phase: 'probing' }
  | { phase: 'helper-off' }
  | { phase: 'idle' }
  | { phase: 'fetching'; url: ScoreUrl; attempt: number }
  | { phase: 'imported'; receipt: Receipt }
  | { phase: 'failed'; reason: FailReason };

type PasteJob = {
  paste: Paste;
  receipts: Readonly<Record<string, Receipt>>;
  nextAttempt: number;
};

type PracticeOpen<Song extends { id: string; title: string }> = {
  song: Song;
  kept: number;
  dropped: number;
};

type MidiRead<Song extends { id: string; title: string }> =
  | { ok: true; song: Song; kept: number; dropped: number }
  | { ok: false; reason: 'empty' | 'bad' };

type FetchMidi =
  | { ok: true; title: string; bytes: Uint8Array }
  | { ok: false; error: HelperError };

type ScorePage = { id: number; title: string };
```

`Paste`, `PasteJob`, `Receipt`, and `FailReason` are file-private. `App` sees `field` and `cutLabel`.

### Signatures

```ts
export const APP_BASE = '/maestro-ai/';
export const HELPER_PATH = `${APP_BASE}api/musescore`;
export const HELPER_MARK = 'musescore-phone';
export const HELPER_ERRORS = ['bad-url', 'unavailable', 'no-midi'] as const;

export function parseScoreUrl(raw: unknown): string | null {
  // Trim a string. Accept only ^https?://(?:(?:s|www)\.)?musescore\.com/\S+$
  // Anything else, including a bare id, returns null.
  throw new Error('not implemented');
}
```

```ts
const PRACTICE_NOTE_CAP = 96;

function parseStandardMidiFile(
  arrayBuffer: ArrayBuffer,
  filename = 'Imported Song.mid',
): PracticeOpen<Song> {
  // Keep the existing MThd parse.
  // Throw Error with code 'midi-bad' when the header is not MThd.
  // Throw Error with code 'midi-empty' when there are no playable notes.
  // Sort by onset, then pitch.
  // keptNotes = parsedNotes.slice(0, PRACTICE_NOTE_CAP)
  // return { song: buildSongFromEvents({ ...same fields, rawNotes: keptNotes }), kept: keptNotes.length, dropped: parsedNotes.length - keptNotes.length }
  throw new Error('not implemented');
}

function readPracticeMidi(
  bytes: ArrayBuffer,
  filename: string,
): MidiRead<Song> {
  throw new Error('not implemented');
}
```

```ts
export function useMuseScorePaste<Song extends { id: string; title: string }>(args: {
  darkMode: boolean;
  readMidi: (bytes: ArrayBuffer, filename: string) => MidiRead<Song>;
  onOpen: (song: Song) => void;
}): {
  field: React.ReactNode;
  cutLabel: (songId: string) => string | null;
} {
  // Start from initialJob(). Keep onOpen and readMidi in refs updated every render.
  // On mount, probeHelper then applyProbe. Check again uses beginProbe and the same probe.
  // The draft string lives here, beside the job, and it is not a phase.
  throw new Error('not implemented');
}

function probeHelper(signal: AbortSignal): Promise<boolean> {
  // GET HELPER_PATH with accept application/json and cache no-store.
  // True only when content-type includes application/json and body.helper === HELPER_MARK.
  // Any throw or any other body is false.
  throw new Error('not implemented');
}

function initialJob(): PasteJob {
  // paste is probing, receipts is empty, nextAttempt is 1.
  throw new Error('not implemented');
}

function asScoreUrl(raw: unknown): ScoreUrl | null {
  // Call parseScoreUrl. Null stays null. A string is the one ScoreUrl cast in this file.
  throw new Error('not implemented');
}

function claimPaste(job: PasteJob, raw: string):
  | { request: null; job: PasteJob }
  | { request: { url: ScoreUrl; attempt: number }; job: PasteJob } {
  // probing or helper-off: same job, no request.
  // fetching: same job, no request.
  // asScoreUrl fails: phase failed, kind bad-url, no request. nextAttempt stays.
  // idle, imported, or failed, and the url is valid:
  // phase fetching, attempt is job.nextAttempt, request is { url, attempt }, nextAttempt increases by 1.
  throw new Error('not implemented');
}

function beginFetch(attempt: number): AbortSignal {
  // Abort the controller from the previous attempt.
  // Abort this controller after 20 seconds with reason 'timed-out'.
  // App unmount aborts with reason 'left' and sets disposedRef.
  throw new Error('not implemented');
}

function settlePaste<Song extends { id: string; title: string }>(
  job: PasteJob,
  result: PasteResult<Song>,
): { job: PasteJob; opened: PracticeOpen<Song> | null } {
  // Ignore the result unless paste.phase is fetching and attempt matches. Return the same job and opened null.
  // helper-off result: phase helper-off, opened null. Keep receipts and nextAttempt.
  // rejected: phase failed, opened null.
  // ready: one Receipt from song.id, song.title, kept, dropped.
  // Store that same object on paste.receipt and under receipts[songId]. opened is the parser result.
  throw new Error('not implemented');
}

function applyProbe(job: PasteJob, found: boolean): PasteJob {
  // Only probing changes. found goes to idle. A miss goes to helper-off.
  throw new Error('not implemented');
}

function beginProbe(job: PasteJob): PasteJob {
  // Only helper-off moves to probing.
  throw new Error('not implemented');
}

function practiceCutSentence(kept: number, dropped: number): string {
  // `Kept ${kept}. Dropped ${dropped}.`
  throw new Error('not implemented');
}

function runPaste<Song extends { id: string; title: string }>(
  request: { url: ScoreUrl; attempt: number; signal: AbortSignal },
  deps: { readMidi: (bytes: ArrayBuffer, filename: string) => MidiRead<Song> },
): Promise<PasteResult<Song>> {
  // POST HELPER_PATH with JSON { url } and accept application/json.
  // content-type other than application/json, a body with both error and midiBase64, or any other JSON: kind helper-off.
  // error code in HELPER_ERRORS, and no midiBase64: kind rejected with that kind.
  // title plus midiBase64: copy into a new ArrayBuffer. If the bytes do not start with MThd, rejected no-midi.
  // readMidi ok: kind ready. Pass `${title}.mid` as the filename so song.title is the score title.
  // readMidi reason empty: rejected empty. reason bad: rejected no-midi.
  // Abort reason timed-out: rejected timed-out. Network TypeError: helper-off.
  throw new Error('not implemented');
}

type PasteResult<Song extends { id: string; title: string }> =
  | { attempt: number; kind: 'ready'; opened: PracticeOpen<Song> }
  | { attempt: number; kind: 'rejected'; reason: FailReason }
  | { attempt: number; kind: 'helper-off' };
```

```ts
export function fetchScoreMidi(
  rawUrl: unknown,
  signal: AbortSignal,
): Promise<FetchMidi> {
  // parseScoreUrl(rawUrl) null: { ok: false, error: 'bad-url' }.
  // GET the page with User-Agent MaestroPhone/1 and no Cookie header. Follow redirects.
  // Missing id or title: unavailable.
  // Resolve a salt snapshot through the process cell. One scrape in flight.
  // Try the discovered salt, then 9654,4e if the first response is not OK and the salts differ.
  // No salt from the build script means the fallback is the only attempt.
  // A failed discovered salt clears the cell after this call has copied the string.
  // requestMidiUrl returns the info url or null. null after the attempts is unavailable.
  // downloadMidi returns bytes or null. null is no-midi.
  throw new Error('not implemented');
}

function readScorePage(html: string): ScorePage | null {
  // Read meta property al:ios:url and og:title, either attribute order.
  // Id is the digits in musescore://score/DIGITS. Decode the five HTML entities in the title.
  // Missing id or empty title returns null.
  throw new Error('not implemented');
}

function discoverSalt(pageHtml: string, signal: AbortSignal): Promise<string | null> {
  // First https URL on musescore.com/static/public/build/musescore whose path contains /20 and ends in .js.
  // Salt is the entire quoted text in the first .substr(0, 4) call. No match returns null.
  throw new Error('not implemented');
}

function authToken(page: ScorePage, salt: string): string {
  // md5(`${page.id}midi0${salt}`).digest('hex').slice(0, 4). No Bearer prefix.
  throw new Error('not implemented');
}

function requestMidiUrl(page: ScorePage, salt: string, signal: AbortSignal): Promise<string | null> {
  // GET https://musescore.com/api/jmuse?id=${page.id}&type=midi&index=0
  // Header Authorization is authToken(page, salt).
  // OK JSON { info: { url: string } } returns that url. Anything else returns null.
  throw new Error('not implemented');
}

function downloadMidi(infoUrl: string, signal: AbortSignal): Promise<Uint8Array | null> {
  // Refuse a url that does not start with https://. Send no Authorization header.
  // Return the body only when it starts with MThd. Otherwise null.
  throw new Error('not implemented');
}
```

```js
function statusFor(error) {
  // HTTP_STATUS is { 'bad-url': 400, unavailable: 404, 'no-midi': 422 }.
  // On boot, throw if any HELPER_ERRORS entry has no numeric status.
  throw new Error('not implemented');
}

function sendJson(res, status, body) {
  // content-type application/json, nosniff, no CORS headers, no-store.
  throw new Error('not implemented');
}

function readJson(req) {
  // Reject a body longer than 2048 bytes.
  throw new Error('not implemented');
}

function serveStatic(req, res) {
  // HELPER_PATH is routed before this runs, so it never falls through to index.html.
  // Files come from dist under APP_BASE. Reject a path that escapes dist.
  throw new Error('not implemented');
}
```

The field switch is file-private inside the hook.

```tsx
function PasteField(props: {
  paste: Paste;
  draft: string;
  darkMode: boolean;
  onDraft: (value: string) => void;
  onSubmit: (raw: string) => void;
  onCheckAgain: () => void;
}): React.ReactElement {
  // probing: the checking line, no input.
  // helper-off: the off line and Check again. onCheckAgain calls beginProbe and the probe.
  // idle, fetching, imported, failed: url input bound to draft.
  // Submit calls onSubmit(draft). Disabled unless idle, imported, or failed.
  // fetching disables the input. imported and failed render their sentence above it.
  throw new Error('not implemented');
}
```

## Synthesis decision

Arena fills this section. This file is candidate A and does not choose a base.

## Tradeoffs accepted

- We accept a practice line that `App` must render, in exchange for a cut that survives leaving the import card.
- We accept `importStatus` remaining a boolean bag for file upload, in exchange for leaving the fake PDF path alone.
- We accept that the file-upload MIDI label still omits `dropped`, in exchange for one speaker of the cut sentence on the paste path and in practice.
- We accept `sourceFormat` staying `Standard MIDI (.mid)`, in exchange for the parser remaining the only writer of the song.
- We accept a 20 second client deadline, in exchange for a job that cannot sit on `fetching` after the helper goes quiet.
- We accept `MaestroPhone/1` as the upstream User-Agent, in exchange for a request that is identifiable in logs and is not a browser impersonation.
- We accept that Check again reloads the probe only, in exchange for a helper-off page that never shows a text box.
- We accept an https-only `info.url`, in exchange for refusing a jmuse body that points at a non-https host. The bytes still have to start with `MThd`.

## Alternatives considered

A userscript, iframe token sniffer, webpack hook, or WebMscore port lost because the grounding forbids them. The iOS click is the unreliable path this helper replaces. Those modules also hide nothing from the phone. Safari still cannot call jmuse.

Returning a Maestro song from `POST /api/musescore` lost because the server would become a second song builder. The 96-note slice would have two homes, and the client would learn the song fields as a wire type. `fetchScoreMidi` hides the page, the salt, and jmuse, and returns bytes.

A Vite middleware used only by `npm run dev` lost because Pages and `npm run phone` both serve `dist/`. A dev-only route is a second paste implementation. `server/phone.mjs` is the one process in front of the built files.

Splitting page, salt, auth, download, route, and hook into six modules lost because that is the fetch written out in order. Each file would restate the score id and the salt. Callers would have to sequence the steps. One server module and one hook hide that sequence.

Merging the link into `importStatus` lost because `success` and `error` can both be true, and the card unmounts on the way to practice. The hook's `phase` makes those combinations unwritable. The file banner stays on its own state so the fake upload does not gain a receipt API.

A browser CORS proxy, or a helper that GETs arbitrary URLs, lost because Pages has no process to proxy with, and an open proxy on the phone would fetch more than MIDI. `fetchScoreMidi` accepts only a score link and returns only an `MThd` body.

Putting the paste `useState` inside `renderRepertoireAndImport` lost because that function is not a component, and the repertoire tree unmounts when practice opens. The in-flight POST would die on the success path, and the cut would unmount with it.

## Open questions and risks

- Does MuseScore reject `User-Agent: MaestroPhone/1`? I did not measure a live request. If it does, which single browser-like value should replace it?
- Are current `info.url` values always https? This sketch refuses any other scheme.
- Should the existing MIDI file banner also print `Dropped`, or is the practice line enough for the paste path?
- The jmuse `info.url` host is whatever MuseScore returns. The `MThd` check stops non-MIDI bytes from reaching the phone. Is that enough, or do you want a host allowlist once a real URL is observed?

## Next implementation step

Change `parseStandardMidiFile` to return `{ song, kept, dropped }` and add `parseScoreUrl` in `shared/musescore-contract.mjs`, before any fetch.
