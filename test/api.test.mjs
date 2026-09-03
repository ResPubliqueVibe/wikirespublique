import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Своя временная база: тесты не должны трогать рабочую data/wiki.sqlite.
const dir = mkdtempSync(join(tmpdir(), 'rpwiki-api-'));
process.env.DB_FILE = join(dir, 't.sqlite');
process.env.PORT = '20034';
process.env.SITE_URL = 'https://wiki.test';
// Свой каталог с картинками: раздача /api/v1/media берёт MEDIA_DIR при импорте,
// поэтому выставляем до загрузки server.js.
const mediaDir = join(dir, 'media');
mkdirSync(join(mediaDir, 'private'), { recursive: true });
process.env.MEDIA_DIR = mediaDir;
const photoBytes = Buffer.from('\x89PNG\r\n\x1a\nтестовая картинка', 'utf8');
writeFileSync(join(mediaDir, 'x.jpg'), photoBytes);

const BASE = 'http://127.0.0.1:20034';

let server;
let ApiTokens;
let token;
let revokedToken;

before(async () => {
  ({ server } = await import('../server.js'));
  ({ ApiTokens } = await import('../src/apitokens.js'));
  const { Pages } = await import('../src/db.js');

  Pages.save({
    slug: 'тестовый_участник',
    title: 'Тестовый Участник',
    content: `---
имя: Тестовый Участник
город: Ереван
телеграм: "{{@TestNick}}"
телеграм_id: 123456789
---

Первый абзац про участника, он же краткое описание.

Второй абзац, в котором спрятан {{секрет}} от посторонних.

[[Категория:Участники]]
`,
    comment: 'тест',
    authorId: null,
    categories: ['Участники'],
  });

  Pages.save({
    slug: 'участник_с_фото',
    title: 'Участник С Фото',
    content: `---
имя: Участник С Фото
фото: /media/x.jpg
подпись: Подпись под фотографией
телеграм: "@WithPhoto"
---

Текст.
`,
    comment: 'тест',
    authorId: null,
    categories: [],
  });

  Pages.save({
    slug: 'участник_с_приватным_фото',
    title: 'Участник С Приватным Фото',
    content: `---
имя: Участник С Приватным Фото
фото: /media/private/y.jpg
телеграм: "@PrivatePhoto"
---

Текст.
`,
    comment: 'тест',
    authorId: null,
    categories: [],
  });

  // Служебная страница: ник в ней — из образца карточки, а не живого человека.
  Pages.save({
    slug: 'шаблон:тест',
    title: 'Шаблон:Тест',
    content: `---
телеграм: "@nickname"
---

Образец карточки.
`,
    comment: 'тест',
    authorId: null,
    categories: [],
  });

  token = ApiTokens.issue('тест').token;
  const revoked = ApiTokens.issue('отозванный');
  ApiTokens.revoke(revoked.id);
  revokedToken = revoked.token;

  // Сервер поднимается асинхронно — дожидаемся, иначе первый fetch промахнётся.
  if (!server.listening) await new Promise((r) => server.once('listening', r));
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path, tok) =>
  fetch(BASE + path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });

test('без заголовка Authorization — 401', async () => {
  const res = await get('/api/v1/users/by-telegram/TestNick');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

test('мусорный токен — 401', async () => {
  const res = await get('/api/v1/users/by-telegram/TestNick', 'rpw_deadbeef');
  assert.equal(res.status, 401);
});

test('отозванный токен — 401', async () => {
  const res = await get('/api/v1/users/by-telegram/TestNick', revokedToken);
  assert.equal(res.status, 401);
});

test('ник находится, карточка раскрыта', async () => {
  const res = await get('/api/v1/users/by-telegram/TestNick', token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.found, true);
  assert.equal(body.page.title, 'Тестовый Участник');
  assert.equal(body.page.url, 'https://wiki.test/wiki/тестовый_участник');
  assert.deepEqual(body.page.categories, ['Участники']);
  assert.equal(body.card['телеграм'], '@TestNick');
  assert.equal(body.card['город'], 'Ереван');
  assert.equal(body.telegram.username, 'TestNick');
  assert.equal(body.summary, 'Первый абзац про участника, он же краткое описание.');
});

test('регистр и @ в пути не влияют', async () => {
  for (const path of ['/api/v1/users/by-telegram/testnick', '/api/v1/users/by-telegram/@TESTNICK']) {
    const body = await (await get(path, token)).json();
    assert.equal(body.found, true, path);
    assert.equal(body.page.slug, 'тестовый_участник');
  }
});

test('несуществующий ник — 404 и found:false', async () => {
  const res = await get('/api/v1/users/by-telegram/НетТакого', token);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.found, false);
  assert.equal(body.error, 'not_found');
});

test('поиск по телеграм_id', async () => {
  const res = await get('/api/v1/users/by-telegram-id/123456789', token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.page.slug, 'тестовый_участник');
  assert.equal(body.telegram.id, '123456789');
});

test('список участников', async () => {
  const body = await (await get('/api/v1/users', token)).json();
  assert.equal(body.count, body.users.length);
  const one = body.users.find((u) => u.page.slug === 'тестовый_участник');
  assert.ok(one);
  assert.equal(one.telegram.username, 'TestNick');
  assert.equal(one.photo_url, null);
  const withPhoto = body.users.find((u) => u.page.slug === 'участник_с_фото');
  assert.equal(withPhoto.photo_url, 'https://wiki.test/api/v1/media/x.jpg');
});

test('приватный кусок в тексте приходит раскрытым', async () => {
  const body = await (await get('/api/v1/users/by-telegram/TestNick', token)).json();
  assert.match(body.text, /спрятан секрет от посторонних/);
  assert.match(body.plain, /спрятан секрет от посторонних/);
  assert.doesNotMatch(body.text, /█/);
});

test('фотография отдаётся адресом через API', async () => {
  const body = await (await get('/api/v1/users/by-telegram/WithPhoto', token)).json();
  assert.equal(body.photo.url, 'https://wiki.test/api/v1/media/x.jpg');
  assert.equal(body.photo.site_url, 'https://wiki.test/media/x.jpg');
  assert.equal(body.photo.private, false);
  assert.equal(body.photo.caption, 'Подпись под фотографией');
  // card.фото — по-прежнему адрес сайта, а подпись остаётся текстом.
  assert.equal(body.card['фото'], 'https://wiki.test/media/x.jpg');
  assert.equal(body.card['подпись'], 'Подпись под фотографией');
});

test('фотография из private помечена приватной', async () => {
  const body = await (await get('/api/v1/users/by-telegram/PrivatePhoto', token)).json();
  assert.equal(body.photo.private, true);
  assert.equal(body.photo.url, 'https://wiki.test/api/v1/media/private/y.jpg');
  assert.equal(body.photo.caption, null);
});

test('фотографии нет — photo: null', async () => {
  const body = await (await get('/api/v1/users/by-telegram/TestNick', token)).json();
  assert.equal(body.photo, null);
});

test('файл качается по токену и совпадает байт в байт', async () => {
  const res = await get('/api/v1/media/x.jpg', token);
  assert.equal(res.status, 200);
  const got = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(got, readFileSync(join(mediaDir, 'x.jpg')));
  assert.match(res.headers.get('cache-control') || '', /private/);
});

test('файл без токена — 401', async () => {
  const res = await get('/api/v1/media/x.jpg');
  assert.equal(res.status, 401);
});

test('несуществующий файл — 404', async () => {
  const res = await get('/api/v1/media/нет-такого.jpg', token);
  assert.equal(res.status, 404);
});

test('обход каталога не выпускает наружу', async () => {
  for (const path of ['/api/v1/media/..%2F..%2Fserver.js', '/api/v1/media/../package.json']) {
    const res = await get(path, token);
    assert.equal(res.status, 404, path);
    const text = await res.text();
    assert.doesNotMatch(text, /express|apiRouter|res-publique-wiki/, path);
  }
});

test('служебная страница с двоеточием в slug не участник', async () => {
  const list = await (await get('/api/v1/users', token)).json();
  assert.equal(list.users.some((u) => u.page.slug.includes(':')), false);
  const res = await get('/api/v1/users/by-telegram/nickname', token);
  assert.equal(res.status, 404);
});
