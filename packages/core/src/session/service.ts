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

export type ProviderId = 'anthropic' | 'openai' | 'deepseek' | 'qwen';

/** env var holding the API key for each provider */
const PROVIDER_ENV: Record<Exclude<ProviderId, 'anthropic'>, { key: string; base?: string }> = {
  openai: { key: 'OPENAI_API_KEY', base: 'OPENAI_BASE_URL' },
  deepseek: { key: 'DEEPSEEK_API_KEY', base: 'DEEPSEEK_BASE_URL' },
  qwen: { key: 'DASHSCOPE_API_KEY', base: 'DASHSCOPE_BASE_URL' },
};

/** Resolve the runtime LLM provider: explicit id > YZERO_PROVIDER > first configured key. */
export async function resolveProviderFromEnv(id?: string): Promise<LLMProvider> {
  const wanted = (id || process.env.YZERO_PROVIDER || '') as ProviderId | '';
  const candidates: ProviderId[] = wanted
    ? [wanted]
    : ['anthropic', 'deepseek', 'qwen', 'openai'];

  for (const pid of candidates) {
    if (pid === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) continue;
      const { AnthropicProvider } = await import('../llm/providers/anthropic.js');
      return new AnthropicProvider({
        apiKey,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        model: process.env.YZERO_MODEL,
      });
    }
    const env = PROVIDER_ENV[pid];
    const apiKey = process.env[env.key];
    if (!apiKey) continue;
    const mod = await import(`../llm/providers/${pid}.js`);
    const Ctor = mod[`${pid[0]!.toUpperCase()}${pid.slice(1)}Provider`] as new (opts: {
      apiKey: string;
      baseUrl?: string;
      model?: string;
    }) => LLMProvider;
    return new Ctor({
      apiKey,
      baseUrl: env.base ? process.env[env.base] : undefined,
      model: process.env.YZERO_MODEL,
    });
  }

  const tried = wanted || 'anthropic/deepseek/qwen/openai';
  throw new Error(
    `未找到可用的 Provider（尝试顺序：${tried}）。请设置对应 API Key：` +
      `ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY，` +
      `或用 YZERO_PROVIDER 指定厂商。`,
  );
}
