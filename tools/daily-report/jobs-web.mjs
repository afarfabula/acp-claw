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

const jdPreview = (s, n = 230) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * @param {object} jobs collectJobs 的返回（items / companies / newItems …）
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] 渲染时间（ISO）
 */
export function renderJobsWeb(jobs, opts = {}) {
  const items = jobs.items ?? [];
  const technicalOnly = jobs.filters?.technicalOnly !== false;
  const minDailySalary = Number(jobs.filters?.minDailySalary ?? 200);
  const allowUnknownSalary = jobs.filters?.allowUnknownSalary !== false;
  const estimateUnknownSalary = jobs.filters?.estimateUnknownSalary !== false;
  const salaryTitle = minDailySalary > 0
    ? `日薪≥${minDailySalary}${estimateUnknownSalary ? '（官网未披露项标参考）' : allowUnknownSalary ? '（未知待核实）' : ''}`
    : '';
  const filterTitle = [technicalOnly ? '仅技术岗' : '', salaryTitle]
    .filter(Boolean)
    .join(' · ');
  const newIds = (jobs.newItems ?? []).map((it) => it.id).filter(Boolean);
  const newSet = new Set(newIds);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const genLocal = new Date(generatedAt).toLocaleString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });

  const companyNames = {};
  for (const c of jobs.companies ?? []) companyNames[c.key] = c.name;
  const officialSources = jobs.officialSources ?? [];

  // 网页只带短 JD 摘要，避免把几百份完整 JD 塞进单页；完整内容仍留在 JSON 里
  const webItems = items.map((it) => ({
    ...it,
    jd: jdPreview(it.jd),
    requirement: jdPreview(it.requirement, 140),
  }));

  const withLt = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const itemsJson = withLt(webItems);
  const companyNamesJson = withLt(companyNames);
  const newIdsJson = withLt(newIds);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(jobs.city || '成都')}技术实习机会</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">
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
  .source-health { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
  .source-health a {
    border-radius: 999px; padding: 1px 7px; font-size: 10.5px; line-height: 1.6;
    text-decoration: none; border: 1px solid #dbe7df; color: #256b45; background: #f0faf4;
  }
  .source-health .empty-source { color: var(--muted); background: #f4f5f8; border-color: var(--line); }
  .source-health .error-source { color: #a3292d; background: #fff1f1; border-color: #ffd4d4; }
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
  .active-filters { display: none; max-width: 1040px; margin: 0 auto; padding: 2px 20px 8px;
                    flex-wrap: wrap; gap: 6px; }
  .active-filters.show { display: flex; }
  .active-filter { border: 1px solid #cbd3ff; background: var(--brand-soft); color: var(--brand);
                   border-radius: 999px; padding: 2px 9px; font-size: 12px; cursor: pointer; }
  .active-filter b { margin-left: 5px; font-size: 13px; }
  .facet-panel { display: none; max-height: min(52vh, 520px); overflow-y: auto;
                 border-top: 1px solid var(--line); background: rgba(255,255,255,.98);
                 box-shadow: 0 10px 24px rgba(20,30,80,.08); }
  .facet-panel.open { display: block; }
  .facet-head { max-width: 1040px; margin: 0 auto; padding: 10px 20px 2px;
                display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
  .facet-head b { color: var(--ink); font-size: 13px; }
  .facet-head .btn { margin-left: auto; padding: 4px 10px; }
  .facets { max-width: 1040px; margin: 0 auto; padding: 4px 20px 14px;
            display: flex; flex-direction: column; gap: 8px; }
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
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); }
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
  .pill.pending { background: #fff7e6; color: #a15c00; }
  .pill.estimated { background: #eef2ff; color: #4052a8; }
  .pill.match-high { background: #e8f7ef; color: #137a46; font-weight: 700; }
  .pill.match-medium { background: #eef2ff; color: #4052a8; }
  .match-line { font-size: 11.5px; color: #526079; line-height: 1.5; }
  .match-line b { color: #26324a; }
  .risk-line { font-size: 11.5px; color: #a15c00; line-height: 1.5; }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag { background: var(--tag); color: var(--tag-ink); border-radius: 6px; padding: 2px 8px; font-size: 11px; }
  .jd { margin: 0; color: #555b6b; font-size: 12.5px; line-height: 1.55;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
        overflow: hidden; overflow-wrap: anywhere; }
  .jd-label { font-size: 11px; color: var(--muted); margin-right: 5px; }
  .card-f { margin-top: auto; display: flex; justify-content: space-between; align-items: center;
            padding-top: 6px; border-top: 1px dashed var(--line); }
  .src { font-size: 11px; color: var(--muted); }
  .go { color: var(--brand); text-decoration: none; font-size: 12.5px; font-weight: 600; }
  .empty { text-align: center; color: var(--muted); padding: 60px 0; }
  .load-more { display: flex; justify-content: center; padding: 18px 0 4px; }
  footer.foot { text-align: center; color: var(--muted); font-size: 11.5px; padding: 20px 0 40px; }
  #map-panel { display: none; margin: 14px 0 0; border: 1px solid var(--line); border-radius: 12px;
               overflow: hidden; background: var(--card); }
  #map-panel.open { display: block; }
  #map { height: 440px; width: 100%; background: #e8ecf5; }
  .map-bar { display: flex; justify-content: space-between; gap: 10px; align-items: center;
             padding: 8px 14px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line); }
  .map-popup b { font-size: 13px; }
  .map-popup .mp-row { margin: 4px 0; font-size: 12px; color: #3b3f4c; }
  .map-popup a { color: var(--brand); font-weight: 600; text-decoration: none; }
  @media (max-width: 720px) {
    .brand { width: 100%; }
    .search { width: 100%; }
    .facet-label { min-width: 100%; }
    .facet-panel { max-height: 62vh; }
  }
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <div class="brand">
      <h1>${esc(jobs.city || '成都')}技术实习机会 <small>${esc(filterTitle)}</small></h1>
      <div class="sub">更新于 ${esc(genLocal)} · 共 <b>${items.length}</b> 条 · 匹配 <b id="shown">${items.length}</b> 条</div>
      <div class="source-health">${officialSources.map((source) => {
        const detail = source.status === 'error'
          ? `${source.name}官网异常`
          : source.included > 0
            ? `${source.name}官网 ${source.included}`
            : `${source.name}官网 0（${jobs.city || '目标城市'}暂无）`;
        const title = source.status === 'error'
          ? source.error
          : `官网实习池 ${source.fetched ?? '—'} 条，${jobs.city || '目标城市'}匹配 ${source.cityMatched ?? 0} 条，最终展示 ${source.included}`;
        const cls = source.status === 'error'
          ? ' class="error-source"'
          : source.included > 0 ? '' : ' class="empty-source"';
        return `<a${cls} href="${esc(source.siteUrl || '#')}" target="_blank" rel="noopener" title="${esc(title)}">${esc(detail)}</a>`;
      }).join('')}</div>
    </div>
    <div class="tools">
      <input class="search" id="q" placeholder="搜索岗位 / 公司 / 关键词 / JD…">
      <div class="seg" id="sort">
        <button class="seg-btn active" data-sort="match">🎯 适合我</button>
        <button class="seg-btn" data-sort="newest">最新发布</button>
        <button class="seg-btn" data-sort="company">公司排序</button>
      </div>
      <button class="btn" id="facet-toggle">筛选<span class="cnt" id="facet-cnt">0</span></button>
      <button class="btn" id="map-toggle">🗺 地图</button>
      <button class="btn" id="only-fit">🔥 高匹配<span class="cnt" id="fit-cnt">0</span></button>
      <button class="btn" id="only-new" hidden>✨ 只看新增<span class="cnt" id="new-cnt">0</span></button>
      <button class="btn ghost" id="reset">重置</button>
    </div>
  </div>
  <div class="active-filters" id="active-filters"></div>
  <div class="facet-panel" id="facet-panel">
    <div class="facet-head">
      <b>筛选条件</b><span>选择后自动收起</span>
      <button class="btn ghost" id="facet-close">收起</button>
    </div>
    <div class="facets" id="facets"></div>
  </div>
</header>
<main>
  <div id="map-panel">
    <div class="map-bar"><span id="map-info">地图</span><span>每个岗位一个点（按城市中心定位），点弹窗直达岗位</span></div>
    <div id="map"></div>
  </div>
  <div class="grid" id="grid"></div>
  <div class="load-more"><button class="btn" id="load-more" hidden>加载更多</button></div>
  <div class="empty" id="empty" style="display:none">没有匹配的岗位，试试放宽筛选条件</div>
</main>
<footer class="foot">字节 / 阿里 / 京东 / 腾讯岗位仅采官网；其他公司来自实习僧与 DeepSeek 网页核验 · 由 daily-report 自动生成</footer>
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"><\/script>
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
    sort: 'match',
    onlyNew: false,
    onlyFit: false,
    limit: 36,
    sel: { company: new Set(), tags: new Set(), city: new Set(), type: new Set(), source: new Set() }
  };
  var PAGE_SIZE = 36;

  function splitValues(v) {
    return String(v == null ? '' : v)
      .split(/[\\/、,，]/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function itemValues(it, key) {
    if (key === 'company') return [it.company || companyNames[it.companyKey] || '未标注'];
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
    if (state.onlyFit && Number(items[i].fitScore || 0) < 70) return false;
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

  function sortIndexes(list) {
    var copy = list.slice();
    if (state.sort === 'match') {
      copy.sort(function (a, b) {
        var fa = Number(items[a].fitScore || 0), fb = Number(items[b].fitScore || 0);
        if (fa !== fb) return fb - fa;
        var da = items[a].publishedAt || '', db = items[b].publishedAt || '';
        if (da !== db) {
          if (!da) return 1;
          if (!db) return -1;
          return da < db ? 1 : -1;
        }
        return a - b;
      });
    } else if (state.sort === 'newest') {
      copy.sort(function (a, b) {
        var da = items[a].publishedAt || '';
        var db = items[b].publishedAt || '';
        if (da === db) return a - b;
        if (!da) return 1;
        if (!db) return -1;
        return da < db ? 1 : -1;
      });
    } else if (state.sort === 'company') {
      copy.sort(function (a, b) {
        var ca = items[a].company || companyNames[items[a].companyKey] || '';
        var cb = items[b].company || companyNames[items[b].companyKey] || '';
        return ca.localeCompare(cb, 'zh-CN') || a - b;
      });
    }
    return copy;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderCard(it) {
    var city = it.cityUnknown ? '城市未标注' : it.city || '—';
    var company = it.company || companyNames[it.companyKey] || '—';
    var isNew = newSet.has(it.id);
    var tags = (it.tags || []).map(function (t) {
      return '<span class="tag">' + escapeHtml(t) + '</span>';
    }).join('');
    var meta = '<span class="pill">📍 ' + escapeHtml(city) + '</span>' +
      '<span class="pill">' + escapeHtml(it.type || '—') + '</span>';
    if (it.fitScore != null) {
      var fitClass = it.fitScore >= 70 ? ' match-high' : it.fitScore >= 45 ? ' match-medium' : '';
      var fitTitle = (it.fitReasons || []).join('；');
      meta += '<span class="pill' + fitClass + '" title="' + escapeHtml(fitTitle) + '">🎯 匹配 ' +
        escapeHtml(String(it.fitScore)) + ' 分</span>';
    }
    if (it.publishedAt) meta += '<span class="pill">🕒 ' + escapeHtml(String(it.publishedAt).slice(0, 10)) + '</span>';
    if (it.department) meta += '<span class="pill dept">' + escapeHtml(it.department) + '</span>';
    if (it.salaryStatus === 'unknown') meta += '<span class="pill pending">💰 薪资待核实</span>';
    else if (it.salary) {
      var salaryNote = {
        aggregate: ' · ' + (it.salaryEvidenceSource || '同岗位聚合'),
        jd: ' · JD原文',
        web: ' · 网页原文',
        benchmark: ' · 参考',
        source: ' · 官网'
      }[it.salarySource] || '';
      var salaryClass = it.salarySource === 'benchmark' ? ' estimated' : '';
      var salaryTitle = it.salarySource === 'benchmark' && it.salaryEvidence
        ? ' title="' + escapeHtml(it.salaryEvidence) + '"'
        : '';
      meta += '<span class="pill' + salaryClass + '"' + salaryTitle + '>💰 ' +
        escapeHtml(it.salary + salaryNote) + '</span>';
    }
    var jd = it.jd
      ? '<p class="jd"><span class="jd-label">JD</span>' + escapeHtml(it.jd) + '</p>'
      : '';
    var matchLine = (it.fitReasons || []).length
      ? '<div class="match-line"><b>为什么适合：</b>' + escapeHtml((it.fitReasons || []).slice(0, 3).join(' · ')) + '</div>'
      : '';
    var riskLine = (it.fitRisks || []).length
      ? '<div class="risk-line">注意：' + escapeHtml((it.fitRisks || []).slice(0, 2).join(' · ')) + '</div>'
      : '';
    var verifyLine = it.verification === 'deepseek-fetch'
      ? ' · DeepSeek Fetch 已核验'
      : it.verification === 'aggregate' ? ' · 聚合源' : '';
    return '<article class="card">' +
      '<header class="card-h"><span class="company">' + escapeHtml(company) +
      (isNew ? '<span class="badge-new">新增</span>' : '') + '</span>' +
      '<h3><a href="' + escapeHtml(it.url || '#') + '" target="_blank" rel="noopener">' +
      escapeHtml(it.title || '未命名岗位') + '</a></h3></header>' +
      '<div class="meta">' + meta + '</div>' +
      '<div class="tags">' + tags + '</div>' + matchLine + riskLine + jd +
      '<footer class="card-f"><span class="src">' + escapeHtml((it.source || '') + verifyLine) + '</span>' +
      '<a class="go" href="' + escapeHtml(it.url || '#') + '" target="_blank" rel="noopener">完整 JD / 投递 →</a>' +
      '</footer></article>';
  }

  var grid = document.getElementById('grid');
  var facetsEl = document.getElementById('facets');
  var qEl = document.getElementById('q');
  var shownEl = document.getElementById('shown');
  var emptyEl = document.getElementById('empty');
  var sortEl = document.getElementById('sort');
  var loadMoreEl = document.getElementById('load-more');
  var facetToggleEl = document.getElementById('facet-toggle');
  var facetPanelEl = document.getElementById('facet-panel');
  var facetCntEl = document.getElementById('facet-cnt');
  var activeFiltersEl = document.getElementById('active-filters');
  var facetsOpen = false;

  // ---------- 地图（Leaflet + 高德栅格瓦片） ----------
  var CITY_COORDS = {
    '北京': [39.9042, 116.4074], '上海': [31.2304, 121.4737], '广州': [23.1291, 113.2644],
    '深圳': [22.5431, 114.0579], '成都': [30.5728, 104.0668], '杭州': [30.2741, 120.1551],
    '南京': [32.0603, 118.7969], '武汉': [30.5928, 114.3055], '西安': [34.3416, 108.9398],
    '苏州': [31.2989, 120.5853], '长沙': [28.2282, 112.9388], '合肥': [31.8206, 117.2272],
    '重庆': [29.5630, 106.5516], '天津': [39.0842, 117.2010], '青岛': [36.0671, 120.3826],
    '厦门': [24.4798, 118.0894], '珠海': [22.2707, 113.5767], '无锡': [31.4912, 120.3119],
    '东莞': [23.0207, 113.7518], '佛山': [23.0215, 113.1214], '郑州': [34.7466, 113.6254],
    '济南': [36.6512, 117.1201], '宁波': [29.8683, 121.5440], '福州': [26.0745, 119.2965],
    '大连': [38.9140, 121.6147], '沈阳': [41.8057, 123.4315], '昆明': [24.8801, 102.8329],
    '贵阳': [26.6470, 106.6302], '南宁': [22.8170, 108.3669], '哈尔滨': [45.8038, 126.5349],
    '长春': [43.8171, 125.3235], '石家庄': [38.0428, 114.5149], '太原': [37.8706, 112.5489],
    '南昌': [28.6820, 115.8579], '温州': [27.9938, 120.6994], '嘉兴': [30.7522, 120.7555],
    '常州': [31.8107, 119.9741], '泉州': [24.8741, 118.6757], '惠州': [23.1115, 114.4162],
    '中山': [22.5176, 113.3928], '兰州': [36.0611, 103.8343], '乌鲁木齐': [43.8256, 87.6168]
  };

  function cityOf(it, idx) {
    if (it.cityUnknown) return null;
    var parts = splitValues(it.city);
    for (var pi = 0; pi < parts.length; pi++) {
      var s = parts[pi];
      for (var key in CITY_COORDS) {
        if (s.indexOf(key) >= 0 || key.indexOf(s) >= 0) {
          var c = CITY_COORDS[key];
          // 确定性抖动：同一城市多个岗位散开，但不随筛选抖动
          var j1 = (Math.sin(idx * 12.9898 + 1) * 43758.5453) % 1;
          var j2 = (Math.sin(idx * 78.233 + 7) * 12543.123) % 1;
          j1 = j1 - Math.floor(j1) - 0.5;
          j2 = j2 - Math.floor(j2) - 0.5;
          return [c[0] + j1 * 0.22, c[1] + j2 * 0.22, key];
        }
      }
    }
    return null;
  }

  var map = null, mapLayer = null, mapOpen = false;
  var mapToggle = document.getElementById('map-toggle');
  var mapPanel = document.getElementById('map-panel');

  function ensureMap() {
    if (map) return true;
    if (!window.L) {
      document.getElementById('map').innerHTML =
        '<div style="padding:20px;color:#6b7280">地图组件加载失败（CDN 不可达），列表不受影响</div>';
      return false;
    }
    map = L.map('map', { scrollWheelZoom: true });
    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '© 高德地图'
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
    return true;
  }

  function updateMap(vis) {
    if (!mapOpen || !map) return;
    mapLayer.clearLayers();
    var bounds = [];
    var cities = {};
    for (var vi = 0; vi < vis.length; vi++) {
      var i = vis[vi];
      var loc = cityOf(items[i], i);
      if (!loc) continue;
      var it = items[i];
      var company = it.company || companyNames[it.companyKey] || '—';
      var isNew = newSet.has(it.id);
      var m = L.circleMarker([loc[0], loc[1]], {
        radius: isNew ? 7 : 5,
        color: isNew ? '#e5484d' : '#4f6ef7',
        weight: 2, fillOpacity: .85
      });
      m.bindPopup(
        '<div class="map-popup"><b>' + escapeHtml(company) + (isNew ? ' · 新增' : '') + '</b>' +
        '<div class="mp-row">' + escapeHtml(it.title || '') + '</div>' +
        '<div class="mp-row">📍 ' + escapeHtml(it.city || loc[2]) +
        (it.type ? ' · ' + escapeHtml(it.type) : '') + '</div>' +
        '<a href="' + escapeHtml(it.url || '#') + '" target="_blank" rel="noopener">查看岗位 →</a></div>'
      );
      m.addTo(mapLayer);
      bounds.push([loc[0], loc[1]]);
      cities[loc[2]] = (cities[loc[2]] || 0) + 1;
    }
    var info = document.getElementById('map-info');
    if (info) {
      var cityList = [];
      for (var k in cities) cityList.push(k + ' ' + cities[k]);
      info.textContent = '地图：' + bounds.length + ' 个定位点 · ' + (cityList.join(' / ') || '无可定位城市');
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
  }

  if (mapToggle && mapPanel) {
    mapToggle.addEventListener('click', function () {
      mapOpen = !mapOpen;
      mapPanel.classList.toggle('open', mapOpen);
      mapToggle.classList.toggle('active', mapOpen);
      if (mapOpen && ensureMap()) {
        setTimeout(function () {
          map.invalidateSize();
          updateMap(window.__lastVis || []);
        }, 60);
      }
    });
  }

  function setFacetsOpen(open) {
    facetsOpen = Boolean(open);
    facetPanelEl.classList.toggle('open', facetsOpen);
    facetToggleEl.classList.toggle('active', facetsOpen);
    if (facetsOpen) renderFacets();
  }

  function renderActiveFilters() {
    if (!activeFiltersEl) return;
    var html = '';
    var count = 0;
    for (var gi = 0; gi < GROUPS.length; gi++) {
      var group = GROUPS[gi];
      state.sel[group.key].forEach(function (v) {
        count++;
        html += '<button type="button" class="active-filter" data-g="' + escapeHtml(group.key) +
          '" data-v="' + escapeHtml(v) + '">' + escapeHtml(group.label.replace(/^\S+\s*/, '')) +
          '：' + escapeHtml(v) + '<b>×</b></button>';
      });
    }
    activeFiltersEl.innerHTML = html;
    activeFiltersEl.classList.toggle('show', Boolean(html));
    if (facetCntEl) facetCntEl.textContent = String(count);
  }

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
    var shown = vis.slice(0, state.limit);
    grid.innerHTML = shown.map(function (i) { return renderCard(items[i]); }).join('');
    if (shownEl) shownEl.textContent = String(vis.length);
    if (emptyEl) emptyEl.style.display = vis.length ? 'none' : 'block';
    if (loadMoreEl) {
      loadMoreEl.hidden = shown.length >= vis.length;
      loadMoreEl.textContent = '加载更多（' + shown.length + ' / ' + vis.length + '）';
    }
    renderActiveFilters();
    if (facetsOpen) renderFacets();
    window.__lastVis = vis;
    updateMap(vis);
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
    state.limit = PAGE_SIZE;
    setFacetsOpen(false);
    render();
  });

  facetToggleEl.addEventListener('click', function () {
    setFacetsOpen(!facetsOpen);
  });

  document.getElementById('facet-close').addEventListener('click', function () {
    setFacetsOpen(false);
  });

  activeFiltersEl.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== activeFiltersEl && !(el.getAttribute && el.getAttribute('data-g'))) el = el.parentElement;
    if (!el || el === activeFiltersEl || !el.getAttribute) return;
    var g = el.getAttribute('data-g');
    var v = el.getAttribute('data-v');
    if (!state.sel[g]) return;
    state.sel[g].delete(v);
    state.limit = PAGE_SIZE;
    render();
  });

  sortEl.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== sortEl && !(el.getAttribute && el.getAttribute('data-sort'))) el = el.parentElement;
    if (!el || el === sortEl || !el.getAttribute) return;
    state.sort = el.getAttribute('data-sort') || 'match';
    state.limit = PAGE_SIZE;
    var btns = sortEl.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i] === el);
    render();
  });

  qEl.addEventListener('input', function () {
    state.q = qEl.value.trim().toLowerCase();
    state.limit = PAGE_SIZE;
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
      state.limit = PAGE_SIZE;
      render();
    });
  }

  var onlyFitEl = document.getElementById('only-fit');
  var fitCntEl = document.getElementById('fit-cnt');
  var highFitCount = items.filter(function (it) { return Number(it.fitScore || 0) >= 70; }).length;
  if (onlyFitEl && highFitCount) {
    if (fitCntEl) fitCntEl.textContent = String(highFitCount);
    onlyFitEl.addEventListener('click', function () {
      state.onlyFit = !state.onlyFit;
      onlyFitEl.classList.toggle('active', state.onlyFit);
      state.limit = PAGE_SIZE;
      render();
    });
  }

  var resetEl = document.getElementById('reset');
  if (resetEl) resetEl.addEventListener('click', function () {
    state.q = '';
    qEl.value = '';
    state.onlyNew = false;
    if (onlyNewEl) onlyNewEl.classList.remove('active');
    state.onlyFit = false;
    if (onlyFitEl) onlyFitEl.classList.remove('active');
    state.sort = 'match';
    var btns = sortEl.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-sort') === 'match');
    }
    for (var gi = 0; gi < GROUPS.length; gi++) state.sel[GROUPS[gi].key].clear();
    state.limit = PAGE_SIZE;
    setFacetsOpen(false);
    render();
  });

  if (loadMoreEl) loadMoreEl.addEventListener('click', function () {
    state.limit += PAGE_SIZE;
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
