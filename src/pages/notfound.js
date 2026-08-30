import { esc } from '../layout.js';

/** Generic error view (404, 403, 500 …) rendered inside the site layout. */
export function errorPage({ status = 500, message = '', detail = '' } = {}) {
  const titles = {
    400: 'Некорректный запрос',
    403: 'Доступ запрещён',
    404: 'Страница не найдена',
    429: 'Слишком много попыток',
    500: 'Внутренняя ошибка',
  };
  const title = titles[status] || 'Ошибка';

  return `<div class="errorview">
  <p class="error-code">${esc(status)}</p>
  <h1 class="article-title">${esc(title)}</h1>
  <p class="error-message">${esc(message || defaultMessage(status))}</p>
  ${detail ? `<pre class="error-detail">${esc(detail)}</pre>` : ''}
  <p class="muted">
    <a href="/">На заглавную</a> · <a href="/pages">Все страницы</a> · <a href="/changes">Свежие правки</a>
  </p>
</div>`;
}

function defaultMessage(status) {
  switch (status) {
    case 403:
      return 'У вас нет прав на это действие.';
    case 404:
      return 'Такого адреса в Res Publique нет. Возможно, ссылка устарела.';
    case 429:
      return 'Слишком много попыток. Подождите немного и попробуйте снова.';
    default:
      return 'Что-то пошло не так. Попробуйте обновить страницу.';
  }
}

export { errorPage as notFoundPage };
