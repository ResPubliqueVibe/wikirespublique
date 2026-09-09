import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Сайт закрыт от поисковиков и ИИ-краулеров: см. src/crawlers.js.
const dir = mkdtempSync(join(tmpdir(), 'rpwiki-crawl-'));
process.env.DB_FILE = join(dir, 't.sqlite');
process.env.PORT = '20036';
process.env.PUBLIC_WIKI = '1';

const BASE = 'http://127.0.0.1:20036';
let server;

before(async () => {
  ({ server } = await import('../server.js'));
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path, ua) =>
  fetch(`${BASE}${path}`, { redirect: 'manual', headers: ua ? { 'user-agent': ua } : {} });

test('robots.txt отдаётся и запрещает ИИ-краулерам всё', async () => {
  const res = await get('/robots.txt');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /User-agent: GPTBot\nDisallow: \//);
  assert.match(body, /User-agent: ClaudeBot\nDisallow: \//);
  assert.match(body, /Disallow: \/media\/private\//);
});

test('robots.txt виден и боту, и гостю без входа', async () => {
  assert.equal((await get('/robots.txt', 'GPTBot/1.1')).status, 200);
});

test('известные боты получают 403', async () => {
  for (const ua of ['Mozilla/5.0 (compatible; GPTBot/1.1)', 'ClaudeBot/1.0', 'CCBot/2.0', 'SemrushBot']) {
    const res = await get('/', ua);
    assert.equal(res.status, 403, ua);
  }
});

test('обычный браузер проходит и получает noindex', async () => {
  const res = await get('/', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0');
  assert.notEqual(res.status, 403);
  assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  if (res.status === 200) assert.match(await res.text(), /<meta name="robots" content="noindex/);
});
