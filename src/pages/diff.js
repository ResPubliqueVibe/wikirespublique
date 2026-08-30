import { diffLines, diffWords } from 'diff';
import { esc, wikiUrl, formatDate, csrfField } from '../layout.js';

const splitLines = (text) => {
  const s = String(text ?? '');
  const lines = s.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Word-level highlight inside a pair of changed lines. */
function inlinePair(oldLine, newLine) {
  const parts = diffWords(String(oldLine ?? ''), String(newLine ?? ''));
  let left = '';
  let right = '';
  for (const p of parts) {
    const html = esc(p.value);
    if (p.added) right += `<ins class="word">${html}</ins>`;
    else if (p.removed) left += `<del class="word">${html}</del>`;
    else {
      left += html;
      right += html;
    }
  }
  return [left, right];
}

/**
 * Build aligned two-column rows from a line diff.
 * @returns {Array<{type:string, ln:number|null, rn:number|null, left:string, right:string}>}
 */
export function buildDiffRows(oldText, newText) {
  const changes = diffLines(String(oldText ?? ''), String(newText ?? ''));
  const rows = [];
  let ln = 0;
  let rn = 0;
  let pendingDel = [];

  const flushDel = () => {
    for (const line of pendingDel) {
      ln += 1;
      rows.push({ type: 'del', ln, rn: null, left: esc(line), right: '' });
    }
    pendingDel = [];
  };

  for (const part of changes) {
    const lines = splitLines(part.value);
    if (part.removed) {
      pendingDel.push(...lines);
      continue;
    }
    if (part.added) {
      let i = 0;
      // Pair added lines with the removals immediately before them.
      while (i < lines.length && pendingDel.length) {
        const oldLine = pendingDel.shift();
        ln += 1;
        rn += 1;
        const [left, right] = inlinePair(oldLine, lines[i]);
        rows.push({ type: 'chg', ln, rn, left, right });
        i += 1;
      }
      flushDel();
      for (; i < lines.length; i++) {
        rn += 1;
        rows.push({ type: 'add', ln: null, rn, left: '', right: esc(lines[i]) });
      }
      continue;
    }
    flushDel();
    for (const line of lines) {
      ln += 1;
      rn += 1;
      rows.push({ type: 'eq', ln, rn, left: esc(line), right: esc(line) });
    }
  }
  flushDel();
  return rows;
}

/** Collapse long runs of unchanged lines, keeping `ctx` lines of context. */
function withContext(rows, ctx = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === 'eq') return;
    for (let j = Math.max(0, i - ctx); j <= Math.min(rows.length - 1, i + ctx); j++) keep[j] = true;
  });
  const out = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skipped) {
        out.push({ type: 'skip', count: skipped });
        skipped = 0;
      }
      out.push(r);
    } else {
      skipped += 1;
    }
  });
  if (skipped) out.push({ type: 'skip', count: skipped });
  return out;
}

function revHeader(rev, label, slug) {
  if (!rev) return `<th scope="col" class="diff-head">${esc(label)}</th>`;
  const who = rev.author
    ? `<a href="/user/${encodeURIComponent(rev.author)}">${esc(rev.author_name || rev.author)}</a>`
    : '<span class="anon">неизвестный</span>';
  return `<th scope="col" class="diff-head">
    <span class="diff-head-label">${esc(label)}</span>
    <a class="diff-head-date" href="${esc(wikiUrl(slug))}/rev/${esc(rev.id)}">${esc(formatDate(rev.created_at))}</a>
    <span class="diff-head-author">${who}</span>
    <span class="diff-head-comment">${rev.comment ? esc(rev.comment) : '<span class="no-comment">без описания</span>'}</span>
  </th>`;
}

/**
 * @param {object} o
 * @param {{slug:string,title:string}} o.page
 * @param {object} o.from  revision row (may be null)
 * @param {object} o.to    revision row
 */
export function diffPage({ page, from, to, user = null, csrfToken = null }) {
  const url = wikiUrl(page.slug);
  const rows = withContext(buildDiffRows(from ? from.content : '', to ? to.content : ''));
  const changed = rows.some((r) => r.type === 'add' || r.type === 'del' || r.type === 'chg');

  const body = rows
    .map((r) => {
      if (r.type === 'skip') {
        return `<tr class="diff-skip"><td colspan="4">пропущено строк без изменений: ${esc(r.count)}</td></tr>`;
      }
      const cls = `diff-${r.type}`;
      return `<tr class="${cls}">
      <td class="diff-num">${r.ln ?? ''}</td>
      <td class="diff-side diff-left">${r.left || '&nbsp;'}</td>
      <td class="diff-num">${r.rn ?? ''}</td>
      <td class="diff-side diff-right">${r.right || '&nbsp;'}</td>
    </tr>`;
    })
    .join('\n');

  const revertForm =
    user && from
      ? `<form method="post" action="${esc(url)}/revert" class="revert-form">
           ${csrfField(csrfToken)}
           <input type="hidden" name="rev" value="${esc(from.id)}">
           <button type="submit" class="btn">Восстановить старую версию</button>
         </form>`
      : '';

  return `<div class="diffview">
  <h1 class="article-title">Сравнение версий: <a href="${esc(url)}">${esc(page.title)}</a></h1>
  <p class="muted"><a href="${esc(url)}/history">← вся история правок</a></p>
  ${changed ? '' : '<div class="notice notice-info">Различий между выбранными версиями нет.</div>'}
  <table class="difftable">
    <thead><tr>
      <th scope="col" class="diff-num-head">№</th>
      ${revHeader(from, 'Старая версия', page.slug)}
      <th scope="col" class="diff-num-head">№</th>
      ${revHeader(to, 'Новая версия', page.slug)}
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
  ${revertForm}
</div>`;
}
