import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

function rowToRecord(row) {
  const bytes = row.midi;
  if (!isMidi(bytes)) return null;
  return {
    scoreId: row.score_id,
    title: row.title,
    sourceUrl: row.source_url,
    savedAt: row.saved_at,
    bytes,
  };
}

function importLegacy(db, dir) {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  } catch {
    return;
  }
  if (!index || typeof index !== 'object' || Array.isArray(index)) return;
  const insert = db.prepare(`
    INSERT INTO scores (score_id, title, source_url, saved_at, midi)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(score_id) DO NOTHING
  `);
  db.exec('BEGIN');
  try {
    for (const entry of Object.values(index)) {
      if (!entry || !SCORE_ID.test(entry.scoreId)) continue;
      let bytes;
      try {
        bytes = fs.readFileSync(path.join(dir, `${entry.scoreId}.mid`));
      } catch {
        continue;
      }
      if (!isMidi(bytes)) continue;
      const title = typeof entry.title === 'string' && entry.title.trim()
        ? entry.title.trim()
        : 'Saved score';
      const sourceUrl = typeof entry.sourceUrl === 'string' ? entry.sourceUrl : '';
      const savedAt = typeof entry.savedAt === 'string' ? entry.savedAt : '1970-01-01T00:00:00.000Z';
      insert.run(entry.scoreId, title, sourceUrl, savedAt, bytes);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createLibrary(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'library.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS scores (
      score_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      midi BLOB NOT NULL
    )
  `);
  importLegacy(db, dir);

  const selectId = db.prepare(`
    SELECT score_id, title, source_url, saved_at, midi
    FROM scores
    WHERE score_id = ?
  `);
  const selectUrl = db.prepare(`
    SELECT score_id, title, source_url, saved_at, midi
    FROM scores
    WHERE source_url = ?
  `);
  const selectAll = db.prepare(`
    SELECT score_id, title, source_url, saved_at, midi
    FROM scores
    ORDER BY saved_at DESC, title ASC
  `);
  const upsert = db.prepare(`
    INSERT INTO scores (score_id, title, source_url, saved_at, midi)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(score_id) DO UPDATE SET
      title = excluded.title,
      source_url = excluded.source_url,
      saved_at = excluded.saved_at,
      midi = excluded.midi
  `);

  return {
    close() {
      db.close();
    },

    async list() {
      const rows = [];
      for (const row of selectAll.all()) {
        const stored = rowToRecord(row);
        if (!stored) continue;
        rows.push({
          scoreId: stored.scoreId,
          title: stored.title,
          savedAt: stored.savedAt,
        });
      }
      return rows;
    },

    async read(scoreId) {
      if (!SCORE_ID.test(scoreId)) return null;
      const row = selectId.get(scoreId);
      if (!row) return null;
      return rowToRecord(row);
    },

    async findByUrl(rawUrl) {
      const fromPath = scoreIdFromUrl(rawUrl);
      if (fromPath) {
        const byId = selectId.get(fromPath);
        if (byId) return rowToRecord(byId);
      }
      const byUrl = selectUrl.get(rawUrl);
      if (!byUrl) return null;
      return rowToRecord(byUrl);
    },

    async save({ scoreId, title, sourceUrl, bytes }) {
      if (!SCORE_ID.test(scoreId) || !isMidi(bytes)) return null;
      const saved = {
        scoreId,
        title: title.trim() || 'Saved score',
        sourceUrl,
        savedAt: new Date().toISOString(),
      };
      upsert.run(saved.scoreId, saved.title, sourceUrl, saved.savedAt, bytes);
      return saved;
    },
  };
}
