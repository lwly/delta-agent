import type { ConfirmResponder, ToolResult } from '@y-zero/shared';
import type { PermissionState } from './permissions.js';

export interface ToolContext {
  /** project root — hard sandbox boundary for all path parameters */
  projectRoot: string;
  signal: AbortSignal;
  /** confirmation callback for danger:'confirm' tools */
  confirm: ConfirmResponder;
  /**
   * F-23 权限模式状态（plan/default/yolo + allowlist + 会话记忆）。
   * 缺省 = default 模式、无 allowlist（行为与历史版本一致：仅 danger:'confirm' 工具确认）。
   */
  permissions?: PermissionState;
  /** interactive ask_user callback */
  askUser: (question: string, options?: string[]) => Promise<string>;
  /** shared todo list state for todo_write */
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>;
  /** per-call timeout default (ms) */
  defaultTimeoutMs?: number;
  /** M3：Skill 两阶段加载 runtime（load_skill/unload_skill 工具依赖；未启用时工具报 skills_unavailable） */
  skills?: SkillRuntime;
  /** 记忆里程碑：L2 动态记忆存储（save_memory/recall_memory 依赖；缺省时工具报 memory_unavailable） */
  memory?: import('../session/memory.js').MemoryStore;
  /** 记忆 scope / 审计归属 */
  sessionId?: string;
  projectId?: string;
}

/** Skill 加载运行时（engine/session 侧组装 SkillBuffer + 已发现 Skills 后注入） */
export interface SkillRuntime {
  load(name: string): Promise<{ ok: boolean; content: string }>;
  unload(name: string): { ok: boolean; content: string };
  /**
   * M3：自动触发建议——对用户输入做 Skill 匹配评分，
   * Top-1 ≥ MATCH_THRESHOLD 时返回候选（由 UI 询问用户是否加载）。
   * 可选：未提供时跳过自动触发，仅靠索引引导模型自行 load_skill。
   */
  suggest?(query: string): Promise<{ name: string; description: string } | undefined>;
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
