#!/usr/bin/env node
/**
 * 飞书云文档 CLI（应用身份 tenant_access_token）
 *
 * 用法：
 *   node cli.mjs read <doc_id|url>                 读取文档纯文本内容
 *   node cli.mjs meta <doc_id|url>                 读取文档标题/版本
 *   node cli.mjs blocks <doc_id|url>               列出文档块（含 block_id，便于定点修改）
 *   node cli.mjs table <doc_id|url> [--index N]    导出文档里的表格（按行列还原）
 *   node cli.mjs create --title <标题> [--folder <folder_token>]
 *   node cli.mjs append <doc_id|url> --md <markdown|@文件路径> [--use-convert]
 *   node cli.mjs update-block <doc_id> <block_id> --text <文本>
 *   node cli.mjs delete-block <doc_id> <block_id> --parent <parent_block_id> [--index N]
 *   node cli.mjs list [--folder <folder_token>]
 *   node cli.mjs search <关键词> [--count N]        搜索云空间文档
 *   node cli.mjs wiki-search <关键词>               搜索知识库节点（wiki 文档用这个）
 *   node cli.mjs wiki-add <doc_id|url> --space <space_id> [--parent <node_token>]   把云文档加入知识库
 *   node cli.mjs share <doc_id|url> --member <open_id|email|...> [--member-type open_id] [--perm view|edit]
 *   node cli.mjs delete <doc_id|url>               删除文档（移入回收站）
 *
 * 说明：应用身份只能操作「自己创建的」或「共享给该应用的」文档。
 */
import { readFileSync } from 'node:fs';
import { getAccessToken } from './auth.mjs';

const API = 'https://open.feishu.cn/open-apis';

async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`${method} ${path} 失败: code=${j.code} ${j.msg}`);
  return j.data;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const wikiCache = new Map();

/** 支持 doc_id、docx 链接、wiki 链接（wiki 节点会解析成真实文档 ID） */
async function docId(input) {
  if (!input) throw new Error('缺少文档 ID 或链接');
  const s = String(input);
  const doc = s.match(/(?:docx|docs|sheets|file)\/([A-Za-z0-9]+)/);
  if (doc) return doc[1];
  const wiki = s.match(/wiki\/([A-Za-z0-9]+)/);
  if (wiki) {
    const nodeToken = wiki[1];
    if (wikiCache.has(nodeToken)) return wikiCache.get(nodeToken);
    const data = await api('/wiki/v2/spaces/get_node', {
      query: { token: nodeToken, obj_type: 'wiki' },
    });
    const objToken = data.node?.obj_token;
    if (!objToken) throw new Error(`无法解析 wiki 节点 ${nodeToken}`);
    wikiCache.set(nodeToken, objToken);
    return objToken;
  }
  return s;
}

function readText(value) {
  if (typeof value !== 'string') throw new Error('缺少文本内容');
  if (value.startsWith('@')) return readFileSync(value.slice(1), 'utf-8');
  return value;
}

/** 走飞书接口转换（需要 docx:document.block:convert 权限，用户身份默认没有） */
async function markdownToBlocksViaApi(md) {
  const data = await api('/docx/v1/documents/blocks/convert', {
    method: 'POST',
    body: { content_type: 'markdown', content: md },
  });
  // blocks 数组顺序不保证等于文档顺序，需按 first_level_block_ids 重排
  const byId = new Map(data.blocks.map((b) => [b.block_id, b]));
  const ordered = [];
  for (const id of data.first_level_block_ids ?? []) {
    const b = byId.get(id);
    if (b) {
      ordered.push(b);
      byId.delete(id);
    }
  }
  // 其余块（嵌套子块）保持原有相对顺序放在后面
  for (const b of data.blocks) {
    if (byId.has(b.block_id)) ordered.push(b);
  }
  return ordered;
}

const TEXT_STYLE = {
  bold: false,
  inline_code: false,
  italic: false,
  strikethrough: false,
  underline: false,
};

/** 把一行里的 **加粗** 和 `代码` 拆成多个 text_run */
function parseInline(text) {
  const elements = [];
  let last = 0;
  for (const m of text.matchAll(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (m.index > last) {
      elements.push({ text_run: { content: text.slice(last, m.index), text_element_style: { ...TEXT_STYLE } } });
    }
    const token = m[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      elements.push({
        text_run: {
          content: link[1],
          text_element_style: { ...TEXT_STYLE, link: { url: encodeURI(link[2]) } },
        },
      });
      last = m.index + token.length;
      continue;
    }
    const isBold = token.startsWith('**');
    elements.push({
      text_run: {
        content: isBold ? token.slice(2, -2) : token.slice(1, -1),
        text_element_style: { ...TEXT_STYLE, bold: isBold, inline_code: !isBold },
      },
    });
    last = m.index + token.length;
  }
  if (last < text.length) {
    elements.push({ text_run: { content: text.slice(last), text_element_style: { ...TEXT_STYLE } } });
  }
  if (elements.length === 0) {
    elements.push({ text_run: { content: text, text_element_style: { ...TEXT_STYLE } } });
  }
  return elements;
}

/** 本地 Markdown → 飞书块（不依赖额外权限） */
function markdownToBlocksLocal(md) {
  const blocks = [];
  let inCode = false;
  let codeBuf = [];
  const flushCode = () => {
    if (!codeBuf.length) return;
    blocks.push({
      block_type: 14,
      code: {
        elements: [{ text_run: { content: codeBuf.join('\n'), text_element_style: { ...TEXT_STYLE } } }],
        style: { language: 1, wrap: false },
      },
    });
    codeBuf = [];
  };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    if (!line.trim()) continue;
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({ block_type: 22, divider: {} });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      blocks.push({
        block_type: 2 + level,
        [`heading${level}`]: { elements: parseInline(heading[2]), style: {} },
      });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({ block_type: 12, bullet: { elements: parseInline(bullet[1]), style: {} } });
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      blocks.push({ block_type: 13, ordered: { elements: parseInline(ordered[1]), style: {} } });
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ block_type: 15, quote: { elements: parseInline(quote[1]), style: {} } });
      continue;
    }
    blocks.push({ block_type: 2, text: { elements: parseInline(line), style: {} } });
  }
  flushCode();
  return blocks;
}

async function markdownToBlocks(md, useApi = false) {
  return useApi ? markdownToBlocksViaApi(md) : markdownToBlocksLocal(md);
}

async function rootChildCount(id) {
  const data = await api(`/docx/v1/documents/${id}/blocks/${id}/children`, {
    query: { page_size: 500 },
  });
  return (data.items ?? []).length;
}

const BLOCK_KEY_BY_TYPE = {
  1: 'page', 2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4',
  7: 'heading5', 8: 'heading6', 12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote',
  17: 'todo', 19: 'callout', 22: 'divider', 23: 'file', 27: 'image', 30: 'sheet',
  31: 'table', 32: 'table_cell', 40: 'add_ons',
};

async function fetchAllBlocks(id) {
  const out = [];
  let pageToken;
  do {
    const data = await api(`/docx/v1/documents/${id}/blocks`, {
      query: { page_size: 500, page_token: pageToken },
    });
    out.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return out;
}

function blockText(block) {
  if (!block) return '';
  const key = BLOCK_KEY_BY_TYPE[block.block_type];
  const elements = block[key]?.elements ?? [];
  return elements
    .map((e) => e.text_run?.content ?? e.mention_doc?.title ?? e.file?.name ?? '')
    .join('');
}

const commands = {
  async read([input]) {
    const data = await api(`/docx/v1/documents/${await docId(input)}/raw_content`);
    process.stdout.write(data.content ?? '');
  },

  async meta([input]) {
    const data = await api(`/docx/v1/documents/${await docId(input)}`);
    console.log(JSON.stringify(data.document ?? data, null, 2));
  },

  async blocks([input]) {
    const id = await docId(input);
    const all = await fetchAllBlocks(id);
    for (const b of all) {
      const key = BLOCK_KEY_BY_TYPE[b.block_type] ?? Object.keys(b).find((k) => k.endsWith('_block')) ?? '?';
      const text = blockText(b);
      console.log(`${b.block_id}  type=${b.block_type}(${key})  ${text.slice(0, 60)}`);
    }
  },

  async table([input], flags) {
    const id = await docId(input);
    const all = await fetchAllBlocks(id);
    const byId = new Map(all.map((b) => [b.block_id, b]));
    const tables = all.filter((b) => b.block_type === 31);
    if (tables.length === 0) {
      console.log('文档里没有表格');
      return;
    }
    const only = flags.index !== undefined ? Number(flags.index) : null;
    tables.forEach((tb, i) => {
      if (only !== null && only !== i) return;
      const { row_size: rows, column_size: cols } = tb.table?.property ?? {};
      console.log(`--- 表格 ${i}：${rows} 行 × ${cols} 列 ---`);
      const cells = (tb.children ?? []).map((cid) => byId.get(cid));
      for (let r = 0; r < rows; r += 1) {
        const row = [];
        for (let c = 0; c < cols; c += 1) {
          const cell = cells[r * cols + c];
          const text = (cell?.children ?? [])
            .map((cid) => blockText(byId.get(cid)))
            .filter(Boolean)
            .join(' / ');
          row.push(text);
        }
        if (row.some((v) => v)) console.log(row.join(' | '));
      }
    });
  },

  async create(_pos, flags) {
    const body = { title: flags.title ?? '未命名文档' };
    if (flags.folder) body.folder_token = flags.folder;
    const data = await api('/docx/v1/documents', { method: 'POST', body });
    const doc = data.document;
    console.log(JSON.stringify({
      document_id: doc.document_id,
      title: doc.title,
      url: `https://feishu.cn/docx/${doc.document_id}`,
    }, null, 2));
  },

  async append([input], flags) {
    const id = await docId(input);
    const md = readText(flags.md);
    const blocks = await markdownToBlocks(md, Boolean(flags['use-convert']));
    // 单次插入块数有上限（约 50），分批写入
    let index = await rootChildCount(id);
    let last;
    const BATCH = 40;
    for (let i = 0; i < blocks.length; i += BATCH) {
      const chunk = blocks.slice(i, i + BATCH);
      last = await api(`/docx/v1/documents/${id}/blocks/${id}/children`, {
        method: 'POST',
        body: { children: chunk, index },
      });
      index += chunk.length;
    }
    console.log(`已追加 ${blocks.length} 个块（分 ${Math.ceil(blocks.length / BATCH)} 批），文档版本 → ${last?.document_revision_id}`);
  },

  async 'update-block'([input, blockId], flags) {
    const id = await docId(input);
    if (!blockId) throw new Error('缺少 block_id');
    const info = await api(`/docx/v1/documents/${id}/blocks/${blockId}`);
    const block = info.block ?? info;
    // 实测：文本/标题/列表/引用都用 update_text_elements 更新
    const editable = new Set([2, 3, 4, 5, 6, 7, 8, 12, 13, 15, 17]);
    if (!editable.has(block.block_type)) {
      throw new Error(`暂不支持修改该类型块（block_type=${block.block_type}）`);
    }
    const data = await api(`/docx/v1/documents/${id}/blocks/${blockId}`, {
      method: 'PATCH',
      body: {
        update_text_elements: { elements: parseInline(readText(flags.text)) },
      },
    });
    console.log(`已更新块 ${blockId}（block_type=${block.block_type}），文档版本 → ${data.document_revision_id}`);
  },

  async 'delete-block'([input, blockId], flags) {
    const id = await docId(input);
    const parent = flags.parent ?? id;
    const data = await api(
      `/docx/v1/documents/${id}/blocks/${parent}/children/batch_delete`,
      { method: 'DELETE', body: { start_index: Number(flags.index ?? 0), end_index: Number(flags.index ?? 0) + 1 } },
    );
    console.log(`已删除块，文档版本 → ${data.document_revision_id}`);
  },

  async list(_pos, flags) {
    const data = await api('/drive/v1/files', {
      query: { page_size: 50, folder_token: flags.folder, order_by: 'EditedTime', direction: 'DESC' },
    });
    for (const f of data.files ?? []) {
      console.log(`${f.token}  ${f.type}  ${f.name}`);
    }
  },

  async search([keyword], flags) {
    if (!keyword) throw new Error('缺少搜索关键词');
    const data = await api('/suite/docs-api/search/object', {
      method: 'POST',
      body: {
        search_key: keyword,
        count: Number(flags.count ?? 20),
        offset: 0,
      },
    });
    // 飞书返回字段是 docs_entities（部分版本为 entities）
    const entities = data.docs_entities ?? data.entities ?? [];
    if (entities.length === 0) {
      console.log('没有匹配的文档');
      return;
    }
    for (const e of entities) {
      console.log(`${e.docs_token}  ${e.docs_type}  ${e.title ?? ''}`);
    }
    console.log(`共 ${data.total ?? entities.length} 条${data.has_more ? '（还有更多）' : ''}`);
  },

  async 'wiki-search'([keyword]) {
    if (!keyword) throw new Error('缺少搜索关键词');
    const data = await api('/wiki/v1/nodes/search', { method: 'POST', body: { query: keyword } });
    const items = data.items ?? [];
    if (items.length === 0) {
      console.log('没有匹配的知识库节点');
      return;
    }
    const wikiType = { 3: 'sheet', 7: 'bitable', 8: 'docx', 12: 'file', 15: 'slides', 16: 'mindnote' };
    for (const i of items) {
      console.log(`${i.node_id}  ${wikiType[i.obj_type] ?? 'type' + i.obj_type}  ${i.title}`);
      if (i.url) console.log(`    ${i.url}`);
    }
    if (data.has_more) console.log('（还有更多结果）');
  },

  async 'wiki-add'([input], flags) {
    const id = await docId(input);
    if (!flags.space) throw new Error('缺少 --space <space_id>');
    const data = await api(`/wiki/v2/spaces/${flags.space}/nodes/move_docs_to_wiki`, {
      method: 'POST',
      body: {
        obj_type: 'docx',
        obj_token: id,
        apply: true,
        parent_wiki_token: flags.parent,
      },
    });
    console.log(JSON.stringify(data, null, 2));
  },

  async share([input], flags) {
    const id = await docId(input);
    const memberType = flags['member-type'] ?? 'open_id';
    const data = await api(`/drive/v1/permissions/${id}/members`, {
      method: 'POST',
      query: { type: 'docx', need_notification: 'false' },
      body: { member_type: memberType, member_id: flags.member, perm: flags.perm ?? 'edit' },
    });
    console.log(`已添加协作者 ${flags.member}（${flags.perm ?? 'edit'}）`);
    console.log(JSON.stringify(data, null, 2));
  },

  async delete([input]) {
    const id = await docId(input);
    await api(`/drive/v1/files/${id}`, { method: 'DELETE', query: { type: 'docx' } });
    console.log(`已删除文档 ${id}（移入回收站）`);
  },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
    return;
  }
  const handler = commands[cmd];
  if (!handler) throw new Error(`未知命令: ${cmd}`);
  const { positional, flags } = parseArgs(rest);
  await handler(positional, flags);
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
