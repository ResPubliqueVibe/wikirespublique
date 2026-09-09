// Сайт не должен попадать в поисковую выдачу и в обучающие выборки ИИ.
// Три слоя, каждый нужен отдельно:
//   1. X-Robots-Tag / <meta robots> — по этому поисковики выкидывают уже
//      проиндексированные страницы. Запрет в robots.txt тут только мешает:
//      бот не зайдёт и не увидит noindex, а ссылка в выдаче останется.
//   2. robots.txt — просьба к ИИ-краулерам, которые noindex не смотрят.
//   3. 403 по User-Agent — для тех, кто robots.txt читает, но игнорирует.
// Скрапера, представляющегося браузером, ничего из этого не остановит.

/** Боты, которым тут делать нечего: ИИ-краулеры и агрегаторы. */
const BLOCKED_AGENTS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
  'ClaudeBot', 'Claude-Web', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'CCBot', 'PerplexityBot', 'Perplexity-User',
  'Google-Extended', 'GoogleOther', 'Applebot-Extended',
  'Bytespider', 'Amazonbot', 'Meta-ExternalAgent', 'Meta-ExternalFetcher',
  'FacebookBot', 'cohere-ai', 'Diffbot', 'omgili', 'omgilibot',
  'ImagesiftBot', 'YouBot', 'AI2Bot', 'Timpibot', 'Webzio-Extended',
  'PetalBot', 'DataForSeoBot', 'SemrushBot', 'AhrefsBot', 'MJ12bot',
  'DotBot', 'Scrapy', 'python-requests',
];

const BLOCKED_RE = new RegExp(
  BLOCKED_AGENTS.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i'
);

export const ROBOTS_TXT = [
  ...BLOCKED_AGENTS.map((a) => `User-agent: ${a}\nDisallow: /`),
  // Поисковикам ходить не запрещаем: им нужно увидеть noindex, иначе
  // страницы так и останутся в индексе.
  'User-agent: *\nDisallow: /api/\nDisallow: /media/private/',
].join('\n\n') + '\n';

export function isBlockedAgent(ua) {
  return typeof ua === 'string' && ua !== '' && BLOCKED_RE.test(ua);
}

/** Отдаёт robots.txt, режет известных ботов и вешает noindex на всё остальное. */
export function crawlerMiddleware(req, res, next) {
  if (req.path === '/robots.txt') {
    res.type('text/plain; charset=utf-8').send(ROBOTS_TXT);
    return;
  }
  // /api не режем по User-Agent: там всё равно нужен токен, а под скрипт
  // клиента (python-requests и прочее) попасть в чёрный список легко.
  if (!req.path.startsWith('/api') && isBlockedAgent(req.get('user-agent'))) {
    res.status(403).type('text/plain; charset=utf-8').send('Not for bots.\n');
    return;
  }
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  next();
}
