import { esc, wikiUrl, formatDate, csrfField, notice } from '../layout.js';
import { renderPage } from '../render.js';

function categoryBar(categories) {
  if (!categories?.length) return '';
  const items = categories
    .map((c) => `<a href="/category/${encodeURIComponent(c)}">${esc(c)}</a>`)
    .join('<span class="cat-sep">·</span>');
  return `<nav class="catbar" aria-label="Категории"><span class="catbar-label">Категории:</span> ${items}</nav>`;
}

/**
 * @param {object} o
 * @param {{slug:string,title:string}} o.page
 * @param {string} o.content  raw wikitext
 */
export function articlePage({
  page,
  content,
  updatedAt,
  author,
  pageExists,
  user,
  csrfToken,
  revision = null,
  flash = null,
}) {
  const { html, infobox, categories } = renderPage(content, { title: page.title, pageExists });

  const banner = revision
    ? `<div class="notice notice-warning" role="alert">
         Вы просматриваете <strong>старую версию</strong> страницы от ${esc(formatDate(revision.created_at))}
         (правка №${esc(revision.id)}${revision.author ? `, автор ${esc(revision.author_name || revision.author)}` : ''}).
         Она может сильно отличаться от <a href="${esc(wikiUrl(page.slug))}">текущей версии</a>.
       </div>`
    : '';

  const revertForm =
    revision && user
      ? `<form method="post" action="${esc(wikiUrl(page.slug))}/revert" class="revert-form">
           ${csrfField(csrfToken)}
           <input type="hidden" name="rev" value="${esc(revision.id)}">
           <button type="submit" class="btn">Восстановить эту версию</button>
         </form>`
      : '';

  const deleteForm =
    user?.is_admin && !revision
      ? `<form method="post" action="${esc(wikiUrl(page.slug))}/delete" class="delete-form"
              onsubmit="return confirm('Удалить страницу «${esc(page.title).replace(/'/g, '&#39;')}» со всей историей?')">
           ${csrfField(csrfToken)}
           <button type="submit" class="btn btn-danger">Удалить страницу</button>
         </form>`
      : '';

  const footerInfo = `<div class="article-footer">
    <p class="lastmod">Последнее изменение: ${esc(formatDate(updatedAt))}${author ? `, участник <a href="/user/${encodeURIComponent(author.username)}">${esc(author.display_name || author.username)}</a>` : ''}.</p>
    ${deleteForm}
  </div>`;

  return `${flash ? notice(flash.kind, flash.text) : ''}
${banner}
<article class="article">
  <h1 class="article-title">${esc(page.title)}</h1>
  ${infobox}
  <div class="article-body">
${html}
  </div>
  <div class="clearfix"></div>
  ${categoryBar(categories)}
  ${revertForm}
  ${footerInfo}
</article>`;
}

/** Shown when the requested page has never been created. */
export function missingPage({ slug, title, user }) {
  return `<article class="article article-missing">
  <h1 class="article-title">${esc(title)}</h1>
  <div class="article-body">
    <div class="notice notice-info">
      <strong>Страницы пока нет</strong>
    </div>
    <p>В Res Publique ещё нет страницы с названием «${esc(title)}». Вы можете создать её первым.</p>
    ${
      user
        ? `<p><a class="btn btn-primary" href="${esc(wikiUrl(slug))}?action=edit">Создать страницу</a></p>`
        : `<p><a class="btn btn-primary" href="/login?next=${encodeURIComponent(`${wikiUrl(slug)}?action=edit`)}">Войдите, чтобы создать страницу</a></p>`
    }
    <p>Или <a href="/search?q=${encodeURIComponent(title)}">поищите</a> похожие страницы, либо загляните в <a href="/pages">список всех страниц</a>.</p>
  </div>
</article>`;
}
