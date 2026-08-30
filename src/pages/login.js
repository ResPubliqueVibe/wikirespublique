import { esc, csrfField, notice } from '../layout.js';

export function loginPage({ csrfToken, error = null, info = null, username = '', next = '' }) {
  return `<div class="authform">
  <h1 class="article-title">Вход</h1>
  ${error ? notice('error', error) : ''}
  ${info ? notice('info', info) : ''}
  <form method="post" action="/login" class="stacked-form">
    ${csrfField(csrfToken)}
    <input type="hidden" name="next" value="${esc(next)}">
    <label class="field">
      <span class="field-label">Имя участника</span>
      <input type="text" name="username" value="${esc(username)}" required autocomplete="username" maxlength="64" autofocus>
    </label>
    <label class="field">
      <span class="field-label">Пароль</span>
      <input type="password" name="password" required autocomplete="current-password" maxlength="200">
    </label>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Войти</button>
    </div>
  </form>
  <p class="muted">Ещё нет учётной записи? <a href="/register">Зарегистрируйтесь</a> — понадобится код приглашения.</p>
</div>`;
}
