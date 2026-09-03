import { statSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { Pages } from './db.js';
import { ApiTokens } from './apitokens.js';
import { parseFrontmatter, redactPlain, toPlainText, extractCategories, PRIVATE_MEDIA_PREFIX } from './render.js';
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
const RATE_WINDOW = 60_000;
const hits = new Map();

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
  const now = Date.now();
  const bucket = hits.get(row.id);
  if (!bucket || now - bucket.start >= RATE_WINDOW) {
    hits.set(row.id, { start: now, count: 1 });
  } else if (++bucket.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  req.apiToken = row;
  next();
});

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
  console.error('[api]', err);
  if (res.headersSent) return res.end();
  res.status(Number(err?.status) || 500).json({ error: 'server_error', message: 'Внутренняя ошибка.' });
});
