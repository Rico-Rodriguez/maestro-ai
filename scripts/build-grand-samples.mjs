// Rebuild the iOS grand from the CC-BY Salamander Grand Piano V3 ogg set.
// Usage: node scripts/build-grand-samples.mjs /path/to/ogg /path/to/hall.wav
// The committed m4a/wav files are what the app ships. This does not run in CI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'ios', 'audio', 'grand');
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LAYERS = [
  { id: 1, hivel: 28 },
  { id: 4, hivel: 46 },
  { id: 7, hivel: 64 },
  { id: 10, hivel: 84 },
  { id: 13, hivel: 104 },
  { id: 16, hivel: 127 },
];

function noteName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  return `${NAMES[midi % 12]}${octave}`;
}

function keepSeconds(midi) {
  if (midi <= 36) return 8;
  if (midi <= 48) return 6.5;
  if (midi <= 60) return 5;
  if (midi <= 72) return 3.8;
  if (midi <= 84) return 2.6;
  return 1.8;
}

function encode(src, dest, { seconds, bitrate }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fade = Math.min(0.045, seconds / 5);
  const start = Math.max(0, seconds - fade).toFixed(3);
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-i', src,
    '-t', String(seconds),
    '-ac', '1',
    '-ar', '48000',
    '-af', `afade=t=out:st=${start}:d=${fade.toFixed(3)}`,
    '-c:a', 'aac',
    '-b:a', bitrate,
    '-movflags', '+faststart',
    dest,
  ], { stdio: 'inherit' });
}

function runPool(jobs, width) {
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      job();
    }
  });
  return Promise.all(workers);
}

const oggDir = process.argv[2];
const hallSrc = process.argv[3];
if (!oggDir || !hallSrc) {
  console.error('usage: node scripts/build-grand-samples.mjs <ogg-dir> <hall.wav>');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const notes = [];
const releases = [];
const resonance = [];
const jobs = [];

for (let midi = 21; midi <= 108; midi += 3) {
  const name = noteName(midi);
  const files = [];
  LAYERS.forEach((layer, index) => {
    const src = path.join(oggDir, `${name}v${layer.id}.ogg`);
    if (!fs.existsSync(src)) throw new Error(`missing ${src}`);
    const file = `n/${midi}-v${index}.m4a`;
    files.push(file);
    jobs.push(() => encode(src, path.join(OUT, file), { seconds: keepSeconds(midi), bitrate: '96k' }));
  });
  notes.push({ midi, files });
  const harm = path.join(oggDir, `harmL${name}.ogg`);
  if (fs.existsSync(harm)) {
    const file = `h/${midi}.m4a`;
    resonance.push({ midi, file });
    jobs.push(() => encode(harm, path.join(OUT, file), { seconds: 2.4, bitrate: '64k' }));
  }
}

for (let midi = 21; midi <= 108; midi += 1) {
  const src = path.join(oggDir, `rel${midi - 20}.ogg`);
  if (!fs.existsSync(src)) throw new Error(`missing ${src}`);
  const file = `r/${midi}.m4a`;
  releases.push({ midi, file });
  jobs.push(() => encode(src, path.join(OUT, file), { seconds: 0.42, bitrate: '64k' }));
}

for (const [srcName, destName] of [['pedalD1.ogg', 'pedalD.m4a'], ['pedalU1.ogg', 'pedalU.m4a']]) {
  const src = path.join(oggDir, srcName);
  jobs.push(() => encode(src, path.join(OUT, destName), { seconds: srcName.startsWith('pedalD') ? 1.1 : 0.7, bitrate: '64k' }));
}

await runPool(jobs, 8);

execFileSync('ffmpeg', [
  '-y', '-v', 'error',
  '-i', hallSrc,
  '-t', '1.7',
  '-ac', '2',
  '-ar', '48000',
  '-af', 'highpass=f=80,afade=t=out:st=1.45:d=0.25,volume=0.45',
  '-c:a', 'pcm_s16le',
  path.join(OUT, 'hall.wav'),
], { stdio: 'inherit' });

const manifest = {
  credit: 'Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0',
  hallCredit: 'Helsinki Conservatory concert hall impulse (Konsa) by lehtoroni, CC0',
  baseUrl: 'audio/grand/',
  hall: 'hall.wav',
  pedalDown: 'pedalD.m4a',
  pedalUp: 'pedalU.m4a',
  layers: LAYERS.map((layer) => layer.hivel),
  notes,
  releases,
  resonance,
};

const body = `export default ${JSON.stringify(manifest)};\n`;
fs.writeFileSync(path.join(ROOT, 'src', 'grand-manifest.mjs'), body);
fs.writeFileSync(path.join(OUT, 'CREDITS.txt'), [
  'Piano samples: Salamander Grand Piano V3 by Alexander Holm.',
  'License: Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/).',
  'Recorded from a Yamaha C5 at 48 kHz. This build keeps six velocity layers,',
  'every minor third from A0 to C8, hammer-release samples, pedal noise,',
  'and sympathetic-resonance releases. Samples were converted to mono AAC',
  'and trimmed only at the end of the natural decay.',
  '',
  'Concert-hall impulse: Kajahdus "Konsa" HALL, recorded at the Helsinki',
  'Conservatory of Music by lehtoroni. License: CC0.',
  'https://github.com/lehtoroni/kajahdus',
  '',
].join('\n'));

let bytes = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else bytes += fs.statSync(full).size;
  }
};
walk(OUT);
const mb = bytes / 1024 / 1024;
console.log(`grand audio ${mb.toFixed(1)} MB, ${notes.length} notes, ${LAYERS.length} layers, ${releases.length} releases`);
if (mb > 60) {
  console.error('grand audio exceeds 60 MB');
  process.exit(1);
}
