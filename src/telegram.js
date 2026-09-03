import { db } from './db.js';
import { parseFrontmatter, redactPlain } from './render.js';

const USERNAME_KEYS = ['телеграм', 'telegram'];
const ID_KEYS = ['телеграм_id', 'telegram_id'];

/** Ник в карточке пишут по-разному: со «собакой», ссылкой, в кавычках и под
 *  разметкой приватности. Сравнивать это можно только приведя к одному виду. */
export function normalizeHandle(raw) {
  if (raw == null) return null;
  let s = redactPlain(String(raw), true).trim();
  s = s.replace(/^["'«]+|["'»]+$/g, '').trim();
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\//i, '');
  s = s.replace(/^tg:\/\/resolve\?domain=/i, '');
  s = s.replace(/^@+/, '').trim();
  s = s.replace(/[/?#].*$/, '');
  return s ? s.toLowerCase() : null;
}

const normalizeId = (raw) => {
  const s = redactPlain(String(raw ?? ''), true).trim().replace(/^["'«]+|["'»]+$/g, '');
  return /^\d+$/.test(s) ? s : null;
};

/** Ник и числовой id из YAML-карточки страницы. */
export function telegramOf(content) {
  const { meta } = parseFrontmatter(content);
  if (!meta) return { username: null, id: null };
  let username = null;
  let id = null;
  for (const [key, value] of Object.entries(meta)) {
    const k = String(key).trim().toLowerCase();
    if (!username && USERNAME_KEYS.includes(k)) username = normalizeHandle(value);
    if (!id && ID_KEYS.includes(k)) id = normalizeId(value);
  }
  return { username, id };
}

// Страниц полсотни: линейный перебор дешевле отдельного индекса, который
// пришлось бы поддерживать при каждой правке. Но пересобирать разбор на каждый
// запрос бота незачем — держим в памяти и сбрасываем, как только появилась
// любая новая ревизия.
let cache = null;

function index() {
  const stamp = db.prepare('SELECT MAX(id) AS v FROM revisions').get().v ?? 0;
  if (cache && cache.stamp === stamp) return cache.rows;
  const rows = db
    .prepare(
      `SELECT p.id, p.slug, p.title, p.updated_at, r.content, r.created_at
       FROM pages p JOIN revisions r ON r.id = p.current_revision_id`
    )
    .all()
    // Двоеточие в slug — namespace-префикс служебной страницы («шаблон:»,
    // «категория:»). У образца карточки в шаблоне ник тоже прописан, и без
    // этого отсева бот выдал бы шаблон за живого участника.
    .filter((row) => !String(row.slug || '').includes(':'))
    .map((row) => ({ ...row, telegram: telegramOf(row.content) }));
  cache = { stamp, rows };
  return rows;
}

/** Страница участника по нику или по числовому id (что задано, то и ищем). */
export function findByTelegram({ username, id } = {}) {
  const wantName = normalizeHandle(username);
  const wantId = normalizeId(id);
  if (!wantName && !wantId) return null;
  for (const row of index()) {
    if (wantName && row.telegram.username === wantName) return row;
    if (wantId && row.telegram.id === wantId) return row;
  }
  return null;
}

/** Все страницы, у которых ник указан — боту, чтобы синхронизироваться разом. */
export function allWithTelegram() {
  return index().filter((row) => row.telegram.username || row.telegram.id);
}
