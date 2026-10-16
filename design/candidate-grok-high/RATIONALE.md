# Score link import

## Problem

Pasting a MuseScore link on Maestro's import card should open a practice song through the existing `parseStandardMidiFile` path in `src/maestro_ai_platform.tsx`. Safari on any origin other than musescore.com cannot call `/api/jmuse`, the iOS shortcut click is unreliable, and GitHub Pages publishes only `dist/`. The parser keeps the first 96 notes and today returns a song, so the dropped count disappears. File upload already stores progress in `importStatus`, a combination of `step`, `success`, `error`, and `label`. A link import needs a title, a kept count, and a dropped count, in one state separate from that file banner.

## Usage (caller's view)

The repertoire card gains a link field. `App` imports `useScorePaste` from `src/score-import.ts` and nothing else from that module.

Inside `App`, beside the `importStatus` state:

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

The MIDI branch of `handleFileUpload` takes the ledger and still inserts `parsed.song`:

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

`server/phone.mjs` is the other caller. The fetch discriminant is `result`. The probe body keeps `ok`.

```js
const result = await fetchScoreMidi(typeof body.url === 'string' ? body.url : '');
const payload =
  result.result === 'midi'
    ? { title: result.title, midiBase64: Buffer.from(result.midi).toString('base64') }
    : { reason: result.reason };
```

## Shape

The organizing structure is `ScoreImport`, per principle-model-the-domain. Phases are `idle`, `fetching`, `imported`, and `failed`. `reduceScoreImport` is the only writer. Idle carries `paste` of `pending`, `ready`, or `helper-off`, and `helper-off` carries `reason`. Imported carries `title`, `kept`, and `dropped`. Failed carries `reason`. Fetching has no reason field. Ready idle has no reason field. `onSong` inserts the song into the `songs` state `App` already owns.

`useScorePaste` is the client function `App` calls. It probes `api/musescore` under `import.meta.env.BASE_URL`, posts the raw paste, decodes helper JSON, and calls the injected `parseStandardMidiFile`. MD5, the process salt slot, the fallback `9654,4e`, and `https://musescore.com/api/jmuse` stay in `server/musescore.mjs`, which exports `fetchScoreMidi`. That function returns `{ result: 'midi', title, midi }` or `{ result: 'rejected', reason }`. `server/phone.mjs` exports nothing. It serves `dist/`, answers the probe with `{ ok: true }`, and base64-encodes the MIDI on the way out. The protocol sits outside the platform file, per principle-minimize-reader-load.

Salt retries are the list from `saltsForRequest`, one salt or two. The salt slot stores a discovered salt. The fallback applies to the current request. `authToken` closes over type `midi` and index `0`. The score-page regex, the HTML meta tags, the jmuse JSON, and the helper JSON are parsed at those boundaries, per principle-boundary-discipline. Brands keep a salt, a score id, and a page URL distinct, per principle-type-system-discipline. The reducer takes events that are already typed.

`parseStandardMidiFile` returns `{ song, kept, dropped }`. The 96-note cap stays in that function as `PRACTICE_NOTE_CAP`. The imported phase copies `song.title`, `kept`, and `dropped` from that return. The union and the ledger are settled before any fetch, and concurrent posts share the salt slot's string, per principle-foundational-thinking.

`App` sees `job`, `canPaste`, and `paste`. `canPaste` asks the reducer whether `paste` would enter `fetching`. The button reads that flag. The `parseMidi` argument lets the hook run the real parser without importing the platform module back. Behind `fetchScoreMidi` sit the page scrape, the salt slot, the single retry, and the MIDI download. Callers of that function get a title and bytes, or one sentence. The card states how many notes were kept and how many were dropped, and a static host shows the helper-off reason on that same control, per principle-experience-first. The phone process uses `node:http` and `node:crypto`, and the browser parser remains the only song builder, per principle-laziness-protocol.

`paste` stores the next job in a ref before the POST, so a second call in the same turn sees `fetching` and returns. A failed salt read clears the slot. That is principle-make-operations-idempotent. Startup compares `PHONE_BASE` with `base` in `vite.config.ts`, and the `node:crypto` import keeps the server module out of the browser bundle, per principle-encode-lessons-in-structure.

## Synthesis decision

pending arena

## Tradeoffs accepted

- We accept a second status block on the import card in exchange for leaving the file-upload `importStatus` bag unchanged.
- We accept passing `parseStandardMidiFile` into the hook in exchange for leaving `buildSongFromEvents` in `src/maestro_ai_platform.tsx`.
- We accept an `.mjs` phone process, plus a startup string check against `vite.config.ts`, in exchange for Node 20 with no type stripper and no new dependency.
- We accept a second library row when the same link is pasted again in exchange for keeping the parser's `Date.now()` song id.
- We accept one refusal sentence for a private score, a score that needs a login, and a bad salt in exchange for a client whose failure data is `reason`.
- We accept the wire keys `title`, `midiBase64`, and `reason` living in both `server/phone.mjs` and `parseHelperBody` in exchange for a Node phone process and a Vite client that stay on their own loaders.

## Alternatives considered

**Exported fetch steps.** Public `readScorePage`, `signJmuse`, and `downloadMidi` would let `phone.mjs` sequence the protocol. Each caller would see the salt, the MD5 token, and `/api/jmuse`, and the score id would be passed between them. `fetchScoreMidi` keeps that sequence in one module. The shell only adds HTTP, files, and base64.

**Paste fields on `importStatus`.** The card would keep a single banner by extending `{ step, success, error, label }`. `success` and `error` can both be true, and the kept and dropped counts would become more optional fields or hide inside `label`. `ScoreImport` makes those combinations unwritable. The file banner stays for the upload path that already uses it.

**A song document from the helper.** The server would parse MIDI and return Maestro events. The phone would skip `parseStandardMidiFile`, so the 96-note cap and `buildSongFromEvents` would have a second implementation. The helper returns bytes and the og:title. The browser parser stays the only song builder.

## Open questions and risks

- Should the file-upload success line also include `dropped`, now that `parseStandardMidiFile` returns it?
- MuseScore's `info.url` can name any host. Should the MIDI GET refuse non-public addresses?
- The spec's only retry salt is `9654,4e`. When MuseScore retires that literal, do imports fail closed until the fallback is updated?

## Next implementation step

Change `parseStandardMidiFile` so it returns `{ song, kept, dropped }`, and point the MIDI branch of `handleFileUpload` at `parsed.song`.
