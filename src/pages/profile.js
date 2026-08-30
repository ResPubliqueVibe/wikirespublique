import { esc, wikiUrl, formatDate, formatDateShort } from '../layout.js';

/**
 * @param {object} o
 * @param {{username:string, display_name:string, is_admin:number, created_at:string}} o.profile
 * @param {number} o.editCount
 * @param {Array} o.edits
 * @param {boolean} o.hasUserPage  whether a wiki page about them exists
 * @param {string} o.userPageSlug
 */
export function profilePage({ profile, editCount, edits, hasUserPage, userPageSlug, user = null }) {
  const name = profile.display_name || profile.username;

  const rows = edits.length
    ? edits
        .map(
          (e) => `<tr>
      <td class="col-date">${esc(formatDate(e.created_at))}</td>
      <td class="col-page"><a href="${esc(wikiUrl(e.slug))}">${esc(e.title)}</a></td>
      <td class="col-size">${esc(e.size)} б</td>
      <td class="col-comment">${e.comment ? esc(e.comment) : '<span class="no-comment">без описания</span>'}</td>
    </tr>`
        )
        .join('\n')
    : '<tr><td colspan="4" class="muted">Правок пока нет.</td></tr>';

  const pageLink = hasUserPage
    ? `<a href="${esc(wikiUrl(userPageSlug))}">Статья об участнике</a>`
    : user
      ? `<a class="new" href="${esc(wikiUrl(userPageSlug))}?action=edit">Написать статью об участнике</a>`
      : `<span class="muted">Статьи об участнике ещё нет.</span>`;

  return `<div class="profile">
  <h1 class="article-title">Участник: ${esc(name)}</h1>
  <div class="profile-meta">
    <p><span class="muted">Учётное имя:</span> ${esc(profile.username)}${
      profile.is_admin ? ' <span class="badge-admin">админ</span>' : ''
    }</p>
    <p><span class="muted">В Res Publique с:</span> ${esc(formatDateShort(profile.created_at))}</p>
    <p><span class="muted">Правок:</span> ${esc(editCount)}</p>
    <p>${pageLink}</p>
  </div>
  <h2>Последние правки</h2>
  <table class="table changes-table">
    <thead><tr>
      <th scope="col">Дата</th><th scope="col">Страница</th><th scope="col">Размер</th><th scope="col">Описание</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}
