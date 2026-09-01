import { DatabaseSync } from 'node:sqlite';
import { redactPlain } from './render.js';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_FILE || join(DATA_DIR, 'wiki.sqlite'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  current_revision_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_categories (
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (page_id, name)
);

CREATE INDEX IF NOT EXISTS idx_revisions_page ON revisions(page_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_author ON revisions(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_categories_name ON page_categories(name);
`);

// Миграции старых баз. Значения по умолчанию подобраны так, чтобы уже
// существующие учётные записи остались рабочими: все они считаются
// подтверждёнными, подтверждения нужны только новым.
{
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.some((c) => c.name === 'is_system')) {
    db.exec('ALTER TABLE users ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'approved')) {
    db.exec('ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1');
  }
}

// ---------------------------------------------------------------------------
// FTS5 — detected at startup, LIKE fallback when unavailable
// ---------------------------------------------------------------------------
export let hasFTS = false;
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, content)`);
  hasFTS = true;
} catch (err) {
  console.warn('[db] FTS5 недоступен, поиск работает через LIKE:', err.message);
}

const nowISO = () => new Date().toISOString();

function ftsDelete(pageId) {
  if (!hasFTS) return;
  db.prepare('DELETE FROM pages_fts WHERE rowid = ?').run(pageId);
}
function ftsUpsert(pageId, title, content) {
  if (!hasFTS) return;
  ftsDelete(pageId);
  // В индекс попадает уже вычищенный текст: иначе поиск по скрытому куску
  // подтверждал бы его содержимое любому постороннему.
  db.prepare('INSERT INTO pages_fts(rowid, title, content) VALUES (?, ?, ?)').run(
    pageId,
    redactPlain(title),
    redactPlain(content)
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export const Users = {
  byId: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  byUsername: (u) => db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(u),
  /** Живые участники: системный «Бот» из сеялки не считается, иначе он занял бы
   *  слот «первый зарегистрировавшийся становится администратором». Заявки,
   *  ждущие подтверждения, считаются — иначе слот достался бы каждому, кто
   *  зарегистрируется, пока первая заявка висит неподтверждённой. */
  count: () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_system = 0').get().n,
  create(username, passwordHash, displayName, isAdmin, isSystem = false, approved = true) {
    const info = db
      .prepare(
        'INSERT INTO users (username, password_hash, display_name, is_admin, is_system, approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        username,
        passwordHash,
        displayName || username,
        isAdmin ? 1 : 0,
        isSystem ? 1 : 0,
        approved ? 1 : 0,
        nowISO()
      );
    return Users.byId(Number(info.lastInsertRowid));
  },

  /** Заявки на регистрацию, ждущие решения администратора. */
  pending: () =>
    db
      .prepare(
        'SELECT id, username, display_name, created_at FROM users WHERE approved = 0 AND is_system = 0 ORDER BY id ASC'
      )
      .all(),
  pendingCount: () =>
    db.prepare('SELECT COUNT(*) AS n FROM users WHERE approved = 0 AND is_system = 0').get().n,
  approve: (id) => db.prepare('UPDATE users SET approved = 1 WHERE id = ? AND approved = 0').run(id).changes,
  /** Отклонение удаляет заявку целиком: имя снова свободно, правок у неё нет. */
  reject: (id) => db.prepare('DELETE FROM users WHERE id = ? AND approved = 0').run(id).changes,
  editCount: (id) => db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE author_id = ?').get(id).n,
  recentEdits: (id, limit = 20) =>
    db
      .prepare(
        `SELECT r.id, r.comment, r.created_at, LENGTH(r.content) AS size, p.slug, p.title
         FROM revisions r JOIN pages p ON p.id = r.page_id
         WHERE r.author_id = ? ORDER BY r.id DESC LIMIT ?`
      )
      .all(id, limit),
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export const Sessions = {
  create(id, userId, csrfToken, days = 30) {
    const created = new Date();
    const expires = new Date(created.getTime() + days * 86400000);
    db.prepare('INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      userId,
      csrfToken,
      created.toISOString(),
      expires.toISOString()
    );
  },
  get: (id) => db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, nowISO()),
  destroy: (id) => db.prepare('DELETE FROM sessions WHERE id = ?').run(id),
  prune: () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowISO()).changes,
};

// ---------------------------------------------------------------------------
// Pages & revisions
// ---------------------------------------------------------------------------
export const Pages = {
  bySlug: (slug) => db.prepare('SELECT * FROM pages WHERE slug = ?').get(slug),
  byId: (id) => db.prepare('SELECT * FROM pages WHERE id = ?').get(id),
  exists: (slug) => !!db.prepare('SELECT 1 FROM pages WHERE slug = ?').get(slug),

  existingSet(slugs) {
    const set = new Set();
    if (!slugs.length) return set;
    const stmt = db.prepare('SELECT slug FROM pages WHERE slug = ?');
    for (const s of slugs) if (stmt.get(s)) set.add(s);
    return set;
  },

  all: () =>
    db
      .prepare(
        `SELECT p.id, p.slug, p.title, p.updated_at,
                r.created_at AS rev_at, LENGTH(r.content) AS size,
                u.username AS author, u.display_name AS author_name
         FROM pages p
         LEFT JOIN revisions r ON r.id = p.current_revision_id
         LEFT JOIN users u ON u.id = r.author_id
         ORDER BY p.title COLLATE NOCASE ASC`
      )
      .all(),

  count: () => db.prepare('SELECT COUNT(*) AS n FROM pages').get().n,

  randomSlug() {
    const row = db.prepare('SELECT slug FROM pages ORDER BY RANDOM() LIMIT 1').get();
    return row ? row.slug : null;
  },

  currentContent(pageId) {
    const row = db
      .prepare('SELECT r.* FROM revisions r JOIN pages p ON p.current_revision_id = r.id WHERE p.id = ?')
      .get(pageId);
    return row || null;
  },

  delete(pageId) {
    ftsDelete(pageId);
    db.prepare('DELETE FROM pages WHERE id = ?').run(pageId);
  },

  /** Create the page if missing and append a revision. Returns { page, revision }. */
  save({ slug, title, content, comment, authorId, categories }) {
    const now = nowISO();
    let page = Pages.bySlug(slug);
    if (!page) {
      const info = db
        .prepare('INSERT INTO pages (slug, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(slug, title, now, now);
      page = Pages.byId(Number(info.lastInsertRowid));
    }
    const rev = db
      .prepare('INSERT INTO revisions (page_id, content, comment, author_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(page.id, content, comment || '', authorId ?? null, now);
    const revId = Number(rev.lastInsertRowid);
    db.prepare('UPDATE pages SET current_revision_id = ?, title = ?, updated_at = ? WHERE id = ?').run(
      revId,
      title,
      now,
      page.id
    );
    Pages.setCategories(page.id, categories || []);
    ftsUpsert(page.id, title, content);
    return { page: Pages.byId(page.id), revisionId: revId };
  },

  setCategories(pageId, names) {
    db.prepare('DELETE FROM page_categories WHERE page_id = ?').run(pageId);
    const stmt = db.prepare('INSERT OR IGNORE INTO page_categories (page_id, name) VALUES (?, ?)');
    for (const n of names) stmt.run(pageId, n);
  },

  categoriesOf: (pageId) =>
    db.prepare('SELECT name FROM page_categories WHERE page_id = ? ORDER BY name').all(pageId).map((r) => r.name),

  inCategory: (name) =>
    db
      .prepare(
        `SELECT p.id, p.slug, p.title, p.updated_at FROM pages p
         JOIN page_categories c ON c.page_id = p.id
         WHERE c.name = ? COLLATE NOCASE ORDER BY p.title COLLATE NOCASE`
      )
      .all(name),

  allCategories: () =>
    db
      .prepare('SELECT name, COUNT(*) AS n FROM page_categories GROUP BY name ORDER BY name COLLATE NOCASE')
      .all(),
};

export const Revisions = {
  byId: (id) =>
    db
      .prepare(
        `SELECT r.*, u.username AS author, u.display_name AS author_name, p.slug, p.title
         FROM revisions r LEFT JOIN users u ON u.id = r.author_id
         JOIN pages p ON p.id = r.page_id WHERE r.id = ?`
      )
      .get(id),

  history: (pageId) =>
    db
      .prepare(
        `SELECT r.id, r.comment, r.created_at, LENGTH(r.content) AS size,
                u.username AS author, u.display_name AS author_name
         FROM revisions r LEFT JOIN users u ON u.id = r.author_id
         WHERE r.page_id = ? ORDER BY r.id DESC`
      )
      .all(pageId),

  recent: (limit = 100) =>
    db
      .prepare(
        `SELECT r.id, r.comment, r.created_at, LENGTH(r.content) AS size, r.page_id,
                p.slug, p.title, u.username AS author, u.display_name AS author_name,
                (SELECT LENGTH(pr.content) FROM revisions pr
                  WHERE pr.page_id = r.page_id AND pr.id < r.id
                  ORDER BY pr.id DESC LIMIT 1) AS prev_size
         FROM revisions r
         JOIN pages p ON p.id = r.page_id
         LEFT JOIN users u ON u.id = r.author_id
         ORDER BY r.id DESC LIMIT ?`
      )
      .all(limit),
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function ftsQuery(q) {
  // Build a safe FTS5 MATCH expression: quote each token, prefix-match the last.
  const tokens = q.match(/[\p{L}\p{N}_]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

export function search(q, limit = 50) {
  const term = (q || '').trim();
  if (!term) return [];
  if (hasFTS) {
    const match = ftsQuery(term);
    if (match) {
      try {
        return db
          .prepare(
            `SELECT p.id, p.slug, p.title, r.content
             FROM pages_fts f JOIN pages p ON p.id = f.rowid
             LEFT JOIN revisions r ON r.id = p.current_revision_id
             WHERE pages_fts MATCH ? ORDER BY bm25(pages_fts, 5.0, 1.0) LIMIT ?`
          )
          .all(match, limit);
      } catch (err) {
        console.warn('[search] FTS-запрос не удался, откат на LIKE:', err.message);
      }
    }
  }
  // Тот же принцип для запасного поиска через LIKE: сравниваем с вычищенным текстом.
  const like = `%${term.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const rows = db
    .prepare(
      `SELECT p.id, p.slug, p.title, r.content
       FROM pages p LEFT JOIN revisions r ON r.id = p.current_revision_id
       WHERE p.title LIKE ? ESCAPE '\\' OR r.content LIKE ? ESCAPE '\\'
       ORDER BY p.title COLLATE NOCASE LIMIT ?`
    )
    .all(like, like, limit);
  // Совпадение могло прийтись на скрытый кусок — такие страницы не показываем.
  const needle = term.toLowerCase();
  return rows.filter((r) =>
    `${redactPlain(r.title)} ${redactPlain(r.content || '')}`.toLowerCase().includes(needle)
  );
}

/** Rebuild the FTS index and category table from current revisions. */
export function reindex() {
  const pages = db
    .prepare('SELECT p.id, p.title, r.content FROM pages p LEFT JOIN revisions r ON r.id = p.current_revision_id')
    .all();
  for (const p of pages) ftsUpsert(p.id, p.title, p.content || '');
  return pages.length;
}

export const prunedSessions = Sessions.prune();
