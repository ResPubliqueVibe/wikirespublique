#!/usr/bin/env node
// Выдача и отзыв токенов API. Работает прямо с базой в data/, которая
// примонтирована в контейнер, — пересобирать образ после выдачи не нужно.
//
//   DB_FILE=data/wiki.sqlite node scripts/api-token.js issue "имя"
//   DB_FILE=data/wiki.sqlite node scripts/api-token.js issue "Шериф" --write
//   DB_FILE=data/wiki.sqlite node scripts/api-token.js list
//   DB_FILE=data/wiki.sqlite node scripts/api-token.js revoke <id>

import { ApiTokens } from '../src/apitokens.js';

const [cmd, ...args] = process.argv.slice(2);

function usage(code = 1) {
  console.log(`Использование:
  node scripts/api-token.js issue "имя"            — только чтение
  node scripts/api-token.js issue "имя" --write    — чтение и запись от имени участника «имя»
  node scripts/api-token.js list
  node scripts/api-token.js revoke <id>`);
  process.exit(code);
}

switch (cmd) {
  case 'issue': {
    // Флаг может стоять где угодно, имя — всё остальное.
    const write = args.some((a) => a === '--write');
    const name = args.filter((a) => a !== '--write').join(' ').trim();
    if (!name) usage();
    let issued;
    try {
      issued = ApiTokens.issue(name, { scope: write ? 'write' : 'read' });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const { id, token } = issued;
    console.log(`Токен #${id} для «${name}» (${write ? 'чтение и запись' : 'только чтение'}):\n\n  ${token}\n`);
    if (write) console.log(`Правки пойдут от имени участника «${issued.author.username}» — он виден в истории страниц.`);
    console.log('Сохраните его сейчас: в базе лежит только хеш, показать токен второй раз невозможно.');
    console.log('Срока годности нет — отозвать можно только вручную: revoke ' + id);
    break;
  }
  case 'list': {
    const rows = ApiTokens.list();
    if (!rows.length) {
      console.log('Токенов нет.');
      break;
    }
    for (const r of rows) {
      const state = r.revoked_at ? `отозван ${r.revoked_at}` : 'активен';
      const right = r.scope === 'write' ? `запись (${r.author || '—'})` : 'чтение';
      console.log(
        `#${r.id}\t${r.prefix}…\t${state}\t${right}\tвызовов: ${r.calls}\tпоследний: ${r.last_used_at || '—'}\t${r.name}`
      );
    }
    break;
  }
  case 'revoke': {
    const id = Number(args[0]);
    if (!id) usage();
    console.log(ApiTokens.revoke(id) ? `Токен #${id} отозван.` : `Токен #${id} не найден или уже отозван.`);
    break;
  }
  default:
    usage(cmd ? 1 : 0);
}
