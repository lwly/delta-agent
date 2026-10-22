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

export const api = {
  // projects
  listProjects: () => request<ProjectRow[]>('GET', '/api/projects'),
  createProject: (root: string) => request<ProjectRow>('POST', '/api/projects', { root }),
  removeProject: (id: string, confirmName: string, hard = false) =>
    request<{ ok: boolean }>('DELETE', `/api/projects/${id}`, { confirmName, hard }),

  // sessions
  listSessions: (projectId: string) => request<SessionRow[]>('GET', `/api/projects/${projectId}/sessions`),
  createSession: (projectId: string, opts?: { title?: string; model?: string; mode?: string }) =>
    request<SessionRow>('POST', `/api/projects/${projectId}/sessions`, opts),
  getSession: (id: string) => request<{ session: SessionRow; messages: ChatMessage[] }>('GET', `/api/sessions/${id}`),
  renameSession: (id: string, title: string) => request<{ ok: boolean }>('PATCH', `/api/sessions/${id}`, { title }),
  removeSession: (id: string, hard = false) =>
    request<{ ok: boolean }>('DELETE', `/api/sessions/${id}?hard=${hard}`),

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
};
