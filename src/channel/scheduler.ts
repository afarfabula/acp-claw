import { CronExpressionParser } from 'cron-parser';
import {
  copyFileSync,
  existsSync,
  type FSWatcher,
  mkdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} from 'fs';
import cron, { type ScheduledTask as CronJob } from 'node-cron';
import { basename, join } from 'path';
import type { Channel, IncomingMessage } from '../types/channel.js';
import type { MessageBus } from '../types/messages.js';

export interface ScheduledTask {
  name: string;
  schedule: string;
  prompt: string;
  chatId?: string;
  /** 可选：把任务注入到指定会话（而不是新建 scheduler 会话） */
  sessionKey?: string;
  /**
   * 可选：每次触发都新建会话（不复用上次上下文），本轮结束后关闭该会话。
   * 适合「每天生成一份日报」这类一次性任务：上下文不累积、进程不常驻。
   */
  freshSession?: boolean;
  /**
   * 可选：每天一个会话——当天多次触发复用同一个会话，跨天自动新建。
   * 触发后会话保留（不立即关闭），便于用户在群里继续追问。
   */
  dailySession?: boolean;
  /** 可选：触发结束后保留会话多久（毫秒），到期才关闭。0/未设置 = 不主动关闭 */
  keepSessionMs?: number;
  /** 可选：把任务目标群绑定到该会话，让群里的后续消息继续这个上下文 */
  bindChat?: boolean;
  /** 可选：使用哪个 agent（如 codex-daily，可配独立 API key 计费） */
  agent?: string;
  channelName?: string;
  senderId?: string;
  oneShot: boolean;
  enabled: boolean;
  createdAt: string;
  lastRun: string | null;
  nextRun: string | null;
}

interface SchedulerConfig {
  tasks: ScheduledTask[];
}

export interface SchedulerLogger {
  info(msg: string): void;
  error(msg: string, err?: unknown): void;
}

const defaultLogger: SchedulerLogger = {
  info: (msg) => console.log(`[scheduler] ${msg}`),
  error: (msg, err) => console.error(`[scheduler] ${msg}`, err ?? ''),
};

export class SchedulerChannel implements Channel {
  readonly name = 'scheduler';

  private workDir: string;
  private configPath: string;
  private config: SchedulerConfig = { tasks: [] };
  private cronJobs = new Map<string, CronJob>();
  private messageHandler: ((message: IncomingMessage) => void) | null = null;
  private watcher: FSWatcher | null = null;
  private logger: SchedulerLogger;

  // 防抖和自触发保护
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isSaving = false;
  private static readonly DEBOUNCE_MS = 200;

  constructor(workDir: string, logger?: SchedulerLogger) {
    this.workDir = workDir;
    this.logger = logger ?? defaultLogger;
    const schedulerDir = join(workDir, 'scheduler');
    if (!existsSync(schedulerDir)) {
      mkdirSync(schedulerDir, { recursive: true });
    }
    this.configPath = join(schedulerDir, 'tasks.json');
    this.loadConfig();
  }

  async start(_messageBus: MessageBus): Promise<void> {
    this.logger.info(
      `Loaded ${this.config.tasks.length} task(s) from ${this.configPath}`,
    );
    for (const task of this.config.tasks) {
      if (task.enabled) {
        this.startCronJob(task);
      }
    }
    this.startWatcher();
    this.logger.info('SchedulerChannel started');
  }

  async stop(): Promise<void> {
    this.stopWatcher();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();
    this.messageHandler = null;
    this.logger.info('SchedulerChannel stopped');
  }

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  addTask(params: {
    name: string;
    schedule: string;
    prompt: string;
    chatId?: string;
    sessionKey?: string;
    freshSession?: boolean;
    dailySession?: boolean;
    keepSessionMs?: number;
    bindChat?: boolean;
    agent?: string;
    channelName?: string;
    senderId?: string;
    oneShot?: boolean;
  }): { success: boolean; error?: string } {
    if (!params.name) return { success: false, error: 'name is required' };
    if (!params.schedule)
      return { success: false, error: 'schedule is required' };
    if (!params.prompt) return { success: false, error: 'prompt is required' };

    if (!cron.validate(params.schedule)) {
      return {
        success: false,
        error: `Invalid cron expression: ${params.schedule}`,
      };
    }

    const existing = this.config.tasks.find((t) => t.name === params.name);
    if (existing) {
      return { success: false, error: `Task "${params.name}" already exists` };
    }

    const task: ScheduledTask = {
      name: params.name,
      schedule: params.schedule,
      prompt: params.prompt,
      chatId: params.chatId,
      sessionKey: params.sessionKey,
      freshSession: params.freshSession ?? false,
      dailySession: params.dailySession ?? false,
      keepSessionMs: params.keepSessionMs ?? 0,
      bindChat: params.bindChat ?? false,
      agent: params.agent,
      channelName: params.channelName,
      senderId: params.senderId,
      oneShot: params.oneShot ?? false,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null,
      nextRun: this.calculateNextRun(params.schedule),
    };

    this.config.tasks.push(task);
    this.saveConfig();
    this.startCronJob(task);

    this.logger.info(`Task added: "${params.name}" [${params.schedule}]`);
    return { success: true };
  }

  deleteTask(name: string): { success: boolean; error?: string } {
    const index = this.config.tasks.findIndex((t) => t.name === name);
    if (index === -1)
      return { success: false, error: `Task not found: ${name}` };

    const job = this.cronJobs.get(name);
    if (job) {
      job.stop();
      this.cronJobs.delete(name);
    }

    this.config.tasks.splice(index, 1);
    this.saveConfig();

    this.logger.info(`Task deleted: "${name}"`);
    return { success: true };
  }

  toggleTask(
    name: string,
    enabled: boolean,
  ): { success: boolean; error?: string } {
    const task = this.config.tasks.find((t) => t.name === name);
    if (!task) return { success: false, error: `Task not found: ${name}` };

    task.enabled = enabled;

    if (enabled) {
      task.nextRun = this.calculateNextRun(task.schedule);
      this.startCronJob(task);
    } else {
      task.nextRun = null;
      const job = this.cronJobs.get(name);
      if (job) {
        job.stop();
        this.cronJobs.delete(name);
      }
    }

    this.saveConfig();
    this.logger.info(
      `Task toggled: "${name}" → ${enabled ? 'enabled' : 'disabled'}`,
    );
    return { success: true };
  }

  listTasks(): ScheduledTask[] {
    return [...this.config.tasks];
  }

  private startCronJob(task: ScheduledTask): void {
    const existing = this.cronJobs.get(task.name);
    if (existing) {
      existing.stop();
    }

    const taskName = task.name;
    const job = cron.schedule(task.schedule, () => {
      try {
        const currentTask = this.config.tasks.find((t) => t.name === taskName);
        if (currentTask) {
          this.executeTask(currentTask);
        }
      } catch (err) {
        this.logger.error(`Error executing task "${taskName}"`, err);
      }
    });

    this.cronJobs.set(task.name, job);
  }

  private executeTask(task: ScheduledTask): void {
    this.logger.info(
      `Executing task: "${task.name}" (oneShot: ${task.oneShot})`,
    );

    task.lastRun = new Date().toISOString();
    task.nextRun = this.calculateNextRun(task.schedule);

    const message: IncomingMessage = {
      id: `scheduled_${task.name}_${Date.now()}`,
      channelName: 'scheduler',
      type: 'text',
      content: task.prompt,
      sender: { id: task.name, name: `scheduler:${task.name}` },
      chatId: task.chatId,
      timestamp: Date.now(),
      raw: {
        taskName: task.name,
        isScheduledTask: true,
        sourceChannel: task.channelName ?? (task.chatId ? 'feishu' : undefined),
        sessionKey: task.sessionKey,
        freshSession: task.freshSession ?? false,
        dailySession: task.dailySession ?? false,
        keepSessionMs: task.keepSessionMs ?? 0,
        bindChat: task.bindChat ?? false,
        agent: task.agent,
        senderId: task.senderId,
        oneShot: task.oneShot,
      },
    };

    this.messageHandler?.(message);

    if (task.oneShot) {
      this.saveConfig();
      setImmediate(() => this.deleteTask(task.name));
    } else {
      this.saveConfig();
    }
  }

  private calculateNextRun(schedule: string): string | null {
    try {
      const interval = CronExpressionParser.parse(schedule);
      return interval.next().toISOString();
    } catch {
      return null;
    }
  }

  private loadConfig(): void {
    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, 'utf-8');
        this.config = JSON.parse(raw) as SchedulerConfig;
      } catch (err) {
        const backupPath = this.configPath + `.corrupted.${Date.now()}`;
        try {
          copyFileSync(this.configPath, backupPath);
          this.logger.error(
            `Config corrupted, backed up to ${backupPath}`,
            err,
          );
        } catch {
          this.logger.error('Config corrupted and backup failed', err);
        }
        this.config = { tasks: [] };
        this.saveConfig();
      }
    } else {
      this.config = { tasks: [] };
      this.saveConfig();
    }
  }

  private saveConfig(): void {
    this.isSaving = true;
    try {
      const tmpPath = this.configPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), 'utf-8');
      renameSync(tmpPath, this.configPath);
    } finally {
      setTimeout(() => {
        this.isSaving = false;
      }, 50);
    }
  }

  private startWatcher(): void {
    if (!existsSync(this.configPath)) {
      this.saveConfig();
    }

    // 监视「目录」而不是文件本身：saveConfig 用「写 .tmp + rename」原子替换，
    // 监视文件会在第一次替换后失效（inode 变了，之后收不到事件）。
    const dir = join(this.workDir, 'scheduler');
    const fileName = basename(this.configPath);
    this.watcher = watch(dir, (_eventType, filename) => {
      if (filename && filename !== fileName) return;
      if (this.isSaving) return;

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.reconcile();
      }, SchedulerChannel.DEBOUNCE_MS);
    });
    // 目录被删/权限变化时 fs.watch 会抛 error 事件，未处理会直接崩掉进程
    this.watcher.on('error', (err) => {
      this.logger.error('Scheduler config watcher error', err);
    });
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private reconcile(): void {
    let newConfig: SchedulerConfig;
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      newConfig = JSON.parse(raw) as SchedulerConfig;
    } catch {
      return;
    }

    const newTaskNames = new Set(newConfig.tasks.map((t) => t.name));
    const oldTaskNames = new Set(this.config.tasks.map((t) => t.name));

    // Stop removed tasks
    for (const name of oldTaskNames) {
      if (!newTaskNames.has(name)) {
        const job = this.cronJobs.get(name);
        if (job) {
          job.stop();
          this.cronJobs.delete(name);
        }
      }
    }

    // Start new or changed tasks
    for (const task of newConfig.tasks) {
      if (!oldTaskNames.has(task.name)) {
        if (task.enabled) {
          this.startCronJob(task);
        }
      } else {
        const oldTask = this.config.tasks.find((t) => t.name === task.name);
        if (
          oldTask &&
          (oldTask.schedule !== task.schedule ||
            oldTask.enabled !== task.enabled)
        ) {
          const job = this.cronJobs.get(task.name);
          if (job) {
            job.stop();
            this.cronJobs.delete(task.name);
          }
          if (task.enabled) {
            this.startCronJob(task);
          }
        }
      }
    }

    this.config = newConfig;
    this.logger.info(`Config reloaded: ${newConfig.tasks.length} tasks`);
  }
}
