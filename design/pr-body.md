## Why

On a phone, Maestro can already turn a MIDI file into a practice song, but Safari cannot ask MuseScore for that file. The official iPhone path injects a userscript into the score page and then fakes a download click. This adds a paste field on the import card and a small helper on your PC that fetches the MIDI.

## What changed

- The Library and Import card takes a MuseScore link and opens the score in practice.
- `npm run phone` serves the built app and `POST /maestro-ai/api/musescore`.
- Practice shows how many notes were kept and how many were dropped after the 96-note cut.

## Scope

- MIDI only. MusicXML, PDF, and MP3 from a link are out.
- A private score, or a score that needs a MuseScore login, fails with a short message. The helper stores no login.
- The published GitHub Pages site shows that paste is off. The field appears when you open Maestro from the phone helper.

## Tradeoffs

- One build works on Pages and on the helper. The page probes the helper instead of baking the off state into the Pages build.
- The note count sits on the practice screen. The import card unmounts as soon as the song opens.

## Blast Radius

File upload of a `.mid` still opens practice. Its banner still prints the kept note count. The parser now returns the kept and dropped counts alongside the song.

## Verification

- `npm test` passed 17 of 17.
- In the browser at the phone helper, the MuseScore field is on the import card. Submitting `nope` shows the sentence that a bare id is not a score link.
- A live MIDI download from MuseScore was not observed. The helper still requires an https file that starts with the MIDI header.
