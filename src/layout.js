import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Версия в адресе статики: без неё браузер держит старый style.css до часа
// и правки вёрстки «не появляются», хотя на сервере они уже есть.
function assetVersion(name) {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', name);
    return String(Math.floor(statSync(file).mtimeMs));
  } catch {
    return '1';
  }
}

const STYLE_VERSION = assetVersion('style.css');
const EMBED_VERSION = assetVersion('embed.js');

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape untrusted text for HTML interpolation. Use everywhere. */
export function esc(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Escape a value for use inside an href/src attribute. */
export function escAttrUrl(value) {
  const v = String(value ?? '');
  if (/^\s*(javascript|data|vbscript):/i.test(v)) return '#';
  return esc(v);
}

export const wikiUrl = (slug) => `/wiki/${encodeURIComponent(slug)}`;

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

export function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

/** "+123" / "−45" byte delta badge. */
export function sizeDelta(size, prevSize) {
  const cur = Number(size) || 0;
  if (prevSize == null) return `<span class="delta delta-new">+${cur}</span>`;
  const d = cur - Number(prevSize);
  if (d === 0) return '<span class="delta delta-zero">0</span>';
  const cls = d > 0 ? 'delta-plus' : 'delta-minus';
  const sign = d > 0 ? '+' : '−';
  return `<span class="delta ${cls}">${sign}${Math.abs(d)}</span>`;
}

export function csrfField(csrfToken) {
  return `<input type="hidden" name="_csrf" value="${esc(csrfToken || '')}">`;
}

export function notice(kind, text) {
  if (!text) return '';
  return `<div class="notice notice-${esc(kind)}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(text)}</div>`;
}

const NAV = [
  { href: '/', label: 'Заглавная страница' },
  { href: '/changes', label: 'Свежие правки' },
  { href: '/pages', label: 'Все страницы' },
  { href: '/random', label: 'Случайная страница' },
  { href: '/category/%D0%A3%D1%87%D0%B0%D1%81%D1%82%D0%BD%D0%B8%D0%BA%D0%B8', label: 'Участники' },
];

function sidebar(current, query) {
  const links = NAV.map(
    (n) =>
      `<li><a href="${esc(n.href)}"${n.href === current ? ' aria-current="page" class="active"' : ''}>${esc(n.label)}</a></li>`
  ).join('');
  return `<div class="sidebar-inner">
  <a class="wordmark" href="/">
    <span class="wordmark-title">Res Publique</span>
    <span class="wordmark-sub">свободная энциклопедия конфы</span>
  </a>
  <nav class="nav" aria-label="Навигация">
    <ul>${links}</ul>
  </nav>
  <form class="search-form" action="/search" method="get" role="search">
    <label class="visually-hidden" for="q">Поиск по вики</label>
    <input type="search" id="q" name="q" placeholder="Поиск…" value="${esc(query || '')}" autocomplete="off">
    <button type="submit">Найти</button>
  </form>
</div>`;
}

function userBlock(user, csrfToken, pendingCount = 0) {
  if (!user) {
    return `<div class="userbar">
      <a href="/login">Войти</a>
      <a href="/register">Регистрация</a>
    </div>`;
  }
  const requests =
    user.is_admin && pendingCount > 0
      ? `<a class="pending-link" href="/requests" title="Заявки на регистрацию">заявки: ${Number(pendingCount)}</a>`
      : '';
  return `<div class="userbar">
    ${requests}
    <a class="username" href="/user/${encodeURIComponent(user.username)}">${esc(user.display_name || user.username)}</a>
    ${user.is_admin ? '<span class="badge-admin" title="Администратор">админ</span>' : ''}
    <form method="post" action="/logout" class="inline-form">${csrfField(csrfToken)}<button type="submit" class="linkbutton">Выйти</button></form>
  </div>`;
}

/**
 * Article tabs: Статья | Править | История
 * @param {{slug:string, active:string, exists:boolean}} opts
 */
export function tabs({ slug, active = 'read', exists = true } = {}) {
  if (!slug) return '';
  const url = wikiUrl(slug);
  const item = (key, label, href) =>
    `<li class="tab${active === key ? ' tab-active' : ''}"><a href="${esc(href)}">${esc(label)}</a></li>`;
  return `<ul class="tabs" role="navigation" aria-label="Действия со статьёй">
    ${item('read', 'Статья', url)}
    ${item('edit', exists ? 'Править' : 'Создать', `${url}?action=edit`)}
    ${item('history', 'История', `${url}/history`)}
  </ul>`;
}

/**
 * Full HTML document.
 * @param {object} o
 * @param {string} o.title       page <title> / used raw-escaped
 * @param {string} o.body        trusted HTML for the content column
 * @param {object} o.user
 * @param {string} o.csrfToken
 */
export function layout({
  title,
  body,
  user = null,
  csrfToken = null,
  pendingCount = 0,
  currentNav = '',
  query = '',
  bodyClass = '',
  tabsHtml = '',
} = {}) {
  const fullTitle = title ? `${title} — Res Publique` : 'Res Publique';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="color-scheme" content="light dark">
<meta name="description" content="Res Publique — свободная энциклопедия конфы.">
<link rel="stylesheet" href="/style.css?v=${STYLE_VERSION}">
<script src="/embed.js?v=${EMBED_VERSION}" defer></script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26' font-family='Georgia,serif'%3ER%3C/text%3E%3C/svg%3E">
</head>
<body class="${esc(bodyClass)}">
<a class="skip-link" href="#content">Перейти к содержанию</a>
<div class="app">
  <header class="sidebar">${sidebar(currentNav, query)}</header>
  <div class="main">
    <div class="topbar">
      ${tabsHtml || '<span class="tabs-spacer"></span>'}
      ${userBlock(user, csrfToken, pendingCount)}
    </div>
    <main class="content" id="content">
${body}
    </main>
    <footer class="site-footer">
      <p>Res Publique — частная вики конфы. Текст доступен участникам; правьте ответственно.</p>
      <p class="footer-links"><a href="/pages">Все страницы</a> · <a href="/changes">Свежие правки</a> · <a href="/random">Случайная страница</a></p>
    </footer>
  </div>
</div>
</body>
</html>`;
}
