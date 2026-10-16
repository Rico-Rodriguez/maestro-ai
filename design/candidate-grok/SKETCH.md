# Phone import sketch

Names match the call sites in `RATIONALE.md`. Function bodies are `not implemented`. Tables and constants are the contract those bodies implement. Node 20 runs `phone/*.mjs` and `server/*.mjs` as plain JavaScript, so those files do not use `export type`. The parse functions are the brands. The only cast is the return inside a parse function after its check has succeeded.

Node 20 standard library only. `node:http`, `node:crypto`, `node:fs`, `node:path`, `node:os`. `node:fs` reads `dist/` and does not write the score.

## Module map

`src/phoneImport.ts` is the only module the React app imports. It owns the session kind, the helper-off sentence, the silent-helper sentence, and the same-origin post.

`phone/wire.mjs` owns `APP_BASE`, the meta tag name, `REFUSAL_MESSAGES`, and the JSON codec. The token recipe stays in `phone/scoreFetch.mjs`. `vite.config.ts` imports `APP_BASE` from here and sets `base` to that constant.

`phone/scoreFetch.mjs` owns `FetchState`, the host allowlist, the suffix, the hash, and `runFetch`. It imports `node:crypto`. The client graph cannot include it.

`server/phone.mjs` owns the listen socket, `dist/` reads, meta injection, and the POST route. It calls `runFetch` with one argument.

`phone/assertClientBundle.mjs` owns the published-bundle check.

`src/maestro_ai_platform.tsx` gains the three call sites and the `songId` argument on `parseStandardMidiFile`. `package.json` gains the scripts below. No other app file changes.

```json
"build": "vite build && node phone/assertClientBundle.mjs",
"phone": "npm run build && node server/phone.mjs"
```

## Public session

Derived from the handler in `RATIONALE.md`. That handler is the only caller. It passes `result.bytes`, `result.title`, and `result.libraryId` to `parseStandardMidiFile`. `off` carries a synchronous sentence because the paste box renders it before a paste. `importUrl` is on both variants so that handler has one shape. On `off`, `importUrl` ignores the string and resolves `blocked` with `HELPER_OFF_MESSAGE`, and it does not post.

```ts
import { REFUSAL_MESSAGES, readLibraryId } from "../phone/wire.mjs";

type LibraryId = NonNullable<ReturnType<typeof readLibraryId>>;

export type MuseScoreImport =
  | {
      readonly kind: "imported";
      readonly libraryId: LibraryId;
      readonly title: string;
      readonly bytes: ArrayBuffer;
    }
  | { readonly kind: "blocked"; readonly message: string };

export type MuseScorePhone =
  | {
      readonly kind: "off";
      readonly message: string;
      importUrl(pageUrl: string): Promise<{ readonly kind: "blocked"; readonly message: string }>;
    }
  | {
      readonly kind: "helper";
      importUrl(pageUrl: string): Promise<MuseScoreImport>;
    };

export function museScorePhone(): MuseScorePhone {
  throw new Error("not implemented");
}
```

`museScorePhone` reads `document` for a meta tag whose name is `PHONE_HELPER_META` and whose content is `PHONE_HELPER_META_CONTENT`. Any other document is `off`.

`importUrl` on `helper` posts `encodePhoneRequest(pageUrl)` to `` `${import.meta.env.BASE_URL}${PHONE_IMPORT_PATH}` `` with `Content-Type: application/json`. A throw, a non-JSON body, or a decode of `null` resolves `blocked` with `HELPER_SILENT_MESSAGE`. A decoded refusal resolves `blocked` with `REFUSAL_MESSAGES[reason]`. A decoded MIDI passes `libraryId` through `readLibraryId` and copies the bytes into a fresh `ArrayBuffer`. `parseStandardMidiFile` wraps the whole buffer it is given, including one a `Uint8Array` view might share. `readLibraryId` is the only digit check. `LibraryId` here is its non-null return.

```ts
export const HELPER_OFF_MESSAGE =
  "The phone helper is off. On your computer run npm run phone, then open the address it prints.";

export const HELPER_SILENT_MESSAGE =
  "The phone helper didn't answer. Keep the npm run phone window open and use the address it printed.";
```

The `off` message and the `blocked` message for a missing meta tag are `HELPER_OFF_MESSAGE`. One string. Score refusals use `REFUSAL_MESSAGES` from `phone/wire.mjs`. Vite does not typecheck, so that object is the runtime list. `encodePhoneResponse` and `decodePhoneResponse` accept a reason only when it is a key of that object.

## Wire

```ts
export const APP_BASE = "/maestro-ai/";
export const PHONE_IMPORT_PATH = "phone-import";
export const PHONE_HELPER_META = "maestro-phone-helper";
export const PHONE_HELPER_META_CONTENT = "on";

declare const libraryIdBrand: unique symbol;
export type LibraryId = string & { readonly [libraryIdBrand]: "LibraryId" };

export const REFUSAL_MESSAGES = {
  "not-musescore": "Paste a public musescore.com link.",
  unavailable:
    "That score isn't available. Private scores and MuseScore Pro scores need a login, which this import doesn't do.",
  "not-midi": "MuseScore didn't return a MIDI file for that link.",
  upstream:
    "The helper couldn't fetch that score. Try again. If it keeps failing, MuseScore may have changed the public page.",
} as const;
export type RefusalReason = keyof typeof REFUSAL_MESSAGES;

export const MIDI_WIRE_FIELDS = ["libraryId", "title", "midiBase64"] as const;

export type PhoneResponse =
  | ({ readonly kind: "midi" } & { readonly [K in (typeof MIDI_WIRE_FIELDS)[number]]: string })
  | { readonly kind: "refused"; readonly reason: RefusalReason };

export function readLibraryId(value: unknown): LibraryId | null {
  throw new Error("not implemented");
}

export function encodePhoneRequest(pageUrl: string): string {
  throw new Error("not implemented");
}

export function decodePhoneRequest(raw: string): string | null {
  throw new Error("not implemented");
}

export function encodePhoneResponse(result: {
  kind: "midi";
  libraryId: string;
  title: string;
  bytes: Uint8Array;
} | {
  kind: "refused";
  reason: RefusalReason;
}): string {
  throw new Error("not implemented");
}

export function decodePhoneResponse(raw: unknown): PhoneResponse | null {
  throw new Error("not implemented");
}

export function encodeMidiBase64(bytes: Uint8Array): string {
  throw new Error("not implemented");
}

export function decodeMidiBase64(value: string): Uint8Array | null {
  throw new Error("not implemented");
}
```

`readLibraryId` accepts only `musescore:` plus one or more digits. `decodePhoneRequest` accepts only a JSON object whose `url` field is a string, and returns that string. For `kind: "midi"`, `decodePhoneResponse` requires every name in `MIDI_WIRE_FIELDS` to be a string, then checks `libraryId` with `readLibraryId`. `encodePhoneResponse` writes exactly those names. `encodeMidiBase64` and `decodeMidiBase64` use `btoa` and `atob`, which Node 20 and the browser both provide. The codec imports no Node built-in.

## Score fetch

Private to `phone/scoreFetch.mjs` except `runFetch`.

```ts
declare const scoreIdBrand: unique symbol;
declare const suffixBrand: unique symbol;
declare const pageUrlBrand: unique symbol;
declare const scriptUrlBrand: unique symbol;
declare const fileUrlBrand: unique symbol;

type ScoreId = string & { readonly [scoreIdBrand]: "ScoreId" };
type Suffix = string & { readonly [suffixBrand]: "Suffix" };
type MuseScoreUrl = string & { readonly [pageUrlBrand]: "MuseScoreUrl" };
type ScriptUrl = string & { readonly [scriptUrlBrand]: "ScriptUrl" };
type FileUrl = string & { readonly [fileUrlBrand]: "FileUrl" };

type ScorePage = {
  readonly scoreId: ScoreId;
  readonly title: string;
  readonly scriptUrl: ScriptUrl;
};

type ScoreMidi = {
  readonly libraryId: LibraryId;
  readonly title: string;
  readonly bytes: Uint8Array;
};

type Attempt =
  | { readonly kind: "script" }
  | { readonly kind: "fallback"; readonly sawHttpRejection: boolean };

type FetchState =
  | { readonly kind: "page"; readonly url: MuseScoreUrl }
  | { readonly kind: "script"; readonly page: ScorePage }
  | { readonly kind: "locate"; readonly page: ScorePage; readonly suffix: Suffix; readonly attempt: Attempt }
  | { readonly kind: "download"; readonly page: ScorePage; readonly fileUrl: FileUrl }
  | { readonly kind: "ready"; readonly midi: ScoreMidi }
  | { readonly kind: "halt"; readonly reason: RefusalReason };

type OpenState = Exclude<FetchState, { kind: "ready" } | { kind: "halt" }>;

type Observation =
  | { readonly kind: "silent" }
  | { readonly kind: "http"; readonly status: number; readonly text: string }
  | { readonly kind: "bytes"; readonly status: number; readonly body: Uint8Array };

const MUSESCORE_HOSTS = ["musescore.com", "www.musescore.com", "s.musescore.com"] as const;
const FALLBACK_SUFFIX = "9654,4e";
const LOCATE_ORIGIN = "https://musescore.com/api/jmuse";
const SUFFIX_IN_SCRIPT = /"([^"]+)"\)\.substr\(0, 4\)/;
const HOP_LIMIT = 3;
const REQUEST_MS = 15_000;

export async function runFetch(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { readonly kind: "midi"; readonly midi: ScoreMidi }
  | { readonly kind: "refused"; readonly reason: RefusalReason }
> {
  throw new Error("not implemented");
}
```

`server/phone.mjs` calls `runFetch(url)`. The second argument is the test seam. `runFetch` starts at `openFetch`. While the state is an `OpenState`, it `observe`s once and `advance`s once. `ready` returns the MIDI. `halt` returns `refused`.

`openFetch` uses `URL`. The protocol is `http:` or `https:`. The hostname is one of `MUSESCORE_HOSTS`. Anything else is `halt` / `not-musescore`. A matching URL is `page`.

`advance` implements this table. The first matching row wins. Any other pair is `halt` `upstream`.

| State | Observation | Next |
| --- | --- | --- |
| `page` | `silent`, or `http` outside 200..299 | `halt` `upstream` |
| `page` | `http` 200..299, and `readScorePage` returns a page | `script` |
| `page` | `http` 200..299, and the score id is missing | `halt` `unavailable` |
| `page` | `http` 200..299, and the id is present but the build-script URL is missing | `halt` `upstream` |
| `script` | `silent`, `http` outside 200..299, or a 200..299 body with no suffix | `halt` `upstream` |
| `script` | `http` 200..299, and `readSuffixFromScript` returns a suffix | `locate` with attempt `script` and that suffix |
| `locate` `script` | `http` 200..299, and `readFileUrl` returns a `FileUrl` | `download` |
| `locate` `script` | `http` outside 200..299, or 200..299 with no `FileUrl` | `locate` `fallback` with `sawHttpRejection` true and `readSuffix(FALLBACK_SUFFIX)` |
| `locate` `script` | `silent` | `locate` `fallback` with `sawHttpRejection` false and the same literal suffix |
| `locate` `fallback` | `http` 200..299, and `readFileUrl` returns a `FileUrl` | `download` |
| `locate` `fallback` | `http` with no `FileUrl` | `halt` `unavailable` |
| `locate` `fallback` | `silent`, and `sawHttpRejection` is true | `halt` `unavailable` |
| `locate` `fallback` | `silent`, and `sawHttpRejection` is false | `halt` `upstream` |
| `download` | `silent`, or `bytes` outside 200..299 | `halt` `upstream` |
| `download` | `bytes` 200, first four bytes are `MThd` | `ready` |
| `download` | `bytes` 200, and the bytes are not `MThd` | `halt` `not-midi` |

The fallback row does not have a `script` state as its next. The build script is fetched only on the `script` state.

```ts
function advance(state: OpenState, observation: Observation): FetchState {
  throw new Error("not implemented");
}

function observe(state: OpenState, fetchImpl: typeof fetch): Promise<Observation> {
  throw new Error("not implemented");
}
```

`observe` requests by state.

| State | Request |
| --- | --- |
| `page` | `getMusescoreText(state.url)` |
| `script` | `getMusescoreText(state.page.scriptUrl)` |
| `locate` | `getLocateText(state.page, state.suffix)` |
| `download` | `getFileBytes(state.fileUrl)` |

```ts
function readScorePage(html: string, pageUrl: MuseScoreUrl):
  | { readonly kind: "score"; readonly page: ScorePage }
  | { readonly kind: "no-score" }
  | { readonly kind: "no-script" } {
  throw new Error("not implemented");
}

function readSuffixFromScript(source: string): Suffix | null {
  throw new Error("not implemented");
}

function readSuffix(value: string): Suffix | null {
  throw new Error("not implemented");
}

function readFileUrl(text: string): FileUrl | null {
  throw new Error("not implemented");
}

function locateUrl(scoreId: ScoreId): URL {
  throw new Error("not implemented");
}

function authorizationValue(scoreId: ScoreId, suffix: Suffix): string {
  throw new Error("not implemented");
}

function openFetch(rawUrl: string): FetchState {
  throw new Error("not implemented");
}

function getMusescoreText(
  url: MuseScoreUrl | ScriptUrl,
  fetchImpl: typeof fetch,
): Promise<Observation> {
  throw new Error("not implemented");
}

function getLocateText(
  page: ScorePage,
  suffix: Suffix,
  fetchImpl: typeof fetch,
): Promise<Observation> {
  throw new Error("not implemented");
}

function getFileBytes(url: FileUrl, fetchImpl: typeof fetch): Promise<Observation> {
  throw new Error("not implemented");
}

function allowMusescoreHost(next: URL): boolean {
  throw new Error("not implemented");
}

function allowPublicHttps(next: URL): boolean {
  throw new Error("not implemented");
}

function libraryIdFromScore(scoreId: ScoreId): LibraryId {
  throw new Error("not implemented");
}

function followHops(
  url: string,
  allowHop: (next: URL) => boolean,
  authorization: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ readonly kind: "silent" } | { readonly kind: "response"; readonly status: number; readonly body: Uint8Array }> {
  throw new Error("not implemented");
}
```

`readScorePage` finds `og:title` and `al:ios:url` without assuming attribute order. The score content matches `musescore://score/` plus digits. A missing title becomes `MuseScore ` plus those digits, so `ScorePage.title` is a non-empty string. The build-script URL may be relative to `pageUrl`. It then has an allowlisted host, a path containing `/static/public/build/musescore` and `/20`, and a `.js` ending. `readSuffixFromScript` takes the first `SUFFIX_IN_SCRIPT` capture and passes it through `readSuffix`. `readSuffix` rejects the empty string and any whitespace.

`locateUrl` uses `LOCATE_ORIGIN` and sets `id` to the score id, `type` to `midi`, and `index` to `0`. `authorizationValue` is `md5(scoreId + "midi" + "0" + suffix).slice(0, 4)` from `node:crypto`. Four hex characters. No `Bearer` prefix. `getLocateText` is the only caller of `locateUrl` and `authorizationValue`.

`readFileUrl` parses JSON `{ info: { url } }`. `allowPublicHttps` accepts `https:` when the hostname is not `localhost`, not an IPv4 address, and contains no `:`. `allowMusescoreHost` accepts `http:` or `https:` when the hostname is in `MUSESCORE_HOSTS`. `followHops` allows at most `HOP_LIMIT` redirects, rechecks every `Location` with `allowHop`, and sets `AbortSignal.timeout(REQUEST_MS)`. When `authorization` is a string, the only header it sets is `Authorization`. It adds no `Cookie` header. A refused hop or a timeout is `silent`. `getMusescoreText` calls it with `allowMusescoreHost` and `undefined`. `getLocateText` calls it with `allowMusescoreHost` and `authorizationValue`. `getFileBytes` calls it with `allowPublicHttps` and `undefined`. Those three are the only callers. They decode a text body into an `http` observation, or they keep a file body as `bytes`.

`libraryIdFromScore` builds `musescore:` plus the score id and returns only what `readLibraryId` accepts.

## Helper process

```ts
export function startPhoneServer(): import("node:http").Server {
  throw new Error("not implemented");
}
```

```ts
const PORT = 8787;
```

`startPhoneServer` listens on `0.0.0.0` and `PORT`. If the port is taken, the process exits. On listen it prints `http://<lan-address>:${PORT}${APP_BASE}` for each IPv4 LAN address. It sets no CORS headers.

`GET` and `HEAD` under `APP_BASE` read `dist/`. The resolved path must stay inside `dist/`. `APP_BASE` and `APP_BASE + "index.html"` get the meta tag inserted before `</head>`. The response is the injected HTML. The file on disk stays unchanged. Other extensions are served as themselves. Unknown extensions use `application/octet-stream`.

`POST` `APP_BASE + PHONE_IMPORT_PATH` reads at most 8 KB, `decodePhoneRequest`, and `runFetch`. `encodePhoneResponse` is the body, with status 200 and `Content-Type: application/json`, for both MIDI and refusal. A body that does not decode is a JSON refusal `not-musescore`. The route does not write a temp file.

When this file is the process entry, it calls `startPhoneServer`.

## Parser change

```js
function parseStandardMidiFile(arrayBuffer, filename = "Imported Song.mid", songId = `midi-${Date.now()}`) {
  throw new Error("not implemented");
}
```

Keep the current parser in `src/maestro_ai_platform.tsx`. Delete `parsedNotes.slice(0, 96)`. Pass `parsedNotes` as `rawNotes`. Use `parsedNotes.length` in the difficulty check. Pass `songId` as `id` into `buildSongFromEvents`. The file-upload call stays `parseStandardMidiFile(buf, file.name)`.

## Bundle check

```js
export function assertClientBundle(distAssetsDir) {
  throw new Error("not implemented");
}
```

Read every `*.js` file under `dist/assets`. Exit 1 when the directory has no such file, or when any file contains `/api/jmuse` or `9654,4e`. `npm run build` runs this after `vite build`.
