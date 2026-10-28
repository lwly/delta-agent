import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { FILES, userConfigDir } from '../paths.js';
import type { ChatMessage, LLMProvider } from '@delta/shared';
import { SessionStore, type ProjectRow, type SessionRow, type TrashItem } from './store.js';
import { TaskStore } from './tasks.js';
import { MemoryStore } from './memory.js';
import { FileChangeStore } from './changes.js';
import { SearchStore, type SearchOptions, type SearchHit } from './search.js';
import { UsageStore } from './usage.js';
import { resolveEmbedding } from '../llm/embeddings.js';

/**
 * F-37：会话当前工作根解析唯一入口（设计文档 §8 共享知识 2，禁止各端自行判断）。
 * worktree 绑定存在且目录存活 → worktree 路径；否则（NULL / 目录被手动删除）回退项目根。
 * 每次 run 组装前调用（D2：工作根重绑定 = 会话持久化字段 + 每次 run 前解析）。
 */
export function resolveWorkRoot(session: SessionRow, projectRoot: string): string {
  if (session.worktree_path && fs.existsSync(session.worktree_path)) {
    return session.worktree_path;
  }
  return projectRoot;
}

/** Default DB location: ~/.delta/agent.db */
export function defaultDbPath(): string {
  return path.join(userConfigDir(), FILES.database);
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

  /**
   * 暂停执行中的会话（PASI-9）：中止当前主循环并把状态落库为 `paused`。
   * 返回 false 表示会话未在执行（无可暂停的运行）。
   * 恢复语义：引擎无断点续跑能力，暂停即结束本轮；下次 send 由 hub 清除
   * paused 标记后正常继续（历史消息保留，用户可追问续做）。
   */
  pauseRun(sessionId: string): boolean {
    if (!this.abortRun(sessionId)) return false;
    this.store.touchSession(sessionId, { status: 'paused' });
    return true;
  }

  /** 清除会话的 paused 标记（恢复执行前由 hub 调用；非 paused 会话不动状态）。 */
  resumeSession(sessionId: string): void {
    const s = this.store.getSession(sessionId);
    if (s?.status === 'paused') this.store.touchSession(sessionId, { status: 'active' });
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
    // 同路径软删除项目复活（历史会话/用量随之找回；UNIQUE(root_path) 不含软删行）
    const revived = this.store.reviveProjectByRoot(root);
    if (revived) return { id: revived.id, name: revived.name, created: true };
    const id = randomUUID();
    const name = path.basename(root) || root;
    this.store.createProject(id, name, root);
    return { id, name, created: true };
  }

  createSession(
    projectId: string,
    opts?: {
      title?: string;
      model?: string;
      mode?: string;
      expert?: string | null;
      expertType?: 'agent' | 'team' | null;
    },
  ): SessionRow {
    // F-39 D5：团队专家强制 react —— 唯一收口点（CLI / HTTP / 任何调用方都经过这里）
    const mode = opts?.expertType === 'team' ? 'react' : opts?.mode;
    return this.store.createSession({ id: randomUUID(), projectId, ...opts, mode });
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

  /** F-37：更新会话 worktree 绑定（worktreePath/worktreeBranch；null = 解绑回主工作区）。 */
  setSessionWorktree(id: string, patch: { worktreePath?: string | null; worktreeBranch?: string | null }): void {
    if (!this.store.getSession(id)) throw new Error('session not found');
    this.store.setSessionWorktree(id, patch);
  }

  /** F-39：就地校正会话执行模式（团队专家绑定 → react） */
  setSessionMode(id: string, mode: string): void {
    if (!this.store.getSession(id)) throw new Error('session not found');
    this.store.setSessionMode(id, mode);
  }

  /** F-39：更新会话的专家绑定（CLI 空会话就地绑定/解绑；Web P0 不走这里） */
  setSessionExpert(id: string, patch: { expert: string | null; expertType: 'agent' | 'team' | null }): void {
    if (!this.store.getSession(id)) throw new Error('session not found');
    this.store.setSessionExpert(id, patch);
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

  /** Latest session for a project, to support `delta` resume-on-start. */
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
   * 删除会话：默认软删除（回收站 30 天）。
   * PASI-9：执行中的会话禁止删除（调用方应先暂停或停止），直接抛错；
   * 项目级联删除 / 回收站彻底清除路径会先 abort 再走到这里，不受影响。
   * hard=true 物理清除（事务内）。
   */
  removeSession(id: string, opts?: { hard?: boolean }): void {
    if (this.isRunning(id)) throw new Error('会话执行中，请先暂停或停止后再删除');
    this.abortRun(id);
    this.tasks.cancelSession(id); // M5: 级联取消排队/运行中任务（§6 中断传播）
    if (opts?.hard) this.store.hardDeleteSession(id);
    else this.store.softDeleteSession(id);
  }

  /**
   * 移除项目：confirmName 必须与项目名完全一致（双端校验）；
   * 级联中止运行中会话并软/硬删除；仅解除注册，不触碰源码目录。
   */
  removeProject(id: string, confirmName: string, opts?: { hard?: boolean }): void {    const project = this.store.getProject(id);
    if (!project) throw new Error('project not found');
    if (confirmName !== project.name) throw new Error('confirmName does not match project name');
    this.abortAllProjectRuns(id);
    for (const s of this.store.listSessions(id)) this.tasks.cancelSession(s.id); // M5 级联取消
    if (opts?.hard) this.store.hardDeleteProject(id);
    else this.store.softDeleteProject(id);
  }

  /** 项目重命名（侧栏更多菜单；仅改显示名，不移动目录）。 */
  renameProject(id: string, name: string): { id: string; name: string } {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('项目名不能为空');
    const project = this.store.getProject(id);
    if (!project) throw new Error('project not found');
    this.store.renameProject(id, trimmed);
    return { id, name: trimmed };
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

  /**
   * 回收站批量彻底清除：逐条调用 purgeTrash，单条失败不影响其余条目。
   * 先对照回收站列表校验存在性（硬删本身对缺失 id 静默成功，需在此拦截），
   * 非法 kind/id 或不在回收站的条目计入 failed 而不抛错；items 为空由 HTTP 层校验拒绝。
   */
  purgeTrashBatch(items: Array<{ kind: 'project' | 'session'; id: string }>): {
    purged: number;
    failed: Array<{ kind: string; id: string; error: string }>;
  } {
    const inTrash = new Set(this.store.listTrash().map((t) => `${t.kind}:${t.id}`));
    let purged = 0;
    const failed: Array<{ kind: string; id: string; error: string }> = [];
    for (const item of items) {
      if ((item.kind !== 'project' && item.kind !== 'session') || typeof item.id !== 'string' || !item.id) {
        failed.push({ kind: String(item.kind), id: String(item.id), error: 'invalid kind or id' });
        continue;
      }
      if (!inTrash.has(`${item.kind}:${item.id}`)) {
        failed.push({ kind: item.kind, id: item.id, error: `${item.kind} not found in trash` });
        continue;
      }
      try {
        this.purgeTrash(item.kind, item.id);
        purged++;
      } catch (e) {
        failed.push({ kind: item.kind, id: item.id, error: (e as Error).message });
      }
    }
    return { purged, failed };
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
 * explicit id > DELTA_PROVIDER > env keys > stored config (`delta models add`).
 * `opts.modelsFile` overrides the provider store location (DI / tests).
 */
export async function resolveProviderFromEnv(
  id?: string,
  opts?: { modelsFile?: string },
): Promise<LLMProvider> {
  // F-45 E2E：脚本化假 Provider 注入（显式环境变量开启；默认关闭对生产零影响）。
  // scripted=确定性「工具→答案」脚本；error=致命错误（退出码 2）；burn=大用量（触发退出码 4）。
  const fakeMode = process.env.DELTA_FAKE_PROVIDER;
  if (fakeMode === 'scripted' || fakeMode === 'error' || fakeMode === 'burn') {
    const { ScriptedFakeProvider } = await import('../llm/fake-provider.js');
    return new ScriptedFakeProvider(fakeMode);
  }

  const wanted = (id || process.env.DELTA_PROVIDER || '') as ProviderId | '';
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
        model: process.env.DELTA_MODEL,
      });
    }
    const env = PROVIDER_ENV[pid];
    const apiKey = process.env[env.key];
    if (!apiKey) continue;
    const mod = (await import(`../llm/providers/${pid}.js`)) as Record<string, unknown>;
    // 导出名不做朴素驼峰拼名（deepseek→DeepSeekProvider、openai→OpenAIProvider 含连续大写），
    // 先按 camelCase 精确取，取不到再按「类名以 Provider 结尾」兜底查找
    const Ctor = (mod[`${pid[0]!.toUpperCase()}${pid.slice(1)}Provider`] ??
      Object.values(mod).find(
        (v) => typeof v === 'function' && v.name.endsWith('Provider'),
      )) as new (opts: {
      apiKey: string;
      baseUrl?: string;
      model?: string;
    }) => LLMProvider;
    return new Ctor({
      apiKey,
      baseUrl: env.base ? process.env[env.base] : undefined,
      model: process.env.DELTA_MODEL,
    });
  }

  // env miss → stored provider config (`delta models add`)
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
      `或用 DELTA_PROVIDER / --provider 指定，或运行 \`delta models add\` 保存配置。${hint}`,
  );
}
