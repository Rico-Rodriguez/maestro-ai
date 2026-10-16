# Synthesis

Base is candidate A. [Cross-judge](28d712ae-22d3-4a35-a46f-badbee33122c) returned no scores. Gemini hit the other-models limit. The pick is the parent reading of both sketches.

## Scores

Phone loop, illegal states, boundary, reader load, idempotence.

- A: 5, 5, 5, 4, 5
- B: 2, 4, 4, 3, 3

A prints the note cut under the practice song, which stays mounted after the import card unmounts. A detects the helper with a live probe, so one `dist/` works on GitHub Pages and on `npm run phone`. B prints the cut on the card that unmounts, and bakes helper-off into the Pages build.

## Grafts

None. B's gateway, build flag, and card-local reducer lose on the two criteria above. Both sketches already return MIDI bytes plus a title and leave song building to `parseStandardMidiFile`.

## Measured correction

On 2026-10-14, `GET https://musescore.com/user/9292486/scores/2086216` with `User-Agent: MaestroPhone/1` returned 200 and score id 2086216, with 7 build-script URLs. The Chrome 125 user agent returned 403 on that same run. The first script was a webpack vendor chunk with no `.substr(0, 4)` literal. `discoverSalt` must scan every candidate script. A later page fetch returned 403 for both user agents. A 403 is `unavailable`. Do not retry in a loop. A live `info.url` body was not observed, so the `MThd` check is still unverified against MuseScore.
