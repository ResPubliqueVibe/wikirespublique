import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Вики с открытым чтением (PUBLIC_WIKI=1): постороннему видна одна заглавная
// страница, всё остальное — приглашение войти. История правок закрыта тем же
// замком; проверяем и маршруты, и то, что ссылок на них гостю не видно.
const dir = mkdtempSync(join(tmpdir(), 'rpwiki-hist-'));
process.env.DB_FILE = join(dir, 't.sqlite');
process.env.PORT = '20035';
process.env.PUBLIC_WIKI = '1';

const BASE = 'http://127.0.0.1:20035';
const SLUG = 'тестовая_страница';

let server;

before(async () => {
  ({ server } = await import('../server.js'));
  const { Pages } = await import('../src/db.js');
  Pages.save({ slug: SLUG, title: 'Тестовая страница', content: 'Текст статьи.' });
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path) => fetch(`${BASE}${path}`, { redirect: 'manual' });
const wiki = `/wiki/${encodeURIComponent(SLUG)}`;

test('гостю закрыты и статья, и история правок', async () => {
  const article = await get(wiki);
  assert.equal(article.status, 401);
  assert.ok(!(await article.text()).includes('Текст статьи.'));

  for (const path of ['/changes', `${wiki}/history`, `${wiki}/diff`, `${wiki}/rev/1`]) {
    assert.equal((await get(path)).status, 401, path);
  }
});

test('гостю не показываем ссылок на историю', async () => {
  const html = await (await get('/')).text();
  assert.ok(!html.includes('Свежие правки'), 'в навигации не должно быть свежих правок');
  assert.ok(!html.includes('/history'), 'вкладки «История» быть не должно');
});
