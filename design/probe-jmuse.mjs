import { createHash } from 'node:crypto';

const pageUrl = process.argv[2];
if (!pageUrl) {
  console.error('usage: node design/probe-jmuse.mjs <musescore-url>');
  process.exit(2);
}

const headers = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US;q=0.8',
};

async function text(url, extra) {
  const response = await fetch(url, { headers: { ...headers, ...extra }, redirect: 'follow' });
  return { status: response.status, body: await response.text(), finalUrl: response.url };
}

const page = await text(pageUrl);
const id = page.body.match(/musescore:\/\/score\/(\d+)/)?.[1] ?? '';
const title = page.body.match(/property="og:title" content="([^"]*)"/)?.[1]
  ?? page.body.match(/content="([^"]*)" property="og:title"/)?.[1]
  ?? '';
const scripts = [...page.body.matchAll(/https:\/\/musescore\.com\/static\/public\/build\/musescore.*?\/20[^"' ]+\.js/g)].map((m) => m[0]);
let suffix = null;
let suffixScript = '';
for (const scriptUrl of scripts) {
  const script = await text(scriptUrl);
  const found = script.body.match(/"([^"]+)"\)\.substr\(0,\s*4\)/);
  if (found) {
    suffix = found[1];
    suffixScript = scriptUrl;
    break;
  }
}

function token(salt) {
  return createHash('md5').update(`${id}midi0${salt}`).digest('hex').slice(0, 4);
}

async function locate(salt) {
  const url = `https://musescore.com/api/jmuse?id=${id}&type=midi&index=0`;
  const response = await fetch(url, { headers: { ...headers, Authorization: token(salt) } });
  const raw = await response.text();
  let infoUrl = '';
  try {
    infoUrl = JSON.parse(raw)?.info?.url ?? '';
  } catch {
    infoUrl = '';
  }
  return { status: response.status, infoUrl, sample: raw.slice(0, 180) };
}

const first = suffix === null ? null : await locate(suffix);
const second = !first || first.status < 200 || first.status >= 300 || !first.infoUrl
  ? await locate('9654,4e')
  : null;
const winner = first?.infoUrl ? first : second?.infoUrl ? second : null;
let midi = null;
if (winner?.infoUrl) {
  const response = await fetch(winner.infoUrl, { headers });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  midi = { status: response.status, bytes: bytes.length, magic, host: new URL(winner.infoUrl).host };
}

console.log(JSON.stringify({
  pageStatus: page.status,
  finalUrl: page.finalUrl,
  id,
  title,
  scriptCount: scripts.length,
  suffixFound: suffix !== null,
  suffixLength: suffix === null ? 0 : suffix.length,
  suffixScript: suffixScript ? new URL(suffixScript).pathname : '',
  first: first && { status: first.status, hasUrl: Boolean(first.infoUrl), sample: first.infoUrl ? '' : first.sample },
  second: second && { status: second.status, hasUrl: Boolean(second.infoUrl), sample: second.infoUrl ? '' : second.sample },
  midi,
}, null, 2));
