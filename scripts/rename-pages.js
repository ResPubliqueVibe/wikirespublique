/**
 * Переименовывает страницы участников, у которых в репозитории поменялись слаг
 * и заголовок: «Валерия Попова» → «Валерия», «Максим» → «Максим 1» и так далее.
 *
 *   DB_FILE=data/wiki.sqlite node scripts/rename-pages.js [--dry-run]
 *
 * Почему отдельный скрипт, а не apply.js: apply.js ищет страницу по слагу из
 * src/content.js и, не найдя, заводит новую. После смены слагов он создал бы
 * полсотни пустых «Валерий», а старые «Валерии Поповы» так и остались бы в
 * живой вики со всей историей правок. Здесь у существующей строки меняются
 * только slug и title: id страницы и история ревизий остаются при ней.
 *
 * Отдельным проходом чинятся вики-ссылки: [[Валерия Попова]] в чужих статьях
 * после переименования вела бы на несуществующую страницу.
 *
 * Скрипт идемпотентен: на уже переехавшей базе он молча ничего не делает.
 *
 * Кроме CLI, renamePages() зовёт seed.js — миграция обязана пройти до сеялки,
 * иначе та заведёт пустые страницы под новыми слагами и переименовывать будет
 * уже некуда (см. комментарий в seed.js).
 */
import { fileURLToPath } from 'node:url';

import { db, Users, Pages, reindex } from '../src/db.js';
import { slugify, parseFrontmatter, extractCategories } from '../src/render.js';

const BOT_USERNAME = 'Бот';
const COMMENT = 'Ссылки на переименованные страницы участников';

// Старый слаг → новый. Заголовок страницы получается из нового слага заменой
// подчёркиваний на пробелы — так же, как заголовки записаны в src/content.js.
const RENAMES = [
  ['Валерия_Попова', 'Валерия'],
  ['Кристина_Соловьёва', 'Кристина'],
  ['Наталья_Устинова', 'Наталья'],
  ['Ирина_Сокологорская', 'Ирина'],
  ['Максим', 'Максим_1'],
  ['Максим_Святченко', 'Максим_2'],
  ['Тюбик_Иры', 'Денис_2'],
  ['Матвей_Станкевич', 'Матвей'],
  ['Мария_Станкевич', 'Мария_1'],
  ['Владимир_Давидович', 'Владимир'],
  ['Мэрьем_Йилдыз', 'Мэрьем'],
  ['Сергей_Попов', 'Сергей'],
  ['Елизавета', 'Елизавета_1'],
  ['Николай_Галлюлин', 'Николай'],
  ['Андрей_Кожокариу', 'Андрей'],
  ['Евгений_Саутин', 'Евгений'],
  ['Пётр_Меерович', 'Пётр'],
  ['Даниэль_Меерович', 'Даниэль'],
  ['Маргарита_Крылова', 'Маргарита'],
  ['Елизавета_Андрейченко_(Руденко)', 'Елизавета_2'],
  ['Давид_Калинер', 'Давид_1'],
  ['Александр_Черный', 'Александр_1'],
  ['Иоахим_Горовиц', 'Александр_2'],
  ['Денис_Дьячков', 'Денис_1'],
  ['Иван_Терентьев', 'Иван'],
  ['Константин_Гавриленко', 'Константин'],
  ['Юлиан_Луценко', 'Юлиан'],
  ['Даниил_Холлац', 'Даниил'],
  ['Диана_Елена_Соловьёва', 'Диана'],
  ['Мария_Милкович', 'Мария_2'],
  ['Виталий_Матюшин', 'Виталий'],
  ['Александра_Орехова', 'Александра'],
  ['Алексей_Пушкарёв', 'Алексей'],
  ['Эмили_Зайферт', 'Эмили'],
];

/**
 * Прогоняет миграцию по открытой базе и возвращает счётчики
 * `{ renamed, relinked, conflicts }`. Базу не закрывает: вызывающий (сеялка)
 * работает с ней дальше.
 */
export function renamePages({ dryRun = false } = {}) {
  const bot = Users.byUsername(BOT_USERNAME);
  // Совсем свежая база: сеялка ещё не заводила ни бота, ни страниц — значит и
  // переименовывать нечего. Молча выходим, а не роняем процесс.
  if (!bot) return { renamed: 0, relinked: 0, conflicts: 0 };

  // Слаг в базе — это slugify() от названия: в нижнем регистре и без скобок,
  // поэтому «Елизавета_Андрейченко_(Руденко)» ищется как «елизавета_андрейченко_руденко».
  const pairs = RENAMES.map(([from, to]) => ({
    oldSlug: slugify(from),
    newSlug: slugify(to),
    oldTitle: from.replace(/_/g, ' '),
    newTitle: to.replace(/_/g, ' '),
  }));

  // -----------------------------------------------------------------------
  // 1. Переименование
  // -----------------------------------------------------------------------
  let renamed = 0;
  let conflicts = 0;
  // Ссылки чиним только на те пары, где новое название и правда принадлежит той
  // самой странице: после конфликта ссылка увела бы читателя к однофамильцу.
  const linkable = [];

  for (const pair of pairs) {
    const page = Pages.bySlug(pair.oldSlug);
    const taken = Pages.bySlug(pair.newSlug);

    if (!page) {
      // Страницы со старым слагом нет: либо переименование уже прошло, либо
      // страницу в живой вики так и не завели. И то и другое — не беда.
      if (taken) linkable.push(pair);
      continue;
    }

    if (taken && taken.id !== page.id) {
      conflicts += 1;
      console.warn(
        `  ! конфликт: «${page.title}» не переименовать в «${pair.newTitle}» — ` +
          `слаг «${pair.newSlug}» уже занят страницей «${taken.title}» (id ${taken.id}). ` +
          'Разберитесь руками, ссылки на это имя я не трогаю.'
      );
      continue;
    }

    linkable.push(pair);
    renamed += 1;
    if (dryRun) {
      console.log(`  ~ переименовалась бы: «${page.title}» → «${pair.newTitle}» (${pair.oldSlug} → ${pair.newSlug})`);
      continue;
    }

    db.prepare('UPDATE pages SET slug = ?, title = ?, updated_at = ? WHERE id = ?').run(
      pair.newSlug,
      pair.newTitle,
      new Date().toISOString(),
      page.id
    );
    console.log(`  * переименована: «${page.title}» → «${pair.newTitle}» (${pair.oldSlug} → ${pair.newSlug})`);
  }

  // -----------------------------------------------------------------------
  // 2. Ссылки в текстах
  // -----------------------------------------------------------------------

  // Сравниваем не куски текста, а слаг цели ссылки целиком: «[[Максим Святченко]]»
  // разбирается как одна цель «Максим Святченко» и никогда не превращается в
  // «Максим 1 Святченко», как вышло бы при замене подстроки «Максим». Заодно
  // сходятся написания, которые вики и так считает одной страницей («максим»,
  // «Максим», «Максим  » — слаг у всех один).
  const byOldSlug = new Map(linkable.map((p) => [p.oldSlug, p]));

  /** Возвращает новый текст или null, если менять нечего. */
  function relink(content) {
    let hits = 0;
    const next = String(content).replace(/\[\[([^[\]]+)\]\]/g, (whole, inner) => {
      const bar = inner.indexOf('|');
      const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
      const pair = byOldSlug.get(slugify(target));
      if (!pair) return whole;
      hits += 1;
      return bar >= 0 ? `[[${pair.newTitle}|${inner.slice(bar + 1)}]]` : `[[${pair.newTitle}]]`;
    });
    return hits ? { content: next, hits } : null;
  }

  let relinked = 0;
  for (const page of Pages.all()) {
    const current = Pages.currentContent(page.id);
    if (!current) continue;

    const fixed = relink(current.content);
    if (!fixed) continue;

    relinked += 1;
    if (dryRun) {
      console.log(`  ~ поправились бы ссылки: ${page.title} (${fixed.hits})`);
      continue;
    }

    const { body } = parseFrontmatter(fixed.content);
    Pages.save({
      slug: page.slug,
      title: page.title,
      content: fixed.content,
      comment: COMMENT,
      authorId: bot.id,
      categories: extractCategories(body).categories,
    });
    console.log(`  * поправлены ссылки: ${page.title} (${fixed.hits})`);
  }

  if (!dryRun && (renamed || relinked)) reindex();

  console.log(
    `\n${dryRun ? 'Переименовалось бы страниц' : 'Переименовано страниц'}: ${renamed}` +
      `, ${dryRun ? 'поправилось бы' : 'поправлено'} страниц со ссылками: ${relinked}` +
      `, конфликтов: ${conflicts}`
  );

  return { renamed, relinked, conflicts };
}

// Дальше — только CLI: при импорте из seed.js argv не читается и база не
// закрывается.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.slice(2).includes('--dry-run');

  if (!Users.byUsername(BOT_USERNAME)) {
    console.log(`В базе нет системного участника «${BOT_USERNAME}» — база пустая, переименовывать нечего.`);
  } else {
    renamePages({ dryRun });
  }

  db.close();
}
