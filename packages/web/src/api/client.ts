/**
 * API client：`yzero serve` REST 端点封装（technical-design §8.2）。
 * 同源部署（serve 内嵌托管）+ dev 代理，均走相对路径。
 */

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  session_count: number;
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  mode: string;
  model: string;
  status: string;
  created_at: string;
  updated_at: string;
  /** F-37：worktree 绑定路径；NULL = 主工作区（会话列表 🌿 标识数据源） */
  worktree_path: string | null;
  worktree_branch: string | null;
}

// ── F-37 git 分支切换 + worktree 会话级隔离（与 core SessionGitState 同构）────

export interface BranchInfo {
  name: string;
  current: boolean;
}

export interface SessionGitState {
  isRepo: boolean;
  projectName: string;
  branch: string | null;
  worktree: { enabled: boolean; path: string | null; branch: string | null };
  running: boolean;
}

export interface BranchSwitchResult {
  ok: boolean;
  reason?: string;
  branch?: string;
  path?: string;
}

export interface MessageImage {
  mediaType: string;
  base64: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; argsJson: string }>;
  toolCallId?: string;
  /** F-25 多模态：user 消息的图片附件 */
  images?: MessageImage[];
  /**
   * F-30 沙箱徽标（R8）：来自 tool_result 事件的 result.meta.sandbox，
   * 只在实时流式期间展示；历史回看（落库不含 meta）不显示。
   */
  sandboxMeta?: {
    mode: string;
    network?: string;
    ms?: number;
    degraded?: boolean;
  };
}

export interface TrashItem {
  kind: 'project' | 'session';
  id: string;
  name: string;
  deleted_at: string;
  project_id?: string;
}

export interface ConfirmRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface HubEvent {
  type: string;
  [key: string]: unknown;
}

async function request<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export interface MemoryItem {
  id: string;
  scope: string;
  kind: string;
  content: string;
  keywords: string;
  importance: number;
  confidence: number;
  access_count: number;
  last_access_at: number | null;
  source: string | null;
  status: 'confirmed' | 'pending';
  superseded_by: string | null;
  created_at: number;
  deleted_at: number | null;
  /** 召回预览时附带 */
  score?: number;
}

export interface MemoryUsage {
  count: number;
  tokens: number;
}

export interface PlanNode {
  id: string;
  goal: string;
  deps: string[];
  suggestedTools: string[];
  role?: string;
  critical?: boolean;
  status: string;
  retries: number;
}

export interface PlanPayload {
  goal: string;
  revision: number;
  nodes: PlanNode[];
}

export interface RunSummary {
  index: number;
  startedAt: string;
  endedAt: string;
  userPreview: string;
  messages: number;
  toolCalls: number;
}

export interface RunStep {
  type: 'user' | 'assistant' | 'tool_call';
  at: string;
  text?: string;
  name?: string;
  argsJson?: string;
  result?: { ok: boolean; content: string; at: string };
}

export interface RunTimeline {
  index: number;
  startedAt: string;
  endedAt: string;
  steps: RunStep[];
}

/** F-17 对话检索命中 */
export interface MessageHit {
  messageId: number;
  sessionId: string;
  sessionTitle: string;
  role: string;
  content: string;
  snippet: string;
  at: string;
  score: number;
  via: 'fulltext' | 'semantic' | 'hybrid';
}

// ── F-31 成本与用量报告（snake_case，与 API/CLI --json 同构）──────────────

export type UsageRange = 'today' | '7d' | '30d' | 'all';

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  turns: number;
  sessions: number;
}

export interface UsageProjectRow extends UsageTotals {
  project_id: string | null;
  project_name: string;
}

export interface UsageModelRow extends UsageTotals {
  model: string;
}

export interface UsageSessionRow extends UsageTotals {
  session_id: string;
  project_id: string;
  title: string;
  model: string;
}

export interface UsageSummary {
  range: UsageRange;
  project: string | null;
  totals: UsageTotals;
  by_project: UsageProjectRow[];
  by_model: UsageModelRow[];
}

export interface UsageSessions {
  range: UsageRange;
  project: string | null;
  items: UsageSessionRow[];
}

// ── F-04a Provider 管理视图（工作台模型配置弹窗与模型下拉共用）──────────────

export interface ProviderView {
  id: string;
  vendor: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
  default: boolean;
  keyMasked: string;
}

// ── F-22 定时任务（调度面板；字段与 core CronJob 对应，snake_case 承载）──────

export interface CronRunRecordView {
  trigger: 'schedule' | 'manual';
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: string;
  exit_code: number | null;
  session_id?: string;
  cost_usd?: number;
  turns?: number;
  error?: string;
  result_preview?: string;
}

export interface CronJobView {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  cwd: string;
  enabled: boolean;
  max_cost_usd?: number;
  created_at: string;
  updated_at: string;
  next_run_at?: string;
  running_since?: string;
  last_run?: CronRunRecordView;
  runs: CronRunRecordView[];
}

export interface CronJobInput {
  name: string;
  cron: string;
  prompt: string;
  cwd: string;
  max_cost_usd?: number;
  enabled?: boolean;
}

/** Composer「/ 技能」候选：skill 元数据（不含正文内容） */
export interface SkillCandidate {
  name: string;
  description: string;
  layer: 'builtin' | 'user' | 'project';
}

export const api = {
  // projects
  listProjects: () => request<ProjectRow[]>('GET', '/api/projects'),
  createProject: (root: string) => request<ProjectRow>('POST', '/api/projects', { root }),
  removeProject: (id: string, confirmName: string, hard = false) =>
    request<{ ok: boolean }>('DELETE', `/api/projects/${id}`, { confirmName, hard }),
  // 侧栏更多菜单：重命名（仅显示名）/ 在系统文件管理器打开目录
  renameProject: (id: string, name: string) =>
    request<{ id: string; name: string }>('POST', `/api/projects/${id}/rename`, { name }),
  revealProject: (id: string) => request<{ ok: boolean }>('POST', `/api/projects/${id}/reveal`),
  // Composer「@ 文件引用」候选：项目根内相对路径（服务端已做忽略目录/符号链接过滤）
  listProjectFiles: (projectId: string, q = '') =>
    request<{ files: string[] }>('GET', `/api/projects/${projectId}/files?q=${encodeURIComponent(q)}`),
  // Composer「/ 技能」候选：三层发现的 skill 元数据
  listSkills: (projectId?: string) =>
    request<{ skills: SkillCandidate[]; errors: string[] }>(
      'GET',
      `/api/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),

  // sessions
  listSessions: (projectId: string) => request<SessionRow[]>('GET', `/api/projects/${projectId}/sessions`),
  createSession: (projectId: string, opts?: { title?: string; model?: string; mode?: string }) =>
    request<SessionRow>('POST', `/api/projects/${projectId}/sessions`, opts),
  getSession: (id: string) => request<{ session: SessionRow; messages: ChatMessage[] }>('GET', `/api/sessions/${id}`),
  renameSession: (id: string, title: string) => request<{ ok: boolean }>('PATCH', `/api/sessions/${id}`, { title }),
  removeSession: (id: string, hard = false) =>
    request<{ ok: boolean }>('DELETE', `/api/sessions/${id}?hard=${hard}`),
  // PASI-9：暂停执行中的会话（中止本轮 + 状态落库 paused；发消息即恢复）
  pause: (sessionId: string) => request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/pause`),
  // 会话级权限模式（plan 只读 / default 询问确认 / yolo 全部放行）
  getPermission: (sessionId: string) =>
    request<{ mode: 'plan' | 'default' | 'yolo' }>('GET', `/api/sessions/${sessionId}/permission`),
  setPermission: (sessionId: string, mode: 'plan' | 'default' | 'yolo') =>
    request<{ ok: boolean; mode: 'plan' | 'default' | 'yolo' }>('PATCH', `/api/sessions/${sessionId}/permission`, { mode }),
  // PASI-9：运行中的会话 id 列表（侧栏 ⏸/✕ 切换与删除门禁）
  runningSessions: () => request<{ ids: string[] }>('GET', '/api/running-sessions'),

  // F-37 git 分支切换 + worktree（session 作用域，与 /permission 同级同风格）
  gitState: (sessionId: string) => request<SessionGitState>('GET', `/api/sessions/${sessionId}/git`),
  listBranches: (sessionId: string) =>
    request<{ ok: true; branches: BranchInfo[] }>('GET', `/api/sessions/${sessionId}/branches`),
  checkoutBranch: (sessionId: string, opts: { branch?: string; newBranch?: string }) =>
    request<BranchSwitchResult>('POST', `/api/sessions/${sessionId}/checkout`, opts),
  setWorktree: (sessionId: string, enabled: boolean, opts?: { branch?: string; newBranch?: string }) =>
    request<BranchSwitchResult>('POST', `/api/sessions/${sessionId}/worktree`, { enabled, ...opts }),

  // 运行（images = F-25 多模态图片附件，base64 不含 data: 前缀）
  send: (sessionId: string, input: string, images?: MessageImage[]) =>
    request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/messages`, { input, images }),
  abort: (sessionId: string) => request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/abort`),
  confirm: (sessionId: string, requestId: string, decision: Record<string, unknown>) =>
    request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/confirm`, { requestId, decision }),
  answer: (sessionId: string, requestId: string, answer: string) =>
    request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/answer`, { requestId, answer }),
  // F-14 计划审批
  approvePlan: (sessionId: string, requestId: string, decision: Record<string, unknown>) =>
    request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/plan`, { requestId, decision }),

  // trash / search
  listTrash: () => request<TrashItem[]>('GET', '/api/trash'),
  restore: (kind: 'project' | 'session', id: string) => request<{ ok: boolean }>('POST', `/api/trash/restore/${kind}/${id}`),
  purgeTrash: (kind: 'project' | 'session', id: string) => request<{ ok: boolean }>('DELETE', `/api/trash/${kind}/${id}`),
  search: (q: string) => request<SessionRow[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  // F-17 对话检索：全文/语义搜索历史消息
  searchMessages: (q: string, mode?: 'auto' | 'fulltext' | 'semantic') => {
    const params = new URLSearchParams({ q });
    if (mode) params.set('mode', mode);
    return request<MessageHit[]>('GET', `/api/search/messages?${params.toString()}`);
  },

  // F-18 会话回放
  listRuns: (sessionId: string) => request<RunSummary[]>('GET', `/api/sessions/${sessionId}/runs`),
  getRunTimeline: (sessionId: string, index: number) =>
    request<RunTimeline>('GET', `/api/sessions/${sessionId}/runs/${index}`),

  // memory（F-06a 记忆面板）
  listMemory: (scope?: string, kind?: string, status?: string) => {
    const q = new URLSearchParams();
    if (scope) q.set('scope', scope);
    if (kind) q.set('kind', kind);
    if (status) q.set('status', status);
    const qs = q.toString();
    return request<{ items: MemoryItem[]; usage?: MemoryUsage }>('GET', `/api/memory${qs ? `?${qs}` : ''}`);
  },
  saveMemory: (input: { scope: string; kind: string; content: string; importance?: number; confidence?: number }) =>
    request<{ ok: boolean; action: string; id: string }>('POST', '/api/memory', input),
  updateMemory: (id: string, patch: { content?: string; importance?: number; kind?: string; confidence?: number }) =>
    request<{ ok: boolean }>('PATCH', `/api/memory/${id}`, patch),
  removeMemory: (id: string, hard = false) => request<{ ok: boolean }>('DELETE', `/api/memory/${id}?hard=${hard}`),
  restoreMemory: (id: string) => request<{ ok: boolean }>('POST', `/api/memory/${id}/restore`),
  listMemoryTrash: () => request<MemoryItem[]>('GET', '/api/memory/trash'),
  approveMemory: (id: string) => request<{ ok: boolean }>('POST', `/api/memory/${id}/approve`),
  rejectMemory: (id: string) => request<{ ok: boolean }>('POST', `/api/memory/${id}/reject`),
  previewRecall: (query: string, scopes?: string[]) =>
    request<MemoryItem[]>('POST', '/api/memory/recall', { query, scopes }),

  // usage（F-31 成本与用量报告）
  usageSummary: (range?: UsageRange, project?: string) => {
    const q = new URLSearchParams();
    if (range) q.set('range', range);
    if (project) q.set('project', project);
    const qs = q.toString();
    return request<UsageSummary>('GET', `/api/usage/summary${qs ? `?${qs}` : ''}`);
  },
  usageSessions: (range?: UsageRange, project?: string) => {
    const q = new URLSearchParams();
    if (range) q.set('range', range);
    if (project) q.set('project', project);
    const qs = q.toString();
    return request<UsageSessions>('GET', `/api/usage/sessions${qs ? `?${qs}` : ''}`);
  },

  // cron（F-22 定时任务面板）
  cronList: () => request<{ jobs: CronJobView[]; warnings: Array<{ message: string }> }>('GET', '/api/cron'),
  cronGet: (id: string) => request<CronJobView>('GET', `/api/cron/${id}`),
  cronAdd: (input: CronJobInput) => request<CronJobView>('POST', '/api/cron', input),
  cronUpdate: (id: string, patch: Partial<Pick<CronJobInput, 'name' | 'cron' | 'prompt' | 'cwd' | 'max_cost_usd'> & { enabled: boolean }>) =>
    request<CronJobView>('PATCH', `/api/cron/${id}`, patch),
  cronRemove: (id: string) => request<{ ok: boolean }>('DELETE', `/api/cron/${id}`),
  cronRun: (id: string) => request<{ ok: boolean; running: boolean }>('POST', `/api/cron/${id}/run`),
};
