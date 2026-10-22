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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; argsJson: string }>;
  toolCallId?: string;
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

  // 运行
  send: (sessionId: string, input: string) => request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/messages`, { input }),
  abort: (sessionId: string) => request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/abort`),
  confirm: (sessionId: string, requestId: string, decision: Record<string, unknown>) =>
    request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/confirm`, { requestId, decision }),
  answer: (sessionId: string, requestId: string, answer: string) =>
    request<{ ok: boolean }>('POST', `/api/sessions/${sessionId}/answer`, { requestId, answer }),

  // trash / search
  listTrash: () => request<TrashItem[]>('GET', '/api/trash'),
  restore: (kind: 'project' | 'session', id: string) => request<{ ok: boolean }>('POST', `/api/trash/restore/${kind}/${id}`),
  purgeTrash: (kind: 'project' | 'session', id: string) => request<{ ok: boolean }>('DELETE', `/api/trash/${kind}/${id}`),
  search: (q: string) => request<SessionRow[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
};
