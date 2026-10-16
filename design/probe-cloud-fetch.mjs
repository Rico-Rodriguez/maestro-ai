import { midiAuthorization } from '../server/chrome-score.mjs';

const pageUrl = 'https://musescore.com/user/16006641/scores/4197961';
const headers = {
  'User-Agent': 'MaestroPhone/1',
  Accept: 'text/html,application/json',
  'Accept-Language': 'en-US,en;q=0.8',
};

const page = await fetch(pageUrl, { headers });
const html = await page.text();
const id = html.match(/musescore:\/\/score\/(\d+)/)?.[1]
  ?? pageUrl.match(/\/scores\/(\d+)/)?.[1]
  ?? '';
const titleMatch = html.match(/property="og:title" content="([^"]*)"/)
  ?? html.match(/content="([^"]*)" property="og:title"/);
const title = titleMatch?.[1] ?? '';
const token = id ? midiAuthorization(id) : '';
const api = await fetch(`https://musescore.com/api/jmuse?id=${id}&type=midi&index=0`, {
  headers: { ...headers, Authorization: token, Referer: pageUrl },
});
const raw = await api.text();
let info = '';
try {
  info = JSON.parse(raw)?.info?.url || '';
} catch {
  info = '';
}
let magic = '';
let bytes = 0;
let fileStatus = 0;
if (info) {
  const file = await fetch(info, { headers });
  const buf = new Uint8Array(await file.arrayBuffer());
  fileStatus = file.status;
  bytes = buf.length;
  magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
}

console.log(JSON.stringify({
  pageStatus: page.status,
  id,
  title,
  apiStatus: api.status,
  hasUrl: Boolean(info),
  fileStatus,
  bytes,
  magic,
  sample: info ? '' : raw.slice(0, 160),
}));
