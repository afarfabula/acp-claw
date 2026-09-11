#!/usr/bin/env node
/**
 * 扫描飞书云空间文件，输出清单与统计
 *
 * 用法：
 *   node inventory.mjs [--depth 3] [--limit 800] [--json]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from './auth.mjs';

const API = 'https://open.feishu.cn/open-apis';
const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const MAX_DEPTH = Number(flags.depth ?? 3);
const LIMIT = Number(flags.limit ?? 800);

async function listFolder(folderToken) {
  const out = [];
  let pageToken;
  do {
    const url = new URL(`${API}/drive/v1/files`);
    url.searchParams.set('page_size', '200');
    if (folderToken) url.searchParams.set('folder_token', folderToken);
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
    const j = await res.json();
    if (j.code !== 0) throw new Error(`列出目录失败: code=${j.code} ${j.msg}`);
    out.push(...(j.data.files ?? []));
    pageToken = j.data.next_page_token;
  } while (pageToken);
  return out;
}

const items = [];
async function walk(folderToken, path, depth) {
  if (depth > MAX_DEPTH || items.length >= LIMIT) return;
  const files = await listFolder(folderToken);
  for (const f of files) {
    if (items.length >= LIMIT) return;
    items.push({
      token: f.token,
      name: f.name,
      type: f.type,
      path,
      url: f.url,
      modified_time: f.modified_time,
      owner_id: f.owner_id,
    });
    if (f.type === 'folder') {
      await walk(f.token, path ? `${path}/${f.name}` : f.name, depth + 1);
    }
  }
}

async function apiGet(path, query = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`${path} 失败: code=${j.code} ${j.msg}`);
  return j.data;
}

const wikiItems = [];
async function walkWiki(spaceId, parentToken, path, depth) {
  if (depth > 4 || wikiItems.length >= LIMIT) return;
  const data = await apiGet(`/wiki/v2/spaces/${spaceId}/nodes`, {
    page_size: 50,
    parent_node_token: parentToken,
  });
  for (const n of data.items ?? []) {
    wikiItems.push({
      space_id: spaceId,
      node_token: n.node_token,
      obj_token: n.obj_token,
      obj_type: n.obj_type,
      title: n.title,
      path,
      obj_edit_time: n.obj_edit_time,
      owner: n.owner,
      creator: n.creator,
      url: n.obj_type ? `https://feishu.cn/${n.obj_type === 'docx' ? 'docx' : n.obj_type}/${n.obj_token}` : '',
    });
    if (n.has_child) {
      await walkWiki(spaceId, n.node_token, path ? `${path}/${n.title}` : n.title, depth + 1);
    }
  }
}

const typeLabel = {
  docx: '文档',
  doc: '旧版文档',
  sheet: '电子表格',
  bitable: '多维表格',
  mindnote: '思维笔记',
  slides: '幻灯片',
  file: '文件',
  folder: '文件夹',
  shortcut: '快捷方式',
};

async function main() {
  await walk('', '', 0);
  const counts = items.reduce((acc, i) => {
    acc[i.type] = (acc[i.type] ?? 0) + 1;
    return acc;
  }, {});

  const dataDir = join(__dirname, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'inventory.json'), JSON.stringify(items, null, 2));

  console.log('=== 类型统计 ===');
  for (const [type, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`${typeLabel[type] ?? type}\t${n}`);
  }
  console.log(`合计\t${items.length}`);

  console.log('\n=== 清单（目录/文件） ===');
  for (const i of items) {
    const label = typeLabel[i.type] ?? i.type;
    const where = i.path ? `${i.path}/` : '';
    console.log(`[${label}] ${where}${i.name}  (${i.token})`);
  }

  // 知识库
  const spaces = await apiGet('/wiki/v2/spaces', { page_size: 50 });
  console.log('\n=== 知识库 ===');
  for (const s of spaces.items ?? []) {
    console.log(`【${s.name}】space_id=${s.space_id} 类型=${s.space_type ?? '-'}`);
    await walkWiki(s.space_id, '', '', 0);
  }
  const wikiCounts = wikiItems.reduce((acc, i) => {
    acc[i.obj_type] = (acc[i.obj_type] ?? 0) + 1;
    return acc;
  }, {});
  console.log('知识库节点统计:', Object.entries(wikiCounts).map(([k, v]) => `${typeLabel[k] ?? k}=${v}`).join('  ') || '（空）');
  for (const w of wikiItems) {
    console.log(`[${typeLabel[w.obj_type] ?? w.obj_type}] ${w.path ? w.path + '/' : ''}${w.title}  (${w.obj_token})`);
  }
  writeFileSync(join(dataDir, 'inventory-wiki.json'), JSON.stringify(wikiItems, null, 2));
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
