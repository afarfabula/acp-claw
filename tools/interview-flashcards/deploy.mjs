#!/usr/bin/env node
// 将 ByeByeBaGu 和生成卡组发布到 acp-claw 仓库 gh-pages 分支的 /memory/。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_SSH = 'git@github.com:afarfabula/acp-claw.git';
const PAGES_BRANCH = 'gh-pages';
const UPSTREAM_DIR = process.env.BYEBYE_BAGU_DIR
  || join(homedir(), 'career-memory', 'ByeByeBaGu');
const DECK_DIR = process.env.INTERVIEW_DECKS_DIR
  || join(homedir(), 'career-memory', 'decks');
const SITE_URL = 'https://afarfabula.github.io/acp-claw/memory/';

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...opts,
  }).trim();
}

function writeHub(memoryDir, deckFiles) {
  const links = deckFiles.map((file) =>
    `<li><a href="./decks/${encodeURIComponent(file)}">${file.replace(/\.md$/, '')}</a></li>`,
  ).join('');
  const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>面经记忆卡组</title>
<style>
body{max-width:760px;margin:48px auto;padding:0 20px;font:16px/1.7 system-ui,sans-serif;color:#18202c;background:#f7f5ef}
h1{font-size:30px;margin-bottom:8px}.muted{color:#647082}a{color:#0f6b4f}
.card{background:#fff;border:1px solid #dde2dc;border-radius:16px;padding:22px;margin:20px 0;box-shadow:0 8px 24px #1c294212}
code{background:#edf1ed;padding:2px 6px;border-radius:5px}
</style>
<h1>面经记忆卡组</h1>
<p class="muted">ByeByeBaGu + FSRS。学习进度只保存在你的浏览器。</p>
<div class="card">
<h2>第一步：打开学习器</h2>
<p><a href="./index.html"><b>进入 ByeByeBaGu →</b></a></p>
<p>首次使用后可在浏览器中安装为 PWA，离线学习。</p>
</div>
<div class="card">
<h2>第二步：导入卡组</h2>
<ol>${links}</ol>
<p>下载或打开 Markdown，在 ByeByeBaGu 的导入区拖入文件。重复导入会按语义去重，不会重置已有进度。</p>
</div>
<div class="card">
<h2>卡组结构</h2>
<p>按大模型/Agent、具身智能、AI Infra 分卡组；当前无匹配题目时不会生成空卡组。公司和原始面经保留在答案末尾。</p>
</div>
<p class="muted">前端：MIT License，ByeByeBaGu。题库由个人面经采集与 AI 整理生成。</p>
</html>`;
  writeFileSync(join(memoryDir, 'decks.html'), html, 'utf8');
}

function writeDeckBootstrap(memoryDir, deckFiles) {
  const indexPath = join(memoryDir, 'index.html');
  const swPath = join(memoryDir, 'sw.js');
  let html = readFileSync(indexPath, 'utf8');
  let sw = readFileSync(swPath, 'utf8');
  const deckPayload = deckFiles.map((file) => ({
    path: `./decks/${encodeURIComponent(file)}`,
    name: file,
  }));
  const version = createHash('sha256')
    .update(JSON.stringify(deckPayload))
    .update(deckFiles.map((file) => readFileSync(join(memoryDir, 'decks', file), 'utf8')).join('\u0000'))
    .digest('hex')
    .slice(0, 12);

  html = html.replace(/\nboot\(\);\n/, '\nwindow.__bootPromise = boot();\n');
  if (!html.includes('window.__bootPromise = boot();')) {
    throw new Error('无法注入 ByeByeBaGu 启动钩子');
  }
  const bootstrap = `
<script>
/* 面经卡组首次加载：使用 ByeByeBaGu 自带解析器和 IndexedDB，不改变 FSRS 学习逻辑。 */
(() => {
  const VERSION = ${JSON.stringify(version)};
  const DECKS = ${JSON.stringify(deckPayload)};
  const SEED_KEY = 'interview_deck_seed_version';
  const run = async () => {
    try {
      await window.__bootPromise;
      if (localStorage.getItem(SEED_KEY) === VERSION && db.decks.length) return;
      const importedDeckIds = [];
      let importedCount = 0;
      let skippedCount = 0;
      for (const deck of DECKS) {
        const response = await fetch(deck.path, { cache: 'no-store' });
        if (!response.ok) throw new Error('卡组加载失败：' + deck.name);
        const norm = normalizeText(await response.text());
        const auto = autoDetect(norm.text);
        const file = { name: deck.name, norm, strategy: auto.name, level: auto.level, result: null };
        refreshResult(file);
        const result = importOne(file, existingHashes(), true);
        if (result.deck) {
          importedDeckIds.push(result.deck.id);
          importedCount += result.kept;
          skippedCount += result.skipped;
        }
      }
      if (importedCount) {
        db.lastImport = { deckIds: importedDeckIds, count: importedCount, ts: Date.now() };
        save();
        switchView('home');
        toast(t('已载入面经卡组 {0} 张', importedCount) +
          (skippedCount ? t('，跳过重复 {0}', skippedCount) : ''));
      }
      localStorage.setItem(SEED_KEY, VERSION);
    } catch (error) {
      console.warn('[interview-decks]', error);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();
</script>`;
  html = html.replace('</body>', `${bootstrap}\n</body>`);
  writeFileSync(indexPath, html, 'utf8');

  const cacheVersion = `shanbei-v29-interview-${version}`;
  sw = sw.replace(/const CACHE = '[^']+';/, `const CACHE = '${cacheVersion}';`);
  const assetList = JSON.stringify(['./', './index.html', './manifest.webmanifest', './icon.svg', ...deckPayload.map((x) => x.path)])
    .replaceAll(',', ', ');
  sw = sw.replace(/const ASSETS = \[[^\]]*\];/, `const ASSETS = ${assetList};`);
  writeFileSync(swPath, sw, 'utf8');
}

export function deployMemorySite({ upstreamDir = UPSTREAM_DIR, deckDir = DECK_DIR } = {}) {
  if (!existsSync(join(upstreamDir, 'index.html'))) {
    throw new Error(`ByeByeBaGu 未找到：${upstreamDir}`);
  }
  if (!existsSync(deckDir)) throw new Error(`卡组目录不存在：${deckDir}`);
  const deckFiles = readdirSync(deckDir).filter((name) => name.endsWith('.md')).sort();
  if (!deckFiles.length) throw new Error('没有可发布的 Markdown 卡组');

  const work = mkdtempSync(join(tmpdir(), 'career-memory-pages-'));
  try {
    const repoDir = join(work, 'repo');
    let cloned = false;
    try {
      sh('git', ['clone', '--depth', '1', '--branch', PAGES_BRANCH, REPO_SSH, repoDir]);
      cloned = true;
    } catch {
      sh('git', ['clone', '--depth', '1', REPO_SSH, repoDir]);
    }
    if (!cloned) {
      sh('git', ['checkout', '--orphan', PAGES_BRANCH], { cwd: repoDir });
      sh('git', ['rm', '-rf', '.'], { cwd: repoDir });
    }
    const memoryDir = join(repoDir, 'memory');
    rmSync(memoryDir, { recursive: true, force: true });
    mkdirSync(memoryDir, { recursive: true });
    for (const name of [
      'index.html',
      'manifest.webmanifest',
      'sw.js',
      'icon.svg',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      const source = join(upstreamDir, name);
      if (existsSync(source)) cpSync(source, join(memoryDir, name));
    }
    const targetDecks = join(memoryDir, 'decks');
    mkdirSync(targetDecks, { recursive: true });
    for (const file of deckFiles) {
      cpSync(join(deckDir, file), join(targetDecks, file));
    }
    writeDeckBootstrap(memoryDir, deckFiles);
    writeHub(memoryDir, deckFiles);

    sh('git', ['add', 'memory'], { cwd: repoDir });
    let changed = false;
    try {
      sh('git', ['diff', '--cached', '--quiet'], { cwd: repoDir });
    } catch {
      changed = true;
    }
    if (!changed) return { url: SITE_URL, pushed: false, files: deckFiles };
    sh('git', ['config', 'user.name', 'afarfabula'], { cwd: repoDir });
    sh('git', ['config', 'user.email', '2025642596@qq.com'], { cwd: repoDir });
    const stamp = new Date().toLocaleString('zh-CN', {
      hour12: false,
      timeZone: 'Asia/Shanghai',
    });
    sh('git', ['commit', '-m', `memory: update decks ${stamp}`], { cwd: repoDir });
    sh('git', ['push', '-u', 'origin', `HEAD:${PAGES_BRANCH}`], { cwd: repoDir });
    return { url: SITE_URL, pushed: true, files: deckFiles };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = deployMemorySite();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
