# Grounding

Paste a MuseScore score link on Maestro's import card. The phone receives a MIDI file and the existing `parseStandardMidiFile` path opens it in practice.

## What the phone cannot do

Safari on any origin other than musescore.com cannot call `/api/jmuse`. The official iPhone path injects a userscript into the score page through an iCloud Shortcut, then saves with a synthetic click. That click is unreliable on iOS. Do not port the userscript, the iframe token sniffer, the webpack hook, or WebMscore.

## What a local Node helper can do

1. GET the score page. Read the score id from `meta[property="al:ios:url"]` (`musescore://score/DIGITS`). Read the title from `og:title`.
2. Find a build script URL matching `musescore.com/static/public/build/musescore…/20….js`. The salt is the full string inside the first `"…").substr(0, 4)` literal. Cache that salt for the process.
3. `Authorization` is `md5(id + type + index + salt).slice(0, 4)`, no Bearer prefix. Type for this feature is `midi`, index is `0`. If that response is not OK, retry with the salt `9654,4e`.
4. `GET https://musescore.com/api/jmuse?id=&type=midi&index=0` returns `{ info: { url } }`. GET that URL and return the bytes.
5. There is no third attempt. The browser-only player click does not exist on the server.

Accepted page URLs match `^https?://(?:(?:s|www)\.)?musescore\.com/\S+$`. A bare id is rejected.

## What this feature does not do

MusicXML, MSCZ, and MP3 are out. A URL does not yield MusicXML. PDF is a stitched image export and Maestro's PDF upload does not parse notes. Official or private scores that need a logged-in session fail closed with a plain error. No cookies are stored.

## Maestro facts the sketch must honor

- Repo `c:\Users\rico2\Downloads\maestro-ai`. React 18, Vite, Tailwind. One component file `src/maestro_ai_platform.tsx`.
- Real ingest is `parseStandardMidiFile(arrayBuffer, filename)` around line 1151. It returns a song and the UI calls `setSongs` and `handleSelectSong(id, 'practice')`.
- That parser keeps only the first 96 notes (`parsedNotes.slice(0, 96)`). The paste path must not hide that cut. Say how many notes were kept.
- PDF, image, and audio upload is a timed fake. Do not extend it.
- GitHub Pages (`.github/workflows/deploy.yml`) serves `dist/` only. The paste control on that origin shows that the helper is off.
- `npm run phone` serves the built app and `POST /api/musescore` on `0.0.0.0` so an iPhone on the same Wi-Fi can open it.

## Domain shape already chosen

One job. Idle, fetching, imported, or failed. The imported state carries the song title, the note count kept, and the note count dropped. The failed state carries a short reason. No parallel booleans.

The server returns MIDI bytes plus the title. It does not return a Maestro song. The browser parser stays the only song builder.
