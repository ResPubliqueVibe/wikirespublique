#!/usr/bin/env node
// Выдача и отзыв токенов API. Работает прямо с базой в data/, которая
// примонтирована в контейнер, — пересобирать образ после выдачи не нужно.
//
//   DB_FILE=data/wiki.sqlite node scripts/api-token.js issue "имя"
//   DB_FILE=data/wiki.sqlite node scripts/api-token.js list
//   DB_FILE=data/wiki.sqlite node scripts/api-token.js revoke <id>

import { ApiTokens } from '../src/apitokens.js';

const [cmd, ...args] = process.argv.slice(2);

function usage(code = 1) {
  console.log(`Использование:
  node scripts/api-token.js issue "имя"
  node scripts/api-token.js list
  node scripts/api-token.js revoke <id>`);
  process.exit(code);
}

switch (cmd) {
  case 'issue': {
    const name = args.join(' ').trim();
    if (!name) usage();
    const { id, token } = ApiTokens.issue(name);
    console.log(`Токен #${id} для «${name}»:\n\n  ${token}\n`);
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
      console.log(
        `#${r.id}\t${r.prefix}…\t${state}\tвызовов: ${r.calls}\tпоследний: ${r.last_used_at || '—'}\t${r.name}`
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
