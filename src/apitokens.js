import crypto from 'node:crypto';
import { db } from './db.js';

// Таблица живёт рядом с модулем, а не в db.js: API — отдельная история,
// и вики без него работает ровно так же.
db.exec(`
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);
`);

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

export const ApiTokens = {
  /** Выдать токен. Сам секрет виден только здесь: в базе лежит его хеш. */
  issue(name) {
    const token = 'rpw_' + crypto.randomBytes(20).toString('hex');
    const info = db
      .prepare('INSERT INTO api_tokens (name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)')
      .run(String(name || '').trim() || 'без имени', sha256(token), token.slice(0, 12), new Date().toISOString());
    return { id: Number(info.lastInsertRowid), name, token };
  },

  /** Проверка предъявленного токена. Сравнение идёт по хешу, поэтому длина
   *  сравнения постоянна и подобрать секрет по времени ответа нельзя. */
  verify(token) {
    if (typeof token !== 'string' || !token) return null;
    const row = db
      .prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .get(sha256(token));
    if (!row) return null;
    db.prepare('UPDATE api_tokens SET last_used_at = ?, calls = calls + 1 WHERE id = ?').run(
      new Date().toISOString(),
      row.id
    );
    return row;
  },

  list: () =>
    db
      .prepare(
        'SELECT id, name, prefix, created_at, last_used_at, calls, revoked_at FROM api_tokens ORDER BY id'
      )
      .all(),

  revoke(id) {
    const info = db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), Number(id));
    return info.changes > 0;
  },
};
