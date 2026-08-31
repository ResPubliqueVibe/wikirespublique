import { esc, csrfField, notice, formatDate } from '../layout.js';

/** Экран после отправки заявки: сессии ещё нет, входить пока некуда. */
export function registrationSubmittedPage({ username }) {
  return `<div class="authform">
  <h1 class="article-title">Заявка отправлена</h1>
  ${notice('info', `Учётная запись «${username}» создана, но ждёт подтверждения администратора.`)}
  <p>Пока заявку не подтвердят, войти не получится. Как только её одобрят, входите
  обычным способом — имя и пароль уже сохранены.</p>
  <p class="muted"><a href="/">На заглавную страницу</a> · <a href="/login">Страница входа</a></p>
</div>`;
}

/** Список заявок для администратора. */
export function requestsPage({ csrfToken, requests = [] }) {
  if (!requests.length) {
    return `<div class="article">
  <h1 class="article-title">Заявки на регистрацию</h1>
  ${notice('info', 'Необработанных заявок нет.')}
  <p class="muted">Сюда попадает каждый, кто зарегистрировался: пока заявку не подтвердить,
  войти он не сможет.</p>
</div>`;
  }

  const rows = requests
    .map(
      (r) => `<tr>
      <td><strong>${esc(r.username)}</strong>${
        r.display_name && r.display_name !== r.username ? ` <span class="muted">(${esc(r.display_name)})</span>` : ''
      }</td>
      <td class="muted">${esc(formatDate(r.created_at))}</td>
      <td class="request-actions">
        <form method="post" action="/requests/${encodeURIComponent(r.id)}/approve" class="inline-form">
          ${csrfField(csrfToken)}<button type="submit" class="btn btn-primary">Подтвердить</button>
        </form>
        <form method="post" action="/requests/${encodeURIComponent(r.id)}/reject" class="inline-form">
          ${csrfField(csrfToken)}<button type="submit" class="btn">Отклонить</button>
        </form>
      </td>
    </tr>`
    )
    .join('\n');

  return `<div class="article">
  <h1 class="article-title">Заявки на регистрацию</h1>
  <p class="muted">Подтверждённый участник сможет войти и править вики. Отклонённая заявка
  удаляется целиком — имя снова свободно.</p>
  <table class="listing">
    <thead><tr><th>Участник</th><th>Заявка подана</th><th>Решение</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`;
}
