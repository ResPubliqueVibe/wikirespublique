import { statSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { Pages, Revisions, search as searchPages } from './db.js';
import { ApiTokens } from './apitokens.js';
import {
  parseFrontmatter,
  redactPlain,
  toPlainText,
  extractCategories,
  slugify,
  titleFromSlug,
  MAX_CONTENT,
  PRIVATE_MEDIA_PREFIX,
} from './render.js';
import { mergeCard, patchSection, appendText } from './editops.js';
import { findByTelegram, allWithTelegram } from './telegram.js';

const SITE_URL = (process.env.SITE_URL || 'https://wiki.respubli.cc').replace(/\/+$/, '');

// Тот же каталог и то же значение по умолчанию, что в server.js: файлы лежат
// снаружи образа, и API отдаёт ровно их, а не копию.
const __dirname = dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = process.env.MEDIA_DIR || join(__dirname, '..', 'media');
const MEDIA_ROOT = path.resolve(MEDIA_DIR);
// Префикс, под которым API раздаёт те же файлы, но по токену.
const API_MEDIA_PREFIX = '/api/v1/media/';
const SITE_MEDIA_PREFIX = '/media/';

// Не больше стольки запросов в минуту на токен. Окно скользит грубо, целыми
// минутами: защита здесь от заклинившего бота, а не от злоумышленника.
const RATE_LIMIT = 120;
// У изменяющих запросов счётчик свой и строже: разогнавшийся агент не должен
// успеть переписать вики быстрее, чем человек это заметит.
const WRITE_RATE_LIMIT = 30;
const RATE_WINDOW = 60_000;
const hits = new Map();
const writeHits = new Map();

const SUMMARY_LIMIT = 400;
// Пути к файлам в карточке относительные; боту нужен адрес, который откроется
// сам по себе. Подпись сюда не входит: это текст, а не путь.
const MEDIA_KEYS = ['фото', 'изображение', 'image'];
// Те же ключи, что в IMAGE_KEYS/CAPTION_KEYS в src/render.js: карточку пишут
// люди, и поле фотографии может называться по-разному.
const IMAGE_KEYS = ['изображение', 'image', 'фото'];
const CAPTION_KEYS = ['подпись', 'caption'];

export const apiRouter = express.Router();

apiRouter.use((req, res, next) => {
  const header = String(req.get('authorization') || '');
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const row = m && ApiTokens.verify(m[1]);
  if (!row) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Нужен заголовок Authorization: Bearer <токен>',
    });
  }
  if (!countHit(hits, row.id, RATE_LIMIT)) return res.status(429).json({ error: 'rate_limited' });
  req.apiToken = row;
  next();
});

// Тело запроса разбираем только здесь: вики работает на формах, и глобальный
// express.json ей не нужен. Битый JSON ловится в обработчике ошибок ниже.
apiRouter.use(express.json({ limit: '1mb' }));

/** Грубое окно в минуту на токен: считаем целыми минутами, защита здесь от
 *  заклинившего бота, а не от злоумышленника. */
function countHit(map, id, limit) {
  const now = Date.now();
  const bucket = map.get(id);
  if (!bucket || now - bucket.start >= RATE_WINDOW) {
    map.set(id, { start: now, count: 1 });
    return true;
  }
  return ++bucket.count <= limit;
}

/** Право на запись. Висит на всех изменяющих маршрутах. */
function requireWrite(req, res, next) {
  if (req.apiToken?.scope !== 'write') {
    return res.status(403).json({ error: 'forbidden', message: 'Токену разрешено только чтение.' });
  }
  if (!countHit(writeHits, req.apiToken.id, WRITE_RATE_LIMIT)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  next();
}

function absolutize(value) {
  const s = String(value ?? '');
  return s.startsWith('/') && !s.startsWith('//') ? SITE_URL + s : s;
}

function stringifyValue(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(stringifyValue).filter(Boolean).join(', ');
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    return Object.entries(v).map(([k, val]) => `${k}: ${stringifyValue(val)}`).join(', ');
  }
  return String(v);
}

/** Карточка страницы как плоский объект. Держатель токена доверенный, поэтому
 *  скрытые куски отдаются раскрытыми: иначе бот получил бы одни плашки. */
function cardOf(meta) {
  const card = {};
  if (!meta) return card;
  for (const [key, value] of Object.entries(meta)) {
    const text = redactPlain(stringifyValue(value), true);
    card[key] = MEDIA_KEYS.includes(String(key).trim().toLowerCase()) ? absolutize(text) : text;
  }
  return card;
}

function summaryOf(body) {
  const first = redactPlain(body, true)
    .split(/\n\s*\n/)
    .map((block) => toPlainText(block, true))
    .find((block) => block && !/^#/.test(block));
  if (!first) return '';
  return first.length > SUMMARY_LIMIT ? first.slice(0, SUMMARY_LIMIT).trimEnd() + '…' : first;
}

/** Фотография участника. Адрес с сайта (`/media/…`) боту бесполезен: там стоит
 *  проверка входа, а `/media/private/` посторонним и вовсе не отдаётся. Поэтому
 *  главный адрес — через API, он качается тем же токеном. */
function photoOf(meta) {
  if (!meta) return null;
  let raw = null;
  let caption = null;
  for (const [key, value] of Object.entries(meta)) {
    const k = String(key).trim().toLowerCase();
    const text = redactPlain(stringifyValue(value), true).trim();
    if (!raw && IMAGE_KEYS.includes(k)) raw = text;
    if (!caption && CAPTION_KEYS.includes(k)) caption = text || null;
  }
  if (!raw) return null;
  // Внешняя картинка открывается сама — проксировать нечего.
  if (/^https?:\/\//i.test(raw)) return { url: raw, site_url: raw, private: false, caption };
  // Всё, что не путь от корня сайта (javascript:, data:, //host), — не файл.
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  const siteUrl = SITE_URL + raw;
  // Через API отдаётся только то, что лежит в MEDIA_DIR; на прочие пути сайта
  // своего маршрута нет, и остаётся дать хотя бы адрес сайта.
  if (!raw.startsWith(SITE_MEDIA_PREFIX)) return { url: siteUrl, site_url: siteUrl, private: false, caption };
  return {
    url: SITE_URL + API_MEDIA_PREFIX + raw.slice(SITE_MEDIA_PREFIX.length),
    site_url: siteUrl,
    private: raw.startsWith(PRIVATE_MEDIA_PREFIX),
    caption,
  };
}

const photoUrlOf = (content) => photoOf(parseFrontmatter(content).meta)?.url ?? null;

/** Путь запроса → файл внутри MEDIA_DIR, либо null. Клиент может прислать что
 *  угодно, поэтому выход за каталог отсекаем до всякого чтения диска. */
function resolveMedia(raw) {
  let rel;
  try {
    rel = decodeURIComponent(String(raw ?? ''));
  } catch {
    return null; // битая %-последовательность
  }
  if (!rel || rel.includes('\0')) return null;
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel)) return null;
  if (rel.split(/[/\\]/).includes('..')) return null;
  const abs = path.resolve(path.join(MEDIA_ROOT, rel));
  if (abs !== MEDIA_ROOT && !abs.startsWith(MEDIA_ROOT + path.sep)) return null;
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null; // нет файла — то же самое, что путь наружу
  }
  return abs;
}

function pageResponse(row) {
  const { meta, body } = parseFrontmatter(row.content);
  const { body: clean } = extractCategories(body);
  return {
    found: true,
    telegram: telegramOut(row),
    page: {
      title: row.title,
      slug: row.slug,
      url: `${SITE_URL}/wiki/${row.slug}`,
      updated_at: row.updated_at,
      categories: Pages.categoriesOf(row.id),
    },
    card: cardOf(meta),
    photo: photoOf(meta),
    text: redactPlain(clean, true).trim(),
    plain: toPlainText(row.content, true),
    summary: summaryOf(clean),
  };
}

/** Ник в ответе отдаём так, как он написан в карточке (с исходным регистром),
 *  а не в приведённом к канону виде — бот показывает его людям. */
function telegramOut(row) {
  const { meta } = parseFrontmatter(row.content);
  let username = null;
  let id = row.telegram?.id ?? null;
  for (const [key, value] of Object.entries(meta || {})) {
    const k = String(key).trim().toLowerCase();
    if (!username && (k === 'телеграм' || k === 'telegram')) {
      username = redactPlain(stringifyValue(value), true).trim().replace(/^@/, '') || null;
    }
  }
  return { username, id };
}

apiRouter.get('/v1/users/by-telegram/:username', (req, res) => {
  const row = findByTelegram({ username: req.params.username });
  if (!row) return notFound(res);
  res.json(pageResponse(row));
});

apiRouter.get('/v1/users/by-telegram-id/:id', (req, res) => {
  const row = findByTelegram({ id: req.params.id });
  if (!row) return notFound(res);
  res.json(pageResponse(row));
});

apiRouter.get('/v1/users', (req, res) => {
  const users = allWithTelegram().map((row) => ({
    telegram: telegramOut(row),
    page: { title: row.title, slug: row.slug, url: `${SITE_URL}/wiki/${row.slug}` },
    photo_url: photoUrlOf(row.content),
  }));
  res.json({ count: users.length, users });
});

// Фотографии по токену. На сайте /media стоит за проверкой входа, так что
// анониму с токеном тот адрес не открыть. Приватные файлы из media/private/
// отдаются здесь наравне с обычными: держатель токена доверенный, как и везде
// в этом API. Регулярка вместо шаблона — нужен «весь остаток пути».
apiRouter.get(/^\/v1\/media\/(.+)$/, (req, res) => {
  const file = resolveMedia(req.params[0]);
  if (!file) return res.status(404).json({ error: 'not_found' });
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// Страницы: чтение
// ---------------------------------------------------------------------------
// Служебные страницы (двоеточие в slug) отсюда НЕ выкидываются: фильтр стоит
// только на списке участников, а агенту может понадобиться и шаблон.

const pageUrl = (slug) => `${SITE_URL}/wiki/${slug}`;

/** Ограничение выдачи: по умолчанию def, но не больше max — иначе одна опечатка
 *  в limit вытянула бы всю вики целиком. */
function clampLimit(raw, def, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Имя автора для человека: показываем то же, что вика показывает в истории. */
const authorName = (row) => row?.author_name || row?.author || null;

/** Тот же normSlug, что в server.js: сырой параметр до базы не доходит. */
function normSlug(raw) {
  const slug = slugify(raw);
  return slug && slug.length <= 200 ? slug : null;
}

function categoriesFor(content) {
  const { body } = parseFrontmatter(content);
  return extractCategories(body).categories;
}

/** Ответ «страницы нет» с угаданным заголовком: агенту он нужен, чтобы тут же
 *  завести страницу через PUT, не выдумывая название. */
function pageMissing(res, slug) {
  return res.status(404).json({
    exists: false,
    slug,
    title: titleFromSlug(slug),
    error: 'not_found',
  });
}

function pageDetail(page) {
  const rev = Pages.currentContent(page.id);
  const content = rev?.content ?? '';
  const { meta, body } = parseFrontmatter(content);
  const { body: clean } = extractCategories(body);
  return {
    exists: true,
    slug: page.slug,
    title: page.title,
    url: pageUrl(page.slug),
    revision_id: page.current_revision_id,
    updated_at: page.updated_at,
    categories: Pages.categoriesOf(page.id),
    card: cardOf(meta),
    // ВАЖНО: content — исходник ДОСЛОВНО, вместе с карточкой и разметкой
    // приватности `{{…}}`. Раскрывать её здесь нельзя: агент правит именно
    // content и возвращает его в PUT, а значит раскрытый текст он сохранил бы
    // обратно — разметка исчезла бы, а секреты стали бы видны всем.
    // Раскрытые варианты для чтения лежат рядом: text, plain, card.
    content,
    text: redactPlain(clean, true).trim(),
    plain: toPlainText(content, true),
  };
}

apiRouter.get('/v1/pages', (req, res) => {
  const limit = clampLimit(req.query.limit, 100, 500);
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  const all = Pages.all();
  const pages = all.slice(offset, offset + limit).map((row) => ({
    slug: row.slug,
    title: row.title,
    url: pageUrl(row.slug),
    updated_at: row.updated_at,
    size: row.size ?? 0,
    categories: Pages.categoriesOf(row.id),
    revision_id: Pages.byId(row.id)?.current_revision_id ?? null,
  }));
  // count — всего страниц в вики, а не в этой выдаче: по нему агент решает,
  // нужен ли следующий offset.
  res.json({ count: Pages.count(), pages });
});

apiRouter.get('/v1/pages/:slug', (req, res) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return pageMissing(res, String(req.params.slug || ''));
  const page = Pages.bySlug(slug);
  if (!page) return pageMissing(res, slug);
  res.json(pageDetail(page));
});

apiRouter.get('/v1/pages/:slug/history', (req, res) => {
  const slug = normSlug(req.params.slug);
  const page = slug && Pages.bySlug(slug);
  if (!page) return pageMissing(res, slug || String(req.params.slug || ''));
  const limit = clampLimit(req.query.limit, 100, 500);
  res.json({
    slug: page.slug,
    title: page.title,
    revisions: Revisions.history(page.id)
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        author: authorName(r),
        comment: r.comment,
        created_at: r.created_at,
        size: r.size,
      })),
  });
});

apiRouter.get('/v1/revisions/:id', (req, res) => {
  const rev = Revisions.byId(Number(req.params.id));
  if (!rev) return res.status(404).json({ error: 'not_found', message: 'Такой версии страницы нет.' });
  res.json({
    id: rev.id,
    slug: rev.slug,
    title: rev.title,
    author: authorName(rev),
    comment: rev.comment,
    created_at: rev.created_at,
    // Исходник ревизии — тоже дословный, по той же причине, что и в /v1/pages/:slug.
    content: rev.content,
  });
});

apiRouter.get('/v1/changes', (req, res) => {
  const limit = clampLimit(req.query.limit, 100, 500);
  const changes = Revisions.recent(limit).map((r) => ({
    revision_id: r.id,
    slug: r.slug,
    title: r.title,
    url: pageUrl(r.slug),
    author: authorName(r),
    comment: r.comment,
    created_at: r.created_at,
    size: r.size,
    prev_size: r.prev_size ?? null,
  }));
  res.json({ count: changes.length, changes });
});

/** Сниппет для API — простым текстом, без <mark> и HTML-экранирования: его
 *  читает агент, а не браузер. Приватное раскрыто, как и везде здесь. */
function plainSnippet(content, query, length = 240) {
  const text = toPlainText(content, true);
  const terms = (String(query ?? '').match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 1);
  let start = 0;
  const lower = text.toLowerCase();
  for (const t of terms) {
    const idx = lower.indexOf(t.toLowerCase());
    if (idx >= 0) {
      start = Math.max(0, idx - 60);
      break;
    }
  }
  let cut = text.slice(start, start + length);
  if (start > 0) cut = '…' + cut;
  if (start + length < text.length) cut += '…';
  return cut;
}

apiRouter.get('/v1/search', (req, res) => {
  const query = String(req.query.q ?? '').trim();
  const limit = clampLimit(req.query.limit, 50, 500);
  const results = searchPages(query, limit).map((row) => ({
    slug: row.slug,
    title: row.title,
    url: pageUrl(row.slug),
    snippet: plainSnippet(row.content || '', query),
  }));
  res.json({ query, count: results.length, results });
});

// ---------------------------------------------------------------------------
// Страницы: запись (нужен токен со scope=write)
// ---------------------------------------------------------------------------

// Ниже какой доли от прежнего размера правка считается подозрительной и при
// какой длине старого текста охрана вообще включается. LLM охотно «сокращает»
// статью до абзаца, и без этого такое уезжало бы молча.
const SHRINK_RATIO = 0.4;
const SHRINK_MIN_OLD = 500;
const DEFAULT_COMMENT = 'Правка через API';

/** Общая часть всех изменяющих маршрутов: проверки, ревизия, ответ.
 *  Возвращает уже отправленный ответ — вызывающему остаётся только `return`. */
function commitEdit(req, res, { slug, page, content, title, comment, options = {} }) {
  const body = req.body || {};

  // Оптимистическая блокировка: агент читает, думает и пишет не мгновенно,
  // а за это время страницу мог поправить человек.
  if (body.expected_revision_id !== undefined && body.expected_revision_id !== null) {
    const expected = Number(body.expected_revision_id);
    const current = page?.current_revision_id ?? null;
    if (!Number.isFinite(expected) || expected !== current) {
      return res.status(409).json({
        error: 'conflict',
        message: 'Страницу успели изменить: перечитайте её и повторите правку.',
        current_revision_id: current,
      });
    }
  }

  const text = String(content).replace(/\r\n/g, '\n');
  if (!text.trim()) {
    // Пустой текст не спасает даже force: пустая страница — это не правка.
    return res.status(400).json({ error: 'empty_content', message: 'Текст страницы не может быть пустым.' });
  }
  if (text.length > MAX_CONTENT) {
    return res.status(400).json({
      error: 'too_long',
      message: `Страница слишком длинная (максимум ${MAX_CONTENT} символов).`,
    });
  }

  const old = page ? Pages.currentContent(page.id)?.content ?? '' : '';
  if (
    !options.allowShrink &&
    body.force !== true &&
    old.length > SHRINK_MIN_OLD &&
    text.length < old.length * SHRINK_RATIO
  ) {
    return res.status(409).json({
      error: 'too_much_removed',
      message: 'Правка выносит большую часть текста. Если это осознанно, повторите с "force": true.',
      old_length: old.length,
      new_length: text.length,
    });
  }

  const { revisionId } = Pages.save({
    slug,
    title,
    content: text,
    comment: String(comment ?? '').trim().slice(0, 300) || DEFAULT_COMMENT,
    authorId: req.apiToken.author_id ?? null,
    // Категории разбираем так же, как server.js, иначе страница выпала бы
    // из своих категорий сразу после правки через API.
    categories: categoriesFor(text),
  });

  return res.status(page ? 200 : 201).json({
    ok: true,
    created: !page,
    slug,
    title,
    url: pageUrl(slug),
    revision_id: revisionId,
    previous_revision_id: page?.current_revision_id ?? null,
  });
}

const badSlug = (res) => res.status(400).json({ error: 'bad_slug', message: 'Некорректное название страницы.' });

apiRouter.put('/v1/pages/:slug', requireWrite, (req, res) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return badSlug(res);
  const body = req.body || {};
  if (typeof body.content !== 'string') {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Нужно поле content — исходник страницы целиком, строкой.',
    });
  }
  const page = Pages.bySlug(slug);
  const title = String(body.title ?? '').trim().slice(0, 200) || page?.title || titleFromSlug(slug);
  return commitEdit(req, res, { slug, page, content: body.content, title, comment: body.comment });
});

apiRouter.patch('/v1/pages/:slug', requireWrite, (req, res) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return badSlug(res);
  const page = Pages.bySlug(slug);
  // PATCH не создаёт страниц: заводить их — дело PUT, иначе опечатка в slug
  // наплодила бы пустышек вместо правки настоящей статьи.
  if (!page) return pageMissing(res, slug);

  const body = req.body || {};
  const { card, section, append } = body;
  let content = Pages.currentContent(page.id)?.content ?? '';
  let touched = false;

  if (card !== undefined) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      return res.status(400).json({ error: 'bad_request', message: 'card должен быть объектом «ключ: значение».' });
    }
    content = mergeCard(content, card);
    touched = true;
  }

  if (section !== undefined) {
    const heading = String(section?.heading ?? '').trim();
    const mode = section?.mode === 'replace' ? 'replace' : 'append';
    if (!heading || typeof section?.content !== 'string') {
      return res.status(400).json({
        error: 'bad_request',
        message: 'section должен быть объектом {heading, content, mode?}.',
      });
    }
    content = patchSection(content, { heading, content: section.content, mode });
    touched = true;
  }

  if (append !== undefined) {
    if (typeof append !== 'string' || !append.trim()) {
      return res.status(400).json({ error: 'bad_request', message: 'append должен быть непустой строкой.' });
    }
    content = appendText(content, append);
    touched = true;
  }

  if (!touched) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Нечего править: пришлите card, section или append.',
    });
  }

  return commitEdit(req, res, { slug, page, content, title: page.title, comment: body.comment });
});

apiRouter.post('/v1/pages/:slug/revert', requireWrite, (req, res) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return badSlug(res);
  const page = Pages.bySlug(slug);
  if (!page) return pageMissing(res, slug);
  const rev = Revisions.byId(Number(req.body?.revision_id));
  if (!rev || rev.slug !== slug) {
    return res.status(400).json({ error: 'bad_revision', message: 'Такой версии этой страницы нет.' });
  }
  return commitEdit(req, res, {
    slug,
    page,
    content: rev.content,
    title: page.title,
    comment: req.body?.comment || `Откат к версии №${rev.id}`,
    // Откат возвращает уже существовавший текст новой ревизией — историю он не
    // режет, поэтому охрана «слишком много вынесено» здесь только мешала бы.
    options: { allowShrink: true },
  });
});

// Удаления страниц в API нет и не будет: ошибившийся агент должен быть
// откатываем, а не разрушителен. Снести страницу может администратор с сайта.

function notFound(res) {
  res.status(404).json({
    found: false,
    error: 'not_found',
    message: 'Участник с таким телеграм-ником в вики не найден.',
  });
}

apiRouter.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Такого метода в API нет.' });
});

// Свой обработчик ошибок: общий отдаёт HTML, а клиент API ждёт JSON.
// eslint-disable-next-line no-unused-vars
apiRouter.use((err, req, res, next) => {
  // Битое тело запроса — ошибка клиента, а не сервера: express.json бросает
  // её сам, и без этой ветки агент получал бы на опечатку в JSON глухую 500.
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: 'Тело запроса не разобралось как JSON.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large', message: 'Тело запроса больше 1 МБ.' });
  }
  console.error('[api]', err);
  if (res.headersSent) return res.end();
  res.status(Number(err?.status) || 500).json({ error: 'server_error', message: 'Внутренняя ошибка.' });
});
