/**
 * Обновляет страницы в базе до текста из src/content.js.
 *
 * Сеялка создаёт только недостающие страницы и никогда не трогает существующие,
 * поэтому правка базового текста в репозитории сама по себе на живую вики не
 * попадает. Этот скрипт дописывает новую ревизию от имени «Бота» — но только
 * если страницу с тех пор никто не правил руками: чужие правки дороже.
 *
 *   node apply.js "Эмили Зайферт"      обновить одну страницу
 *   node apply.js --all                все страницы из src/content.js
 *   node apply.js --all --dry-run      только показать, что изменилось бы
 *   node apply.js "Участники" --force  перезаписать и чужую правку
 */
import { db, Users, Pages, reindex } from './src/db.js';
import { slugify, parseFrontmatter, extractCategories } from './src/render.js';
import { PAGES, FIELD_ORDER } from './src/content.js';

const BOT_USERNAME = 'Бот';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const names = argv.filter((a) => !a.startsWith('--'));
const force = flags.has('--force');
const dryRun = flags.has('--dry-run');

if (!names.length && !flags.has('--all')) {
  console.error('Укажите название страницы или --all. Доступные страницы:');
  for (const p of PAGES) console.error(`  ${p.title}`);
  process.exit(2);
}

const targets = flags.has('--all')
  ? PAGES
  : names.map((name) => {
      const wanted = slugify(name);
      const spec = PAGES.find((p) => slugify(p.slug) === wanted || slugify(p.title) === wanted);
      if (!spec) {
        console.error(`Нет такой страницы в src/content.js: «${name}»`);
        process.exit(2);
      }
      return spec;
    });

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

// Для каждого месяца: день, с которого начинается новый знак, и сам этот знак.
// Родившийся раньше этого дня попадает под знак предыдущего месяца.
const ZODIAC = [
  [1, 20, 'Водолей'],
  [2, 19, 'Рыбы'],
  [3, 21, 'Овен'],
  [4, 20, 'Телец'],
  [5, 21, 'Близнецы'],
  [6, 21, 'Рак'],
  [7, 23, 'Лев'],
  [8, 23, 'Дева'],
  [9, 23, 'Весы'],
  [10, 23, 'Скорпион'],
  [11, 22, 'Стрелец'],
  [12, 22, 'Козерог'],
];

/** «7 июня 2009» → «Близнецы». null, если дату не разобрать. */
function zodiacFor(text) {
  const m = /^\s*(\d{1,2})\s+([а-яё]+)/i.exec(String(text ?? ''));
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  if (!month || day < 1 || day > 31) return null;
  const [, from, sign] = ZODIAC[month - 1];
  if (day >= from) return sign;
  return ZODIAC[(month + 10) % 12][2];
}

/**
 * Проверяет, что поля карточки участника идут в общем для всех биографий
 * порядке. Не блокирует запись — просто говорит, где карточка выбивается.
 */
function fieldOrderProblem(content) {
  const { meta } = parseFrontmatter(content);
  // Карточка не разобралась: YAML сломан (например, значение начинается с «%»
  // или с «*»). Молча потерять всю карточку хуже, чем громко сказать.
  if (!meta && /^---[ \t]*\r?\n/.test(String(content))) return 'карточка не разобралась: проверьте YAML';
  if (!meta || String(meta['тип'] ?? '').trim() !== 'участник') return null;

  const keys = Object.keys(meta).map((k) => String(k).trim().toLowerCase());
  const unknown = keys.filter((k) => !FIELD_ORDER.includes(k));
  const known = keys.filter((k) => FIELD_ORDER.includes(k));
  const expected = FIELD_ORDER.filter((k) => known.includes(k));
  const problems = [];
  if (known.join('|') !== expected.join('|')) problems.push(`порядок полей: ожидается ${expected.join(', ')}`);
  if (unknown.length) problems.push(`поля вне общего списка: ${unknown.join(', ')}`);

  const birth = meta['дата рождения'];
  const sign = meta['знак зодиака'];
  const computed = birth ? zodiacFor(birth) : null;
  if (birth && !sign) problems.push(`есть дата рождения, но нет знака зодиака (по дате — ${computed || '?'})`);
  if (birth && sign && computed && String(sign).trim() !== computed) {
    problems.push(`знак зодиака «${sign}» не сходится с датой «${birth}» (по дате — ${computed})`);
  }
  if (!birth && sign) problems.push('знак зодиака есть, а даты рождения нет');
  return problems.length ? problems.join('; ') : null;
}

for (const spec of PAGES) {
  const problem = fieldOrderProblem(spec.content);
  if (problem) console.warn(`  ? ${spec.title} — ${problem}`);
}

const bot = Users.byUsername(BOT_USERNAME);
if (!bot) {
  console.error(`В базе нет системного участника «${BOT_USERNAME}» — сначала запустите сеялку.`);
  process.exit(1);
}

let changed = 0;
for (const spec of targets) {
  const slug = slugify(spec.slug);
  const page = Pages.bySlug(slug);

  if (page) {
    const current = Pages.currentContent(page.id);
    if (current && current.content === spec.content) {
      console.log(`  = без изменений: ${spec.title}`);
      continue;
    }
    if (current && current.author_id !== bot.id && !force) {
      const author = Users.byId(current.author_id);
      console.log(
        `  ! пропущена: ${spec.title} — последняя правка не от «${BOT_USERNAME}»` +
          `${author ? ` (${author.display_name})` : ''}. Перезаписать: --force`
      );
      continue;
    }
  }

  if (dryRun) {
    console.log(`  ~ обновилась бы: ${spec.title}`);
    changed += 1;
    continue;
  }

  const { body } = parseFrontmatter(spec.content);
  Pages.save({
    slug,
    title: spec.title,
    content: spec.content,
    comment: spec.comment || 'Обновление из репозитория',
    authorId: bot.id,
    categories: extractCategories(body).categories,
  });
  console.log(`  ${page ? '*' : '+'} ${page ? 'обновлена' : 'создана'}: ${spec.title}`);
  changed += 1;
}

if (!dryRun && changed) reindex();
console.log(`\n${dryRun ? 'Изменилось бы страниц' : 'Изменено страниц'}: ${changed}`);
db.close();
