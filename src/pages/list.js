import { esc, wikiUrl, formatDateShort } from '../layout.js';

/** /pages — every page, grouped by first letter, plus the category index. */
export function listPage({ pages, categories = [] }) {
  const groups = new Map();
  for (const p of pages) {
    const letter = (String(p.title || '?').trim().charAt(0) || '?').toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(p);
  }

  const letters = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'));

  const jump = letters.length
    ? `<nav class="alpha-index" aria-label="Указатель по буквам">${letters
        .map((l) => `<a href="#letter-${encodeURIComponent(l)}">${esc(l)}</a>`)
        .join('')}</nav>`
    : '';

  const blocks = letters
    .map((l) => {
      const items = groups
        .get(l)
        .map(
          (p) => `<li>
        <a href="${esc(wikiUrl(p.slug))}">${esc(p.title)}</a>
        <span class="muted list-meta">${esc(p.size ?? 0)} б · ${esc(formatDateShort(p.updated_at))}${
          p.author ? ` · ${esc(p.author_name || p.author)}` : ''
        }</span>
      </li>`
        )
        .join('');
      return `<section class="alpha-group" id="letter-${encodeURIComponent(l)}">
      <h2 class="alpha-letter">${esc(l)}</h2>
      <ul class="page-list">${items}</ul>
    </section>`;
    })
    .join('\n');

  const cats = categories.length
    ? `<section class="cat-index">
      <h2>Категории</h2>
      <ul class="cat-list">${categories
        .map(
          (c) =>
            `<li><a href="/category/${encodeURIComponent(c.name)}">${esc(c.name)}</a> <span class="muted">(${esc(c.n)})</span></li>`
        )
        .join('')}</ul>
    </section>`
    : '';

  return `<div class="listing">
  <h1 class="article-title">Все страницы</h1>
  <p class="muted">Всего страниц: ${pages.length}.</p>
  ${jump}
  ${pages.length ? blocks : '<p>Пока не создано ни одной страницы.</p>'}
  ${cats}
</div>`;
}

/** /category/:name */
export function categoryPage({ name, pages }) {
  const items = pages
    .map(
      (p) =>
        `<li><a href="${esc(wikiUrl(p.slug))}">${esc(p.title)}</a> <span class="muted list-meta">${esc(
          formatDateShort(p.updated_at)
        )}</span></li>`
    )
    .join('');

  return `<div class="listing category-view">
  <h1 class="article-title">Категория: ${esc(name)}</h1>
  <p class="muted">Страниц в категории: ${pages.length}.</p>
  ${
    pages.length
      ? `<ul class="page-list">${items}</ul>`
      : `<p>В этой категории пока нет страниц. Чтобы добавить страницу, впишите в её текст <code>[[Категория:${esc(
          name
        )}]]</code>.</p>`
  }
  <p class="muted"><a href="/pages">← все страницы и категории</a></p>
</div>`;
}
