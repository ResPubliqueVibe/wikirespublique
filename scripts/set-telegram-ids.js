/**
 * Проставляет страницам участников поле «телеграм_id» по списку участников чата.
 *
 *   DB_FILE=data/wiki.sqlite node scripts/set-telegram-ids.js <members.json> [--dry-run]
 *
 * Почему отдельный скрипт, а не apply.js: apply.js переписывает страницу целиком
 * текстом из src/content.js и пропускает всё, что правили руками через сайт, —
 * а среди этих страниц такие есть, и айди на них просто не появился бы. Здесь
 * правится текущий текст страницы, и только одной строкой.
 *
 * Файл со списком участников содержит телефоны: читаем из него строго
 * «username» и «id», больше ничего никуда не попадает.
 */
import { readFileSync } from 'node:fs';

import { db, Users, Pages, reindex } from '../src/db.js';
import { parseFrontmatter, extractCategories } from '../src/render.js';
import { normalizeHandle, telegramOf } from '../src/telegram.js';

const BOT_USERNAME = 'Бот';
const COMMENT = 'Телеграм-айди из списка участников чата';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const membersPath = argv.find((a) => !a.startsWith('--'));

if (!membersPath) {
  console.error('Укажите путь к members.json. Пример:');
  console.error('  DB_FILE=data/wiki.sqlite node scripts/set-telegram-ids.js members.json --dry-run');
  process.exit(2);
}

/** Ник → числовой id. Ник приводим к общему виду, чтобы «@Nick» и «nick» сошлись. */
function loadMembers(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.members || [];
  const byNick = new Map();
  for (const m of list) {
    const nick = normalizeHandle(m?.username);
    if (nick && m?.id != null) byNick.set(nick, String(m.id));
  }
  return byNick;
}

/**
 * Вставляет «телеграм_id» сразу за строкой «телеграм:» в карточке.
 * Значение оборачиваем в разметку приватности, как и ник: сырой текст статьи
 * попадает в поисковый индекс, сниппеты и диффы, и незакрытый айди утёк бы туда
 * постороннему мимо карточки. Возвращает null, если строку «телеграм:» не нашли.
 */
function insertId(content, id) {
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Карточка — это первый блок между «---», строка «телеграм:» есть только в ней.
    if (/^\s*(?:телеграм|telegram)\s*:/i.test(lines[i])) {
      const indent = /^\s*/.exec(lines[i])[0];
      lines.splice(i + 1, 0, `${indent}телеграм_id: "{{${id}}}"`);
      return lines.join('\n');
    }
  }
  return null;
}

const members = loadMembers(membersPath);
console.log(`Список участников: ${members.size} ников с айди`);

const bot = Users.byUsername(BOT_USERNAME);
if (!bot) {
  console.error(`В базе нет системного участника «${BOT_USERNAME}» — сначала запустите сеялку.`);
  process.exit(1);
}

let changed = 0;
let same = 0;
let conflicts = 0;

for (const page of Pages.all()) {
  // Двоеточие в слаге — служебная страница («шаблон:», «категория:»); ник в
  // образце карточки живому человеку не принадлежит.
  if (String(page.slug || '').includes(':')) continue;

  const current = Pages.currentContent(page.id);
  if (!current) continue;

  const { username, id: existing } = telegramOf(current.content);
  if (!username) continue;

  const wanted = members.get(username);
  if (!wanted) continue;

  if (existing === wanted) {
    same += 1;
    console.log(`  = уже стоит: ${page.title} (@${username} → ${wanted})`);
    continue;
  }
  if (existing) {
    conflicts += 1;
    console.warn(`  ! разошлось: ${page.title} (@${username}) — в карточке ${existing}, в списке ${wanted}; не трогаю`);
    continue;
  }

  const content = insertId(current.content, wanted);
  if (!content) {
    console.warn(`  ! пропущена: ${page.title} — в карточке нет строки «телеграм:»`);
    continue;
  }

  changed += 1;
  if (dryRun) {
    console.log(`  ~ проставился бы: ${page.title} (@${username} → ${wanted})`);
    continue;
  }

  const { body } = parseFrontmatter(content);
  Pages.save({
    slug: page.slug,
    title: page.title,
    content,
    comment: COMMENT,
    authorId: bot.id,
    categories: extractCategories(body).categories,
  });
  console.log(`  * проставлен: ${page.title} (@${username} → ${wanted})`);
}

if (!dryRun && changed) reindex();
console.log(
  `\n${dryRun ? 'Изменилось бы страниц' : 'Изменено страниц'}: ${changed}` +
    `, уже стояло: ${same}, расхождений: ${conflicts}`
);
db.close();
