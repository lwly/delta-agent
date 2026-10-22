import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, LLMProvider } from '@y-zero/shared';
import { SessionStore, type ProjectRow, type SessionRow, type TrashItem } from './store.js';

/** Default DB location: ~/.y-zero/agent.db */
export function defaultDbPath(): string {
  return path.join(os.homedir(), '.y-zero', 'agent.db');
}

export const TRASH_RETENTION_DAYS = 30;

/**
 * SessionService：多项目 × 多对话（technical-design §8）。
 * M4 补全：项目列表、软删除/回收站/恢复/过期清理、会话检索、运行中会话管理。
 */
export class SessionService {
  readonly store: SessionStore;
  /** 运行中会话的 AbortController 注册表（删除前必须中止，§8.2 移除安全策略） */
  private activeRuns = new Map<string, AbortController>();

  constructor(dbPath: string = defaultDbPath()) {
    this.store = new SessionStore(dbPath);
  }

  close(): void {
    this.store.close();
  }

  // ── 运行中会话管理 ────────────────────────────────────────────────────────

  /** 引擎启动时注册；结束时务必 unregisterRun。 */
  registerRun(sessionId: string, controller: AbortController): void {
    this.activeRuns.set(sessionId, controller);
  }

  unregisterRun(sessionId: string): void {
    this.activeRuns.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  /** 中止运行中的会话主循环（删除前调用；等待由调用方完成工具退出）。 */
  abortRun(sessionId: string): boolean {
    const c = this.activeRuns.get(sessionId);
    if (!c) return false;
    c.abort();
    this.activeRuns.delete(sessionId);
    return true;
  }

  private abortAllProjectRuns(projectId: string): void {
    for (const s of this.store.listSessions(projectId)) this.abortRun(s.id);
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

  createSession(projectId: string, opts?: { title?: string; model?: string; mode?: string }): SessionRow {
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

  // ── M4：项目/会话管理（§8.2 服务接口）────────────────────────────────────

  listProjects(): ProjectRow[] {
    return this.store.listProjects();
  }

  getProject(id: string): ProjectRow | undefined {
    return this.store.getProject(id);
  }

  renameSession(id: string, title: string): void {
    if (!this.store.getSession(id)) throw new Error('session not found');
    this.store.touchSession(id, { title: title.trim() || undefined });
  }

  /**
   * 删除会话：默认软删除（回收站 30 天）；运行中先中止。
   * hard=true 物理清除（事务内）。
   */
  removeSession(id: string, opts?: { hard?: boolean }): void {
    this.abortRun(id);
    if (opts?.hard) this.store.hardDeleteSession(id);
    else this.store.softDeleteSession(id);
  }

  /**
   * 移除项目：confirmName 必须与项目名完全一致（双端校验）；
   * 级联中止运行中会话并软/硬删除；仅解除注册，不触碰源码目录。
   */
  removeProject(id: string, confirmName: string, opts?: { hard?: boolean }): void {
    const project = this.store.getProject(id);
    if (!project) throw new Error('project not found');
    if (confirmName !== project.name) throw new Error('confirmName does not match project name');
    this.abortAllProjectRuns(id);
    if (opts?.hard) this.store.hardDeleteProject(id);
    else this.store.softDeleteProject(id);
  }

  restore(kind: 'project' | 'session', id: string): void {
    if (kind === 'project') this.store.restoreProject(id);
    else this.store.restoreSession(id);
  }

  /** 回收站内彻底清除（已软删除，跳过 confirmName 二次确认）。 */
  purgeTrash(kind: 'project' | 'session', id: string): void {
    if (kind === 'project') {
      this.abortAllProjectRuns(id);
      this.store.hardDeleteProject(id);
    } else {
      this.abortRun(id);
      this.store.hardDeleteSession(id);
    }
  }

  listTrash(): TrashItem[] {
    return this.store.listTrash();
  }

  /** 清理超期软删除（默认 30 天），返回清除条数。 */
  purgeExpired(days: number = TRASH_RETENTION_DAYS): number {
    return this.store.purgeExpired(days);
  }

  /** 会话检索：标题或消息内容（仅存活的会话）。 */
  searchSessions(query: string, limit = 20): SessionRow[] {
    const q = query.trim();
    if (!q) return [];
    return this.store.searchSessions(q, limit);
  }
}

export type ProviderId = 'anthropic' | 'openai' | 'deepseek' | 'qwen';

/** env var holding the API key for each provider */
const PROVIDER_ENV: Record<Exclude<ProviderId, 'anthropic'>, { key: string; base?: string }> = {
  openai: { key: 'OPENAI_API_KEY', base: 'OPENAI_BASE_URL' },
  deepseek: { key: 'DEEPSEEK_API_KEY', base: 'DEEPSEEK_BASE_URL' },
  qwen: { key: 'DASHSCOPE_API_KEY', base: 'DASHSCOPE_BASE_URL' },
};

/**
 * Resolve the runtime LLM provider:
 * explicit id > YZERO_PROVIDER > env keys > stored config (`yzero models add`).
 * `opts.modelsFile` overrides the provider store location (DI / tests).
 */
export async function resolveProviderFromEnv(
  id?: string,
  opts?: { modelsFile?: string },
): Promise<LLMProvider> {
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

  // env miss → stored provider config (`yzero models add`)
  const { ProviderManager } = await import('../llm/manager.js');
  const mgr = new ProviderManager(opts?.modelsFile);
  const errors: string[] = [];
  for (const pid of mgr.activeIds()) {
    if (wanted && pid !== wanted) continue;
    try {
      return await mgr.createProvider(pid);
    } catch (e) {
      errors.push(`${pid}: ${(e as Error).message}`);
    }
  }

  const tried = wanted || 'anthropic/deepseek/qwen/openai';
  const hint = errors.length ? `\n存储配置解析失败：\n  ${errors.join('\n  ')}` : '';
  throw new Error(
    `未找到可用的 Provider（尝试顺序：${tried}）。请设置对应 API Key：` +
      `ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY，` +
      `或用 YZERO_PROVIDER / --provider 指定，或运行 \`yzero models add\` 保存配置。${hint}`,
  );
}
