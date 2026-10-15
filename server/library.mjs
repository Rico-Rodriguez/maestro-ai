import fs from 'node:fs';
import path from 'node:path';

const SCORE_ID = /^\d+$/;

export function scoreIdFromUrl(rawUrl) {
  try {
    const match = /\/scores\/(\d+)\/?$/.exec(new URL(rawUrl).pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isMidi(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x4d
    && bytes[1] === 0x54
    && bytes[2] === 0x68
    && bytes[3] === 0x64;
}

export function createLibrary(dir) {
  const indexPath = path.join(dir, 'index.json');

  async function readIndex() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  async function writeIndex(index) {
    await fs.promises.mkdir(dir, { recursive: true });
    const temporary = `${indexPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(index));
    await fs.promises.rename(temporary, indexPath);
  }

  function midiPath(scoreId) {
    return path.join(dir, `${scoreId}.mid`);
  }

  async function readEntry(entry) {
    if (!entry || !SCORE_ID.test(entry.scoreId)) return null;
    let bytes;
    try {
      bytes = await fs.promises.readFile(midiPath(entry.scoreId));
    } catch {
      return null;
    }
    if (!isMidi(bytes)) return null;
    return {
      scoreId: entry.scoreId,
      title: typeof entry.title === 'string' ? entry.title : 'Saved score',
      sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : '',
      savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : '',
      bytes,
    };
  }

  return {
    async list() {
      const index = await readIndex();
      const rows = [];
      for (const entry of Object.values(index)) {
        const stored = await readEntry(entry);
        if (!stored) continue;
        rows.push({
          scoreId: stored.scoreId,
          title: stored.title,
          savedAt: stored.savedAt,
        });
      }
      rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.title.localeCompare(b.title));
      return rows;
    },

    async read(scoreId) {
      if (!SCORE_ID.test(scoreId)) return null;
      const index = await readIndex();
      return readEntry(index[scoreId]);
    },

    async findByUrl(rawUrl) {
      const index = await readIndex();
      const fromPath = scoreIdFromUrl(rawUrl);
      if (fromPath && index[fromPath]) return readEntry(index[fromPath]);
      const match = Object.values(index).find((entry) => entry && entry.sourceUrl === rawUrl);
      if (!match) return null;
      return readEntry(match);
    },

    async save({ scoreId, title, sourceUrl, bytes }) {
      if (!SCORE_ID.test(scoreId) || !isMidi(bytes)) return null;
      await fs.promises.mkdir(dir, { recursive: true });
      const temporary = path.join(dir, `${scoreId}.${process.pid}.tmp`);
      await fs.promises.writeFile(temporary, bytes);
      await fs.promises.rename(temporary, midiPath(scoreId));
      const index = await readIndex();
      const saved = {
        scoreId,
        title: title.trim() || 'Saved score',
        sourceUrl,
        savedAt: new Date().toISOString(),
      };
      index[scoreId] = saved;
      await writeIndex(index);
      return saved;
    },
  };
}
