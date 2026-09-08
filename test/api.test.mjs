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
let writeToken;

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
телеграм_id: "{{123456789}}"
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
  // Пишущий токен: правки от него идут от имени участника «Шериф».
  writeToken = ApiTokens.issue('Шериф', { scope: 'write' }).token;
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

/** Изменяющий запрос. body строкой уходит как есть — так проверяется битый JSON. */
const send = (method, path, body, tok) =>
  fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

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

test('поиск по айди даёт того же участника, что и поиск по нику', async () => {
  const byId = await (await get('/api/v1/users/by-telegram-id/123456789', token)).json();
  const byNick = await (await get('/api/v1/users/by-telegram/TestNick', token)).json();
  assert.equal(byId.found, true);
  assert.deepEqual(byId.page, byNick.page);
  assert.deepEqual(byId.telegram, byNick.telegram);
});

// Айди в источнике обёрнут в {{…}} — и находиться он должен всё равно,
// иначе разметка приватности ломала бы поиск бота.
test('телеграм_id не печатается в карточке никому', async () => {
  const { renderPage } = await import('../src/render.js');
  const raw = `---
имя: Тестовый Участник
телеграм: "{{@TestNick}}"
телеграм_id: "{{123}}"
---

Текст статьи.
`;
  for (const canSeePrivate of [true, false]) {
    const { infobox } = renderPage(raw, { title: 'Тестовый Участник', canSeePrivate });
    assert.doesNotMatch(infobox, /123/, `canSeePrivate: ${canSeePrivate}`);
    assert.doesNotMatch(infobox, /телеграм_id/i, `canSeePrivate: ${canSeePrivate}`);
  }
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

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

test('read-токен на запись — 403', async () => {
  const cases = [
    ['PUT', '/api/v1/pages/новая_от_чтения', { content: 'Текст' }],
    ['PATCH', '/api/v1/pages/тестовый_участник', { append: 'Текст' }],
    ['POST', '/api/v1/pages/тестовый_участник/revert', { revision_id: 1 }],
  ];
  for (const [method, path, body] of cases) {
    const res = await send(method, path, body, token);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).error, 'forbidden');
  }
});

test('PUT создаёт страницу — 201, и она читается', async () => {
  const res = await send('PUT', '/api/v1/pages/новая_статья', {
    content: '# Новая статья\n\nПервый абзац.\n\n[[Категория:Тесты]]\n',
    comment: 'создано агентом',
  }, writeToken);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.created, true);
  assert.equal(body.title, 'Новая статья');
  assert.equal(body.previous_revision_id, null);
  assert.equal(body.url, 'https://wiki.test/wiki/новая_статья');

  const page = await (await get('/api/v1/pages/новая_статья', token)).json();
  assert.equal(page.exists, true);
  assert.equal(page.revision_id, body.revision_id);
  assert.match(page.content, /Первый абзац/);
  assert.deepEqual(page.categories, ['Тесты']);
});

test('PUT меняет страницу — 200 и previous_revision_id прежней ревизии', async () => {
  const before = await (await get('/api/v1/pages/новая_статья', token)).json();
  const res = await send('PUT', '/api/v1/pages/новая_статья', {
    content: '# Новая статья\n\nПервый абзац стал длиннее, чем был раньше.\n',
    expected_revision_id: before.revision_id,
  }, writeToken);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, false);
  assert.equal(body.previous_revision_id, before.revision_id);
  assert.notEqual(body.revision_id, before.revision_id);
});

test('неверный expected_revision_id — 409 с текущей ревизией', async () => {
  const page = await (await get('/api/v1/pages/новая_статья', token)).json();
  const res = await send('PUT', '/api/v1/pages/новая_статья', {
    content: 'Что-то совсем другое, но достаточно длинное для проверки.',
    expected_revision_id: page.revision_id + 1000,
  }, writeToken);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'conflict');
  assert.equal(body.current_revision_id, page.revision_id);
});

test('вынос текста — 409 too_much_removed, с force проходит', async () => {
  const long = 'Длинный текст статьи. '.repeat(100); // ~2200 символов
  assert.ok(long.length > 2000);
  await send('PUT', '/api/v1/pages/длинная_статья', { content: long }, writeToken);

  const short = 'Коротко.';
  const res = await send('PUT', '/api/v1/pages/длинная_статья', { content: short }, writeToken);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'too_much_removed');
  assert.equal(body.new_length, short.length);
  assert.ok(body.old_length > body.new_length);

  const forced = await send('PUT', '/api/v1/pages/длинная_статья', { content: short, force: true }, writeToken);
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).ok, true);
});

test('пустой content — 400 даже с force', async () => {
  for (const body of [{ content: '' }, { content: '   \n  ', force: true }]) {
    const res = await send('PUT', '/api/v1/pages/новая_статья', body, writeToken);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'empty_content');
  }
  const res = await send('PUT', '/api/v1/pages/новая_статья', { comment: 'без текста' }, writeToken);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
});

test('PATCH card добавляет и удаляет ключи, порядок — по FIELD_ORDER', async () => {
  await send('PUT', '/api/v1/pages/карточная', {
    content: '---\nгород: Ереван\nрост: 180\nпрозвище: Шляпа\n---\n\nТело статьи не трогаем.\n',
  }, writeToken);

  const res = await send('PATCH', '/api/v1/pages/карточная', {
    card: { имя: 'Икс', город: 'Берлин', рост: null, 'любимый цвет': 'синий' },
  }, writeToken);
  assert.equal(res.status, 200);

  const page = await (await get('/api/v1/pages/карточная', token)).json();
  const { meta } = (await import('../src/render.js')).parseFrontmatter(page.content);
  assert.deepEqual(Object.keys(meta), ['имя', 'город', 'прозвище', 'любимый цвет']);
  assert.equal(meta['город'], 'Берлин');
  assert.equal(meta['рост'], undefined);
  assert.match(page.content, /Тело статьи не трогаем\./);
});

test('PATCH section дописывает в нужный раздел и заводит новый', async () => {
  await send('PUT', '/api/v1/pages/разделы', {
    content: '# Разделы\n\n## Работа\n\nРаботал тут.\n\n## Хобби\n\nСобирает марки.\n',
  }, writeToken);

  await send('PATCH', '/api/v1/pages/разделы', {
    section: { heading: 'работа', content: 'А потом ушёл.', mode: 'append' },
  }, writeToken);
  let page = await (await get('/api/v1/pages/разделы', token)).json();
  assert.match(page.content, /Работал тут\.\n\nА потом ушёл\./);
  assert.match(page.content, /## Хобби\n\nСобирает марки\./);

  const res = await send('PATCH', '/api/v1/pages/разделы', {
    section: { heading: 'Слухи', content: 'Говорят разное.' },
  }, writeToken);
  assert.equal(res.status, 200);
  page = await (await get('/api/v1/pages/разделы', token)).json();
  assert.match(page.content, /## Слухи\n\nГоворят разное\./);
  assert.ok(page.content.indexOf('## Слухи') > page.content.indexOf('## Хобби'));
});

test('PATCH append дописывает в конец', async () => {
  const res = await send('PATCH', '/api/v1/pages/разделы', { append: 'Совсем в конец.' }, writeToken);
  assert.equal(res.status, 200);
  const page = await (await get('/api/v1/pages/разделы', token)).json();
  assert.match(page.content, /Совсем в конец\.\n$/);
});

test('PATCH несуществующей страницы — 404, страница не заводится', async () => {
  const res = await send('PATCH', '/api/v1/pages/такой_нет', { append: 'Текст' }, writeToken);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.exists, false);
  assert.equal(body.title, 'Такой нет');
  assert.equal((await get('/api/v1/pages/такой_нет', token)).status, 404);
});

test('revert возвращает прежний текст новой ревизией', async () => {
  await send('PUT', '/api/v1/pages/откатная', { content: 'Первая версия текста.\n' }, writeToken);
  const first = await (await get('/api/v1/pages/откатная', token)).json();
  await send('PUT', '/api/v1/pages/откатная', { content: 'Вторая версия текста.\n' }, writeToken);

  const res = await send('POST', '/api/v1/pages/откатная/revert', { revision_id: first.revision_id }, writeToken);
  assert.equal(res.status, 200);
  const page = await (await get('/api/v1/pages/откатная', token)).json();
  assert.equal(page.content, 'Первая версия текста.\n');

  const history = await (await get('/api/v1/pages/откатная/history', token)).json();
  assert.equal(history.revisions.length, 3);
  assert.equal(history.revisions[0].id, page.revision_id);

  const alien = await send('POST', '/api/v1/pages/откатная/revert', {
    revision_id: (await (await get('/api/v1/pages/разделы', token)).json()).revision_id,
  }, writeToken);
  assert.equal(alien.status, 400);
  assert.equal((await alien.json()).error, 'bad_revision');
});

test('автор правки — участник токена, правка видна в /v1/changes', async () => {
  const history = await (await get('/api/v1/pages/откатная/history', token)).json();
  assert.equal(history.revisions[0].author, 'Шериф');

  const changes = await (await get('/api/v1/changes?limit=20', token)).json();
  const mine = changes.changes.find((c) => c.slug === 'откатная');
  assert.ok(mine);
  assert.equal(mine.author, 'Шериф');
  assert.equal(mine.url, 'https://wiki.test/wiki/откатная');
  assert.ok(mine.revision_id > 0);
});

test('списки, история, ревизия и поиск отдают ожидаемое', async () => {
  const list = await (await get('/api/v1/pages?limit=500', token)).json();
  assert.ok(list.count >= list.pages.length);
  const one = list.pages.find((p) => p.slug === 'новая_статья');
  assert.ok(one);
  assert.equal(one.url, 'https://wiki.test/wiki/новая_статья');
  assert.ok(one.size > 0);
  assert.ok(one.revision_id > 0);
  // Служебные страницы из списка не выкидываются — агенту нужен и шаблон.
  assert.ok(list.pages.some((p) => p.slug.includes(':')));

  const paged = await (await get('/api/v1/pages?limit=1&offset=1', token)).json();
  assert.equal(paged.pages.length, 1);
  assert.equal(paged.count, list.count);
  assert.notEqual(paged.pages[0].slug, list.pages[0].slug);

  const hist = await (await get('/api/v1/pages/новая_статья/history', token)).json();
  assert.equal(hist.slug, 'новая_статья');
  assert.ok(hist.revisions.length >= 2);
  assert.ok(hist.revisions[0].id > hist.revisions[1].id);

  const rev = await (await get(`/api/v1/revisions/${hist.revisions.at(-1).id}`, token)).json();
  assert.equal(rev.slug, 'новая_статья');
  assert.equal(rev.comment, 'создано агентом');
  assert.match(rev.content, /Первый абзац/);

  const found = await (await get('/api/v1/search?q=Собирает', token)).json();
  assert.equal(found.query, 'Собирает');
  assert.equal(found.count, found.results.length);
  const hit = found.results.find((r) => r.slug === 'разделы');
  assert.ok(hit);
  assert.match(hit.snippet, /Собирает марки/);
});

test('приватная разметка в content не раскрыта, а в text — раскрыта', async () => {
  const page = await (await get('/api/v1/pages/тестовый_участник', token)).json();
  assert.match(page.content, /\{\{секрет\}\}/);
  assert.match(page.content, /телеграм: "\{\{@TestNick\}\}"/);
  assert.match(page.text, /спрятан секрет от посторонних/);
  assert.doesNotMatch(page.text, /\{\{/);
  assert.equal(page.card['телеграм'], '@TestNick');
});

test('битый JSON — 400 bad_json, а не 500', async () => {
  const res = await send('PUT', '/api/v1/pages/новая_статья', '{ "content": ', writeToken);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_json');
});

test('несуществующая страница — 404 с угаданным заголовком', async () => {
  const res = await get('/api/v1/pages/нет_такой_страницы', token);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.exists, false);
  assert.equal(body.error, 'not_found');
  assert.equal(body.title, 'Нет такой страницы');
});
