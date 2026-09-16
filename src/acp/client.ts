import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { ContentBlock } from './prompt-builder.js';

export interface SessionUpdateMeta {
  id?: string;
  lastChunk?: boolean;
  type?: 'full' | 'delta';
  messageId?: string;
}

export interface SessionUpdate {
  _meta?: SessionUpdateMeta;
  sessionUpdate: string;
  content?: { type: string; text: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  stopReason?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcIncomingRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage =
  | JsonRpcResponse
  | JsonRpcNotification
  | JsonRpcIncomingRequest;

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private command: string;
  private args: string[];
  private env: Record<string, string> | undefined;
  private initResult: {
    agentCapabilities?: {
      loadSession?: boolean;
      sessionCapabilities?: { resume?: boolean; close?: boolean };
    };
  } | null = null;
  private shutdownTimeout = 5000;
  private terminals = new Map<
    string,
    {
      process: ChildProcess;
      output: string;
      exited: boolean;
      exitCode: number | null;
      signal: string | null;
      exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
    }
  >();

  constructor(
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
  ) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
  }

  async start(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.env ?? {}) },
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });

    this.process.on('close', (code) => {
      this.rejectAllPending(
        new Error(`Agent process exited with code ${code}`),
      );
      this.process = null;
      this.emit('close');
    });

    if (this.process.stderr) {
      this.process.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          this.emit('stderr', text);
        }
      });
    }

    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          this.handleMessage(msg);
        } catch {
          // Ignore malformed lines
        }
      });
    }

    // Perform initialize handshake
    this.initResult = (await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'acp-claw', version: '1.0.0' },
    })) as {
      agentCapabilities?: {
        loadSession?: boolean;
        sessionCapabilities?: { resume?: boolean; close?: boolean };
      };
    };
  }

  supportsLoadSession(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.loadSession);
  }

  supportsResumeSession(): boolean {
    return Boolean(
      this.initResult?.agentCapabilities?.sessionCapabilities?.resume,
    );
  }

  async resumeSession(sessionId: string, cwd: string): Promise<string> {
    await this.request('session/resume', { sessionId, cwd, mcpServers: [] });
    return sessionId;
  }

  async createSession(cwd: string): Promise<string> {
    const result = (await this.request('session/new', {
      cwd,
      mcpServers: [],
    })) as { sessionId?: string };
    if (!result?.sessionId) {
      throw new Error('session/new did not return a valid sessionId');
    }
    return result.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<string> {
    await this.request('session/load', { sessionId, cwd, mcpServers: [] });
    return sessionId;
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<void> {
    await this.request('session/prompt', { sessionId, prompt });
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  closeSession(sessionId: string): void {
    this.notify('session/close', { sessionId });
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null;

    // Close stdin to signal the agent
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
    } catch {
      // Best effort
    }

    // Wait for graceful exit, then escalate
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* already dead */
        }
        const killTimeout = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already dead */
          }
          resolve();
        }, this.shutdownTimeout);
        proc.once('close', () => {
          clearTimeout(killTimeout);
          resolve();
        });
      }, this.shutdownTimeout);

      proc.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin || this.process.stdin.destroyed) {
        return reject(new Error('Agent process not running'));
      }
      const id = this.nextId++;
      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.process?.stdin || this.process.stdin.destroyed) return;
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    try {
      this.process.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // Best effort: stdin may be closed
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    const hasId = 'id' in msg && msg.id != null;
    const hasMethod =
      'method' in msg &&
      typeof (msg as unknown as Record<string, unknown>).method === 'string';

    if (hasId && hasMethod) {
      // Agent-to-client request (has both id and method)
      this.handleAgentRequest(msg as JsonRpcIncomingRequest);
    } else if (hasId && !hasMethod) {
      // Response to our request
      const response = msg as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
    } else if (hasMethod && !hasId) {
      // Notification from agent
      this.handleNotification(msg as JsonRpcNotification);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === 'session/update') {
      const params = msg.params as
        | { sessionId: string; update: SessionUpdate }
        | undefined;
      if (params) {
        this.emit('session-update', params.sessionId, params.update);
      }
    }
  }

  private handleAgentRequest(msg: JsonRpcIncomingRequest): void {
    const respond = (result: unknown) => {
      this.sendResponse(msg.id, result, undefined);
    };
    const respondError = (code: number, message: string) => {
      this.sendResponse(msg.id, undefined, { code, message });
    };

    try {
      this.emit('agent-request', msg.method, msg.params);
      switch (msg.method) {
        case 'fs/read_text_file':
          respond(this.handleReadTextFile(msg.params));
          break;
        case 'fs/write_text_file':
          respond(this.handleWriteTextFile(msg.params));
          break;
        case 'session/request_permission':
          respond(this.handleRequestPermission(msg.params));
          break;
        case 'terminal/create':
          this.handleCreateTerminal(msg.params)
            .then(respond)
            .catch((e) => {
              respondError(-32603, e instanceof Error ? e.message : String(e));
            });
          return; // async, already handled
        case 'terminal/output':
          respond(this.handleTerminalOutput(msg.params));
          break;
        case 'terminal/wait_for_exit':
          this.handleWaitForTerminalExit(msg.params)
            .then(respond)
            .catch((e) => {
              respondError(-32603, e instanceof Error ? e.message : String(e));
            });
          return; // async, already handled
        case 'terminal/kill':
          respond(this.handleKillTerminal(msg.params));
          break;
        case 'terminal/release':
          respond(this.handleReleaseTerminal(msg.params));
          break;
        default:
          console.warn(`⚠️ Unknown agent method: ${msg.method}`);
          respond({});
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      respondError(-32603, errMsg);
    }
  }

  private sendResponse(
    id: number | string,
    result: unknown,
    error: { code: number; message: string } | undefined,
  ): void {
    if (!this.process?.stdin || this.process.stdin.destroyed) return;
    const response: Record<string, unknown> = { jsonrpc: '2.0', id };
    if (error) {
      response.error = error;
    } else {
      response.result = result;
    }
    this.process.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private handleReadTextFile(params: unknown): { content: string } {
    const p = params as { path?: string; sessionId?: string } | undefined;
    if (!p?.path) {
      throw new Error('Missing required parameter: path');
    }
    const content = readFileSync(p.path, 'utf-8');
    return { content };
  }

  private handleWriteTextFile(params: unknown): { created: boolean } {
    const p = params as
      | { path?: string; content?: string; sessionId?: string }
      | undefined;
    if (!p?.path || typeof p.content !== 'string') {
      throw new Error('Missing required parameters: path and content');
    }
    const fileExists = existsSync(p.path);
    const dir = dirname(p.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(p.path, p.content, 'utf-8');
    return { created: !fileExists };
  }

  private handleRequestPermission(params: unknown): {
    outcome: { outcome: string; optionId?: string };
  } {
    const p = params as
      | { options?: Array<{ optionId: string; kind: string }> }
      | undefined;
    const options = p?.options ?? [];
    if (options.length === 0) {
      return { outcome: { outcome: 'cancelled' } };
    }
    // Auto-approve: prefer "allow" kind options (protocol uses 'allow_once'/'allow_always')
    const allowOption = options.find(
      (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
    );
    const selected = allowOption ?? options[0];
    return { outcome: { outcome: 'selected', optionId: selected.optionId } };
  }

  private async handleCreateTerminal(
    params: unknown,
  ): Promise<{ terminalId: string }> {
    const p = params as
      | {
          command?: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          sessionId?: string;
        }
      | undefined;
    if (!p?.command) {
      throw new Error('Missing required parameter: command');
    }
    const terminalId = randomUUID();
    const proc = spawn(p.command, p.args ?? [], {
      cwd: p.cwd || undefined,
      env: p.env ? { ...process.env, ...p.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    const terminal: {
      process: ChildProcess;
      output: string;
      exited: boolean;
      exitCode: number | null;
      signal: string | null;
      exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
    } = {
      process: proc,
      output: '',
      exited: false,
      exitCode: null,
      signal: null,
      exitPromise: null as unknown as Promise<{
        exitCode: number | null;
        signal: string | null;
      }>,
    };

    const MAX_OUTPUT = 64 * 1024;
    const appendOutput = (data: Buffer) => {
      const str = data.toString();
      if (terminal.output.length < MAX_OUTPUT) {
        terminal.output += str;
        if (terminal.output.length > MAX_OUTPUT) {
          terminal.output = terminal.output.slice(0, MAX_OUTPUT);
        }
      }
    };

    proc.stdout?.on('data', appendOutput);
    proc.stderr?.on('data', appendOutput);

    terminal.exitPromise = new Promise((resolve) => {
      proc.on('close', (code, signal) => {
        terminal.exited = true;
        terminal.exitCode = code;
        terminal.signal = signal;
        resolve({ exitCode: code, signal });
      });
    });

    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  private handleTerminalOutput(params: unknown): {
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: string | null };
  } {
    const p = params as { terminalId?: string } | undefined;
    if (!p?.terminalId) {
      throw new Error('Missing required parameter: terminalId');
    }
    const terminal = this.terminals.get(p.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${p.terminalId}`);
    }
    const result: {
      output: string;
      truncated: boolean;
      exitStatus?: { exitCode: number | null; signal: string | null };
    } = {
      output: terminal.output,
      truncated: terminal.output.length >= 64 * 1024,
    };
    if (terminal.exited) {
      result.exitStatus = {
        exitCode: terminal.exitCode,
        signal: terminal.signal,
      };
    }
    return result;
  }

  private async handleWaitForTerminalExit(
    params: unknown,
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    const p = params as { terminalId?: string } | undefined;
    if (!p?.terminalId) {
      throw new Error('Missing required parameter: terminalId');
    }
    const terminal = this.terminals.get(p.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${p.terminalId}`);
    }
    return terminal.exitPromise;
  }

  private handleKillTerminal(params: unknown): Record<string, never> {
    const p = params as { terminalId?: string } | undefined;
    if (!p?.terminalId) {
      throw new Error('Missing required parameter: terminalId');
    }
    const terminal = this.terminals.get(p.terminalId);
    if (terminal && !terminal.exited) {
      terminal.process.kill('SIGTERM');
    }
    return {};
  }

  private handleReleaseTerminal(params: unknown): Record<string, never> {
    const p = params as { terminalId?: string } | undefined;
    if (!p?.terminalId) {
      throw new Error('Missing required parameter: terminalId');
    }
    const terminal = this.terminals.get(p.terminalId);
    if (terminal) {
      if (!terminal.exited) {
        terminal.process.kill('SIGTERM');
      }
      this.terminals.delete(p.terminalId);
    }
    return {};
  }

  private rejectAllPending(err: Error): void {
    for (const [id, { reject }] of this.pending) {
      reject(err);
      this.pending.delete(id);
    }
  }
}
