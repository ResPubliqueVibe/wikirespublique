import { esc } from '../layout.js';

/**
 * Что видит посторонний вместо любой страницы, кроме заглавной. Цензура в
 * тексте прячет личное, но сам список статей и то, кто в конфе есть, — тоже
 * не для чужих глаз. Поэтому дальше заглавной анонима не пускают вовсе,
 * а вместо статьи показывают приглашение войти.
 */
export function gatePage({ next = '' } = {}) {
  const back = next ? `?next=${encodeURIComponent(next)}` : '';
  return `<div class="errorview gateview">
  <p class="error-code">🔒</p>
  <h1 class="article-title">Дальше — только для своих</h1>
  <p class="error-message">
    Вики Res Publique открыта участникам конфы. Посторонним видна одна заглавная
    страница: остальное — про живых людей, и читать это всем подряд незачем.
  </p>
  <p class="gate-actions">
    <a class="btn btn-primary" href="/login${esc(back)}">Войти</a>
    <a class="btn" href="/register">Зарегистрироваться</a>
  </p>
  <p class="muted">
    Регистрация — по коду приглашения: его дают в конфе. Аккаунт заводится сразу,
    доступ открывает администратор. <a href="/">Вернуться на заглавную</a>.
  </p>
</div>`;
}
