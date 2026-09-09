import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Своя временная база и свой порт: тест поднимает настоящий сервер.
const dir = mkdtempSync(join(tmpdir(), 'rpwiki-gate-'));
process.env.DB_FILE = join(dir, 't.sqlite');
process.env.PORT = '20036';
process.env.PUBLIC_WIKI = '1';
const mediaDir = join(dir, 'media');
mkdirSync(join(mediaDir, 'private'), { recursive: true });
process.env.MEDIA_DIR = mediaDir;

const BASE = 'http://127.0.0.1:20036';
let server;

before(async () => {
  ({ server } = await import('../server.js'));
  const { Pages } = await import('../src/db.js');
  Pages.save({ slug: 'заглавная_страница', title: 'Заглавная страница', content: '# Привет' });
  Pages.save({ slug: 'денис_1', title: 'Денис 1', content: 'Личное про человека.' });
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('заглавная открыта посторонним', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Привет/);
});

test('заглавная открыта и под своим адресом, в любом написании', async () => {
  for (const slug of ['заглавная_страница', 'Заглавная_страница', 'ЗАГЛАВНАЯ_СТРАНИЦА']) {
    const res = await fetch(`${BASE}/wiki/${encodeURIComponent(slug)}`);
    assert.equal(res.status, 200, slug);
  }
});

test('статья постороннему не отдаётся — вместо неё приглашение', async () => {
  const res = await fetch(`${BASE}/wiki/${encodeURIComponent('денис_1')}`);
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.doesNotMatch(html, /Личное про человека/);
  assert.match(html, /только для своих/i);
  assert.match(html, /\/register/);
});

test('списки, поиск, категории и свежие правки тоже закрыты', async () => {
  for (const path of ['/pages', '/search?q=%D0%B0', '/category/Участники', '/changes', '/random']) {
    const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 401, path);
  }
});

test('вход и регистрация остаются доступны', async () => {
  for (const path of ['/login', '/register']) {
    assert.equal((await fetch(`${BASE}${path}`)).status, 200, path);
  }
});

test('писать посторонним нельзя', async () => {
  const res = await fetch(`${BASE}/wiki/${encodeURIComponent('денис_1')}`, { method: 'POST' });
  assert.equal(res.status, 403);
});
