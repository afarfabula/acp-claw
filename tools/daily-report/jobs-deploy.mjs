// 把渲染好的岗位 HTML 加密（pagecrypt，客户端 AES-256）并部署到 acp-claw 仓库的 gh-pages 分支。
//
// 不新建独立仓库：代码在 main 的 tools/ 里，静态页面推到 gh-pages 分支。
// 用户在 GitHub 仓库 Settings → Pages 选 "Deploy from a branch" → gh-pages / root 即可，
// 站点地址 https://afarfabula.github.io/acp-claw/

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const REPO_SSH = 'git@github.com:afarfabula/acp-claw.git';
const PAGES_BRANCH = 'gh-pages';

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', ...opts }).trim();
}

/** 首次自动生成强密码 */
export function generateWebPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(24);
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

/**
 * 加密并部署到 gh-pages 分支。
 * @param {string} htmlFile 未加密的 HTML 源文件路径
 * @param {object} cfg jobs.web 段
 * @param {string} cfg.password
 * @param {object} [log] 日志回调
 */
export async function deployJobsWeb(htmlFile, cfg, log = () => {}) {
  if (!cfg?.password) throw new Error('缺少 jobs.web.password');
  const { encryptHTML } = await import('pagecrypt');
  const rawHtml = readFileSync(htmlFile, 'utf-8');

  const work = mkdtempSync(join(tmpdir(), 'jobs-pages-'));
  try {
    const repoDir = join(work, 'repo');

    // 1) 先尝试 clone gh-pages 分支（--depth 1）
    log(`clone ${PAGES_BRANCH} ...`);
    let cloned = false;
    try {
      sh('git', ['clone', '--depth', '1', '--branch', PAGES_BRANCH, REPO_SSH, repoDir]);
      cloned = true;
    } catch {
      log(`${PAGES_BRANCH} 分支不存在，创建孤儿分支 ...`);
    }

    if (!cloned) {
      // gh-pages 不存在：clone main 后切孤儿分支
      sh('git', ['clone', '--depth', '1', REPO_SSH, repoDir]);
      sh('git', ['checkout', '--orphan', PAGES_BRANCH], { cwd: repoDir });
      sh('git', ['rm', '-rf', '.'], { cwd: repoDir });
      sh('git', ['config', 'user.name', 'afarfabula'], { cwd: repoDir });
      sh('git', ['config', 'user.email', '2025642596@qq.com'], { cwd: repoDir });
    }

    // 2) 加密输出到根目录
    const outFile = join(repoDir, 'index.html');
    log('加密 HTML ...');
    const encrypted = await encryptHTML(rawHtml, cfg.password);
    writeFileSync(outFile, encrypted, 'utf-8');

    // 3) commit + push
    sh('git', ['add', 'index.html'], { cwd: repoDir });
    let changed = false;
    try {
      sh('git', ['diff', '--cached', '--quiet'], { cwd: repoDir, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      changed = true;
    }
    if (!changed) {
      log('内容无变化，跳过 push');
      return { url: 'https://afarfabula.github.io/acp-claw/', pushed: false };
    }
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    sh('git', ['commit', '-m', `jobs: update ${stamp}`], { cwd: repoDir });
    log(`push 到 origin/${PAGES_BRANCH} ...`);
    sh('git', ['push', '-u', 'origin', `HEAD:${PAGES_BRANCH}`], { cwd: repoDir });
    return { url: 'https://afarfabula.github.io/acp-claw/', pushed: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
