# Phone MuseScore import

## Problem

On a phone, the person pastes a public musescore.com link into the repertoire card and expects that score in practice. The card already turns a local `.mid` into a song through `parseStandardMidiFile` in `src/maestro_ai_platform.tsx`, then `setSongs` and `handleSelectSong(id, 'practice')`. The phone browser cannot call MuseScore for that MIDI. Safari on any origin other than musescore.com is blocked, and GitHub Pages is one of those origins. `.github/workflows/deploy.yml` publishes `dist/` and runs `npm run build` with no server. A process on the computer can fetch the page, and the person opens it from the phone on the same Wi-Fi. The published build has to keep succeeding, and the paste box there has to say the helper is off. The card must not learn the token recipe. `parseStandardMidiFile` keeps `parsedNotes.slice(0, 96)`, so a real piano score would open as a broken practice song. A second paste of the same score has to match the existing library row on the score id. The helper sends no cookies, asks for no password, and does not write the score to disk.

## Usage (caller's view)

The repertoire card is the caller. It imports one factory from `src/phoneImport.ts`.

```tsx
import { museScorePhone } from './phoneImport';
```

The hook sits next to `importStatus`.

```tsx
const phone = useMemo(() => museScorePhone(), []);
const [musescoreLink, setMusescoreLink] = useState('');
```

Call site 1. The ingestion card, inside `renderRepertoireAndImport`. On Pages, `phone.kind` is `'off'` and this paragraph is the explanation. The input stays on the same card.

```tsx
{phone.kind === 'off' && (
  <p className="text-xs text-stone-500 dark:text-stone-400">{phone.message}</p>
)}
<input
  value={musescoreLink}
  onChange={(e) => setMusescoreLink(e.target.value)}
  placeholder="https://musescore.com/..."
/>
<button type="button" onClick={() => void handleMuseScoreLink()}>
  Import MuseScore link
</button>
```

Call site 2. `handleMuseScoreLink`, beside `handleFileUpload`. Success uses the same song builder and the same practice handoff as the `.mid` branch. The note count in the status line is the MIDI's note count, which depends on the parser change in the sketch.

```tsx
const handleMuseScoreLink = async () => {
  setImportStatus({ step: 1, label: 'Fetching the MuseScore MIDI...' });
  try {
    const result = await phone.importUrl(musescoreLink);
    if (result.kind === 'blocked') {
      setImportStatus({ step: 0, error: true, label: result.message });
      return;
    }
    const parsed = parseStandardMidiFile(result.bytes, result.title, result.libraryId);
    const song = {
      ...parsed,
      composer: 'MuseScore',
      sourceFormat: 'MuseScore MIDI',
      license: 'Public MuseScore score'
    };
    setSongs(prev => [song, ...prev.filter(s => s.id !== song.id)]);
    handleSelectSong(song.id, 'practice');
    setImportStatus({
      step: 4,
      success: true,
      label: `Imported "${song.title}" (${song.events.length} notes). Ready to play!`
    });
  } catch (err) {
    setImportStatus({
      step: 0,
      error: true,
      label: `Import failed: ${err.message}`
    });
  }
};
```

Call site 3. The same handler, when `songs` already contains that `libraryId`. Start with one row `musescore:12345` titled Prelude. Paste either public URL for that score again. `importUrl` returns the same `libraryId`. The filter drops the old row and the prepend writes one replacement. `handleSelectSong` opens practice. The library length stays the same.

The caller passes the pasted string and receives bytes, a title, and a library id. `result.bytes` is an `ArrayBuffer`, the same shape `file.arrayBuffer()` already gives `parseStandardMidiFile`.

## Shape

The score fetch is the `FetchState` union in `phone/scoreFetch.mjs`. Per model-the-domain, the two token attempts are variants of the `locate` state, and the module owns every state. A file per step would copy `ScorePage` and the host allowlist. The union has no DOM-sniff state, so the third attempt in the grounding cannot be added without a new variant. Per type-system-discipline, that variant is absent from this cut.

States are `page`, `script`, `locate`, `download`, `ready`, and `halt`. The fallback `locate` variant carries `sawHttpRejection` from the first attempt. The suffix is read in `script` and stored on `locate`. No later state reads the build script. This cut has no pages, so the machine does not return to `script`.

`runFetch(rawUrl)` is the only export. It parses the pasted URL at the start, per boundary-discipline, with `URL`, and allows only `musescore.com`, `www.musescore.com`, and `s.musescore.com` on `http` or `https`. HTML, the build script, the locate JSON, and the file bytes become `ScorePage`, `Suffix`, `FileUrl`, and MIDI bytes at that boundary. Later transitions trust those types. `ready` holds a `LibraryId` of `musescore:` plus the digits from `al:ios:url`. The card stores that string as `song.id` and does not parse it.

`followHops` is the only redirect walker. Page, script, and locate hops must stay on the host allowlist. The file hop must be `https`, must not be an IP literal or `localhost`, and stops after three hops. The locate request is the only caller that sets `Authorization`. The value is the first four hex characters of the hash, with no `Bearer` prefix. The file hop sets no `Authorization` and no `Cookie`. Each call keeps its own `FetchState`. Per foundational-thinking, concurrent pastes share no suffix and no MIDI. The process writes no score file. `node:fs` reads `dist/` only.

`src/phoneImport.ts` exports `museScorePhone`. That factory is the app entry. `importUrl` posts the pasted string to `phone-import` on the same origin and decodes JSON through `phone/wire.mjs`. Expected failures resolve `blocked`. The card learns `off` versus `helper` from a meta tag the helper injects into `index.html`. Pages serves the Vite file with no tag, and `importUrl` then resolves `blocked` without a request. Per laziness-protocol, the client has no second URL grammar and this cut adds no npm dependency. Node 20 runs the helper as plain `.mjs`.

Per minimize-reader-load, `server/phone.mjs` serves `dist/`, injects the meta tag, and calls `runFetch`. The token stays in `phone/scoreFetch.mjs`. `APP_BASE` lives in `phone/wire.mjs`, and `vite.config.ts` imports it, so `/maestro-ai/` is one constant. Per encode-lessons-in-structure, `phone/scoreFetch.mjs` imports `node:crypto`, so a client import fails `vite build`. `npm run build` also runs `phone/assertClientBundle.mjs`, which fails if any `dist/assets/*.js` file contains `/api/jmuse` or `9654,4e`.

The card's interface is the session object. It sees a kind, an off sentence, and `importUrl`. Behind that sit the host check, HTML extraction, the suffix, both attempts, the file download, base64, and the helper-off decision. A second method would only forward the same paste. The session kind stays visible because the paste box has to say the helper is off on Pages. `importUrl` has no note-limit argument. `parseStandardMidiFile` drops the 96-note slice and takes an optional `songId`. The file-upload call stays `parseStandardMidiFile(buf, file.name)`. This call passes `libraryId`. Per experience-first, the practice song is the whole MIDI. Per make-operations-idempotent, a repeat paste replaces the one row with that id, and a crashed fetch leaves no file that the next run could treat as a partial import.

## Synthesis decision

pending arena

## Tradeoffs accepted

- We accept a fresh build-script download on every paste, including a repeat of the same link, in exchange for the helper keeping no suffix and no MIDI after the response is sent.
- We accept that local `.mid` uploads also keep every note, in exchange for one parser. The existing difficulty label still calls a score Intermediate above 40 notes.
- We accept that a repeat paste replaces the row and resets in-memory practice position, in exchange for one row whose notes are the latest MIDI. Event ids stay `${libraryId}-ev-${index}` from `buildSongFromEvents`.
- We accept port 8787 on every interface, in exchange for a stable address the phone can open. A taken port exits the process.
- We accept that a score which answers only a disguised browser session ends `unavailable` or `upstream`, in exchange for a plain `fetch`.
- We accept that `npm run phone` rebuilds `dist/` first, in exchange for the phone and Pages running one bundle.

## Alternatives considered

A stage API on the client, `readPage`, `readSuffix`, and `downloadMidi`, with the helper as a proxy. The card would call three methods and would handle the suffix. That interface is wide and hides little of the protocol. One `importUrl` hides the sequence.

A single async function with a `retried` boolean and no `FetchState`. The card would see an equally small entry. It loses inside the helper. The next edit can set the boolean and still read the script, or add the DOM attempt beside it. The union makes that edit a new state, and this cut has no such state.

A Vite dev-server proxy under `npm run dev`, with the locate path named in `vite.config.ts`. The phone would depend on the dev server, Pages would need a second hosting story, and the client could call the proxied path. The production helper keeps that string in `phone/scoreFetch.mjs` only.

## Open questions and risks

- Should a LAN neighbor have to type a token that `npm run phone` prints before `runFetch` runs? The sketch binds `0.0.0.0` with no token.
- The grounding names `info.url` and does not name its host. The file hop allows public `https` names and refuses IP literals, `localhost`, and other schemes. Does a real file URL pass that check? Confirm with one public score before widening it. A public name that resolves to a private address is still open, because Node 20 `fetch` has no connect-time address filter in this sketch.
- A locate response that arrives but does not yield a file URL counts as an HTTP rejection, including a 200 whose body is the wrong shape. If both attempts end that way, or the second drops after the first was rejected, the card says the score needs a login. Should a dropped second attempt, or a 200 HTML body, say `upstream`?

## Next implementation step

Implement `advance` and `runFetch` in `phone/scoreFetch.mjs` from the transition table, with a fake `fetch` that proves a denied script attempt uses the literal suffix and does not request the build script again.
