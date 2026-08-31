import crypto from 'node:crypto';

import { db, Users, Pages, reindex } from './src/db.js';
import { hashPassword } from './src/auth.js';
import { slugify, parseFrontmatter, extractCategories } from './src/render.js';
import { PAGES } from './src/content.js';

const BOT_USERNAME = 'Бот';

function ensureBot() {
  let bot = Users.byUsername(BOT_USERNAME);
  if (bot) return bot;
  // Unguessable random password: the account is for authorship attribution only.
  const password = crypto.randomBytes(32).toString('hex');
  bot = Users.create(BOT_USERNAME, hashPassword(password), BOT_USERNAME, 0, true);
  console.log(`  + создан системный участник «${BOT_USERNAME}»`);
  return bot;
}

function categoriesFor(content) {
  const { body } = parseFrontmatter(content);
  return extractCategories(body).categories;
}

function seed() {
  const bot = ensureBot();
  let created = 0;
  let skipped = 0;

  for (const spec of PAGES) {
    const slug = slugify(spec.slug);
    if (!slug) throw new Error(`Пустой слаг для «${spec.title}»`);
    if (Pages.exists(slug)) {
      skipped += 1;
      console.log(`  = уже есть: ${spec.title} (${slug})`);
      continue;
    }
    Pages.save({
      slug,
      title: spec.title,
      content: spec.content,
      comment: spec.comment,
      authorId: bot.id,
      categories: categoriesFor(spec.content),
    });
    created += 1;
    console.log(`  + создана: ${spec.title} (${slug})`);
  }

  reindex();

  const total = Pages.count();
  console.log(`\nСоздано: ${created}, пропущено (уже существовали): ${skipped}`);
  console.log(`Всего страниц в базе: ${total}`);
  console.log(`Всего участников в базе: ${Users.count()}`);
  return total;
}

seed();
db.close();
