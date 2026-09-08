import crypto from 'node:crypto';
import { db, Users } from './db.js';

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

// Миграция старых баз: право и автор появились позже самих токенов.
// DEFAULT 'read' обязателен — без него уже выданный токен остался бы с NULL
// в scope и потерял бы доступ на следующем же запросе.
{
  const cols = db.prepare('PRAGMA table_info(api_tokens)').all();
  if (!cols.some((c) => c.name === 'scope')) {
    db.exec("ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'read'");
  }
  if (!cols.some((c) => c.name === 'author_id')) {
    db.exec('ALTER TABLE api_tokens ADD COLUMN author_id INTEGER REFERENCES users(id)');
  }
}

// Пароль учётной записи агента. verifyPassword ждёт формат `scrypt$соль$хеш`
// и такую строку не примет никогда — войти под этим именем с сайта нельзя,
// а править через API можно.
const NO_PASSWORD = 'api';

/** Участник, от чьего имени пишет токен: чтобы в истории страницы и в «Свежих
 *  правках» было видно, кто именно правил, а не безымянный API. */
export function ensureApiAuthor(name) {
  const username = String(name || '').trim();
  if (!username) throw new Error('У пишущего токена должно быть имя: под ним правки попадут в историю.');
  const existing = Users.byUsername(username);
  if (existing) {
    // Имя занято живым человеком — его правками прикрываться нельзя.
    if (!existing.is_system) {
      throw new Error(`Участник «${username}» — живой человек, а не служебная учётная запись. Возьмите другое имя.`);
    }
    return existing; // второй токен тому же агенту: переиспользуем
  }
  // is_system = 1: имя не попадёт в заявки на подтверждение и не займёт слот
  // «первый зарегистрировавшийся становится администратором».
  return Users.create(username, NO_PASSWORD, username, false, true, true);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

export const ApiTokens = {
  /** Выдать токен. Сам секрет виден только здесь: в базе лежит его хеш.
   *  scope: 'read' (по умолчанию, как было) или 'write' — тогда заводится
   *  участник с этим же именем, от которого и пойдут правки. */
  issue(name, { scope = 'read' } = {}) {
    const clean = String(name || '').trim() || 'без имени';
    const write = scope === 'write';
    const author = write ? ensureApiAuthor(clean) : null;
    const token = 'rpw_' + crypto.randomBytes(20).toString('hex');
    const info = db
      .prepare(
        'INSERT INTO api_tokens (name, token_hash, prefix, created_at, scope, author_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        clean,
        sha256(token),
        token.slice(0, 12),
        new Date().toISOString(),
        write ? 'write' : 'read',
        author?.id ?? null
      );
    return { id: Number(info.lastInsertRowid), name: clean, token, scope: write ? 'write' : 'read', author };
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
        `SELECT t.id, t.name, t.prefix, t.created_at, t.last_used_at, t.calls, t.revoked_at,
                t.scope, t.author_id, u.username AS author
         FROM api_tokens t LEFT JOIN users u ON u.id = t.author_id ORDER BY t.id`
      )
      .all(),

  revoke(id) {
    const info = db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), Number(id));
    return info.changes > 0;
  },
};
