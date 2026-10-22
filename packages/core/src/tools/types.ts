import type { ConfirmResponder, ToolResult } from '@y-zero/shared';

export interface ToolContext {
  /** project root — hard sandbox boundary for all path parameters */
  projectRoot: string;
  signal: AbortSignal;
  /** confirmation callback for danger:'confirm' tools */
  confirm: ConfirmResponder;
  /** interactive ask_user callback */
  askUser: (question: string, options?: string[]) => Promise<string>;
  /** shared todo list state for todo_write */
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>;
  /** per-call timeout default (ms) */
  defaultTimeoutMs?: number;
  /** M3：Skill 两阶段加载 runtime（load_skill/unload_skill 工具依赖；未启用时工具报 skills_unavailable） */
  skills?: SkillRuntime;
}

/** Skill 加载运行时（engine/session 侧组装 SkillBuffer + 已发现 Skills 后注入） */
export interface SkillRuntime {
  load(name: string): Promise<{ ok: boolean; content: string }>;
  unload(name: string): { ok: boolean; content: string };
}

export type ToolDanger = 'safe' | 'confirm';

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema (object) for the arguments */
  schema: Record<string, unknown>;
  danger: ToolDanger;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(content: string, meta?: Record<string, unknown>): ToolResult {
  return { callId: '', name: '', ok: true, content, meta };
}

export function fail(content: string, error?: string): ToolResult {
  return { callId: '', name: '', ok: false, content, error: error ?? content };
}
