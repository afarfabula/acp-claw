// 把 collectJobs 的结果渲染成一个纯静态 HTML 页面（再交给 pagecrypt 加密）。
// 不依赖任何构建工具，直接输出一个带内联 CSS/JS 的单文件。
//
// 2026-10-15 改版：筛选面板重做
//   · 顶部 sticky 栏：搜索 + 排序（默认 / 最新发布 / 成都优先）+ 只看新增 + 重置 + 结果计数
//   · 多维筛选 chips（公司 / 方向 / 城市 / 类型 / 来源）：组内 OR、组间 AND
//   · 数量徽章联动：每个值显示「其它条件不变、选中它还能命中几条」
//   · 卡片带「新增」标记；移动端自适应

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');

/**
 * @param {object} jobs collectJobs 的返回（items / companies / newItems …）
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] 渲染时间（ISO）
 */
export function renderJobsWeb(jobs, opts = {}) {
  const items = jobs.items ?? [];
  const newIds = (jobs.newItems ?? []).map((it) => it.id).filter(Boolean);
  const newSet = new Set(newIds);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const genLocal = new Date(generatedAt).toLocaleString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });

  const companyNames = {};
  for (const c of jobs.companies ?? []) companyNames[c.key] = c.name;

  const cards = items
    .map((it, i) => {
      const city = it.cityUnknown ? '城市未标注' : it.city || '—';
      const tags = (it.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
      const company = companyNames[it.companyKey] ?? it.company ?? '—';
      const isNew = newSet.has(it.id);
      return `
    <article class="card" data-i="${i}">
      <header class="card-h">
        <span class="company">${esc(company)}${isNew ? '<span class="badge-new">新增</span>' : ''}</span>
        <h3><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
      </header>
      <div class="meta">
        <span class="pill">📍 ${esc(city)}</span>
        <span class="pill">${esc(it.type || '—')}</span>
        ${it.publishedAt ? `<span class="pill">🕒 ${fmtDate(it.publishedAt)}</span>` : ''}
        ${it.department ? `<span class="pill dept">${esc(it.department)}</span>` : ''}
        ${it.salary ? `<span class="pill">💰 ${esc(it.salary)}</span>` : ''}
      </div>
      <div class="tags">${tags}</div>
      ${it.jd ? `<p class="jd">${esc(it.jd)}</p>` : ''}
      <footer class="card-f">
        <span class="src">${esc(it.source || '')}</span>
        <a class="go" href="${esc(it.url)}" target="_blank" rel="noopener">查看 →</a>
      </footer>
    </article>`;
    })
    .join('\n');

  const withLt = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const itemsJson = withLt(items);
  const companyNamesJson = withLt(companyNames);
  const newIdsJson = withLt(newIds);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>实习机会 · 大模型 / AI Infra</title>
<style>
  :root {
    --bg: #f5f6fb; --card: #fff; --ink: #1b1e28; --muted: #6b7280; --line: #e5e7f0;
    --brand: #4f6ef7; --brand-soft: #eef1ff; --tag: #eef1ff; --tag-ink: #3d55c9;
    --new: #e5484d; --new-soft: #ffecec;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background: var(--bg); color: var(--ink); }
  header.top { position: sticky; top: 0; z-index: 5; background: rgba(255,255,255,.94);
               backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
  .top-in { max-width: 1040px; margin: 0 auto; padding: 12px 20px 8px;
            display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .brand { display: flex; flex-direction: column; gap: 2px; margin-right: auto; }
  h1 { font-size: 17px; margin: 0; }
  h1 small { color: var(--muted); font-weight: normal; font-size: 12px; margin-left: 6px; }
  .sub { font-size: 12px; color: var(--muted); }
  .sub b { color: var(--ink); }
  .tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .search { width: 260px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px;
            font-size: 14px; background: var(--card); }
  .search:focus { outline: 2px solid var(--brand); border-color: transparent; }
  .seg { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--card); }
  .seg-btn { border: 0; background: transparent; padding: 8px 12px; font-size: 13px; cursor: pointer;
             color: var(--muted); white-space: nowrap; }
  .seg-btn + .seg-btn { border-left: 1px solid var(--line); }
  .seg-btn.active { background: var(--brand); color: #fff; }
  .btn { padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--card);
         cursor: pointer; font-size: 13px; white-space: nowrap; }
  .btn:hover { border-color: var(--brand); color: var(--brand); }
  .btn.active { background: var(--brand); color: #fff; border-color: var(--brand); }
  .btn.ghost { color: var(--muted); }
  .btn .cnt { font-size: 11px; background: var(--new-soft); color: var(--new);
              border-radius: 999px; padding: 0 6px; margin-left: 4px; }
  .facets { max-width: 1040px; margin: 0 auto; padding: 0 20px 10px;
            display: flex; flex-direction: column; gap: 6px; }
  .facet { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .facet-label { font-size: 12px; color: var(--muted); min-width: 58px; }
  .chip { border: 1px solid var(--line); background: var(--card); border-radius: 999px;
          padding: 3px 10px; font-size: 12.5px; cursor: pointer; color: var(--ink);
          display: inline-flex; align-items: center; gap: 5px; }
  .chip b { font-weight: 600; color: var(--muted); font-size: 11.5px; }
  .chip:hover { border-color: var(--brand); color: var(--brand); }
  .chip.on { background: var(--brand); border-color: var(--brand); color: #fff; }
  .chip.on b { color: rgba(255,255,255,.85); }
  .chip.off { opacity: .45; }
  main { max-width: 1040px; margin: 14px auto 60px; padding: 0 20px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
          padding: 14px 16px; display: flex; flex-direction: column; gap: 8px;
          transition: box-shadow .15s; }
  .card:hover { box-shadow: 0 6px 20px rgba(20,30,80,.08); }
  .card-h { display: flex; flex-direction: column; gap: 2px; }
  .company { font-size: 11px; color: var(--brand); font-weight: 600; letter-spacing: .3px;
             display: flex; align-items: center; gap: 6px; }
  .badge-new { background: var(--new-soft); color: var(--new); border-radius: 4px;
               padding: 0 5px; font-size: 10.5px; font-weight: 600; }
  .card h3 { margin: 0; font-size: 15px; line-height: 1.4; }
  .card h3 a { color: inherit; text-decoration: none; }
  .card h3 a:hover { color: var(--brand); }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; }
  .pill { background: var(--bg); border-radius: 6px; padding: 2px 8px; font-size: 11px; color: var(--muted); }
  .pill.dept { color: var(--ink); }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag { background: var(--tag); color: var(--tag-ink); border-radius: 6px; padding: 2px 8px; font-size: 11px; }
  .jd { margin: 0; color: #3b3f4c; font-size: 12.5px; max-height: 4.4em; overflow: hidden; }
  .card-f { margin-top: auto; display: flex; justify-content: space-between; align-items: center;
            padding-top: 6px; border-top: 1px dashed var(--line); }
  .src { font-size: 11px; color: var(--muted); }
  .go { color: var(--brand); text-decoration: none; font-size: 12.5px; font-weight: 600; }
  .empty { text-align: center; color: var(--muted); padding: 60px 0; }
  footer.foot { text-align: center; color: var(--muted); font-size: 11.5px; padding: 20px 0 40px; }
  @media (max-width: 720px) {
    .brand { width: 100%; }
    .search { width: 100%; }
    .facet-label { min-width: 100%; }
  }
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <div class="brand">
      <h1>实习机会 <small>大模型 / AI Infra</small></h1>
      <div class="sub">更新于 ${esc(genLocal)} · 共 <b>${items.length}</b> 条 · 当前显示 <b id="shown">${items.length}</b> 条</div>
    </div>
    <div class="tools">
      <input class="search" id="q" placeholder="搜索岗位 / 公司 / 关键词 / JD…">
      <div class="seg" id="sort">
        <button class="seg-btn active" data-sort="default">默认</button>
        <button class="seg-btn" data-sort="newest">最新发布</button>
        <button class="seg-btn" data-sort="chengdu">📍 成都优先</button>
      </div>
      <button class="btn" id="only-new" hidden>✨ 只看新增<span class="cnt" id="new-cnt">0</span></button>
      <button class="btn ghost" id="reset">重置</button>
    </div>
  </div>
  <div class="facets" id="facets"></div>
</header>
<main>
  <div class="grid" id="grid">${cards}</div>
  <div class="empty" id="empty" style="display:none">没有匹配的岗位，试试放宽筛选条件</div>
</main>
<footer class="foot">数据源：字节 / 阿里 / 京东 / 腾讯校招官网 + 实习僧 · 由 daily-report 自动生成</footer>
<script>
(function () {
  var items = ${itemsJson};
  var companyNames = ${companyNamesJson};
  var newIds = ${newIdsJson};
  var newSet = new Set(newIds);

  var GROUPS = [
    { key: 'company', label: '🏢 公司' },
    { key: 'tags', label: '🎯 方向' },
    { key: 'city', label: '📍 城市' },
    { key: 'type', label: '🧩 类型' },
    { key: 'source', label: '📡 来源' }
  ];

  var state = {
    q: '',
    sort: 'default',
    onlyNew: false,
    sel: { company: new Set(), tags: new Set(), city: new Set(), type: new Set(), source: new Set() }
  };

  function splitValues(v) {
    return String(v == null ? '' : v)
      .split(/[\\/、,，]/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function itemValues(it, key) {
    if (key === 'company') return [companyNames[it.companyKey] || it.company || '未标注'];
    if (key === 'tags') {
      var ts = it.tags || [];
      return ts.length ? ts.slice() : ['未标注'];
    }
    if (key === 'city') {
      if (it.cityUnknown) return ['未标注'];
      var cs = splitValues(it.city);
      return cs.length ? cs : ['未标注'];
    }
    if (key === 'type') return [it.type || '未标注'];
    if (key === 'source') return [it.source || '未标注'];
    return [];
  }

  var HAY = items.map(function (it) {
    return [it.title, it.company, it.city, it.department, it.type, it.source,
            it.salary, it.degree, it.requirement, it.jd, (it.tags || []).join(' ')]
      .join(' ').toLowerCase();
  });

  var VALUES = items.map(function (it) {
    var o = {};
    for (var gi = 0; gi < GROUPS.length; gi++) o[GROUPS[gi].key] = itemValues(it, GROUPS[gi].key);
    return o;
  });

  // 每组里出现过的全部取值（用于始终显示所有 chip，计数为 0 时灰显）
  var ALL_VALUES = {};
  for (var agi = 0; agi < GROUPS.length; agi++) {
    var gk = GROUPS[agi].key;
    var seenV = {};
    var listV = [];
    for (var ai = 0; ai < items.length; ai++) {
      var vs = VALUES[ai][gk];
      for (var avi = 0; avi < vs.length; avi++) {
        if (!seenV[vs[avi]]) { seenV[vs[avi]] = 1; listV.push(vs[avi]); }
      }
    }
    ALL_VALUES[gk] = listV;
  }

  // skipKey：忽略某一组自己的勾选（用于算该组的联动计数）
  function matches(i, skipKey) {
    if (state.onlyNew && !newSet.has(items[i].id)) return false;
    if (state.q && HAY[i].indexOf(state.q) < 0) return false;
    for (var gi = 0; gi < GROUPS.length; gi++) {
      var g = GROUPS[gi];
      if (g.key === skipKey) continue;
      var sel = state.sel[g.key];
      if (!sel.size) continue;
      var vals = VALUES[i][g.key];
      var hit = false;
      for (var vi = 0; vi < vals.length; vi++) { if (sel.has(vals[vi])) { hit = true; break; } }
      if (!hit) return false;
    }
    return true;
  }

  function visibleIndexes() {
    var out = [];
    for (var i = 0; i < items.length; i++) if (matches(i, null)) out.push(i);
    return out;
  }

  function facetCounts(groupKey) {
    var counts = {};
    for (var i = 0; i < items.length; i++) {
      if (!matches(i, groupKey)) continue;
      var vals = VALUES[i][groupKey];
      for (var vi = 0; vi < vals.length; vi++) counts[vals[vi]] = (counts[vals[vi]] || 0) + 1;
    }
    return counts;
  }

  function isChengdu(it) { return String(it.city || '').indexOf('成都') >= 0; }

  function sortIndexes(list) {
    var copy = list.slice();
    if (state.sort === 'newest') {
      copy.sort(function (a, b) {
        var da = items[a].publishedAt || '';
        var db = items[b].publishedAt || '';
        if (da === db) return a - b;
        if (!da) return 1;
        if (!db) return -1;
        return da < db ? 1 : -1;
      });
    } else if (state.sort === 'chengdu') {
      copy.sort(function (a, b) {
        return (isChengdu(items[a]) ? 0 : 1) - (isChengdu(items[b]) ? 0 : 1) || a - b;
      });
    }
    return copy;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var grid = document.getElementById('grid');
  var cardEls = Array.prototype.slice.call(grid.children);
  var facetsEl = document.getElementById('facets');
  var qEl = document.getElementById('q');
  var shownEl = document.getElementById('shown');
  var emptyEl = document.getElementById('empty');
  var sortEl = document.getElementById('sort');

  function renderFacets() {
    var html = '';
    for (var gi = 0; gi < GROUPS.length; gi++) {
      var g = GROUPS[gi];
      var counts = facetCounts(g.key);
      var sel = state.sel[g.key];
      var seen = {};
      var keys = [];
      (ALL_VALUES[g.key] || []).forEach(function (k) { if (!seen[k]) { seen[k] = 1; keys.push(k); } });
      sel.forEach(function (k) { if (!seen[k]) { seen[k] = 1; keys.push(k); } });
      if (!keys.length) continue;
      keys.sort(function (a, b) {
        var sa = sel.has(a) ? 0 : 1, sb = sel.has(b) ? 0 : 1;
        if (sa !== sb) return sa - sb;
        var ca = counts[a] || 0, cb = counts[b] || 0;
        if (ca !== cb) return cb - ca;
        return a < b ? -1 : 1;
      });
      var chips = '';
      for (var ki = 0; ki < keys.length; ki++) {
        var v = keys[ki];
        var on = sel.has(v);
        var cnt = counts[v] || 0;
        chips += '<button type="button" class="chip' + (on ? ' on' : '') + (cnt ? '' : ' off') +
          '" data-g="' + escapeHtml(g.key) + '" data-v="' + escapeHtml(v) + '">' +
          escapeHtml(v) + '<b>' + cnt + '</b></button>';
      }
      html += '<div class="facet"><span class="facet-label">' + g.label + '</span>' + chips + '</div>';
    }
    facetsEl.innerHTML = html;
  }

  function render() {
    var vis = sortIndexes(visibleIndexes());
    var shown = new Set(vis);
    for (var i = 0; i < cardEls.length; i++) {
      cardEls[i].style.display = shown.has(i) ? '' : 'none';
    }
    var frag = document.createDocumentFragment();
    for (var vi = 0; vi < vis.length; vi++) frag.appendChild(cardEls[vis[vi]]);
    grid.appendChild(frag);
    if (shownEl) shownEl.textContent = String(vis.length);
    if (emptyEl) emptyEl.style.display = vis.length ? 'none' : 'block';
    renderFacets();
  }

  facetsEl.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== facetsEl && !(el.getAttribute && el.getAttribute('data-g'))) el = el.parentElement;
    if (!el || el === facetsEl || !el.getAttribute) return;
    var g = el.getAttribute('data-g');
    var v = el.getAttribute('data-v');
    var sel = state.sel[g];
    if (!sel) return;
    if (sel.has(v)) sel.delete(v); else sel.add(v);
    render();
  });

  sortEl.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== sortEl && !(el.getAttribute && el.getAttribute('data-sort'))) el = el.parentElement;
    if (!el || el === sortEl || !el.getAttribute) return;
    state.sort = el.getAttribute('data-sort') || 'default';
    var btns = sortEl.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i] === el);
    render();
  });

  qEl.addEventListener('input', function () {
    state.q = qEl.value.trim().toLowerCase();
    render();
  });

  var onlyNewEl = document.getElementById('only-new');
  var newCntEl = document.getElementById('new-cnt');
  if (onlyNewEl && newIds.length) {
    onlyNewEl.hidden = false;
    if (newCntEl) newCntEl.textContent = String(newIds.length);
    onlyNewEl.addEventListener('click', function () {
      state.onlyNew = !state.onlyNew;
      onlyNewEl.classList.toggle('active', state.onlyNew);
      render();
    });
  }

  var resetEl = document.getElementById('reset');
  if (resetEl) resetEl.addEventListener('click', function () {
    state.q = '';
    qEl.value = '';
    state.onlyNew = false;
    if (onlyNewEl) onlyNewEl.classList.remove('active');
    state.sort = 'default';
    var btns = sortEl.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-sort') === 'default');
    }
    for (var gi = 0; gi < GROUPS.length; gi++) state.sel[GROUPS[gi].key].clear();
    render();
  });

  render();

  // 供离线测试/调试用（浏览器里无副作用）
  if (typeof globalThis !== 'undefined') {
    globalThis.__jobsWeb = {
      items: items, state: state, GROUPS: GROUPS,
      visibleIndexes: visibleIndexes, facetCounts: facetCounts, sortIndexes: sortIndexes,
      render: render
    };
  }
})();
</script>
</body>
</html>`;
}
