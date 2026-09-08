// Точечные правки исходника страницы: слияние YAML-карточки, правка раздела
// по заголовку и дописывание в конец. Вынесено из api.js отдельно — это чистые
// функции над текстом, их удобно и проверять отдельно от HTTP.
import yaml from 'js-yaml';

import { parseFrontmatter } from './render.js';
import { FIELD_ORDER } from './content.js';

/** Часть исходника до тела: карточка вместе с обрамляющими `---`, либо ''. */
function frontmatterPrefix(raw, body) {
  const text = String(raw ?? '');
  return text.slice(0, text.length - body.length);
}

/** Слияние карточки. `null` в значении удаляет ключ; порядок ключей после
 *  слияния — по FIELD_ORDER, остальные следом в прежнем порядке. Карточки во
 *  всех биографиях держат один порядок, и агент не должен его ломать. */
export function mergeCard(raw, patch) {
  const { meta, body } = parseFrontmatter(raw);
  const merged = { ...(meta || {}) };
  for (const [key, value] of Object.entries(patch)) {
    const k = String(key).trim();
    if (!k) continue;
    if (value === null) delete merged[k];
    else merged[k] = value;
  }

  const keys = Object.keys(merged);
  const ordered = [
    ...FIELD_ORDER.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !FIELD_ORDER.includes(k)),
  ];
  // Все ключи удалили — карточка исчезает вместе с обрамлением.
  if (!ordered.length) return body.replace(/^\n+/, '');

  const card = {};
  for (const k of ordered) card[k] = merged[k];
  // lineWidth: -1 — иначе js-yaml переносит длинные значения, и исходник,
  // который потом правит человек, разъезжается на ровном месте.
  const dumped = yaml.dump(card, { lineWidth: -1, noRefs: true });
  const tail = meta ? body : (body ? '\n' + body : '\n');
  return `---\n${dumped}---\n${tail}`;
}

/** Заголовок для сравнения: без решёток, регистра и лишних пробелов. */
const normHeading = (s) =>
  String(s ?? '')
    .replace(/^\s*#+\s*/, '')
    .replace(/\s*#*\s*$/, '')
    .trim()
    .toLowerCase();

function trimTrailingBlank(lines) {
  const out = [...lines];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/** Правка раздела по заголовку (`##` или `###`). mode: 'append' | 'replace'.
 *  Раздела нет — он добавляется в конец статьи заголовком `##`. */
export function patchSection(raw, { heading, content, mode = 'append' }) {
  const { body } = parseFrontmatter(raw);
  const prefix = frontmatterPrefix(raw, body);
  const text = String(content ?? '').replace(/\s+$/, '');
  const want = normHeading(heading);
  const lines = body.split('\n');

  let start = -1;
  let level = 2;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(lines[i]);
    if (m && normHeading(m[2]) === want) {
      start = i;
      level = m[1].length;
      break;
    }
  }

  if (start < 0) {
    const head = String(heading ?? '').replace(/^\s*#+\s*/, '').trim();
    return prefix + `${body.replace(/\s+$/, '')}\n\n## ${head}\n\n${text}\n`;
  }

  // Конец раздела — следующий заголовок того же или более высокого уровня:
  // вложенные `###` внутри `##` остаются частью раздела.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }

  const inner = trimTrailingBlank(lines.slice(start + 1, end));
  const added = text.split('\n');
  const next =
    mode === 'replace' ? ['', ...added] : [...(inner.length ? inner : ['']), '', ...added];
  const after = lines.slice(end);
  const result = [...lines.slice(0, start + 1), ...next, ...(after.length ? ['', ...after] : [''])];
  return prefix + result.join('\n');
}

/** Текст в конец статьи (после всех разделов). */
export function appendText(raw, content) {
  const { body } = parseFrontmatter(raw);
  const prefix = frontmatterPrefix(raw, body);
  const text = String(content ?? '').replace(/\s+$/, '');
  return prefix + `${body.replace(/\s+$/, '')}\n\n${text}\n`;
}
