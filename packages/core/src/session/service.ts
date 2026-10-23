import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, LLMProvider } from '@y-zero/shared';
import { SessionStore, type ProjectRow, type SessionRow, type TrashItem } from './store.js';
import { TaskStore } from './tasks.js';
import { MemoryStore } from './memory.js';
import { FileChangeStore } from './changes.js';
import { SearchStore, type SearchOptions, type SearchHit } from './search.js';
import { UsageStore } from './usage.js';
import { resolveEmbedding } from '../llm/embeddings.js';

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
  /** M5: 任务持久化（同库 tasks 表：租约心跳 + 崩溃恢复） */
  readonly tasks: TaskStore;
  /** 记忆里程碑：L2 动态记忆（同库 memories 表：写入管线 + 评分召回） */
  readonly memory: MemoryStore;
  /** F-24 文件变更管理（同库 file_changes 表：写快照 + diff 汇总 + 回滚） */
  readonly changes: FileChangeStore;
  /** F-17 对话检索（同库 messages_fts + message_embeddings：全文 + 语义混合） */
  readonly search: SearchStore;
  /** F-31 成本与用量报告（同库 usage 表：只读聚合查询） */
  readonly usage: UsageStore;
  /** 运行中会话的 AbortController 注册表（删除前必须中止，§8.2 移除安全策略） */
  private activeRuns = new Map<string, AbortController>();

  constructor(dbPath: string = defaultDbPath(), opts?: { embedderFactory?: () => ReturnType<typeof resolveEmbedding> }) {
    this.store = new SessionStore(dbPath);
    this.tasks = new TaskStore(this.store.db);
    this.memory = new MemoryStore(this.store.db);
    this.changes = new FileChangeStore(this.store.db);
    this.search = new SearchStore(this.store.db, opts?.embedderFactory ?? resolveEmbedding);
    this.usage = new UsageStore(this.store.db);
  }

  /**
   * M5 启动恢复：扫描孤儿任务（running 且租约过期 → queued，retries+1）。
   * CLI/Web 启动时调用；返回恢复条数。
   */
  recoverTasks(sessionId?: string): number {
    return this.tasks.recoverOrphans(sessionId);
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

  /**
   * Register (or find) the project for a working directory.
   * F-34：返回值多带 `created`，标记本次是否为新注册（首次启动 onboarding 的判定依据）。
   */
  ensureProject(rootPath: string): { id: string; name: string; created: boolean } {
    const root = path.resolve(rootPath);
    const existing = this.store.findProjectByRoot(root);
    if (existing) return { id: existing.id, name: existing.name, created: false };
    const id = randomUUID();
    const name = path.basename(root) || root;
    this.store.createProject(id, name, root);
    return { id, name, created: true };
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
    const id = this.store.appendMessage(sessionId, m);
    this.search.indexMessage(id, sessionId, m.role, m.content); // F-17 同步全文索引
    this.store.touchSession(sessionId, {});
  }

  getHistory(sessionId: string): ChatMessage[] {
    return this.store.getMessages(sessionId);
  }

  // ── F-18 会话回放（按 user 消息切分任务边界）─────────────────────────────

  getMessagesDetailed(sessionId: string): Array<{ message: ChatMessage; at: string }> {
    return this.store.getMessagesDetailed(sessionId);
  }

  /** 任务（run）摘要列表：每条 user 消息开启一次任务。 */
  getRuns(sessionId: string): RunSummary[] {
    const rows = this.getMessagesDetailed(sessionId);
    const runs: RunSummary[] = [];
    let current: RunSummary | undefined;
    for (const { message: m, at } of rows) {
      if (m.role === 'user') {
        current = {
          index: runs.length,
          startedAt: at,
          endedAt: at,
          userPreview: m.content.slice(0, 80),
          messages: 1,
          toolCalls: 0,
        };
        runs.push(current);
        continue;
      }
      if (!current) continue; // 无 user 开头的游离消息（不属任何任务）
      current.endedAt = at;
      current.messages++;
      current.toolCalls += m.toolCalls?.length ?? 0;
    }
    return runs;
  }

  /** 单次任务的时间线（工具调用与其结果按 callId 配对）。 */
  getRunTimeline(sessionId: string, runIndex: number): RunTimeline | undefined {
    const rows = this.getMessagesDetailed(sessionId);
    // 切分到目标 run 的消息区间
    let idx = -1;
    const spans: Array<Array<{ message: ChatMessage; at: string }>> = [];
    for (const row of rows) {
      if (row.message.role === 'user') {
        idx++;
        spans.push([]);
      }
      if (idx >= 0) spans[idx]!.push(row);
    }
    const span = spans[runIndex];
    if (!span) return undefined;

    const steps: RunTimeline['steps'] = [];
    // 待配对的调用：callId → step 引用
    const pendingCalls = new Map<string, Extract<RunTimeline['steps'][number], { type: 'tool_call' }>>();
    for (const { message: m, at } of span) {
      if (m.role === 'user') {
        steps.push({ type: 'user', at, text: m.content });
      } else if (m.role === 'assistant') {
        if (m.content.trim()) steps.push({ type: 'assistant', at, text: m.content });
        for (const c of m.toolCalls ?? []) {
          const step = {
            type: 'tool_call' as const,
            at,
            name: c.name,
            argsJson: c.argsJson,
          };
          steps.push(step);
          pendingCalls.set(c.id, step);
        }
      } else if (m.role === 'tool') {
        const call = m.toolCallId ? pendingCalls.get(m.toolCallId) : undefined;
        const payload = { ok: true, content: m.content, at };
        if (call) {
          try {
            const parsed = JSON.parse(m.content) as { ok?: boolean };
            payload.ok = parsed.ok !== false;
          } catch {
            /* 非 JSON 结果默认 ok */
          }
          call.result = payload;
        } else {
          steps.push({ type: 'tool_call', at, name: 'tool', argsJson: '', result: payload });
        }
      }
    }
    return {
      index: runIndex,
      startedAt: span[0]!.at,
      endedAt: span[span.length - 1]!.at,
      steps,
    };
  }

  recordUsage(sessionId: string, turn: number, input: number, output: number, costUsd: number, model = ''): void {
    this.store.recordUsage(sessionId, turn, input, output, costUsd, model);
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
    this.tasks.cancelSession(id); // M5: 级联取消排队/运行中任务（§6 中断传播）
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
    for (const s of this.store.listSessions(id)) this.tasks.cancelSession(s.id); // M5 级联取消
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
      for (const s of this.store.listSessions(id)) this.tasks.cancelSession(s.id);
      this.store.hardDeleteProject(id);
    } else {
      this.abortRun(id);
      this.tasks.cancelSession(id);
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

  /**
   * F-17 对话检索：全文（FTS5）+ 语义（embedding）混合搜索历史消息。
   * mode=auto 且 embedding 不可用时自动降级为纯全文。
   */
  async searchMessages(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    return this.search.search(query, opts);
  }
}

export type ProviderId = 'anthropic' | 'openai' | 'deepseek' | 'qwen';

// ── F-18 会话回放类型 ─────────────────────────────────────────────────────

export interface RunSummary {
  /** 第几次任务（从 0 开始） */
  index: number;
  startedAt: string;
  endedAt: string;
  /** 用户输入预览（前 80 字） */
  userPreview: string;
  messages: number;
  toolCalls: number;
}

export interface RunTimeline {
  index: number;
  startedAt: string;
  endedAt: string;
  steps: Array<
    | { type: 'user'; at: string; text: string }
    | { type: 'assistant'; at: string; text: string }
    | {
        type: 'tool_call';
        at: string;
        name: string;
        argsJson: string;
        result?: { ok: boolean; content: string; at: string };
      }
  >;
}

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
