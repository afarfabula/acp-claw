import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface SessionRecord {
  sessionKey: string;
  acpSessionId?: string;
  agentName: string;
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
}

export interface ControllerState {
  startedAt: number;
  lastActivityAt: number;
  activeSessions: string[];
  activeSessionMap?: Record<string, string>;
  /** chatId → sessionKey 映射，用于按聊天 ID 定位会话 */
  chatSessionMap?: Record<string, string>;
}

export class SessionStore {
  constructor(private sessionsDir: string) {
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
  }

  save(record: SessionRecord): void {
    const filePath = join(this.sessionsDir, `${record.sessionKey}.json`);
    writeFileSync(filePath, JSON.stringify(record, null, 2));
  }

  load(sessionKey: string): SessionRecord | undefined {
    const filePath = join(this.sessionsDir, `${sessionKey}.json`);
    if (!existsSync(filePath)) return undefined;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return undefined;
    }
  }

  list(): SessionRecord[] {
    if (!existsSync(this.sessionsDir)) return [];
    const files = readdirSync(this.sessionsDir).filter(
      (f) => f.endsWith('.json') && f !== '_controller.json',
    );
    const records: SessionRecord[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.sessionsDir, file), 'utf-8');
        records.push(JSON.parse(raw) as SessionRecord);
      } catch {
        // skip malformed files
      }
    }
    return records;
  }

  delete(sessionKey: string): void {
    const filePath = join(this.sessionsDir, `${sessionKey}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  saveControllerState(state: ControllerState): void {
    const filePath = join(this.sessionsDir, '_controller.json');
    writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  loadControllerState(): ControllerState | undefined {
    const filePath = join(this.sessionsDir, '_controller.json');
    if (!existsSync(filePath)) return undefined;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as ControllerState;
    } catch {
      return undefined;
    }
  }
}
