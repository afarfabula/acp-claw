import { resolveAgent } from '../acp/agent-registry.js';
import { AcpClient, type SessionUpdate } from '../acp/client.js';
import type { ContentBlock } from '../acp/prompt-builder.js';
import type { AcpClawConfig } from '../config.js';
import {
  getSessionKey,
  getUserPrefix,
  localDayKey,
  parseSessionKey,
} from './router.js';
import { type SessionRecord, SessionStore } from './store.js';

export { getSessionKey, getUserPrefix, localDayKey, parseSessionKey };

export interface ActiveSession {
  sessionKey: string;
  record: SessionRecord;
  client: AcpClient;
  busy: boolean;
  isNew: boolean;
  /** true = session 刚从 reconnect 恢复，第一次 prompt 可能收到 replay */
  expectReplay: boolean;
  promptPromise: Promise<void> | null;
}

export class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private config: AcpClawConfig;
  private store: SessionStore;
  private cwd: string;
  private activeSessionMap = new Map<string, string>(); // userPrefix → active sessionKey

  constructor(config: AcpClawConfig, workDir: string) {
    this.config = config;
    this.cwd = workDir;
    this.store = new SessionStore(`${workDir}/sessions`);
  }

  async getOrCreate(
    sessionKey: string,
    agentName?: string,
  ): Promise<ActiveSession> {
    const existing = this.sessions.get(sessionKey);
    // 如果 session 存在且 client 有效，直接返回
    if (existing && existing.client) return existing;

    // 检查是否有可恢复的旧 record（从 restore 加载的）
    let restoredRecord: SessionRecord | undefined;
    let restoredAgentName: string | undefined;
    if (existing && !existing.client) {
      restoredRecord = existing.record;
      restoredAgentName = existing.record.agentName;
      this.sessions.delete(sessionKey);
    }

    const agent = agentName ?? restoredAgentName ?? this.config.defaultAgent;
    const agentConfig = resolveAgent(agent, this.config.agents);
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agent}`);
    }

    const client = new AcpClient(
      agentConfig.command,
      agentConfig.args ?? [],
      agentConfig.env,
    );
    await client.start();

    // 在 loadSession 之前注册 listener，确保协议规定的 replay events 被正确接收消费
    // loadSession 期间：静默消费 replay（session 尚未创建，emit 为空操作）
    // prompt 期间：通过 prompt() 注册的独立 listener 路由到 pipeline
    client.on('session-update', (sessionId: string, update: SessionUpdate) => {
      console.log(`[before loading session-update] sessionId：${sessionId} ${JSON.stringify(update)}`);
      // 消费 replay events，防止 Node.js EventEmitter 警告
    });

    // Reconnect: 按 resume > load > create 优先级恢复 session
    let acpSessionId: string;
    if (restoredRecord?.acpSessionId) {
      acpSessionId = await this.reconnectSession(
        client,
        restoredRecord.acpSessionId,
      );
    } else {
      acpSessionId = await client.createSession(this.cwd);
    }

    if (!acpSessionId) {
      throw new Error(
        `Failed to obtain a valid acpSessionId for session: ${sessionKey}`,
      );
    }

    const now = Date.now();
    const record: SessionRecord = {
      sessionKey,
      acpSessionId,
      agentName: agent,
      cwd: this.cwd,
      createdAt: now,
      lastActivityAt: now,
    };

    this.store.save(record);
    console.log(`[session] saved ${sessionKey} acpSessionId=${acpSessionId}`);

    const isReconnect = Boolean(restoredRecord);

    const session: ActiveSession = {
      sessionKey,
      record,
      client,
      busy: false,
      isNew: !isReconnect,
      expectReplay: isReconnect,
      promptPromise: null,
    };

    client.on('session-update', (sessionId: string, update: SessionUpdate) => {
      if (sessionId === acpSessionId) {
        this.emit(session, update);
      }
    });

    client.on('error', () => {
      // errors are handled per-prompt via callbacks
    });

    client.on('stderr', (text: string) => {
      console.warn(`[agent stderr] ${text}`);
    });

    client.on('close', () => {
      // 不删除 session，保留 record 以便恢复
      session.client = null as unknown as AcpClient;
    });

    this.sessions.set(sessionKey, session);
    return session;
  }

  async prompt(
    sessionKey: string,
    parts: ContentBlock[],
    onUpdate: (update: SessionUpdate) => void,
  ): Promise<void> {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      throw new Error(`No active session for key: ${sessionKey}`);
    }

    // Auto-reconnect if session was restored but not yet connected
    if (!session.client || !session.record.acpSessionId) {
      session = await this.getOrCreate(sessionKey, session.record.agentName);
    }

    session.busy = true;
    session.record.lastActivityAt = Date.now();

    const listener = (sessionId: string, update: SessionUpdate) => {
      if (sessionId === session.record.acpSessionId) {
        onUpdate(update);
      }
    };

    session.client.on('session-update', listener);

    const acpSessionId = session.record.acpSessionId!;

    const p = (async () => {
      try {
        await session.client.prompt(acpSessionId, parts);
      } finally {
        if (session.client) {
          session.client.removeListener('session-update', listener);
        }
        session.busy = false;
        session.promptPromise = null;
        session.record.lastActivityAt = Date.now();
        this.store.save(session.record);
      }
    })();

    session.promptPromise = p;
    await p;
  }

  /**
   * Cancel the current prompt on a session.
   * Returns a promise that resolves when the current prompt finishes.
   */
  async cancel(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    if (!session.busy || !session.record.acpSessionId) return;

    session.client.cancel(session.record.acpSessionId);

    // Wait for the current prompt to finish
    if (session.promptPromise) {
      try {
        await session.promptPromise;
      } catch {
        // Ignore errors from cancelled prompt
      }
    }
  }

  async switchAgent(
    sessionKey: string,
    newAgent: string,
  ): Promise<ActiveSession> {
    this.detach(sessionKey);
    return this.getOrCreate(sessionKey, newAgent);
  }

  async close(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    // Remove from map immediately to prevent race with client 'close' event
    this.sessions.delete(sessionKey);
    this.store.delete(sessionKey);

    try {
      if (session.client && session.record.acpSessionId) {
        session.client.closeSession(session.record.acpSessionId);
      }
    } catch {
      // Best effort: agent may not support session/close
    }

    try {
      if (session.client) {
        await session.client.shutdown();
      }
    } catch {
      // Best effort: agent may have already exited
    }
  }

  /**
   * Detach session immediately without waiting for agent shutdown.
   * The old agent process is cleaned up in the background.
   */
  detach(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    this.sessions.delete(sessionKey);
    this.store.delete(sessionKey);

    // Fire-and-forget: clean up old agent in background
    if (session.client) {
      const client = session.client;
      const acpSessionId = session.record.acpSessionId;
      setImmediate(async () => {
        try {
          if (acpSessionId) client.closeSession(acpSessionId);
        } catch {
          /* ignore */
        }
        try {
          await client.shutdown();
        } catch {
          /* ignore */
        }
      });
    }
  }

  async closeAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    await Promise.all(keys.map((key) => this.close(key)));
  }

  /**
   * 取得「当天会话」：同一天内复用同一个会话（多次定时触发共享上下文），
   * 跨天则分配新会话（上下文从头开始）。
   */
  getDailySession(
    userPrefix: string,
    dayKey: string = localDayKey(),
  ): { sessionKey: string; isNew: boolean } {
    const activeKey = this.activeSessionMap.get(userPrefix);
    const active = activeKey ? this.sessions.get(activeKey) : undefined;
    if (active && localDayKey(active.record.createdAt) === dayKey) {
      return { sessionKey: active.sessionKey, isNew: false };
    }
    const sessionKey = `${userPrefix}${this.getNextSessionId(userPrefix)}`;
    this.setActiveSession(userPrefix, sessionKey);
    return { sessionKey, isNew: true };
  }

  private idleSweeper: ReturnType<typeof setInterval> | null = null;
  /** sessionKey → 保护截止时间（定时任务保留窗口内的会话不被空闲回收） */
  private protection = new Map<string, number>();

  /** 在 untilTs 之前保护该会话，空闲回收会跳过它 */
  protectSession(sessionKey: string, untilTs: number): void {
    this.protection.set(sessionKey, untilTs);
  }

  unprotectSession(sessionKey: string): void {
    this.protection.delete(sessionKey);
  }

  /**
   * 定期回收长时间无活动的会话（进程关掉、记录删除），
   * 时长取 config.sessionIdleTimeoutMs（默认 30 分钟）。
   */
  startIdleSweeper(): void {
    const timeout = this.config.sessionIdleTimeoutMs ?? 30 * 60_000;
    if (this.idleSweeper) clearInterval(this.idleSweeper);
    const interval = Math.max(60_000, Math.min(Math.floor(timeout / 4), 10 * 60_000));
    this.idleSweeper = setInterval(() => {
      void this.sweepIdle(timeout);
    }, interval);
    this.idleSweeper.unref?.();
    console.log(
      `[session] idle sweeper started: timeout=${Math.round(timeout / 60000)}min interval=${Math.round(interval / 60000)}min`,
    );
  }

  stopIdleSweeper(): void {
    if (this.idleSweeper) clearInterval(this.idleSweeper);
    this.idleSweeper = null;
  }

  async sweepIdle(timeout: number): Promise<void> {
    const now = Date.now();
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.busy) continue;
      const protectedUntil = this.protection.get(key);
      if (protectedUntil && protectedUntil > now) continue;
      if (protectedUntil) this.protection.delete(key);
      if (now - session.record.lastActivityAt < timeout) continue;
      console.log(
        `[session] idle > ${Math.round(timeout / 60000)}min, closing ${key}`,
      );
      try {
        await this.close(key);
      } catch {
        // 回收失败不影响后续
      }
    }
  }

  /**
   * Shutdown all ACP client processes without deleting session records.
   * Used during graceful shutdown to preserve session persistence for restart.
   */
  async shutdownAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(
      sessions.map(async (session) => {
        if (!session.client) return;
        try {
          await session.client.shutdown();
        } catch {
          // Best effort: agent may have already exited
        }
        session.client = null as unknown as AcpClient;
      }),
    );
  }

  getSession(sessionKey: string): ActiveSession | undefined {
    return this.sessions.get(sessionKey);
  }

  listActive(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  async restore(): Promise<void> {
    const records = this.store.list();
    for (const record of records) {
      console.log(
        `[session] restore: ${record.sessionKey} acpSessionId=${record.acpSessionId}`,
      );
      // Store records in memory but do NOT reconnect.
      // Sessions will be recreated on next message via getOrCreate.
      this.sessions.set(record.sessionKey, {
        sessionKey: record.sessionKey,
        record,
        client: null as unknown as AcpClient,
        busy: false,
        isNew: false,
        expectReplay: false,
        promptPromise: null,
      });
    }

    // 恢复 activeSessionMap
    const state = this.store.loadControllerState();
    if (state?.activeSessionMap) {
      for (const [userPrefix, sessionKey] of Object.entries(
        state.activeSessionMap,
      )) {
        this.activeSessionMap.set(userPrefix, sessionKey);
      }
    }
  }

  saveAll(): void {
    for (const session of this.sessions.values()) {
      this.store.save(session.record);
    }

    const controllerState = {
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      activeSessions: [...this.sessions.keys()],
      activeSessionMap: Object.fromEntries(this.activeSessionMap),
    };
    this.store.saveControllerState(controllerState);
  }

  /**
   * Get active session key for a user, defaults to session 1 if none set.
   */
  getActiveSessionKey(userPrefix: string): string {
    const active = this.activeSessionMap.get(userPrefix);
    if (active) return active;
    // Default to session 1
    const defaultKey = `${userPrefix}1`;
    this.activeSessionMap.set(userPrefix, defaultKey);
    return defaultKey;
  }

  /**
   * Set the active session for a user.
   */
  setActiveSession(userPrefix: string, sessionKey: string): void {
    this.activeSessionMap.set(userPrefix, sessionKey);
  }

  /**
   * List all sessions for a user prefix.
   */
  listByUser(userPrefix: string): ActiveSession[] {
    const results: ActiveSession[] = [];
    for (const [key, session] of this.sessions) {
      if (key.startsWith(userPrefix)) {
        results.push(session);
      }
    }
    return results;
  }

  /**
   * Get next available session ID for a user.
   */
  getNextSessionId(userPrefix: string): number {
    let maxId = 0;
    for (const key of this.sessions.keys()) {
      if (key.startsWith(userPrefix)) {
        const parsed = parseSessionKey(key);
        if (parsed && parsed.sessionId > maxId) {
          maxId = parsed.sessionId;
        }
      }
    }
    // Also check store for persisted sessions
    const records = this.store.list();
    for (const record of records) {
      if (record.sessionKey.startsWith(userPrefix)) {
        const parsed = parseSessionKey(record.sessionKey);
        if (parsed && parsed.sessionId > maxId) {
          maxId = parsed.sessionId;
        }
      }
    }
    return maxId + 1;
  }

  /**
   * Restart ACP client for a session (close and recreate connection).
   */
  async restart(sessionKey: string): Promise<ActiveSession> {
    const session = this.sessions.get(sessionKey);
    const agentName = session?.record.agentName;
    this.detach(sessionKey);
    return this.getOrCreate(sessionKey, agentName);
  }

  private emit(_session: ActiveSession, _update: SessionUpdate): void {
    // Internal event routing - updates are delivered via prompt() callback
  }

  /**
   * 按 resume > load > create 优先级尝试恢复 session。
   * 每一步失败自动 fallback 到下一步。
   */
  private async reconnectSession(
    client: AcpClient,
    oldSessionId: string,
  ): Promise<string> {
    // 1. 尝试 resume（最强恢复，保留完整对话上下文）
    if (client.supportsResumeSession()) {
      try {
        const id = await client.resumeSession(oldSessionId, this.cwd);
        console.log(`[session] resumeSession succeeded for ${oldSessionId}`);
        return id;
      } catch (err) {
        console.warn(`[session] resumeSession failed:`, err);
      }
    }

    // 2. 尝试 load（重新加载 session 状态）
    if (client.supportsLoadSession()) {
      try {
        const id = await client.loadSession(oldSessionId, this.cwd);
        console.log(`[session] loadSession succeeded for ${oldSessionId}`);
        return id;
      } catch (err) {
        console.warn(`[session] loadSession failed:`, err);
      }
    }

    // 3. Fallback: 创建新 session
    console.warn(
      `[session] all reconnect attempts failed for ${oldSessionId}, creating new session`,
    );
    return await client.createSession(this.cwd);
  }
}
