import { esc, wikiUrl, formatDate, sizeDelta } from '../layout.js';

/** /changes — recent changes across the whole wiki, grouped by day. */
export function changesPage({ revisions, limit = 100 }) {
  if (!revisions.length) {
    return `<div class="changes">
  <h1 class="article-title">Свежие правки</h1>
  <p>Правок пока нет. <a href="/pages">Загляните в список страниц</a>.</p>
</div>`;
  }

  const days = [];
  for (const r of revisions) {
    const key = String(r.created_at).slice(0, 10);
    if (!days.length || days[days.length - 1].key !== key) days.push({ key, at: r.created_at, items: [] });
    days[days.length - 1].items.push(r);
  }

  const blocks = days
    .map((day) => {
      const rows = day.items
        .map((r) => {
          const isNew = r.prev_size == null;
          return `<tr>
        <td class="col-time">${esc(formatDate(r.created_at))}</td>
        <td class="col-page">${isNew ? '<span class="tag-new" title="новая страница">Н</span> ' : ''}<a href="${esc(
          wikiUrl(r.slug)
        )}">${esc(r.title)}</a></td>
        <td class="col-author">${
          r.author
            ? `<a href="/user/${encodeURIComponent(r.author)}">${esc(r.author_name || r.author)}</a>`
            : '<span class="anon">неизвестный</span>'
        }</td>
        <td class="col-size">${sizeDelta(r.size, r.prev_size)}</td>
        <td class="col-comment">${r.comment ? esc(r.comment) : '<span class="no-comment">без описания</span>'}</td>
        <td class="col-links"><a href="${esc(wikiUrl(r.slug))}/history">история</a> · <a href="${esc(
          wikiUrl(r.slug)
        )}/rev/${esc(r.id)}">версия</a></td>
      </tr>`;
        })
        .join('\n');
      return `<section class="changes-day">
      <h2 class="changes-date">${esc(formatDate(day.at).split(',')[0])}</h2>
      <table class="table changes-table">
        <thead><tr>
          <th scope="col">Время</th><th scope="col">Страница</th><th scope="col">Участник</th>
          <th scope="col">Δ</th><th scope="col">Описание</th><th scope="col"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
    })
    .join('\n');

  return `<div class="changes">
  <h1 class="article-title">Свежие правки</h1>
  <p class="muted">Показаны последние ${esc(revisions.length)} правок (максимум ${esc(limit)}).</p>
  ${blocks}
</div>`;
}
