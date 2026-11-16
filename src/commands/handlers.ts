import { listAgents } from '../acp/agent-registry.js';
import { type AcpClawConfig, saveConfig } from '../config.js';
import { parseSessionKey, type SessionManager } from '../session/manager.js';
import { type Lang, t } from './i18n.js';

export interface CommandContext {
  sessionKey: string;
  userPrefix: string;
  sessionManager: SessionManager;
  config: AcpClawConfig;
  isBusy: boolean;
  workDir: string;
  language: Lang;
}

export interface CommandResult {
  text: string;
}

export async function handleCommand(
  commandName: string,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const lang = ctx.language;
  switch (commandName) {
    case 'agent':
      return handleAgent(args, ctx);
    case 'session':
      return handleSession(args, ctx);
    case 'status':
      return handleStatus(ctx);
    case 'help':
      return handleHelp(lang);
    case 'restart':
      return handleRestart(ctx);
    case 'language':
      return handleLanguage(args, ctx);
    default:
      return { text: t('unknown_command', lang, { command: commandName }) };
  }
}

async function handleAgent(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const lang = ctx.language;
  const available = listAgents(ctx.config.agents);

  if (args.length === 0) {
    const session = ctx.sessionManager.getSession(ctx.sessionKey);
    const current = session?.record.agentName ?? ctx.config.defaultAgent;
    const marker = t('agent.current_marker', lang);
    const list = available
      .map((a) => (a === current ? `  * ${a} ${marker}` : `    ${a}`))
      .join('\n');
    return { text: t('agent.current', lang, { current, list }) };
  }

  const agentName = args[0];
  if (!available.includes(agentName)) {
    return {
      text: t('agent.unknown', lang, {
        name: agentName,
        available: available.join(', '),
      }),
    };
  }

  if (ctx.isBusy) {
    return { text: t('agent.busy', lang) };
  }

  await ctx.sessionManager.switchAgent(ctx.sessionKey, agentName);
  return { text: t('agent.switched', lang, { name: agentName }) };
}

function getSessionStatus(session: { client: unknown }): string {
  return session.client ? '🟢' : '🟡';
}

async function handleSession(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const lang = ctx.language;

  if (args.length === 0) {
    const session = ctx.sessionManager.getSession(ctx.sessionKey);
    if (!session) {
      return { text: t('session.no_active', lang, { key: ctx.sessionKey }) };
    }
    const status = getSessionStatus(session);
    const statusLine = session.client
      ? ''
      : t('session.status_reconnecting', lang);
    return {
      text:
        [
          `${status} Session: ${session.sessionKey}`,
          `Agent: ${session.record.agentName}`,
          `${t('session.info_created', lang)}: ${new Date(session.record.createdAt).toLocaleString()}`,
          `${t('session.info_last_activity', lang)}: ${new Date(session.record.lastActivityAt).toLocaleString()}`,
        ].join('\n') + statusLine,
    };
  }

  const sub = args[0];

  if (sub === 'new') {
    if (ctx.isBusy) {
      return { text: t('agent.busy', lang) };
    }
    const session = ctx.sessionManager.getSession(ctx.sessionKey);
    const agentName = session?.record.agentName ?? ctx.config.defaultAgent;
    const nextId = ctx.sessionManager.getNextSessionId(ctx.userPrefix);
    const newKey = `${ctx.userPrefix}${nextId}`;
    await ctx.sessionManager.getOrCreate(newKey, agentName);
    ctx.sessionManager.setActiveSession(ctx.userPrefix, newKey);
    return { text: t('session.new_created', lang, { id: String(nextId) }) };
  }

  if (sub === 'list') {
    const sessions = ctx.sessionManager.listByUser(ctx.userPrefix);
    if (sessions.length === 0) {
      return { text: t('session.list_empty', lang) };
    }
    const activeKey = ctx.sessionKey;
    const lines = sessions.map((s) => {
      const parsed = parseSessionKey(s.sessionKey);
      const id = parsed?.sessionId ?? '?';
      const marker = s.sessionKey === activeKey ? ' *' : '';
      const busyTag = s.busy ? ' [busy]' : '';
      const status = getSessionStatus(s);
      return `  ${status} #${id} ${s.record.agentName}${busyTag}${marker}`;
    });
    return { text: `${t('session.list_title', lang)}\n${lines.join('\n')}` };
  }

  if (sub === 'switch') {
    const targetId = args[1];
    if (!targetId) {
      return { text: t('session.switch_usage', lang) };
    }
    const targetKey = `${ctx.userPrefix}${targetId}`;
    const targetSession = ctx.sessionManager.getSession(targetKey);
    if (!targetSession) {
      return { text: t('session.switch_not_found', lang, { id: targetId }) };
    }
    ctx.sessionManager.setActiveSession(ctx.userPrefix, targetKey);
    return { text: t('session.switch_success', lang, { id: targetId }) };
  }

  if (sub === 'delete') {
    const targetId = args[1];
    if (!targetId) {
      return { text: t('session.delete_usage', lang) };
    }
    const targetKey = `${ctx.userPrefix}${targetId}`;
    const targetSession = ctx.sessionManager.getSession(targetKey);
    if (!targetSession) {
      return { text: t('session.delete_not_found', lang, { id: targetId }) };
    }
    if (targetSession.busy) {
      return { text: t('session.delete_busy', lang, { id: targetId }) };
    }
    if (targetKey === ctx.sessionKey) {
      return { text: t('session.delete_active', lang) };
    }
    await ctx.sessionManager.close(targetKey);
    return { text: t('session.delete_success', lang, { id: targetId }) };
  }

  return { text: t('session.unknown_sub', lang, { sub }) };
}

function handleStatus(ctx: CommandContext): CommandResult {
  const lang = ctx.language;
  const session = ctx.sessionManager.getSession(ctx.sessionKey);
  if (!session) {
    return { text: t('status.no_session', lang, { key: ctx.sessionKey }) };
  }

  const busyText = session.busy
    ? t('status.busy_yes', lang)
    : t('status.busy_no', lang);

  return {
    text: [
      `Agent: ${session.record.agentName}`,
      `Session Key: ${session.sessionKey}`,
      `${t('status.busy_label', lang)}: ${busyText}`,
      `${t('status.last_activity', lang)}: ${new Date(session.record.lastActivityAt).toLocaleString()}`,
    ].join('\n'),
  };
}

async function handleRestart(ctx: CommandContext): Promise<CommandResult> {
  const lang = ctx.language;
  if (ctx.isBusy) {
    return { text: t('restart.busy', lang) };
  }
  await ctx.sessionManager.restart(ctx.sessionKey);
  return { text: t('restart.success', lang) };
}

function handleHelp(lang: Lang): CommandResult {
  return {
    text: [
      t('help.title', lang),
      t('help.agent', lang),
      t('help.session', lang),
      t('help.session_new', lang),
      t('help.session_list', lang),
      t('help.session_switch', lang),
      t('help.session_delete', lang),
      t('help.status', lang),
      t('help.language', lang),
      t('help.restart', lang),
      t('help.help', lang),
    ].join('\n'),
  };
}

function handleLanguage(args: string[], ctx: CommandContext): CommandResult {
  const lang = ctx.language;

  if (args.length === 0) {
    return { text: t('language.current', lang, { lang }) };
  }

  const newLang = args[0];
  if (newLang !== 'zh' && newLang !== 'en') {
    return { text: t('language.invalid', lang, { lang: newLang }) };
  }

  ctx.config.language = newLang;
  saveConfig(ctx.workDir, ctx.config);
  return { text: t('language.switched', newLang, { lang: newLang }) };
}
