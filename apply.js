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
import { PAGES } from './src/content.js';

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
