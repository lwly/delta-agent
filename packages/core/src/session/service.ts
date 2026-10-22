import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, LLMProvider } from '@y-zero/shared';
import { SessionStore, type SessionRow } from './store.js';

/** Default DB location: ~/.y-zero/agent.db */
export function defaultDbPath(): string {
  return path.join(os.homedir(), '.y-zero', 'agent.db');
}

/**
 * M1 minimal SessionService: project auto-registration by cwd,
 * session create/append/history. Full service (trash, restore, search)
 * lands with the M4 Web console.
 */
export class SessionService {
  readonly store: SessionStore;

  constructor(dbPath: string = defaultDbPath()) {
    this.store = new SessionStore(dbPath);
  }

  close(): void {
    this.store.close();
  }

  /** Register (or find) the project for a working directory. */
  ensureProject(rootPath: string): { id: string; name: string } {
    const root = path.resolve(rootPath);
    const existing = this.store.findProjectByRoot(root);
    if (existing) return { id: existing.id, name: existing.name };
    const id = randomUUID();
    const name = path.basename(root) || root;
    this.store.createProject(id, name, root);
    return { id, name };
  }

  createSession(projectId: string, opts?: { title?: string; model?: string }): SessionRow {
    return this.store.createSession({ id: randomUUID(), projectId, ...opts });
  }

  getSession(id: string): SessionRow | undefined {
    return this.store.getSession(id);
  }

  listSessions(projectId: string): SessionRow[] {
    return this.store.listSessions(projectId);
  }

  appendMessage(sessionId: string, m: ChatMessage): void {
    this.store.appendMessage(sessionId, m);
    this.store.touchSession(sessionId, {});
  }

  getHistory(sessionId: string): ChatMessage[] {
    return this.store.getMessages(sessionId);
  }

  recordUsage(sessionId: string, turn: number, input: number, output: number, costUsd: number): void {
    this.store.recordUsage(sessionId, turn, input, output, costUsd);
  }

  recordCompaction(sessionId: string, before: number, after: number, summary: string): void {
    this.store.recordCompaction(sessionId, before, after, summary);
  }

  /** Latest session for a project, to support `yzero` resume-on-start. */
  latestSession(projectId: string): SessionRow | undefined {
    return this.listSessions(projectId)[0];
  }
}

/** Resolve the runtime LLM provider from environment (M1: anthropic only). */
export async function resolveProviderFromEnv(): Promise<LLMProvider> {
  const { AnthropicProvider } = await import('../llm/providers/anthropic.js');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY 未设置。M1 阶段请 export ANTHROPIC_API_KEY=sk-ant-... 后重试（M2 将提供 models 命令与本地 Key 管理）。',
    );
  }
  return new AnthropicProvider({
    apiKey,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model: process.env.YZERO_MODEL,
  });
}
