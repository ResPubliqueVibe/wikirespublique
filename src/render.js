import MarkdownIt from 'markdown-it';
import yaml from 'js-yaml';
import { esc } from './layout.js';

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------
/**
 * lowercase, trim, spaces -> "_", Cyrillic kept as-is (never transliterated),
 * everything that is not a letter/digit/_/-/: is stripped.
 * ":" is kept as the namespace separator so pages like "Шаблон:Биография"
 * keep a readable URL.
 */
export function slugify(input) {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_\-:]/gu, '')
    .replace(/_{2,}/g, '_')
    .replace(/^[_\-]+|[_\-]+$/g, '');
}

/** Human-readable title guessed from a slug when a page does not exist yet. */
export function titleFromSlug(slug) {
  const s = String(slug ?? '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Без названия';
}

export const CATEGORY_PREFIX = 'Категория:';

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------
/** Splits optional leading YAML frontmatter from the markdown body. */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '');
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: null, body: text };
  let meta = null;
  try {
    const parsed = yaml.load(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {
    meta = null; // malformed frontmatter: treat the page as plain markdown
  }
  return { meta, body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
/** Pulls [[Категория:Имя]] markers out of the flowing text. */
export function extractCategories(body) {
  const names = [];
  const cleaned = String(body ?? '').replace(/\[\[\s*Категория\s*:\s*([^\]|]+?)\s*\]\]/gu, (_, name) => {
    const n = name.trim();
    if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
    return '';
  });
  // Collapse blank lines left behind by removed category markers.
  return { categories: names, body: cleaned.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n') };
}

// ---------------------------------------------------------------------------
// markdown-it + wikilinks
// ---------------------------------------------------------------------------
const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });

// ---------------------------------------------------------------------------
// Приватные куски: {{секрет}} или {{секрет||что видит посторонний}}.
// Разделитель двойной: одинарная черта уже занята вики-ссылками [[цель|текст]],
// и внутри скрытого блока такая ссылка утаскивала часть текста в «замену».
// Скобки выбраны не случайно: markdown-it обрывает текстовый разбор на «{»,
// а на «(» — нет, поэтому со скобками-круглыми правило просто не срабатывало.
// ---------------------------------------------------------------------------
const REDACTED = '[ДАННЫЕ УДАЛЕНЫ]';
const PRIVATE_RE = /\{\{([^{}]*?)\}\}/g;

function splitPrivate(raw) {
  const i = String(raw).indexOf('||');
  return i < 0
    ? { secret: String(raw).trim(), fallback: '' }
    : { secret: String(raw).slice(0, i).trim(), fallback: String(raw).slice(i + 2).trim() };
}

/** Убирает разметку из обычного текста: заголовок вкладки, сниппеты, диффы. */
export function redactPlain(text, canSeePrivate = false) {
  return String(text ?? '').replace(PRIVATE_RE, (_, raw) => {
    const { secret, fallback } = splitPrivate(raw);
    return canSeePrivate ? secret : fallback || REDACTED;
  });
}

md.inline.ruler.before('emphasis', 'private', (state, silent) => {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x7b || src.charCodeAt(pos + 1) !== 0x7b) return false;
  const end = src.indexOf('}}', pos + 2);
  if (end < 0) return false;
  if (!silent) {
    const token = state.push('private', '', 0);
    token.meta = splitPrivate(src.slice(pos + 2, end));
  }
  state.pos = end + 2;
  return true;
});

md.renderer.rules.private = (tokens, idx, _opts, env) => {
  const { secret, fallback } = tokens[idx].meta;
  if (env?.canSeePrivate) {
    // Внутри скрытого куска работает обычная разметка: ссылки, картинки, курсив.
    return `<span class="private" title="Видно только участникам">${md.renderInline(secret, env)}</span>`;
  }
  return `<span class="redacted" title="Скрыто: войдите, чтобы увидеть">${esc(fallback || REDACTED)}</span>`;
};

/** Inline rule for [[Target]] and [[Target|label]]. */
function wikilinkPlugin(mdInst) {
  mdInst.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src;
    let pos = state.pos;
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
    const end = src.indexOf(']]', pos + 2);
    if (end < 0) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner.trim() || inner.includes('[[')) return false;
    if (!silent) {
      const bar = inner.indexOf('|');
      const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
      const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || target;
      if (!target) return false;
      const slug = slugify(target);
      const exists = state.env?.pageExists ? !!state.env.pageExists(slug) : true;
      if (state.env?.wanted && !exists) state.env.wanted.add(slug);

      const open = state.push('link_open', 'a', 1);
      open.attrSet('href', exists ? `/wiki/${encodeURIComponent(slug)}` : `/wiki/${encodeURIComponent(slug)}?action=edit`);
      open.attrSet('class', exists ? 'wikilink' : 'wikilink new');
      open.attrSet('title', exists ? target : `${target} (страницы пока нет)`);
      const text = state.push('text', '', 0);
      text.content = label;
      state.push('link_close', 'a', -1);
    }
    state.pos = end + 2;
    return true;
  });
}
md.use(wikilinkPlugin);

// Видео вставляют тем же синтаксисом, что и картинку: ![подпись](/media/файл.mp4).
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = tokens[idx].attrGet('src') || '';
  if (!VIDEO_RE.test(src)) return defaultImage(tokens, idx, options, env, self);
  const alt = tokens[idx].content || '';
  return `<video class="article-video" controls preload="metadata" src="${esc(src)}"` +
    `${alt ? ` title="${esc(alt)}"` : ''}></video>`;
};

/** Anchor ids on headings + TOC collection. */
function headingAnchors(mdInst) {
  mdInst.core.ruler.push('heading_anchors', (state) => {
    const toc = [];
    const used = new Map();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'heading_open') continue;
      const level = Number(t.tag.slice(1));
      const inline = tokens[i + 1];
      const text = inline && inline.type === 'inline' ? inline.content.replace(/\[\[|\]\]/g, '') : '';
      let id = slugify(text) || `раздел-${toc.length + 1}`;
      const seen = used.get(id) || 0;
      used.set(id, seen + 1);
      if (seen) id = `${id}-${seen + 1}`;
      t.attrSet('id', id);
      if (level === 2 || level === 3) toc.push({ level, id, text, tokenIndex: i });
    }
    if (state.env) state.env.toc = toc;
  });
}
md.use(headingAnchors);

function tocHtml(toc) {
  let html = '<nav class="toc" role="navigation" aria-labelledby="toc-heading">';
  html += '<h2 class="toc-title" id="toc-heading">Содержание</h2><ol class="toc-list">';
  let openSub = false;
  for (const item of toc) {
    if (item.level === 3) {
      if (!openSub) {
        html += '<li class="toc-sub-wrap"><ol class="toc-sublist">';
        openSub = true;
      }
      html += `<li class="toc-item toc-l3"><a href="#${esc(item.id)}">${esc(item.text)}</a></li>`;
    } else {
      if (openSub) {
        html += '</ol></li>';
        openSub = false;
      }
      html += `<li class="toc-item toc-l2"><a href="#${esc(item.id)}">${esc(item.text)}</a></li>`;
    }
  }
  if (openSub) html += '</ol></li>';
  return html + '</ol></nav>';
}

/** Renders inline markdown (used for infobox values). */
export function renderInline(text, env = {}) {
  return md.renderInline(String(text ?? ''), env);
}

// ---------------------------------------------------------------------------
// Infobox
// ---------------------------------------------------------------------------
const IMAGE_KEYS = ['изображение', 'image', 'фото'];
export const PRIVATE_MEDIA_PREFIX = '/media/private/';
const TYPE_KEYS = ['тип', 'type'];
// Имя, под которым страница показывается при открытии. Нужно, когда в ссылках
// и списках человек значится под одним именем, а в самой статье — под другим.
const TITLE_KEYS = ['заголовок', 'title'];
// Телеграм-ник — контакт живого человека, поэтому постороннему он не показывается
// даже без разметки: поле прячется само.
const PRIVATE_KEYS = ['телеграм', 'telegram'];
const CAPTION_KEYS = ['подпись', 'caption'];

function safeImageUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/') && !u.startsWith('//')) return u;
  return null; // reject javascript:, data:, protocol-relative, etc.
}

function stringifyValue(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(stringifyValue).filter(Boolean).join(', ');
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    return Object.entries(v)
      .map(([k, val]) => `${k}: ${stringifyValue(val)}`)
      .join(', ');
  }
  return String(v);
}

export function renderInfobox(meta, title, env) {
  if (!meta) return { html: '', type: null };
  const entries = Object.entries(meta);
  if (!entries.length) return { html: '', type: null };

  let image = null;
  let caption = null;
  let type = null;
  let displayTitle = null;
  let imagePrivate = false;
  const rows = [];
  for (const [key, value] of entries) {
    const k = String(key).trim().toLowerCase();
    if (IMAGE_KEYS.includes(k)) {
      const url = safeImageUrl(stringifyValue(value));
      // Приватность фотографии определяет каталог: всё из /media/private/
      // постороннему не показывается (сам файл сервер ему тоже не отдаёт).
      if (url && url.startsWith(PRIVATE_MEDIA_PREFIX) && !env?.canSeePrivate) {
        imagePrivate = true;
        image = null;
      } else {
        image = url;
      }
      continue;
    }
    if (CAPTION_KEYS.includes(k)) {
      caption = stringifyValue(value);
      continue;
    }
    if (TYPE_KEYS.includes(k)) {
      type = stringifyValue(value);
      continue;
    }
    if (TITLE_KEYS.includes(k)) {
      displayTitle = stringifyValue(value).trim();
      continue;
    }
    let text = stringifyValue(value);
    if (PRIVATE_KEYS.includes(k) && text.trim() && !text.includes('{{')) text = `{{${text}}}`;
    if (text.trim()) rows.push([String(key), text]);
  }

  const shown = displayTitle || title;
  const typeClass = type ? ` infobox-${slugify(type) || 'общий'}` : '';
  let html = `<aside class="infobox${typeClass}" aria-label="Карточка: ${esc(redactPlain(shown, env?.canSeePrivate))}">`;
  html += `<div class="infobox-header">${renderInline(shown, env)}</div>`;
  if (type) html += `<div class="infobox-type">${esc(type)}</div>`;
  if (image) {
    const alt = esc(redactPlain(shown, env?.canSeePrivate));
    html += `<div class="infobox-image"><img src="${esc(image)}" alt="${alt}" loading="lazy"></div>`;
    if (caption) html += `<div class="infobox-caption">${renderInline(caption, env)}</div>`;
  } else if (imagePrivate) {
    html += `<div class="infobox-image infobox-image-redacted" role="img" aria-label="Изображение скрыто">`;
    html += `<span class="redacted">[ИЗОБРАЖЕНИЕ ИЗЪЯТО]</span></div>`;
  }
  if (rows.length) {
    html += '<table class="infobox-rows">';
    for (const [label, value] of rows) {
      html += `<tr><th scope="row">${esc(label)}</th><td>${renderInline(value, env)}</td></tr>`;
    }
    html += '</table>';
  }
  html += '</aside>';
  return { html, type, displayTitle };
}

// ---------------------------------------------------------------------------
// Full page render
// ---------------------------------------------------------------------------
/**
 * @param {string} raw          full page source (frontmatter + markdown)
 * @param {object} opts
 * @param {string} opts.title   page title (for the infobox header)
 * @param {(slug:string)=>boolean} opts.pageExists
 * @returns {{html:string, infobox:string, categories:string[], toc:Array, meta:object|null}}
 */
export function renderPage(raw, { title = '', pageExists = () => true, canSeePrivate = false } = {}) {
  const { meta, body } = parseFrontmatter(raw);
  const { categories, body: clean } = extractCategories(body);
  const env = { pageExists, canSeePrivate, wanted: new Set() };

  const tokens = md.parse(clean, env);
  const toc = env.toc || [];
  let html = md.renderer.render(tokens, md.options, env);

  // A table of contents is shown from three headings up, placed after the
  // intro paragraph(s) — i.e. immediately before the first h2/h3.
  if (toc.length >= 3) {
    const box = tocHtml(toc);
    const first = html.search(/<h[23][ >]/);
    html = first >= 0 ? html.slice(0, first) + box + '\n' + html.slice(first) : html + box;
  }
  const { html: infobox, displayTitle } = renderInfobox(meta, title, env);

  return { html, infobox, categories, toc, meta, displayTitle, wanted: [...env.wanted] };
}

/** Plain-text preview of a page source, used for search snippets. */
export function toPlainText(raw, canSeePrivate = false) {
  const { body } = parseFrontmatter(redactPlain(raw, canSeePrivate));
  const { body: clean } = extractCategories(body);
  return clean
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escaped snippet with <mark>-highlighted query terms. */
export function snippet(raw, query, length = 240, canSeePrivate = false) {
  const text = toPlainText(raw, canSeePrivate);
  const terms = (String(query ?? '').match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 1);
  let start = 0;
  if (terms.length) {
    const lower = text.toLowerCase();
    for (const t of terms) {
      const idx = lower.indexOf(t.toLowerCase());
      if (idx >= 0) {
        start = Math.max(0, idx - 60);
        break;
      }
    }
  }
  let cut = text.slice(start, start + length);
  if (start > 0) cut = '…' + cut;
  if (start + length < text.length) cut = cut + '…';
  let html = esc(cut);
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'giu');
    html = html.replace(re, '<mark>$1</mark>');
  }
  return html;
}
