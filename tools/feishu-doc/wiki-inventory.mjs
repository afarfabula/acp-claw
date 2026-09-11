#!/usr/bin/env node
/**
 * 枚举飞书知识库：空间列表 → 节点树（递归） → 再用节点搜索补充
 *
 * 用法：
 *   node wiki-inventory.mjs [--keywords "LLM,论文,实验"]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from './auth.mjs';

const API = 'https://open.feishu.cn/open-apis';
const __dirname = dirname(fileURLToPath(import.meta.url));

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
  return j;
}

async function allSpaces() {
  const out = [];
  let pageToken;
  do {
    const j = await req('/wiki/v2/spaces', { query: { page_size: 50, page_token: pageToken } });
    if (j.code !== 0) throw new Error(`获取知识空间失败: ${j.msg}`);
    out.push(...(j.data.items ?? []));
    pageToken = j.data.has_more ? j.data.page_token : undefined;
  } while (pageToken);
  return out;
}

async function spaceInfo(spaceId) {
  const j = await req(`/wiki/v2/spaces/${spaceId}`);
  return j.code === 0 ? j.data : null;
}

const nodes = [];
async function walkSpace(spaceId, parentToken, path, depth, errs) {
  if (depth > 5 || nodes.length >= 1500) return;
  let pageToken;
  do {
    const j = await req(`/wiki/v2/spaces/${spaceId}/nodes`, {
      query: { page_size: 50, parent_node_token: parentToken, page_token: pageToken },
    });
    if (j.code !== 0) {
      errs.push({ space_id: spaceId, parent: parentToken ?? '(root)', code: j.code, msg: j.msg });
      return;
    }
    for (const n of j.data.items ?? []) {
      nodes.push({
        space_id: spaceId,
        node_token: n.node_token,
        obj_token: n.obj_token,
        obj_type: n.obj_type,
        title: n.title,
        path,
        url: n.node_token ? `https://feishu.cn/wiki/${n.node_token}` : '',
        obj_edit_time: n.obj_edit_time,
        has_child: n.has_child,
      });
      if (n.has_child) {
        await walkSpace(spaceId, n.node_token, path ? `${path}/${n.title}` : n.title, depth + 1, errs);
      }
    }
    pageToken = j.data.has_more ? j.data.page_token : undefined;
  } while (pageToken);
}

async function searchNodes(keyword) {
  const j = await req('/wiki/v1/nodes/search', { method: 'POST', body: { query: keyword } });
  return j.code === 0 ? (j.data.items ?? []) : [];
}

const typeLabel = { 1: '旧版文档', 3: '电子表格', 7: '多维表格', 8: '文档', 12: '文件', 15: '幻灯片', 16: '思维笔记' };

async function main() {
  const flagIdx = process.argv.indexOf('--keywords');
  const keywords = flagIdx > 0 && process.argv[flagIdx + 1]
    ? process.argv[flagIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    : ['LLM', '论文', '实验', 'study', 'doc', '笔记', '日程', 'Scheduler', 'idea', '推理'];

  const spaces = await allSpaces();
  const seenSpaces = new Map(spaces.map((s) => [s.space_id, s]));
  const errs = [];
  const spaceNodes = new Map();

  for (const s of spaces) {
    const before = nodes.length;
    await walkSpace(s.space_id, undefined, '', 0, errs);
    spaceNodes.set(s.space_id, nodes.length - before);
  }

  // 用节点搜索补充：可能发现没有列在空间列表里的空间
  const extra = new Map();
  for (const kw of keywords) {
    for (const n of await searchNodes(kw)) {
      if (!nodes.some((x) => x.node_token === n.node_id)) {
        extra.set(n.node_id, {
          space_id: n.space_id,
          node_token: n.node_id,
          obj_token: n.obj_token,
          obj_type: n.obj_type,
          title: n.title,
          url: n.url,
          path: '(搜索发现)',
        });
      }
      if (n.space_id && !seenSpaces.has(n.space_id)) {
        seenSpaces.set(n.space_id, { space_id: n.space_id, name: `(未列入空间列表 ${n.space_id})` });
      }
    }
  }

  // 对搜索发现的新空间：补名字 + 尝试遍历
  for (const s of [...seenSpaces.values()]) {
    if (spaceNodes.has(s.space_id)) continue;
    const info = await spaceInfo(s.space_id);
    if (info?.space?.name) s.name = info.space.name;
    const before = nodes.length;
    await walkSpace(s.space_id, undefined, '', 0, errs);
    spaceNodes.set(s.space_id, nodes.length - before);
  }

  const all = [...nodes, ...extra.values()];
  const dataDir = join(__dirname, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'wiki-inventory.json'), JSON.stringify(all, null, 2));

  console.log(`=== 知识空间（${seenSpaces.size} 个）===`);
  for (const [id, s] of seenSpaces) {
    console.log(`【${s.name}】${id}  树内节点=${spaceNodes.get(id) ?? '(未列出)'}`);
  }
  console.log(`\n=== 节点总数：${all.length}（树内 ${nodes.length} + 搜索补充 ${extra.size}）===`);
  for (const n of all) {
    console.log(`[${typeLabel[n.obj_type] ?? n.obj_type}] ${n.path ? n.path + '/' : ''}${n.title}`);
  }
  if (errs.length) {
    console.log('\n=== 部分空间无权限遍历 ===');
    for (const e of errs.slice(0, 5)) console.log(`space=${e.space_id} parent=${e.parent} code=${e.code} ${String(e.msg).slice(0, 60)}`);
  }
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
