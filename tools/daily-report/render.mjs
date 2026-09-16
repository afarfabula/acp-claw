// 把采集结果渲染成「素材 Markdown」，供大模型总结成日报
import { describeWeatherCode } from './collect.mjs';
import { localParts } from './state.mjs';

const trim = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? '');

function section(title) {
  return `\n## ${title}\n`;
}

export function renderBrief(data, { timeZone = 'Asia/Shanghai' } = {}) {
  const { meta, weather, balance, papers, infra, projects } = data;
  const out = [];

  out.push(`# 日报素材 ${meta.stamp}（${timeZone}）`);
  if (meta.failures?.length) {
    out.push(`\n> 部分数据源采集失败：${meta.failures.join(' | ')}`);
  }

  // 1. 天气
  out.push(section('1. 天气（未来 ' + (weather ? `${weather.rows.length}` : 0) + ' 小时）'));
  if (!weather) {
    out.push('采集失败');
  } else {
    out.push(`地点：${weather.name}（${weather.latitude}, ${weather.longitude}，海拔 ${weather.elevation}m）`);
    const s = weather.summary;
    out.push(
      `汇总：${trim(s.conditions.join('/'), 60)}；气温 ${s.tempMin}~${s.tempMax}°C；` +
        `降水概率最高 ${s.popMax}%（${s.popMaxAt}）；24h 累计降水 ${s.rainTotal}mm；日出 ${s.sunrise} 日落 ${s.sunset}`,
    );
    out.push('');
    out.push('| 时刻 | 天气 | 气温 | 体感 | 降水概率 | 降水 | 风速 |');
    out.push('|---|---|---|---|---|---|---|');
    for (const r of weather.rows) {
      out.push(
        `| ${r.date.slice(5)} ${r.time} | ${describeWeatherCode(r.code)} | ${r.temp}°C | ${r.feels}°C | ${r.pop}% | ${r.precip}mm | ${r.wind}km/h |`,
      );
    }
  }

  // 2. 余额
  out.push(section('2. DeepSeek API 余额'));
  if (!balance) {
    out.push('采集失败');
  } else {
    out.push(
      `${balance.label}：可用=${balance.available ? '是' : '否'}，余额 ${balance.total} ${balance.currency}` +
        `（充值 ${balance.toppedUp}，赠送 ${balance.granted}）`,
    );
  }

  // 3. 论文
  out.push(section(`3. 论文（arXiv 最近 ${papers?.hours ?? 24} 小时提交）`));
  let paperCount = 0;
  for (const topic of papers?.topics ?? []) {
    out.push(`\n### ${topic.label}（${topic.items.length} 篇）`);
    if (!topic.items.length) {
      out.push('- 无新论文');
      continue;
    }
    for (const p of topic.items) {
      paperCount += 1;
      out.push(`- **${trim(p.title, 160)}** ｜ ${trim(p.categories.join(','), 40)} ｜ ${p.published?.slice(0, 10)}`);
      out.push(`  - ${p.id}`);
      out.push(`  - 摘要：${trim(p.summary, 420)}`);
    }
  }
  out.push(`\n（本窗口共 ${paperCount} 篇被主题检索命中）`);

  // 4. HF 热榜
  out.push(section('4. HF Daily Papers 热榜（当日）'));
  if (!papers?.hf?.length) {
    out.push('无数据');
  } else {
    for (const p of papers.hf) {
      out.push(`- [${p.upvotes}👍] ${trim(p.title, 160)} ｜ ${p.id} ｜ ${p.publishedAt?.slice(0, 10)}`);
      out.push(`  - 摘要：${trim(p.summary, 260)}`);
    }
  }

  // 5. Infra
  out.push(section(`5. 推理框架 / Infra 动态（最近 ${infra?.hours ?? 48} 小时）`));
  if (!infra?.releases?.length) {
    out.push('- 关注仓库无新 release');
  } else {
    for (const r of infra.releases) {
      out.push(`- ${r.repo} 发布 **${r.tag}**${r.prerelease ? '（pre）' : ''} ｜ ${r.publishedAt?.slice(0, 16).replace('T', ' ')} ｜ ${r.url}`);
      if (r.notes) out.push(`  - ${trim(r.notes, 300)}`);
    }
  }
  if (infra?.trending?.length) {
    out.push('\n近期高星新项目：');
    for (const t of infra.trending) {
      out.push(`- ${t.full_name}（${t.stars}★）${trim(t.description, 120)}`);
    }
  }

  // 6. 项目进展
  out.push(section(`6. 项目进展（最近 ${projects?.hours ?? 48} 小时的 commit）`));
  for (const p of projects?.local ?? []) {
    if (p.error) {
      out.push(`\n### ${p.name}\n- 跳过：${p.error}`);
      continue;
    }
    out.push(`\n### ${p.name}（${p.path}）`);
    out.push(`分支 ${p.branch} ｜ 未提交改动 ${p.dirtyCount} 项 ｜ 最后提交：${p.lastCommit ?? '无'}`);
    if (!p.commits.length) {
      out.push(`- 本窗口无新 commit`);
    } else {
      for (const c of p.commits) {
        out.push(`- ${c.date} ${c.hash} ${trim(c.author, 12)}: ${trim(c.subject, 160)}`);
      }
    }
    if (p.dirtySample?.length) out.push(`- 未提交示例：${p.dirtySample.map((d) => trim(d, 60)).join(' ; ')}`);
  }
  for (const g of projects?.github ?? []) {
    out.push(`\n### ${g.repo}（GitHub 远端）`);
    for (const c of g.commits) {
      out.push(`- ${c.sha} ${trim(c.message, 160)}`);
    }
  }

  return out.join('\n');
}

/** 落盘用：完整 JSON + 素材 markdown 的文件名 */
export function artifactNames(cfg) {
  const { date, stamp } = localParts(new Date(), cfg.timezone);
  return { date, stamp };
}
