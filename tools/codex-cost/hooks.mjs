/**
 * 把状态栏挂到 Codex 的 Stop hook 上（~/.codex/hooks.json）。
 * 幂等：重复安装只保留一份自己的条目；卸载只删自己写的条目。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const HOOK_MARKER = 'codex-cost/statusline.mjs';

function hooksPath(codexHome) {
  return join(codexHome, 'hooks.json');
}

export function readHooks(codexHome) {
  const file = hooksPath(codexHome);
  if (!existsSync(file)) return { file, config: { hooks: {} } };
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.hooks ??= {};
    return { file, config };
  } catch (error) {
    throw new Error(`无法解析 ${file}: ${error.message}`);
  }
}

function stripEntries(entries, predicate) {
  return (entries ?? []).filter(
    (entry) =>
      !(entry?.hooks ?? []).some((hook) =>
        predicate(String(hook?.command ?? '')),
      ),
  );
}

export function installHook({
  codexHome,
  nodePath,
  scriptPath,
  timeout = 10,
  dropForeign = true,
}) {
  const { file, config } = readHooks(codexHome);
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak-${Date.now()}`);
  }

  const isOurs = (command) => command.includes(HOOK_MARKER);
  // 清掉旧的自己 + （可选）其它工具写的伪状态栏，避免一轮出现两行状态栏
  const isForeignStatusline = (command) =>
    command.includes('codex-statusline.py') ||
    command.includes('token_tracker');

  config.hooks.Stop = stripEntries(config.hooks.Stop, isOurs);
  if (dropForeign)
    config.hooks.Stop = stripEntries(config.hooks.Stop, isForeignStatusline);
  config.hooks.Stop.push({
    hooks: [
      {
        type: 'command',
        command: `"${nodePath}" "${scriptPath}"`,
        timeout,
      },
    ],
  });

  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

export function uninstallHook({ codexHome }) {
  const { file, config } = readHooks(codexHome);
  if (!existsSync(file)) return null;
  copyFileSync(file, `${file}.bak-${Date.now()}`);
  config.hooks.Stop = stripEntries(config.hooks.Stop, (command) =>
    command.includes(HOOK_MARKER),
  );
  if (!config.hooks.Stop.length) delete config.hooks.Stop;
  if (!Object.keys(config.hooks).length) delete config.hooks;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

export function hookStatus({ codexHome }) {
  const { config } = readHooks(codexHome);
  const entries = (config.hooks?.Stop ?? []).flatMap(
    (entry) => entry.hooks ?? [],
  );
  return entries.map((hook) => ({
    command: hook.command,
    ours: String(hook.command ?? '').includes(HOOK_MARKER),
  }));
}
