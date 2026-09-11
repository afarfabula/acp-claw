#!/usr/bin/env node
/**
 * 重组 My Document Library 知识库：
 *   1) 建 3 个分类父页面（量化 / RL / 推理框架）
 *   2) 把对应主题的文档移到父页面下
 *   3) 修正误移动的节点
 *
 * 用法：
 *   node reorganize.mjs            # dry-run，只打印计划
 *   node reorganize.mjs --apply    # 实际执行
 */
import { getAccessToken } from './auth.mjs';

const API = 'https://open.feishu.cn/open-apis';
const SPACE = '7559077648836820995';
const APPLY = process.argv.includes('--apply');

async function req(path, { method = 'GET', query = {}, body } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`${method} ${path} 失败: code=${j.code} ${j.msg}`);
  return j.data;
}

async function tree(spaceId, parent, out = []) {
  let pageToken;
  do {
    const d = await req(`/wiki/v2/spaces/${spaceId}/nodes`, {
      query: { page_size: 50, parent_node_token: parent, page_token: pageToken },
    });
    for (const n of d.items ?? []) {
      out.push(n);
      if (n.has_child) await tree(spaceId, n.node_token, out);
    }
    pageToken = d.has_more ? d.page_token : undefined;
  } while (pageToken);
  return out;
}

const CATEGORIES = [
  {
    title: '量化 / 压缩 / Token Reduction',
    match: /量化|Quantization|QAT|CAGE|token reduction|Token Reduction|Token Pruning|ITS|OPD|HTC-VLM|LEO-MINI|Uni-MoE|Expert-Sample/i,
  },
  {
    title: 'RL / 后训练',
    match: /RL|强化|GRPO|DPO|ReasonAgent|SCRL|Sampling|PowerSMC|MoDES|后训练|SCOPE|TTT|voco/i,
  },
  {
    title: '推理框架 / Infra',
    match: /vllm|vLLM|Sglang|SGLang|推理|Infra|infra|KV cache|MOE|端侧|VLM_Inference|BenchMarks|epoch|全生命周期/i,
  },
];

const SKIP = /学业|事务|工作|实习|索引/;
const NON_CATEGORY = /Scheduler|选课|入学考试|答辩|个人称述|实习证明|MT 导览|行程|^Bill$|Bytedance|HBN|OpenViking|Memorandum|Review|UNICORN|trace 产物|设计方案|CP 设计|Attention Osciliation|模板|Open your MIND/i;

async function main() {
  const nodes = await tree(SPACE, undefined);
  const byTitle = new Map();
  for (const n of nodes) byTitle.set(n.title.trim(), n);

  const plan = [];
  const claimed = new Set();
  for (const cat of CATEGORIES) {
    const members = nodes.filter((n) => {
      const t = n.title.trim();
      if (t === cat.title) return false;
      if (claimed.has(t)) return false;          // 每个文档只归入第一个命中的分类
      if (SKIP.test(t) || NON_CATEGORY.test(t)) return false;
      if (!cat.match.test(t)) return false;
      claimed.add(t);
      return true;
    });
    plan.push({ cat, members });
  }

  console.log(`空间节点总数: ${nodes.length}`);
  const withKids = nodes.filter((n) => n.has_child);
  if (withKids.length) {
    console.log(`\n（当前有子节点的文档：${withKids.map((n) => n.title.trim()).join('、')}）`);
  }
  for (const { cat, members } of plan) {
    console.log(`\n【${cat.title}】目标父页面 ${byTitle.has(cat.title) ? '已存在' : '需新建'}；将移入 ${members.length} 篇：`);
    for (const m of members) console.log(`   - ${m.title.trim()}${m.parent_node_token ? '  (当前在子层级)' : ''}`);
  }

  // 误移动检查：LLM 量化 目前挂在 KV cache 下
  const kv = byTitle.get('KV cache');
  if (kv?.has_child) {
    const kids = await tree(SPACE, kv.node_token);
    console.log(`\n⚠️ 误移动修正：KV cache 下有 ${kids.length} 个子节点 → ${kids.map((k) => k.title).join(', ')}`);
  }

  const stray = byTitle.get('（测试父页）');
  if (stray) console.log(`\n🧹 待清理的测试父页节点: ${stray.node_token}（文档 ${stray.obj_token}）`);

  if (!APPLY) {
    console.log('\n（当前是 dry-run，加 --apply 才会真正执行）');
    return;
  }

  // 先清理测试父页
  if (stray) {
    try {
      await req(`/wiki/v2/spaces/${SPACE}/nodes/${stray.node_token}`, { method: 'DELETE' });
      console.log('🧹 已删除测试父页节点');
    } catch (e) {
      console.log('🧹 删除测试父页失败:', e.message);
    }
    try {
      await req(`/drive/v1/files/${stray.obj_token}`, { method: 'DELETE', query: { type: 'docx' } });
      console.log('🧹 已删除测试父页文档');
    } catch (e) {
      console.log('🧹 删除测试页文档失败:', e.message);
    }
  }

  // 执行
  for (const { cat, members } of plan) {
    let parent = byTitle.get(cat.title);
    if (!parent) {
      const doc = await req('/docx/v1/documents', { method: 'POST', body: { title: cat.title } });
      const docId = doc.document.document_id;
      await req(`/wiki/v2/spaces/${SPACE}/nodes/move_docs_to_wiki`, {
        method: 'POST',
        body: { obj_type: 'docx', obj_token: docId, apply: true },
      });
      await new Promise((r) => setTimeout(r, 2500));
      const fresh = await tree(SPACE, undefined);
      parent = fresh.find((n) => n.title.trim() === cat.title);
      if (!parent) throw new Error(`父页面创建后未找到: ${cat.title}`);
      byTitle.set(cat.title, parent);
      console.log(`✅ 新建父页面 ${cat.title} → node=${parent.node_token}`);
    }
    for (const m of members) {
      if (m.node_token === parent.node_token) continue;
      await req(`/wiki/v2/spaces/${SPACE}/nodes/${m.node_token}/move`, {
        method: 'POST',
        body: { target_parent_token: parent.node_token, target_space_id: SPACE },
      });
      console.log(`   ↳ 已移动《${m.title.trim()}》→ ${cat.title}`);
    }
  }
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
