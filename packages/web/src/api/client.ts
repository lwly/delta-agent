/**
 * API client：`delta serve` REST 端点封装（technical-design §8.2）。
 * 同源部署（serve 内嵌托管）+ dev 代理，均走相对路径。
 * 桌面宿主鉴权：token 由 api/auth.ts 承载（fetch 头 + 下载链接 query）。
 */
import { authHeaders, authQuery } from './auth';

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
  /** F-39：绑定专家 name；NULL = 无专家 */
  expert: string | null;
  expert_type: string | null;
}

// ── F-39 专家 / 专家团（与 core ExpertListItem / 详情 DTO 同构）────────────

export interface LocalizedText {
  en: string;
  zh: string;
}

export type ExpertType = 'agent' | 'team';

export interface ExpertListItem {
  /** P1（T16）：user/project 层已信任（builtin 恒 true）；召唤前信任门的数据源 */
  trusted?: boolean;
  name: string;
  displayName: LocalizedText;
  profession: LocalizedText;
  expertType: ExpertType;
  layer: 'builtin' | 'user' | 'project';
  description: string;
  keywords: string[];
  categoryId: string | null;
  memberCount: number;
  missingMcp: string[];
  hasAvatar: boolean;
}

export interface ExpertMemberView {
  id: string;
  name: LocalizedText;
  profession: LocalizedText;
  role: 'lead' | 'member';
  avatar: boolean;
  skills: string[];
}

export interface ExpertDetail {
  name: string;
  version: string;
  description: string;
  author: { name: string; email?: string };
  expertType: ExpertType;
  displayName: LocalizedText;
  profession: LocalizedText;
  layer: 'builtin' | 'user' | 'project';
  skills: string[];
  tools: string[] | null;
  tool_stats: { restricted: number; total: number; unrestricted: boolean };
  /** P1（T16）：工具集指纹（信任确认回传用；服务端重算复核） */
  tools_hash: string;
  keywords: string[];
  members: ExpertMemberView[];
  prompt_preview: string;
  prompt_stats: { chars: number; tokens: number; truncated: boolean };
  hasAvatar: boolean;
}

export interface SessionExpertState {
  bound: null | {
    name: string;
    displayName?: LocalizedText;
    profession?: LocalizedText;
    expertType?: ExpertType;
    layer?: 'builtin' | 'user' | 'project';
    hasAvatar?: boolean;
  };
  missing: boolean;
  mode_forced: boolean;
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
  // ── 以下均为 Web UI 本地字段（非服务端协议），仅对 SSE 实时到达的消息记录 ──
  /** UI-本地：消息本地接收时间（ms）；历史会话拉回的消息无此字段 → 不显示时间戳 */
  ts?: number;
  /** F-39：专家团成员显示名（UI 本地字段；实时 = meta.agent_name，回放由 content 前缀解析回填） */
  agentName?: string;
  /** UI-本地：thinking_delta 累积的思考文本（随其后落库的 assistant 消息保留展示） */
  thinking?: string;
  /** UI-本地：工具本地计时耗时（ms）；tool_call_start→tool_result 差值，非服务端口径 */
  durationMs?: number;
  /** UI-本地：本次会话内工具调用序号（store 递增计数，按 callId 关联） */
  toolSeq?: number;
  /** UI-本地：tool_result 事件 ok 原值（落库不含 ok，重拉后由 store 回带） */
  ok?: boolean;
}

export interface TrashItem {
  kind: 'project' | 'session';
  id: string;
  name: string;
  deleted_at: string;
  project_id?: string;
}

/** 回收站批量彻底清除：单条失败明细 */
export interface PurgeBatchFailure {
  kind: string;
  id: string;
  error: string;
}

/** 回收站批量彻底清除结果：ok 恒为 true，部分失败看 failed */
export interface PurgeBatchResult {
  ok: boolean;
  purged: number;
  failed: PurgeBatchFailure[];
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
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

/**
 * 统一 fetch 封装：供未走 `api` 对象的调用方（面板组件直连端点等）使用。
 * 桌面宿主对 /api/* 强制校验 x-delta-auth，任何裸 fetch 都会 401，
 * 必须经此函数（或 request()）发起请求。
 * token 为空（CLI serve / 浏览器形态）时原样透传 headers，不附加任何凭据。
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders() },
  });
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

// ── 会话预算设置（settings.json 的 budget 键；累计口径：input+output 按轮累加）──

export interface BudgetSetting {
  maxTokens?: number;
  maxCostUsd?: number;
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
  /** F-22b 任务级权限模式；缺省视为 default */
  permission?: 'plan' | 'default' | 'yolo';
  /** F-22b 有效期起点（ISO）；缺省长期有效 */
  valid_from?: string;
  /** F-22b 有效期终点（ISO）；缺省长期有效 */
  valid_until?: string;
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
  /** F-22b 权限模式；缺省 default */
  permission?: 'plan' | 'default' | 'yolo';
  /** F-22b 有效期起点（ISO）；缺省长期有效 */
  valid_from?: string;
  /** F-22b 有效期终点（ISO）；缺省长期有效 */
  valid_until?: string;
}

/** PATCH /api/cron/:id 补丁：permission/valid_from/valid_until 支持 null = 清除（恢复缺省语义） */
export interface CronJobPatch {
  name?: string;
  cron?: string;
  prompt?: string;
  cwd?: string;
  max_cost_usd?: number;
  enabled?: boolean;
  permission?: 'plan' | 'default' | 'yolo' | null;
  valid_from?: string | null;
  valid_until?: string | null;
}

/** GET /api/cron 响应（F-22b：workspaces = serve 启动目录 + 既有任务 cwd 去重，供表单下拉） */
export interface CronListResponse {
  jobs: CronJobView[];
  warnings: Array<{ message: string }>;
  workspaces: string[];
}

/** Composer「/ 技能」候选：skill 元数据（不含正文内容） */
export interface SkillCandidate {
  name: string;
  description: string;
  layer: 'builtin' | 'user' | 'project';
}

// ── Skills / MCP 配置中心（设置页面板）──────────────────────────────────────

/** Skill 完整视图（GET /api/skills/detail；body 供编辑器回填） */
export interface SkillDetailView {
  name: string;
  description: string;
  triggers: string[];
  toolsAllowlist: string[];
  layer: 'builtin' | 'user' | 'project';
  dir: string;
  references: string[];
  body: string;
  /** 当前层同名覆盖的低层来源（如 project 覆盖 user → 'user'） */
  shadowing?: 'builtin' | 'user' | 'project';
}

export interface SkillDetailResponse {
  skills: SkillDetailView[];
  /** 逐层原始发现（未经同名覆盖合并），供展示覆盖关系 */
  layers: Record<string, SkillDetailView[]>;
  /** name → 该 Skill 存在于哪些层（低层同名内容被高层覆盖后仍保留在磁盘） */
  availability: Record<string, string[]>;
  errors: string[];
}

export interface SkillSaveInput {
  scope: 'user' | 'project';
  projectId?: string;
  description: string;
  triggers: string[];
  toolsAllowlist: string[];
  body: string;
}

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  /** 保留字段（当前仅支持 stdio 传输），原样存取 */
  url?: string;
}

export interface McpFileState {
  path: string;
  exists: boolean;
  parseError?: string;
  servers: Record<string, McpServerEntry>;
}

export interface McpConfigResponse {
  global: McpFileState;
  project: McpFileState | null;
  /** 合并视图（项目覆盖全局），值带 __source 标注来源 */
  merged: Record<string, McpServerEntry & { __source: 'global' | 'project' }>;
  projectEnabled: boolean;
}

// ── Skill Hub（技能市场：目录浏览 / 预览 / 一键安装 / 远程源管理）────────────

/** Hub 目录条目（GET /api/skill-hub items 元素；含完整 body 供本地预览兜底） */
export interface HubEntryView {
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  triggers: string[];
  toolsAllowlist: string[];
  body: string;
  /** 来源：'builtin' 或远程源名 */
  source: string;
  /** 已安装层（本地 SKILL.md 无版本字段，不做版本对比 → UI 口径为「覆盖重装」） */
  installedIn: { user?: boolean; project?: boolean; builtin?: boolean };
}

/** 远程源拉取状态 */
export interface HubSourceStatus {
  name: string;
  url: string;
  status: 'ok' | 'error';
  error?: string;
  count: number;
}

export interface HubListResponse {
  items: HubEntryView[];
  sources: HubSourceStatus[];
  errors: string[];
}

/** 远程源配置（skill-hub.json sources 数组元素） */
export interface HubSourceConfig {
  name: string;
  url: string;
}

/** 安装入参：url 模式（导入 SKILL.md 原文）与目录模式（source+name）二选一 */
export interface HubInstallInput {
  scope: 'user' | 'project';
  projectId?: string;
  /** 目录模式：来源（'builtin' 或源名）+ 名称 */
  source?: string;
  name?: string;
  /** url 模式：SKILL.md raw 原文地址（可选显式 name，缺省从 URL 推导） */
  url?: string;
}

// ── F-38 项目文件浏览器 + 变更文件面板（字段 snake_case，与 core REST 契约逐字对齐）──

/** 面板作用域：有会话走会话工作根（含 worktree），无会话回落项目根 */
export interface BrowseScope {
  kind: 'session' | 'project';
  id: string;
}

export interface BrowseEntry {
  name: string;
  type: 'dir' | 'file';
  /** 仅 file */
  size?: number;
}

export interface BrowseTreeResponse {
  ok: true;
  /** 请求的相对路径（根为 ''） */
  path: string;
  root_name: string;
  entries: BrowseEntry[];
  /** 过滤后的条目总数（截断前） */
  total: number;
  truncated: boolean;
}

export type PreviewKind = 'markdown' | 'text' | 'image' | 'binary' | 'oversize';

export interface FilePreviewResponse {
  ok: true;
  path: string;
  name: string;
  size: number;
  kind: PreviewKind;
  modified_at: string;
  content?: string;
  language?: string;
  mime?: string;
  data_url?: string;
  /** binary | oversize 的中文降级文案（服务端下发，前端原样展示） */
  reason?: string;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface ChangeFile {
  /** 工作根相对路径（POSIX）；改名取新路径 */
  path: string;
  status: ChangeStatus;
  added: number;
  removed: number;
  binary: boolean;
  orig_path: string | null;
}

export interface ChangesResponse {
  ok: boolean;
  reason?: string;
  is_repo: boolean;
  root_name?: string;
  files: ChangeFile[];
  totals: { added: number; removed: number };
  total_files: number;
  truncated: boolean;
}

export type DiffRowType = 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffRow {
  type: DiffRowType;
  old_no: number | null;
  new_no: number | null;
  /** 不含行首标记 ' ' / '+' / '-'；hunk 行为完整 `@@ … @@` 头 */
  text: string;
}

export interface DiffResponse {
  ok: boolean;
  reason?: string;
  path: string;
  status: ChangeStatus;
  binary: boolean;
  truncated: boolean;
  added: number;
  removed: number;
  rows: DiffRow[];
  /** 无 HEAD 的仓库（首个提交前） */
  head_missing?: boolean;
}

/** browse 端点的作用域前缀（session 主 / project 回落） */
const browseBase = (scope: BrowseScope): string =>
  scope.kind === 'session' ? `/api/sessions/${scope.id}` : `/api/projects/${scope.id}`;

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
  createSession: (projectId: string, opts?: { title?: string; model?: string; mode?: string; expert?: string }) =>
    request<SessionRow>('POST', `/api/projects/${projectId}/sessions`, opts),
  // F-39 专家库（列表不含 body/头像内容；头像按 name 拉取后前端缓存）
  listExperts: (projectId?: string) =>
    request<{ experts: ExpertListItem[]; errors: string[]; disabled?: string[] }>(
      'GET',
      `/api/experts${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  getExpert: (name: string) => request<ExpertDetail>('GET', `/api/experts/${encodeURIComponent(name)}`),
  getExpertAvatar: (name: string) =>
    request<{ data_url: string | null }>('GET', `/api/experts/${encodeURIComponent(name)}/avatar`),
  // 会话绑定状态（唯一权威来源：包删除 → missing:true）
  getSessionExpert: (sessionId: string) =>
    request<SessionExpertState>('GET', `/api/sessions/${sessionId}/expert`),
  // F-39 P1：空会话就地改绑/解绑（有消息或运行中 → 409，调用方回退新建会话）
  rebindSessionExpert: (sessionId: string, expert: string | null) =>
    request<{ ok: boolean; expert: string | null; expertType: string | null }>(
      'PATCH',
      `/api/sessions/${sessionId}/expert`,
      { expert },
    ),
  // F-39 P1（T16）：信任 / 撤销信任
  trustExpert: (name: string, toolsHash: string) =>
    request<{ ok: boolean }>('POST', `/api/experts/${encodeURIComponent(name)}/trust`, { tools_hash: toolsHash }),
  revokeTrust: (name: string) =>
    request<{ ok: boolean }>('DELETE', `/api/experts/${encodeURIComponent(name)}/trust`),
  // F-39 P1（T15）：停用/恢复 / 删除 / 创建 / 导入 / 导出（导出走浏览器下载）
  setExpertDisabled: (name: string, disabled: boolean) =>
    request<{ ok: boolean }>('PATCH', `/api/experts/${encodeURIComponent(name)}/disabled`, { disabled }),
  deleteExpert: (name: string) =>
    request<{ ok: boolean }>('DELETE', `/api/experts/${encodeURIComponent(name)}`),
  createExpert: (form: { name: string; displayName: string; profession: string; description?: string; expertType: 'agent' | 'team'; layer?: 'user' | 'project' }) =>
    request<{ ok: boolean; name: string; dir: string }>('POST', '/api/experts/create', form),
  importExpert: (b64: string, layer: 'user' | 'project' = 'user', force = false) =>
    request<{ ok: boolean; name: string; warnings: string[] }>('POST', '/api/experts/import', { b64, layer, force }),
  exportExpertUrl: (name: string) => `/api/experts/${encodeURIComponent(name)}/export${authQuery()}`,
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
  // PASI-9：运行中的会话 id 列表（侧栏 ⏸/✕ 切换与删除门禁）；
  // projects = 有会话运行中的项目 id（旧服务端可能不返回，调用方需兼容 undefined）
  runningSessions: () => request<{ ids: string[]; projects?: string[] }>('GET', '/api/running-sessions'),

  // 系统集成工具清单（设置页「功能」面板：内置 + MCP 工具）
  toolList: () =>
    request<{ items: Array<{ name: string; description: string; danger: 'safe' | 'confirm' }> }>(
      'GET', '/api/tools',
    ),

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
  purgeTrashBatch: (items: Array<{ kind: 'project' | 'session'; id: string }>) =>
    request<PurgeBatchResult>('POST', '/api/trash/purge-batch', { items }),
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

  // 会话预算（settings.json 的 budget 键；修改后下一轮运行生效）
  getBudgetSetting: () =>
    request<BudgetSetting & { defaults: { maxTokens: number; maxCostUsd: number } }>('GET', '/api/settings/budget'),
  updateBudgetSetting: (patch: { maxTokens?: number | null; maxCostUsd?: number | null }) =>
    request<{ ok: boolean } & BudgetSetting>('PUT', '/api/settings/budget', patch),
  // 方案 D「追加预算继续」：现有上限乘以 multiply（默认 2），下一轮运行生效
  extendBudget: (multiply = 2) =>
    request<{ ok: boolean } & BudgetSetting>('POST', '/api/settings/budget/extend', { multiply }),

  // cron（F-22 定时任务面板；F-22b WorkBuddy 化改版）
  cronList: () => request<CronListResponse>('GET', '/api/cron'),
  cronGet: (id: string) => request<CronJobView>('GET', `/api/cron/${id}`),
  cronAdd: (input: CronJobInput) => request<CronJobView>('POST', '/api/cron', input),
  cronUpdate: (id: string, patch: CronJobPatch) => request<CronJobView>('PATCH', `/api/cron/${id}`, patch),
  cronRemove: (id: string) => request<{ ok: boolean }>('DELETE', `/api/cron/${id}`),
  cronRun: (id: string) => request<{ ok: boolean; running: boolean }>('POST', `/api/cron/${id}/run`),

  // skills / mcp 配置中心（设置页面板）
  skillDetails: (projectId?: string) =>
    request<SkillDetailResponse>(
      'GET',
      `/api/skills/detail${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  saveSkill: (name: string, input: SkillSaveInput) =>
    request<{ ok: boolean; path: string }>('POST', `/api/skills/${encodeURIComponent(name)}`, input),
  deleteSkill: (name: string, scope: 'user' | 'project', projectId?: string) => {
    const q = new URLSearchParams({ scope });
    if (projectId) q.set('projectId', projectId);
    return request<{ ok: boolean }>('DELETE', `/api/skills/${encodeURIComponent(name)}?${q.toString()}`);
  },
  mcpConfigs: (projectId?: string) =>
    request<McpConfigResponse>(
      'GET',
      `/api/mcp${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  saveMcpServers: (scope: 'global' | 'project', mcpServers: Record<string, McpServerEntry>, projectId?: string) =>
    request<{ ok: boolean; path: string }>('PUT', '/api/mcp', {
      scope,
      mcpServers,
      ...(projectId ? { projectId } : {}),
    }),

  // skill hub（技能市场；安装/卸载落盘走 writeSkill/deleteSkill，口径与 Skills 面板一致）
  hubList: (projectId?: string) =>
    request<HubListResponse>(
      'GET',
      `/api/skill-hub${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  hubItem: (source: string, name: string, projectId?: string) => {
    const q = new URLSearchParams({ source, name });
    if (projectId) q.set('projectId', projectId);
    return request<HubEntryView>('GET', `/api/skill-hub/item?${q.toString()}`);
  },
  hubInstall: (input: HubInstallInput) =>
    request<{ ok: boolean; name: string; path: string }>('POST', '/api/skill-hub/install', input),
  hubSources: () => request<{ sources: HubSourceConfig[]; error?: string }>('GET', '/api/skill-hub/sources'),
  hubSaveSources: (sources: HubSourceConfig[]) =>
    request<{ ok: boolean; path: string }>('PUT', '/api/skill-hub/sources', { sources }),

  // ── F-38 文件浏览器 + 变更面板（只读；path 一律工作根相对路径）──────────────
  browseTree: (scope: BrowseScope, path = '') =>
    request<BrowseTreeResponse>('GET', `${browseBase(scope)}/browse/tree?path=${encodeURIComponent(path)}`),
  browseFile: (scope: BrowseScope, path: string) =>
    request<FilePreviewResponse>('GET', `${browseBase(scope)}/browse/file?path=${encodeURIComponent(path)}`),
  browseChanges: (scope: BrowseScope) => request<ChangesResponse>('GET', `${browseBase(scope)}/browse/changes`),
  browseDiff: (scope: BrowseScope, path: string) =>
    request<DiffResponse>('GET', `${browseBase(scope)}/browse/diff?path=${encodeURIComponent(path)}`),
  /** 在系统文件管理器中显示（省略 path = 工作根）；唯一允许的 POST，不写任何项目文件 */
  browseReveal: (scope: BrowseScope, path = '') =>
    request<{ ok: boolean }>('POST', `${browseBase(scope)}/browse/reveal`, { path }),
};
