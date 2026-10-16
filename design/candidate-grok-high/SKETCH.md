# Score link import

Pure policy is written out below. `useScorePaste`, `fetchScoreMidi`, and `startPhoneServer` throw `not implemented`. `parseStandardMidiFile` keeps its current parser. The only edit there is the return ledger.

## Usage

`App` in `src/maestro_ai_platform.tsx` imports one value. The card calls `paste`. The MIDI branch of `handleFileUpload` reads the ledger. `server/phone.mjs` calls `fetchScoreMidi`.

```tsx
import { useScorePaste } from './score-import';
```

Inside `App`, beside the `importStatus` state around line 1806:

```tsx
const [scoreLink, setScoreLink] = useState('');
const { job, canPaste, paste } = useScorePaste({
  parseMidi: parseStandardMidiFile,
  onSong: (song) => {
    setSongs((prev) => [song, ...prev]);
    handleSelectSong(song.id, 'practice');
  },
});
```

Inside `renderRepertoireAndImport`, under the file input. The button reads `canPaste`. The notice reads `job`.

```tsx
<form
  className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center"
  onSubmit={(event) => {
    event.preventDefault();
    paste(scoreLink);
  }}
>
  <input
    type="url"
    inputMode="url"
    autoCapitalize="none"
    autoCorrect="off"
    spellCheck={false}
    placeholder="https://musescore.com/user/scores/12345678"
    value={scoreLink}
    onChange={(event) => setScoreLink(event.target.value)}
    className="min-w-0 flex-1 rounded-xl border border-stone-300 bg-transparent px-3 py-2.5 text-sm dark:border-stone-700"
  />
  <button
    type="submit"
    disabled={!canPaste}
    className="rounded-xl bg-orange-700 px-4 py-2.5 text-xs font-bold text-white hover:bg-orange-600 disabled:opacity-50 sm:text-sm"
  >
    Open score link
  </button>
</form>
{job.phase === 'idle' && job.paste === 'helper-off' ? (
  <p className="mt-3 text-xs font-semibold text-stone-500">{job.reason}</p>
) : null}
{job.phase === 'fetching' ? (
  <p className="mt-3 text-xs font-semibold text-amber-700 dark:text-amber-300">Fetching the score.</p>
) : null}
{job.phase === 'imported' ? (
  <p className="mt-3 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
    Imported "{job.title}". Kept {job.kept} notes. Dropped {job.dropped}.
  </p>
) : null}
{job.phase === 'failed' ? (
  <p className="mt-3 text-xs font-semibold text-rose-600 dark:text-rose-300">{job.reason}</p>
) : null}
```

MIDI branch of `handleFileUpload`, replacing the current `parseStandardMidiFile` block:

```tsx
const parsed = parseStandardMidiFile(buf, file.name);
setSongs(prev => [parsed.song, ...prev]);
handleSelectSong(parsed.song.id, 'practice');
setImportStatus({
  step: 4,
  success: true,
  label: `Imported "${parsed.song.title}" (${parsed.kept} notes). Ready to play!`
});
```

`server/phone.mjs` after it has parsed a JSON body. The fetch discriminant is `result`. The probe body keeps `ok`.

```js
const result = await fetchScoreMidi(typeof body.url === 'string' ? body.url : '');
const payload =
  result.result === 'midi'
    ? { title: result.title, midiBase64: Buffer.from(result.midi).toString('base64') }
    : { reason: result.reason };
```

`importStatus` stays the file-upload banner. The paste notice is `job`.

## Module map

| File | Owns | Exports |
| --- | --- | --- |
| `src/score-import.ts` | The paste job, the helper probe, the helper JSON parse, the call into `parseMidi` | `useScorePaste`, type `ScoreImport`, type `ScorePaste`, type `MidiImport` |
| `src/maestro_ai_platform.tsx` | The link field, `songs`, `handleSelectSong`, `parseStandardMidiFile`, the file-upload banner | unchanged `App` |
| `server/musescore.mjs` | Page URL check, HTML reads, salt cache, MD5, `/api/jmuse`, the MIDI download | `fetchScoreMidi` |
| `server/phone.mjs` | `0.0.0.0` listen, `dist/` files, probe JSON, base64, the Vite base check | nothing |
| `package.json` | script `"phone": "node server/phone.mjs"` | |

`src/maestro_ai_platform.tsx` may import `useScorePaste` from `src/score-import.ts`. A second import from that file is a mistake. `src/` must not import `server/`. `server/musescore.mjs` imports `node:crypto`, so a browser bundle that reaches for the salt helper fails the build.

Adding `scoreLoading`, `scoreError`, or another paste status `useState` beside `job` is a mistake. The job already has a phase for that.

`npm run dev` and GitHub Pages serve the same client bundle. Both leave the helper off. `npm run phone` serves the existing `dist/`. If `dist/` is missing it exits 1 with `Run npm run build before npm run phone.`

## Job

`ScoreImport` is the score-fetch state. `reduceScoreImport` is the only writer. The song stays in `App`'s `songs` list. The job records the title and the note ledger after a parse, because those are what the notice prints.

```ts
export type ScoreImport =
  | { readonly phase: 'idle'; readonly paste: 'pending' | 'ready' }
  | { readonly phase: 'idle'; readonly paste: 'helper-off'; readonly reason: string }
  | { readonly phase: 'fetching' }
  | {
      readonly phase: 'imported';
      readonly title: string;
      readonly kept: number;
      readonly dropped: number;
    }
  | { readonly phase: 'failed'; readonly reason: string };

export type MidiImport<Song> = {
  readonly song: Song;
  readonly kept: number;
  readonly dropped: number;
};

export type ScorePaste = {
  readonly job: ScoreImport;
  readonly canPaste: boolean;
  readonly paste: (raw: string) => void;
};

type ScoreImportEvent =
  | { readonly type: 'probe-ready' }
  | { readonly type: 'probe-off'; readonly reason: string }
  | { readonly type: 'paste' }
  | { readonly type: 'imported'; readonly title: string; readonly kept: number; readonly dropped: number }
  | { readonly type: 'failed'; readonly reason: string };

function reduceScoreImport(job: ScoreImport, event: ScoreImportEvent): ScoreImport {
  switch (event.type) {
    case 'probe-ready':
      if (job.phase === 'idle' && job.paste === 'pending') {
        return { phase: 'idle', paste: 'ready' };
      }
      return job;
    case 'probe-off':
      if (job.phase === 'idle' && job.paste === 'pending') {
        return { phase: 'idle', paste: 'helper-off', reason: event.reason };
      }
      return job;
    case 'paste':
      if (job.phase === 'fetching') return job;
      if (job.phase === 'idle' && job.paste !== 'ready') return job;
      return { phase: 'fetching' };
    case 'imported':
      if (job.phase !== 'fetching') return job;
      return {
        phase: 'imported',
        title: event.title,
        kept: event.kept,
        dropped: event.dropped,
      };
    case 'failed':
      if (job.phase !== 'fetching') return job;
      return { phase: 'failed', reason: event.reason };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
```

`canPaste` is `reduceScoreImport(job, { type: 'paste' }).phase === 'fetching'`. The button reads `canPaste`.

Idle `pending` is the state before the probe settles. A paste in that state does not POST. Idle `helper-off` is how GitHub Pages and `npm run dev` render the control. `fetching` ignores a second paste, so two taps insert one song.

## Client

`useScorePaste` starts at `{ phase: 'idle', paste: 'pending' }`.

On mount it GETs the helper URL. `parseHelperBody` kind `ready` dispatches `probe-ready`. Every other kind dispatches `probe-off` with `HELPER_OFF_REASON`. A Pages 200 that returns `index.html` is kind `off`.

`paste` reads `onSong`, `parseMidi`, and the current job from refs. `App` passes a fresh lambda each render. The refs keep that lambda from restarting the probe. `paste` writes the next job into the job ref before the POST, so a second call in the same turn already sees `fetching`.

`paste` applies `reduceScoreImport` with `paste`. When the next phase is not `fetching`, it returns. Otherwise it stores that job and POSTs `{ url: raw }` to the helper URL. The server owns the score-page pattern. The client posts the raw string.

- A network failure dispatches `failed` with `HELPER_DROPPED`.
- Kind `rejected` dispatches `failed` with that `reason`.
- Kind `midi` calls `parseMidi(bytes, title)`. Then it calls `onSong(song)` and dispatches `imported` with `song.title`, `kept`, and `dropped`.
- A thrown parse dispatches `failed` with `Error.message`, or `MIDI_UNREADABLE` when the throw is not an `Error`.
- Kind `ready` or `off` on a POST dispatches `failed` with `HELPER_UNREADABLE`.

```ts
const HELPER_OFF_REASON =
  'Score links need the phone helper on your Wi-Fi. This copy of Maestro is static.';
const HELPER_DROPPED = 'The phone helper stopped responding.';
const HELPER_UNREADABLE = 'The phone helper sent an unreadable response.';
const MIDI_UNREADABLE = 'The MIDI file could not be read.';

function helperUrl(): string {
  const root = new URL(import.meta.env.BASE_URL, document.baseURI);
  return new URL('api/musescore', root).href;
}

type HelperBody =
  | { readonly kind: 'ready' }
  | { readonly kind: 'midi'; readonly title: string; readonly midi: Uint8Array }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'off' };

function parseHelperBody(raw: unknown): HelperBody {
  throw new Error('not implemented');
}

export function useScorePaste<Song>(handlers: {
  readonly onSong: (song: Song) => void;
  readonly parseMidi: (bytes: ArrayBuffer, filename: string) => MidiImport<Song>;
}): ScorePaste {
  throw new Error('not implemented');
}
```

`parseHelperBody` accepts `unknown`. The hook trusts `HelperBody` after that. Match in this order.

1. `title` and `midiBase64` are strings, and `midiBase64` decodes to one or more bytes. Kind `midi`.
2. `reason` is a string. Kind `rejected`.
3. `ok` is `true`. Kind `ready`.
4. Otherwise kind `off`.

The helper URL is `api/musescore` under `import.meta.env.BASE_URL`. Vite fills that from `base` in `vite.config.ts`. `server/phone.mjs` redirects `/maestro-ai` to `/maestro-ai/` so a typed LAN address opens the app.

## Parser ledger

`PRACTICE_NOTE_CAP` lives inside `parseStandardMidiFile`. `kept` and `dropped` come from the array that slice already uses, so the notice and the song share one cut.

```ts
const PRACTICE_NOTE_CAP = 96;

function parseStandardMidiFile(
  arrayBuffer: ArrayBuffer,
  filename = 'Imported Song.mid',
): MidiImport<ReturnType<typeof buildSongFromEvents>> {
  const keptNotes = parsedNotes.slice(0, PRACTICE_NOTE_CAP);
  const song = buildSongFromEvents({
    // existing fields, with rawNotes: keptNotes
  });
  return {
    song,
    kept: keptNotes.length,
    dropped: parsedNotes.length - keptNotes.length,
  };
}
```

The hook passes the server title as `filename`. The existing suffix strip still applies. The imported phase copies `song.title`, which is the title the library row shows.

MusicXML, PDF, image, and audio upload are unchanged.

## Score fetch

`fetchScoreMidi` returns MIDI bytes and a title, or a short `reason`. A Maestro song is built later, in the browser. The discriminant is `result`, because the probe body already uses `ok`. The function throws only when the helper itself is broken.

A salt, a score id, and a page URL are different brands. `as` appears only inside `mustSalt`, `mustScoreId`, and `parseScorePageUrl`, after the check that brands the string.

```ts
type Salt = string & { readonly __brand: 'Salt' };
type ScoreId = string & { readonly __brand: 'ScoreId' };
type ScorePageUrl = string & { readonly __brand: 'ScorePageUrl' };

export type ScoreMidi =
  | { readonly result: 'midi'; readonly title: string; readonly midi: Uint8Array }
  | { readonly result: 'rejected'; readonly reason: string };

const LINK_REASON = 'Paste a full MuseScore score link.';
const PAGE_REASON = 'That page did not include a score id and a title.';
const NO_MIDI_REASON =
  'MuseScore did not return MIDI. Private scores and scores that need a login do not import.';
const DOWNLOAD_REASON = 'The MIDI file did not download.';
const TIMEOUT_REASON = 'MuseScore did not respond.';

const SCORE_PAGE = /^https?:\/\/(?:(?:s|www)\.)?musescore\.com\/\S+$/;
const MIDI_TYPE = 'midi';
const MIDI_INDEX = '0';
const MIDI_BYTE_CAP = 8_000_000;

function mustSalt(value: string): Salt {
  if (!/^\S+$/.test(value)) throw new Error('empty salt');
  return value as Salt;
}

function mustScoreId(digits: string): ScoreId {
  if (!/^\d+$/.test(digits)) throw new Error('score id');
  return digits as ScoreId;
}

const FALLBACK_SALT = mustSalt('9654,4e');

function parseScorePageUrl(raw: unknown): ScorePageUrl | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!SCORE_PAGE.test(trimmed)) return null;
  return trimmed as ScorePageUrl;
}

function saltsForRequest(discovered: Salt | null): readonly Salt[] {
  if (discovered === null || discovered === FALLBACK_SALT) return [FALLBACK_SALT];
  return [discovered, FALLBACK_SALT];
}

function authToken(id: ScoreId, salt: Salt): string {
  // Type and index are fixed here. A parameter would let a caller ask for mp3.
  return createHash('md5').update(`${id}${MIDI_TYPE}${MIDI_INDEX}${salt}`).digest('hex').slice(0, 4);
}

let saltSlot: { scriptUrl: string; pending: Promise<Salt | null> } | null = null;

function loadSalt(scriptUrl: string): Promise<Salt | null> {
  if (saltSlot?.scriptUrl === scriptUrl) return saltSlot.pending;
  const pending = readSaltFromScript(scriptUrl).then(
    (found) => found,
    () => {
      if (saltSlot?.pending === pending) saltSlot = null;
      return null;
    },
  );
  saltSlot = { scriptUrl, pending };
  return pending;
}

function readSaltFromScript(scriptUrl: string): Promise<Salt | null> {
  throw new Error('not implemented');
}

function readScorePage(html: string): { id: ScoreId; title: string } | null {
  throw new Error('not implemented');
}

function readBuildScriptUrl(html: string): string | null {
  throw new Error('not implemented');
}

function readMidiUrl(body: unknown): string | null {
  throw new Error('not implemented');
}

export async function fetchScoreMidi(pageUrl: string): Promise<ScoreMidi> {
  throw new Error('not implemented');
}
```

`loadSalt` is the slot. `readSaltFromScript` returns a promise that rejects on failure, and `loadSalt` assigns the slot around that promise. A null discovery uses the fallback for that request only. The fallback salt stays out of the slot.

`fetchScoreMidi` does the following.

1. `parseScorePageUrl`. A miss returns `LINK_REASON`. A bare id misses.
2. GET the page with `redirect: 'manual'` and no cookies. One hop is allowed when `Location` still matches `SCORE_PAGE`. `readScorePage` reads `musescore://score/DIGITS` from `al:ios:url` and the title from `og:title`, in either attribute order, and brands the id with `mustScoreId`. It decodes `&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;` in the title. A null page returns `PAGE_REASON`.
3. `readBuildScriptUrl` finds the first `musescore.com/static/public/build/musescore` script that ends in `.js`. `loadSalt` on that URL. A missing script URL is a null discovery, and the request continues with the fallback salt.
4. Walk `saltsForRequest` in order. For each salt, GET `https://musescore.com/api/jmuse?id=&type=midi&index=0` with header `Authorization` set to `authToken`. The header value is those four hex characters alone. `readMidiUrl` takes the first JSON body whose `info.url` is an `https` string. The walk stops at two salts.
5. No winning URL returns `NO_MIDI_REASON`.
6. GET that MIDI URL once. A non-https URL, a non-OK status, or a body over `MIDI_BYTE_CAP` returns `DOWNLOAD_REASON`. A timeout returns `TIMEOUT_REASON`.
7. Return `{ result: 'midi', title, midi }`.

`readSaltFromScript` captures the full quoted string of the first `"...").substr(0, 4)` match, then brands it with `mustSalt`. MuseScore slices that literal later. The helper hashes the full captured string. Slicing it here would sign with the wrong salt. `readScorePage`, `readBuildScriptUrl`, and `readMidiUrl` are private. `fetchScoreMidi` is the export.

Outbound GETs use a 15 second timeout and user agent `Maestro phone helper`.

## Phone process

```js
const PHONE_PORT = 4173;
const PHONE_BASE = '/maestro-ai/';

function startPhoneServer() {
  throw new Error('not implemented');
}

startPhoneServer();
```

On startup, read `vite.config.ts` and require `base: '/maestro-ai/'` to match `PHONE_BASE`. Exit 1 on a mismatch. Bind `0.0.0.0` on `PHONE_PORT`. Log each IPv4 `http://<address>:4173/maestro-ai/`.

Routes under `PHONE_BASE`.

- `GET .../api/musescore` responds `{ "ok": true }` as JSON.
- `POST .../api/musescore` reads at most 2048 bytes, JSON-parses them, and calls `fetchScoreMidi`. `result: 'midi'` becomes status 200 and `{ "title", "midiBase64" }`. `result: 'rejected'` becomes status 200 and `{ "reason" }`. Status stays 200 so the client can tell a JSON refusal from a static host.
- Any other GET under the base maps into `dist/` after `path.normalize`. A path that escapes `dist/` gets 404. `/maestro-ai` redirects to `/maestro-ai/`.

No `Access-Control-Allow-Origin`. The page and the helper are the same origin. No new npm dependency. `node:http`, `node:fs`, and `node:crypto` are enough.
