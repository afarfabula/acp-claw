#!/usr/bin/env node
/**
 * handwrite —— 把一段文字渲染成「看起来像手写」的 A4 PDF
 *
 *   handwrite render  [选项]           文本 → 手写风 PDF（可选同时出 PNG 预览）
 *   handwrite preview [选项]           只出 PNG 预览，快速看效果
 *   handwrite serve   [--port 8899]    启动 Overleaf 风格网页版（浏览器里调参数、下载 PDF）
 *   handwrite fonts   [--build]        查看 / 重建字体库（5 款开源手写体 + 数学符号）
 *   handwrite params                   打印默认参数（= reference/handwrite.py 的默认值）
 *   handwrite doctor                   体检：python / 依赖 / 字体 / 工具链
 *   handwrite setup   [--force]        建 .venv + 装依赖 +（--with-fonts）下载并合并字体
 *   handwrite test    [smoke|parity|ui] 跑测试（engine 会按需自动起服务）
 *   handwrite help | version
 *
 * 常用选项（render / preview 通用）：
 *   -i, --input <file>      正文文件（省略则读 stdin）
 *   -o, --out <file>        输出 PDF（默认 out/<输入名>.pdf）
 *   --preview png|none      是否导出预览图（preview 命令默认 png）
 *   --params '<json>'       直接给一坨参数（键名同网页版，见 README）
 *   --font <merged-*.ttf>   手写体；default merged.ttf（龙藏体）
 *   --font-size 38          字号 px          --line-spacing 64   行距 px
 *   --margin 70             页边距 px        --dpi 150           分辨率
 *   --jitter-x / --jitter-y 1.6             笔画位移抖动 σ
 *   --perturb-theta 0.06    笔画旋转抖动 σ（弧度，0.06 ≈ 3.4°）
 *   --ink '#12305f'         墨色（蓝笔）     --paper blank|lined|grid
 *   --grid-layout           按等宽格子排版   --seed <str>        固定种子 → 可复现
 *   --supersample 2         抗锯齿倍数 1/2/3 --pdf-mode lossless|g4|jpeg
 *   --json                  以 JSON 输出结果（给脚本/agent 用）
 *
 * 依赖：Node ≥ 18（只是外壳）+ 一个 Python 环境（第一次跑 `handwrite setup` 会自动建）。
 * 原理：Handright 逐字排版 + 逐笔画随机扰动；字体是把开源中文手写体和 DejaVu Serif
 * 合并后的 merged.ttf，用来补 αβλ‖·‖² 这类数学符号。详见 README.md。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, 'engine', 'server');
const FONTS_DIR = join(HERE, 'fonts');
const OUT_DIR = join(HERE, 'out');
const VENV_PY = join(HERE, '.venv', 'bin', 'python');
const SYSTEM_PY = process.env.HANDWRITE_PYTHON || 'python3';
const DEFAULT_PORT = Number(process.env.HANDWRITE_PORT || 8899);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(1);
}

/** 找可用的 Python：优先工具自带 .venv（依赖齐全），否则退回系统 python3 */
function pythonBin() {
  if (existsSync(VENV_PY)) return VENV_PY;
  return SYSTEM_PY;
}

function runPython(args, opts = {}) {
  // cwd 固定在工具根目录：这样 `-i example/homework.txt` 这类相对路径按用户预期解析
  const res = spawnSync(pythonBin(), args, {
    cwd: HERE,
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: SERVER_DIR },
  });
  if (opts.capture) return res;
  if (res.status !== 0) process.exit(res.status ?? 1);
  return res;
}

function hasModule(name) {
  const res = runPython(['-c', `import ${name}`], { capture: true });
  return res.status === 0;
}

/** 短选项别名，其余一律用长名 */
const ALIAS = { i: 'input', o: 'out', v: 'version', h: 'help' };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const raw = arg.replace(/^--?/, '');
    const key = ALIAS[raw] || raw;
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith('--') && next.length > 1)) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { positional, flags };
}

/** 把 CLI 开关翻译成 render_cli.py 的参数 */
function renderArgs(flags) {
  const args = [];
  const passthrough = [
    'input',
    'out',
    'out-dir',
    'params',
    'font',
    'font-size',
    'line-spacing',
    'line-spacing-sigma',
    'font-size-sigma',
    'word-spacing',
    'word-spacing-sigma',
    'margin',
    'dpi',
    'jitter-x',
    'jitter-y',
    'perturb-theta',
    'ink',
    'paper',
    'page-size',
    'supersample',
    'pdf-mode',
    'jpeg-quality',
    'seed',
    'preview-dir',
    'preview-width',
  ];
  for (const key of passthrough) {
    const value = flags[key];
    if (value === undefined || value === false) continue;
    args.push(`--${key}`, String(value));
  }
  for (const key of ['grid-layout', 'lined', 'json']) {
    if (flags[key]) args.push(`--${key}`);
  }
  if (flags.preview !== undefined)
    args.push('--preview', String(flags.preview));
  return args;
}

const INHERIT = { stdio: 'inherit' };

/** Node 没有同步 sleep，用 Atomics.wait 阻塞一下（只为等本地服务就绪） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cmdRender(flags, { previewOnly = false } = {}) {
  const args = renderArgs(flags);
  if (previewOnly) {
    args.push('--preview', String(flags.preview || 'png'));
    if (flags.out === undefined)
      args.push('--out', join(OUT_DIR, 'preview.pdf'));
  } else if (flags.preview === undefined) {
    args.push('--preview', 'none');
  }
  runPython([join(SERVER_DIR, 'render_cli.py'), ...args], INHERIT);
}

function cmdServe(flags) {
  const port = String(flags.port || DEFAULT_PORT);
  const host = String(flags.host || process.env.HOST || '0.0.0.0');
  log(`▶ 手写作业生成器（网页版）→ http://127.0.0.1:${port}`);
  log('  参数面板 / 渲染图 / 下载 PDF；Ctrl-C 退出');
  const child = spawn(
    pythonBin(),
    [
      '-m',
      'uvicorn',
      'app:app',
      '--host',
      host,
      '--port',
      port,
      '--log-level',
      'info',
    ],
    {
      cwd: SERVER_DIR,
      stdio: 'inherit',
      env: { ...process.env, PYTHONPATH: SERVER_DIR },
    },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
}

function cmdFonts(flags) {
  let acted = false;
  if (flags.fetch) {
    runPython(
      [join(SERVER_DIR, 'fetch_fonts.py'), ...(flags.force ? ['--force'] : [])],
      INHERIT,
    );
    acted = true;
  }
  if (flags.build) {
    runPython([join(SERVER_DIR, 'fontlib.py'), '--build-all'], INHERIT);
    acted = true;
  }
  if (acted && !flags.list) return;
  const list = spawnSync(
    pythonBin(),
    [join(SERVER_DIR, 'fontlib.py'), '--list'],
    {
      cwd: HERE,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: SERVER_DIR },
    },
  );
  if (list.status !== 0) fail(list.stderr || '列出字体失败');
  const fonts = JSON.parse(list.stdout);
  if (!fonts.length) {
    log(
      '字体库是空的，先跑：node cli.mjs fonts --fetch --build   （或 node cli.mjs setup --with-fonts）',
    );
    return;
  }
  log(`字体库（${fonts.length} 个，均在 fonts/）：`);
  for (const f of fonts) {
    log(
      `  ${f.id.padEnd(28)} ${String(f.label).padEnd(8)} ${String(f.size_kb).padStart(6)}KB  GB2312 ${f.coverage}%`,
    );
  }
}

function cmdParams(flags) {
  const code =
    `import json, sys; sys.path.insert(0, ${JSON.stringify(SERVER_DIR)}); import render as r;` +
    'print(json.dumps(r.defaults(), ensure_ascii=False, indent=2))';
  const res = runPython(['-c', code], { capture: true });
  if (res.status !== 0) fail(res.stderr || '读取默认参数失败');
  process.stdout.write(res.stdout);
  if (!flags.json) {
    log(
      "\n以上即 reference/handwrite.py（原始实现）的默认值；用 --params '{...}' 覆盖任意字段。",
    );
  }
}

function cmdDoctor() {
  const rows = [];
  const pyVersion = spawnSync(pythonBin(), ['--version'], { encoding: 'utf8' });
  rows.push(['python', pythonBin(), pyVersion.status === 0]);
  for (const mod of ['handright', 'PIL', 'fontTools']) {
    rows.push([`模块 ${mod}`, hasModule(mod) ? 'ok' : '缺失', hasModule(mod)]);
  }
  const web = hasModule('fastapi') && hasModule('uvicorn');
  rows.push([
    '网页版依赖 fastapi/uvicorn',
    web ? 'ok' : '缺失（只用 render 可不管）',
    web,
  ]);
  const fonts = existsSync(FONTS_DIR)
    ? readdirSync(FONTS_DIR).filter((f) => f.endsWith('.ttf'))
    : [];
  rows.push(['字体库 fonts/*.ttf', `${fonts.length} 个`, fonts.length > 0]);
  const serif = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    '/usr/share/fonts/dejavu/DejaVuSerif.ttf',
  ].find((p) => existsSync(p));
  rows.push([
    '数学符号衬线体 DejaVu Serif',
    serif || '缺失（合并字体时需要）',
    Boolean(serif),
  ]);
  for (const bin of ['pdftoppm', 'gs']) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    rows.push([
      `可选工具 ${bin}`,
      r.status === 0 ? 'ok' : '未安装（仅测试用）',
      true,
    ]);
  }
  log('体检结果：');
  for (const [name, detail, ok] of rows) {
    log(`  ${ok ? '✓' : '✗'} ${name.padEnd(30)} ${detail}`);
  }
  if (!existsSync(VENV_PY)) {
    log(
      '\n提示：还没建 .venv，跑 `node cli.mjs setup --with-fonts` 一次性装好依赖和字体。',
    );
  }
}

function cmdSetup(flags) {
  if (!existsSync(VENV_PY) || flags.force) {
    log(`→ 创建虚拟环境 ${join(HERE, '.venv')}`);
    const venv = spawnSync(SYSTEM_PY, ['-m', 'venv', join(HERE, '.venv')], {
      stdio: 'inherit',
    });
    if (venv.status !== 0) fail('创建 venv 失败（需要 python3-venv）');
  } else {
    log('→ 复用已有 .venv');
  }
  log(
    '→ 安装 Python 依赖（handright / Pillow / fontTools / fastapi / uvicorn）',
  );
  const pip = spawnSync(
    VENV_PY,
    ['-m', 'pip', 'install', '-q', '-r', join(SERVER_DIR, 'requirements.txt')],
    { stdio: 'inherit' },
  );
  if (pip.status !== 0) fail('pip 安装失败');
  if (flags['with-fonts']) {
    log('→ 下载开源手写体（5 款，SIL OFL）');
    cmdFonts({ fetch: true, force: flags.force });
    log('→ 合并数学符号，生成 fonts/merged*.ttf');
    cmdFonts({ build: true });
  } else {
    log('→ 跳过字体（需要时跑：node cli.mjs fonts --fetch --build）');
  }
  cmdFonts({ list: true });
  log(
    '\n✅ 就绪。试试：node cli.mjs render -i example/homework.txt --preview png',
  );
}

function cmdTest(flags) {
  const which = flags.positional?.[1] || flags.positional?.[0] || 'smoke';
  const script = {
    smoke: 'smoke_test.py',
    parity: 'test_cli_parity.py',
    ui: 'screenshot.py',
  }[which];
  if (!script) fail(`未知测试：${which}（可用 smoke / parity / ui）`);
  let server = null;
  if (!process.env.BASE) {
    const port = DEFAULT_PORT;
    log(`→ 后台起服务 :${port}（测试完自动关）`);
    server = spawn(
      pythonBin(),
      [
        '-m',
        'uvicorn',
        'app:app',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--log-level',
        'warning',
      ],
      {
        cwd: SERVER_DIR,
        stdio: 'ignore',
        env: { ...process.env, PYTHONPATH: SERVER_DIR },
      },
    );
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      const probe = spawnSync(
        pythonBin(),
        [
          '-c',
          `import urllib.request;urllib.request.urlopen("http://127.0.0.1:${port}/healthz",timeout=2)`,
        ],
        { encoding: 'utf8' },
      );
      if (probe.status === 0) {
        ready = true;
        break;
      }
      sleepSync(500);
    }
    if (!ready) {
      server.kill();
      fail('服务没起来，先跑 node cli.mjs doctor 看看');
    }
    process.env.BASE = `http://127.0.0.1:${port}`;
  }
  const res = spawnSync(pythonBin(), [join(HERE, 'tests', script)], {
    cwd: HERE,
    stdio: 'inherit',
    env: { ...process.env, BASE: process.env.BASE || '' },
  });
  if (server) server.kill();
  process.exit(res.status ?? 1);
}

function cmdVersion() {
  log(`handwrite ${VERSION}（acp-claw tool）`);
  log(`工具目录: ${HERE}`);
}

function helpText() {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const header = text.split('*/')[0] || '';
  return header
    .split('\n')
    .slice(1) // 去掉 shebang 行
    .map((line) => line.replace(/^\s*(\/\*\*)?\s*\*?\s?/, ''))
    .join('\n')
    .trim();
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0] || 'help';
  switch (cmd) {
    case 'render':
      return cmdRender(flags);
    case 'preview':
      return cmdRender(flags, { previewOnly: true });
    case 'serve':
      return cmdServe(flags);
    case 'fonts':
      return cmdFonts(flags);
    case 'params':
      return cmdParams(flags);
    case 'doctor':
      return cmdDoctor();
    case 'setup':
      return cmdSetup(flags);
    case 'test':
      return cmdTest({ positional, flags });
    case 'version':
    case '--version':
    case '-v':
      return cmdVersion();
    case 'help':
    case '--help':
    case '-h':
      return process.stdout.write(`${helpText()}\n`);
    default:
      throw new Error(
        `未知命令：${cmd}（可用：render / preview / serve / fonts / params / doctor / setup / test / help）`,
      );
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
