import { esc, wikiUrl, csrfField, notice } from '../layout.js';

export function editPage({ slug, title, content = '', isNew, csrfToken, error = null }) {
  return `<div class="editor">
  <h1 class="article-title">${isNew ? 'Создание страницы' : 'Правка'}: ${esc(title)}</h1>
  ${error ? notice('error', error) : ''}
  <p class="editor-hint">
    Разметка: <code>##&nbsp;Заголовок</code>, <code>**жирный**</code>, <code>*курсив*</code>,
    ссылка на другую страницу — <code>[[Название]]</code> или <code>[[Название|текст]]</code>,
    категория — <code>[[Категория:Участники]]</code>.
    Карточка-инфобокс задаётся YAML-блоком между <code>---</code> в самом начале страницы.
  </p>
  <form method="post" action="${esc(wikiUrl(slug))}" class="edit-form">
    ${csrfField(csrfToken)}
    <label class="field">
      <span class="field-label">Заголовок страницы</span>
      <input type="text" name="title" value="${esc(title)}" required maxlength="200">
    </label>
    <label class="field">
      <span class="field-label">Текст страницы</span>
      <textarea name="content" rows="26" spellcheck="true" required>${esc(content)}</textarea>
    </label>
    <label class="field">
      <span class="field-label">Описание правки</span>
      <input type="text" name="comment" maxlength="300" placeholder="Что изменилось и почему">
    </label>
    <div class="edit-actions">
      <button type="submit" class="btn btn-primary">Сохранить страницу</button>
      <a class="btn" href="${esc(wikiUrl(slug))}">Отмена</a>
    </div>
  </form>
</div>`;
}
