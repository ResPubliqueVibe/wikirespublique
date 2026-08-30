import { esc, wikiUrl, formatDate, sizeDelta } from '../layout.js';

export function historyPage({ page, revisions }) {
  const url = wikiUrl(page.slug);
  const rows = revisions
    .map((r, i) => {
      const prev = revisions[i + 1];
      const isCurrent = i === 0;
      return `<tr${isCurrent ? ' class="rev-current"' : ''}>
      <td class="col-radio"><input type="radio" name="from" value="${esc(r.id)}" aria-label="Старая версия №${esc(r.id)}"${i === 1 || (revisions.length === 1 && i === 0) ? ' checked' : ''}></td>
      <td class="col-radio"><input type="radio" name="to" value="${esc(r.id)}" aria-label="Новая версия №${esc(r.id)}"${isCurrent ? ' checked' : ''}></td>
      <td class="col-date"><a href="${esc(url)}/rev/${esc(r.id)}">${esc(formatDate(r.created_at))}</a>${isCurrent ? ' <span class="tag-current">текущая</span>' : ''}</td>
      <td class="col-author">${
        r.author
          ? `<a href="/user/${encodeURIComponent(r.author)}">${esc(r.author_name || r.author)}</a>`
          : '<span class="anon">неизвестный</span>'
      }</td>
      <td class="col-size">${esc(r.size)} б ${sizeDelta(r.size, prev ? prev.size : null)}</td>
      <td class="col-comment">${r.comment ? esc(r.comment) : '<span class="no-comment">без описания</span>'}</td>
    </tr>`;
    })
    .join('\n');

  return `<div class="history">
  <h1 class="article-title">История правок: <a href="${esc(url)}">${esc(page.title)}</a></h1>
  <p class="muted">Всего правок: ${revisions.length}. Отметьте две версии и нажмите «Сравнить».</p>
  <form method="get" action="${esc(url)}/diff" class="history-form">
    <div class="history-actions"><button type="submit" class="btn btn-primary">Сравнить выбранные версии</button></div>
    <table class="table history-table">
      <thead><tr>
        <th scope="col" class="col-radio">стар.</th>
        <th scope="col" class="col-radio">нов.</th>
        <th scope="col">Дата</th><th scope="col">Участник</th><th scope="col">Размер</th><th scope="col">Описание</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="history-actions"><button type="submit" class="btn btn-primary">Сравнить выбранные версии</button></div>
  </form>
</div>`;
}
