import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cookieParser from 'cookie-parser';

import { Users, Pages, Revisions, search as searchPages } from './src/db.js';
import {
  hashPassword,
  verifyPassword,
  safeEqual,
  startSession,
  endSession,
  sessionMiddleware,
  requireLogin,
  requireAdmin,
  checkCsrf,
} from './src/auth.js';
import { layout, tabs, esc } from './src/layout.js';
import { slugify, titleFromSlug, parseFrontmatter, extractCategories } from './src/render.js';

import { articlePage, missingPage } from './src/pages/article.js';
import { editPage } from './src/pages/edit.js';
import { historyPage } from './src/pages/history.js';
import { diffPage } from './src/pages/diff.js';
import { listPage, categoryPage } from './src/pages/list.js';
import { searchPage } from './src/pages/search.js';
import { loginPage } from './src/pages/login.js';
import { registerPage } from './src/pages/register.js';
import { profilePage } from './src/pages/profile.js';
import { changesPage } from './src/pages/changes.js';
import { errorPage } from './src/pages/notfound.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 20020;
const HOST = '0.0.0.0';
const INVITE_CODE = process.env.INVITE_CODE || 'respublique';
const HOME_SLUG = slugify('Заглавная_страница');
const MAX_CONTENT = 200000;
const CHANGES_LIMIT = 100;
const ANON_CSRF_COOKIE = 'rp_csrf';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('etag', false);

app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());
app.use(sessionMiddleware);

// Anonymous visitors still need a CSRF token (login / register forms):
// double-submit cookie, compared with timingSafeEqual inside checkCsrf.
app.use((req, res, next) => {
  if (!req.csrfToken) {
    let token = req.cookies?.[ANON_CSRF_COOKIE];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      token = crypto.randomBytes(32).toString('hex');
      res.cookie(ANON_CSRF_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.SECURE_COOKIES === '1',
        path: '/',
        maxAge: 30 * 86400000,
      });
    }
    req.csrfToken = token;
  }
  next();
});

app.use(
  express.static(join(__dirname, 'public'), {
    maxAge: '1h',
    index: false,
    dotfiles: 'ignore',
  })
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(req, res, { status = 200, title, body, currentNav = '', query = '', tabsHtml = '', bodyClass = '' }) {
  res.status(status).type('html').send(
    layout({
      title,
      body,
      user: req.user,
      csrfToken: req.csrfToken,
      currentNav,
      query,
      tabsHtml,
      bodyClass,
    })
  );
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Normalise :slug; never touch the DB with the raw parameter. */
function normSlug(raw) {
  const slug = slugify(raw);
  if (!slug || slug.length > 200) return null;
  return slug;
}

const pageExists = (slug) => Pages.exists(slug);

function categoriesFor(content) {
  const { body } = parseFrontmatter(content);
  return extractCategories(body).categories;
}

function authorOf(revision) {
  return revision?.author_id ? Users.byId(revision.author_id) : null;
}

// ---------------------------------------------------------------------------
// In-memory rate limit: 10 attempts per IP per 10 minutes
// ---------------------------------------------------------------------------
const RATE_MAX = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = `${req.path}|${req.ip || 'unknown'}`;
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateBuckets.set(key, hits);
    res.set('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
    return next(httpError(429, 'Слишком много попыток с вашего адреса. Попробуйте через 10 минут.'));
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateBuckets) {
    const live = hits.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) rateBuckets.set(key, live);
    else rateBuckets.delete(key);
  }
}, RATE_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------
function renderArticle(req, res, slug, { revision = null, flash = null } = {}) {
  const page = Pages.bySlug(slug);
  if (!page) {
    const title = titleFromSlug(slug);
    return send(req, res, {
      status: 404,
      title,
      body: missingPage({ slug, title, user: req.user }),
      tabsHtml: tabs({ slug, active: 'read', exists: false }),
      bodyClass: 'page-missing',
    });
  }
  const current = Pages.currentContent(page.id);
  const shown = revision || current;
  return send(req, res, {
    title: page.title,
    body: articlePage({
      page,
      content: shown ? shown.content : '',
      updatedAt: (current || shown)?.created_at || page.updated_at,
      author: authorOf(current),
      pageExists,
      user: req.user,
      csrfToken: req.csrfToken,
      revision: revision || null,
      flash,
    }),
    tabsHtml: tabs({ slug, active: 'read', exists: true }),
    bodyClass: 'page-article',
  });
}

app.get('/', (req, res) => renderArticle(req, res, HOME_SLUG));

app.get('/random', (req, res, next) => {
  const slug = Pages.randomSlug();
  if (!slug) return next(httpError(404, 'В вики пока нет ни одной страницы.'));
  res.redirect(`/wiki/${encodeURIComponent(slug)}`);
});

app.get('/pages', (req, res) => {
  send(req, res, {
    title: 'Все страницы',
    body: listPage({ pages: Pages.all(), categories: Pages.allCategories() }),
    currentNav: '/pages',
  });
});

app.get('/category/:name', (req, res, next) => {
  const name = String(req.params.name || '').trim().slice(0, 200);
  if (!name) return next(httpError(404, 'Категория не указана.'));
  send(req, res, {
    title: `Категория: ${name}`,
    body: categoryPage({ name, pages: Pages.inCategory(name) }),
  });
});

app.get('/search', (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 200);
  const results = q.trim() ? searchPages(q) : [];
  send(req, res, {
    title: q.trim() ? `Поиск: ${q}` : 'Поиск',
    body: searchPage({ query: q, results, exact: Pages.exists(slugify(q)), user: req.user }),
    query: q,
  });
});

app.get('/changes', (req, res) => {
  send(req, res, {
    title: 'Свежие правки',
    body: changesPage({ revisions: Revisions.recent(CHANGES_LIMIT), limit: CHANGES_LIMIT }),
    currentNav: '/changes',
  });
});

app.get('/wiki/:slug', (req, res, next) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return next(httpError(404, 'Некорректное название страницы.'));
  if (slug !== req.params.slug) {
    const qs = new URLSearchParams(req.query).toString();
    return res.redirect(302, `/wiki/${encodeURIComponent(slug)}${qs ? `?${qs}` : ''}`);
  }

  if (req.query.action === 'edit') {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    const page = Pages.bySlug(slug);
    const current = page ? Pages.currentContent(page.id) : null;
    const title = page ? page.title : titleFromSlug(slug);
    return send(req, res, {
      title: `Правка: ${title}`,
      body: editPage({
        slug,
        title,
        content: current ? current.content : '',
        isNew: !page,
        csrfToken: req.csrfToken,
      }),
      tabsHtml: tabs({ slug, active: 'edit', exists: !!page }),
      bodyClass: 'page-edit',
    });
  }

  const flash = req.query.saved === '1' ? { kind: 'success', text: 'Страница сохранена.' } : null;
  return renderArticle(req, res, slug, { flash });
});

app.post('/wiki/:slug', requireLogin, checkCsrf, (req, res, next) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return next(httpError(400, 'Некорректное название страницы.'));

  const rawTitle = String(req.body.title ?? '').trim().slice(0, 200);
  const content = String(req.body.content ?? '').replace(/\r\n/g, '\n');
  const comment = String(req.body.comment ?? '').trim().slice(0, 300);
  const existing = Pages.bySlug(slug);
  const title = rawTitle || existing?.title || titleFromSlug(slug);

  const fail = (message) =>
    send(req, res, {
      status: 400,
      title: `Правка: ${title}`,
      body: editPage({ slug, title, content, isNew: !existing, csrfToken: req.csrfToken, error: message }),
      tabsHtml: tabs({ slug, active: 'edit', exists: !!existing }),
      bodyClass: 'page-edit',
    });

  if (!content.trim()) return fail('Текст страницы не может быть пустым.');
  if (content.length > MAX_CONTENT) return fail(`Страница слишком длинная (максимум ${MAX_CONTENT} символов).`);

  Pages.save({
    slug,
    title,
    content,
    comment,
    authorId: req.user.id,
    categories: categoriesFor(content),
  });
  res.redirect(303, `/wiki/${encodeURIComponent(slug)}?saved=1`);
});

app.get('/wiki/:slug/history', (req, res, next) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return next(httpError(404, 'Некорректное название страницы.'));
  const page = Pages.bySlug(slug);
  if (!page) return renderArticle(req, res, slug);
  send(req, res, {
    title: `История: ${page.title}`,
    body: historyPage({ page, revisions: Revisions.history(page.id) }),
    tabsHtml: tabs({ slug, active: 'history', exists: true }),
    bodyClass: 'page-history',
  });
});

app.get('/wiki/:slug/rev/:id', (req, res, next) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return next(httpError(404, 'Некорректное название страницы.'));
  const page = Pages.bySlug(slug);
  if (!page) return next(httpError(404, 'Страница не найдена.'));
  const rev = Revisions.byId(Number(req.params.id));
  if (!rev || rev.slug !== slug) return next(httpError(404, 'Такой версии страницы нет.'));
  const isCurrent = rev.id === page.current_revision_id;
  renderArticle(req, res, slug, { revision: isCurrent ? null : rev });
});

app.get('/wiki/:slug/diff', (req, res, next) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return next(httpError(404, 'Некорректное название страницы.'));
  const page = Pages.bySlug(slug);
  if (!page) return next(httpError(404, 'Страница не найдена.'));

  const history = Revisions.history(page.id);
  const pick = (value, fallbackIndex) => {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) {
      const rev = Revisions.byId(id);
      if (rev && rev.slug === slug) return rev;
    }
    const fb = history[fallbackIndex];
    return fb ? Revisions.byId(fb.id) : null;
  };

  const to = pick(req.query.to, 0);
  const from = pick(req.query.from, 1);
  if (!to) return next(httpError(404, 'У страницы нет версий для сравнения.'));

  send(req, res, {
    title: `Сравнение версий: ${page.title}`,
    body: diffPage({ page, from, to, user: req.user, csrfToken: req.csrfToken }),
    tabsHtml: tabs({ slug, active: 'history', exists: true }),
    bodyClass: 'page-diff',
  });
});

app.post('/wiki/:slug/revert', requireLogin, checkCsrf, (req, res, next) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return next(httpError(400, 'Некорректное название страницы.'));
  const page = Pages.bySlug(slug);
  if (!page) return next(httpError(404, 'Страница не найдена.'));
  const rev = Revisions.byId(Number(req.body.rev));
  if (!rev || rev.slug !== slug) return next(httpError(400, 'Такой версии страницы нет.'));

  Pages.save({
    slug,
    title: page.title,
    content: rev.content,
    comment: `Откат к версии №${rev.id}`,
    authorId: req.user.id,
    categories: categoriesFor(rev.content),
  });
  res.redirect(303, `/wiki/${encodeURIComponent(slug)}?saved=1`);
});

app.post('/wiki/:slug/delete', requireLogin, requireAdmin, checkCsrf, (req, res, next) => {
  const slug = normSlug(req.params.slug);
  if (!slug) return next(httpError(400, 'Некорректное название страницы.'));
  const page = Pages.bySlug(slug);
  if (!page) return next(httpError(404, 'Страница не найдена.'));
  Pages.delete(page.id);
  res.redirect(303, '/pages');
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
/** Only allow same-origin relative paths as a post-login redirect target. */
function safeNext(value) {
  const v = String(value ?? '');
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v.slice(0, 500);
}

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  send(req, res, {
    title: 'Вход',
    body: loginPage({ csrfToken: req.csrfToken, next: safeNext(req.query.next) }),
  });
});

app.post('/login', rateLimit, checkCsrf, (req, res) => {
  const username = String(req.body.username ?? '').trim().slice(0, 64);
  const password = String(req.body.password ?? '');
  const next = safeNext(req.body.next);

  const user = username ? Users.byUsername(username) : null;
  const ok = user ? verifyPassword(password, user.password_hash) : false;
  if (!ok) {
    return send(req, res, {
      status: 401,
      title: 'Вход',
      body: loginPage({
        csrfToken: req.csrfToken,
        error: 'Неверное имя участника или пароль.',
        username,
        next,
      }),
    });
  }
  startSession(res, user.id);
  res.redirect(303, next);
});

app.post('/logout', checkCsrf, (req, res) => {
  endSession(req, res);
  res.redirect(303, '/');
});

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  send(req, res, {
    title: 'Регистрация',
    body: registerPage({ csrfToken: req.csrfToken, firstUser: Users.count() === 0 }),
  });
});

app.post('/register', rateLimit, checkCsrf, (req, res) => {
  const username = String(req.body.username ?? '').trim().slice(0, 64);
  const displayName = String(req.body.display_name ?? '').trim().slice(0, 80);
  const password = String(req.body.password ?? '');
  const password2 = String(req.body.password2 ?? '');
  const invite = String(req.body.invite ?? '');
  const values = { username, display_name: displayName, invite: '' };
  const firstUser = Users.count() === 0;

  const fail = (message) =>
    send(req, res, {
      status: 400,
      title: 'Регистрация',
      body: registerPage({ csrfToken: req.csrfToken, error: message, values, firstUser }),
    });

  if (!safeEqual(invite, INVITE_CODE)) return fail('Неверный код приглашения.');
  if (username.length < 2) return fail('Имя участника слишком короткое (минимум 2 символа).');
  if (/[\s/?#]/.test(username)) return fail('В имени участника нельзя использовать пробелы и символы / ? #.');
  if (password.length < 8) return fail('Пароль должен быть не короче 8 символов.');
  if (password !== password2) return fail('Пароли не совпадают.');
  if (Users.byUsername(username)) return fail('Такое имя участника уже занято.');

  const user = Users.create(username, hashPassword(password), displayName || username, firstUser);
  startSession(res, user.id);
  res.redirect(303, '/');
});

app.get('/user/:username', (req, res, next) => {
  const username = String(req.params.username || '').trim().slice(0, 64);
  const profile = username ? Users.byUsername(username) : null;
  if (!profile) return next(httpError(404, 'Такого участника нет.'));
  const userPageSlug = slugify(profile.display_name || profile.username) || slugify(profile.username);
  send(req, res, {
    title: `Участник: ${profile.display_name || profile.username}`,
    body: profilePage({
      profile,
      editCount: Users.editCount(profile.id),
      edits: Users.recentEdits(profile.id, 30),
      hasUserPage: !!userPageSlug && Pages.exists(userPageSlug),
      userPageSlug,
      user: req.user,
    }),
  });
});

// ---------------------------------------------------------------------------
// 404 + error handler
// ---------------------------------------------------------------------------
app.use((req, res) => {
  send(req, res, {
    status: 404,
    title: 'Страница не найдена',
    body: errorPage({ status: 404 }),
    bodyClass: 'page-error',
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number(err?.status) || 500;
  if (status >= 500) console.error('[error]', err);
  if (res.headersSent) return res.end();
  send(req, res, {
    status,
    title: status === 404 ? 'Страница не найдена' : 'Ошибка',
    body: errorPage({ status, message: status >= 500 ? '' : err?.message || '' }),
    bodyClass: 'page-error',
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Res Publique слушает http://${HOST}:${PORT} (страниц: ${Pages.count()})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

export { app, server, esc };
