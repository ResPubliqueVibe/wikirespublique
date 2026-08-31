import { esc, csrfField, notice } from '../layout.js';

export function registerPage({ csrfToken, error = null, values = {}, firstUser = false }) {
  const v = (k) => esc(values?.[k] ?? '');
  return `<div class="authform">
  <h1 class="article-title">Регистрация</h1>
  ${error ? notice('error', error) : ''}
  ${
    firstUser
      ? notice('info', 'Вы будете первым участником — учётная запись получит права администратора.')
      : ''
  }
  <p class="muted">Res Publique — закрытая вики конфы. Для регистрации нужен код приглашения,
  а саму заявку подтверждает администратор: войти получится только после подтверждения.</p>
  <form method="post" action="/register" class="stacked-form">
    ${csrfField(csrfToken)}
    <label class="field">
      <span class="field-label">Имя участника</span>
      <input type="text" name="username" value="${v('username')}" required autocomplete="username"
             minlength="2" maxlength="64" pattern="[^\\s/?#]{2,64}" autofocus>
      <span class="field-hint">2–64 символа, без пробелов и слэшей. Оно будет видно в истории правок.</span>
    </label>
    <label class="field">
      <span class="field-label">Отображаемое имя <span class="muted">(необязательно)</span></span>
      <input type="text" name="display_name" value="${v('display_name')}" maxlength="80" autocomplete="nickname">
    </label>
    <label class="field">
      <span class="field-label">Пароль</span>
      <input type="password" name="password" required autocomplete="new-password" minlength="8" maxlength="200">
      <span class="field-hint">Минимум 8 символов.</span>
    </label>
    <label class="field">
      <span class="field-label">Пароль ещё раз</span>
      <input type="password" name="password2" required autocomplete="new-password" minlength="8" maxlength="200">
    </label>
    <label class="field">
      <span class="field-label">Код приглашения</span>
      <input type="text" name="invite" value="${v('invite')}" required maxlength="200" autocomplete="off">
    </label>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">${firstUser ? 'Создать учётную запись' : 'Отправить заявку'}</button>
    </div>
  </form>
  <p class="muted">Уже зарегистрированы? <a href="/login">Войдите</a>.</p>
</div>`;
}
