// 把 collectJobs 的结果渲染成一个纯静态 HTML 页面（再交给 pagecrypt 加密）。
// 不依赖任何构建工具，直接输出一个带内联 CSS/JS 的单文件。

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fmtDate = (s) => (s ? s.slice(0, 10) : '—');

/**
 * @param {object} jobs collectJobs 的返回
 * @param {object} opts
 * @param {string} [opts.generatedAt] 渲染时间（ISO）
 * @param {string} [opts.passwordHint] 密码提示（不显示密码本身）
 */
export function renderJobsWeb(jobs, opts = {}) {
  const items = jobs.items ?? [];
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const genLocal = new Date(generatedAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });

  // 按公司分组（保留原顺序）
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.companyKey)) groups.set(it.companyKey, []);
    groups.get(it.companyKey).push(it);
  }

  const companyMeta = new Map(
    (jobs.companies ?? []).map((c) => [c.key, { name: c.name, newCount: c.newCount }]),
  );

  const cards = items.map((it, i) => {
    const city = it.cityUnknown ? '城市未标注' : it.city || '—';
    const tags = (it.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const source = it.source || '';
    return `
    <article class="card" data-i="${i}">
      <header class="card-h">
        <span class="company">${esc(companyMeta.get(it.companyKey)?.name ?? it.company)}</span>
        <h3><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
      </header>
      <div class="meta">
        <span class="pill">📍 ${esc(city)}</span>
        <span class="pill">${esc(it.type || '—')}</span>
        ${it.publishedAt ? `<span class="pill">🕒 ${fmtDate(it.publishedAt)}</span>` : ''}
        ${it.department ? `<span class="pill dept">${esc(it.department)}</span>` : ''}
      </div>
      <div class="tags">${tags}</div>
      ${it.jd ? `<p class="jd">${esc(it.jd)}</p>` : ''}
      <footer class="card-f">
        <span class="src">${esc(source)}</span>
        <a class="go" href="${esc(it.url)}" target="_blank" rel="noopener">查看 →</a>
      </footer>
    </article>`;
  }).join('\n');

  const stats = (jobs.companies ?? [])
    .filter((c) => c.count > 0)
    .map((c) => `<span class="stat">${esc(c.name)} <b>${c.count}</b></span>`)
    .join('');

  const allItemsJson = JSON.stringify(items).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>实习机会 · 大模型 / AI Infra</title>
<style>
  :root {
    --bg: #f6f7fb; --card: #fff; --ink: #1c1e26; --muted: #6b7280;
    --line: #e6e8ef; --brand: #4f6ef7; --tag: #eef1ff; --tag-ink: #3d55c9;
  }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background: var(--bg); color: var(--ink); }
  header.top { position: sticky; top:0; z-index:5; background: rgba(255,255,255,.92);
               backdrop-filter: blur(8px); border-bottom:1px solid var(--line); padding:14px 20px; }
  .top-in { max-width: 980px; margin: 0 auto; display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  h1 { font-size: 17px; margin: 0; }
  h1 small { color: var(--muted); font-weight: normal; font-size: 12px; margin-left: 8px; }
  .search { flex:1; min-width: 200px; padding:8px 12px; border:1px solid var(--line); border-radius: 8px; font-size:14px; }
  .search:focus { outline:2px solid var(--brand); border-color:transparent; }
  .btn { padding:8px 14px; border:1px solid var(--line); border-radius: 8px; background: var(--card); cursor:pointer; font-size:13px; white-space:nowrap; }
  .btn.active { background: var(--brand); color:#fff; border-color:var(--brand); }
  .btn:hover { border-color: var(--brand); }
main { max-width: 980px; margin: 16px auto 60px; padding: 0 20px; }
  .stats { display:flex; flex-wrap:wrap; gap:8px; margin: 8px 0 16px; }
  .stat { background: var(--card); border:1px solid var(--line); border-radius: 999px; padding:4px 12px; font-size:12px; color: var(--muted); }
  .stat b { color: var(--ink); margin-left: 2px; }
  .grid { display:grid; gap:12px; grid-template-columns: repeat(auto-fill, minmax(300px,1fr)); }
  .card { background: var(--card); border:1px solid var(--line); border-radius: 12px; padding:14px 16px;
          display:flex; flex-direction:column; gap:8px; transition: box-shadow .15s; }
  .card:hover { box-shadow: 0 6px 20px rgba(20,30,80,.08); }
  .card-h { display:flex; flex-direction:column; gap:2px; }
  .company { font-size: 11px; color: var(--brand); font-weight:600; letter-spacing:.3px; }
  .card h3 { margin: 0; font-size: 15px; line-height:1.4; }
  .card h3 a { color: inherit; text-decoration: none; }
  .card h3 a:hover { color: var(--brand); }
  .meta { display:flex; flex-wrap:wrap; gap:6px; }
  .pill { background: var(--bg); border-radius:6px; padding:2px 8px; font-size:11px; color: var(--muted); }
  .pill.dept { color: var(--ink); }
  .tags { display:flex; flex-wrap:wrap; gap:4px; }
  .tag { background: var(--tag); color: var(--tag-ink); border-radius: 6px; padding:2px 8px; font-size:11px; }
  .jd { margin:0; color:#3b3f4c; font-size:12.5px; max-height: 4.4em; overflow:hidden; }
  .card-f { margin-top:auto; display:flex; justify-content:space-between; align-items:center; padding-top:6px; border-top:1px dashed var(--line); }
  .src { font-size:11px; color: var(--muted); }
  .go { color: var(--brand); text-decoration:none; font-size:12.5px; font-weight:600; }
  .empty { text-align:center; color:var(--muted); padding: 60px 0; }
  footer.foot { text-align:center; color: var(--muted); font-size:11.5px; padding: 20px 0 40px; }
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <h1>实习机会 <small>大模型 / AI Infra · 更新于 ${esc(genLocal)}</small></h1>
    <input class="search" id="q" placeholder="搜索岗位 / 公司 / 关键词…" autofocus>
    <button class="btn" id="btn-cd" title="成都的排前面">📍 成都优先</button>
    <button class="btn" id="btn-cd-only" title="只看成都">只看成都</button>
  </div>
</header>
<main>
  <div class="stats">${stats || '<span class="stat">暂无数据</span>'}</div>
  <div class="grid" id="grid">${cards || ''}</div>
  <div class="empty" id="empty" style="display:none">没有匹配的岗位</div>
</main>
<footer class="foot">数据源：字节 / 阿里 / 京东 / 腾讯校招官网 + 实习僧 · 由 daily-report 自动生成</footer>
<script>
  const items = ${allItemsJson};
  const grid = document.getElementById('grid');
  const cards = Array.from(grid.children);
  let cdFirst = false, cdOnly = false;

  function isChengdu(it) {
    return (it.city || '').includes('成都') || (it.cityUnknown === false && (it.city || '').includes('成都'));
  }

  function applySort() {
    const order = items.map((it, i) => i);
    if (cdFirst) {
      order.sort((a, b) => {
        const ca = isChengdu(items[a]) ? 0 : 1;
        const cb = isChengdu(items[b]) ? 0 : 1;
        return ca - cb || a - b;
      });
    }
    const frag = document.createDocumentFragment();
    for (const i of order) frag.appendChild(cards[i]);
    grid.appendChild(frag);
  }

  function applyFilter() {
    const q = document.getElementById('q').value.trim().toLowerCase();
    let shown = 0;
    cards.forEach((c, i) => {
      const it = items[i];
      const hay = [it.title, it.company, it.city, it.jd, ...(it.tags||[])].join(' ').toLowerCase();
      const okQ = !q || hay.includes(q);
      const okCd = !cdOnly || isChengdu(it);
      const ok = okQ && okCd;
      c.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    document.getElementById('empty').style.display = shown ? 'none' : 'block';
  }

  document.getElementById('q').addEventListener('input', (e) => {
    applyFilter();
  });

  document.getElementById('btn-cd').addEventListener('click', (e) => {
    cdFirst = !cdFirst;
    e.target.classList.toggle('active', cdFirst);
    applySort();
  });

  document.getElementById('btn-cd-only').addEventListener('click', (e) => {
    cdOnly = !cdOnly;
    e.target.classList.toggle('active', cdOnly);
    applyFilter();
  });
</script>
</body>
</html>`;
}
