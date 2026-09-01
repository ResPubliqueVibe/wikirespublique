import { esc, wikiUrl } from '../layout.js';
import { snippet, slugify } from '../render.js';

/**
 * @param {object} o
 * @param {string} o.query
 * @param {Array<{slug:string,title:string,content:string}>} o.results
 * @param {boolean} o.exact  whether a page with exactly this slug exists
 */
export function searchPage({ query, results, exact = false, user = null, canSeePrivate = false }) {
  const q = String(query ?? '');
  const slug = slugify(q);

  const head = `<div class="searchview">
  <h1 class="article-title">Поиск</h1>
  <form class="search-page-form" action="/search" method="get" role="search">
    <label class="visually-hidden" for="q-main">Поисковый запрос</label>
    <input type="search" id="q-main" name="q" value="${esc(q)}" placeholder="Что ищем?" autocomplete="off">
    <button type="submit" class="btn btn-primary">Найти</button>
  </form>`;

  if (!q.trim()) {
    return `${head}
  <p class="muted">Введите слово или фразу — поиск идёт по заголовкам и тексту страниц.</p>
</div>`;
  }

  const createHint =
    !exact && slug
      ? `<div class="notice notice-info">Страницы «${esc(q)}» не существует. ${
          user
            ? `<a href="${esc(wikiUrl(slug))}?action=edit">Создать её</a>?`
            : `<a href="/login?next=${encodeURIComponent(`${wikiUrl(slug)}?action=edit`)}">Войдите</a>, чтобы создать её.`
        }</div>`
      : '';

  if (!results.length) {
    return `${head}
  ${createHint}
  <p>По запросу «${esc(q)}» ничего не найдено.</p>
  <p class="muted">Попробуйте другое слово или посмотрите <a href="/pages">список всех страниц</a>.</p>
</div>`;
  }

  const items = results
    .map(
      (r) => `<li class="search-result">
    <a class="search-title" href="${esc(wikiUrl(r.slug))}">${esc(r.title)}</a>
    <p class="search-snippet">${snippet(r.content || '', q, 240, canSeePrivate)}</p>
  </li>`
    )
    .join('\n');

  return `${head}
  ${createHint}
  <p class="muted">Найдено страниц: ${results.length} по запросу «${esc(q)}».</p>
  <ul class="search-results">${items}</ul>
</div>`;
}
