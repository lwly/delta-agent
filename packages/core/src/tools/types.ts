import type { ConfirmResponder, ToolResult, ToolCall, ToolDefinition, LLMProvider, BudgetConfig } from '@y-zero/shared';
import type { PermissionState } from './permissions.js';
import type { FileChangeStore } from '../session/changes.js';
import type { HookManager } from '../hooks/manager.js';

/**
 * F-26 子代理运行时（task 工具依赖）：主循环构建 RunContext 时注入。
 * 缺省时 task 工具报 task_unavailable（工具定义仍对模型可见，引导降级自主完成）。
 */
export interface SubagentRuntime {
  provider: LLMProvider;
  model: string;
  /** 子代理用量回写的父预算（独立状态累加，保证会话费用口径完整） */
  budget?: import('../context/budget.js').BudgetManager;
  /** 子代理独立预算配置（缺省继承 DEFAULT_SESSION_BUDGET） */
  budgetConfig?: Partial<BudgetConfig>;
  /** 子代理上下文窗口（压缩触发用；缺省 200k） */
  windowTokens?: number;
  /** 嵌套深度：主循环 0，子代理派生即 +1；≥ MAX_SUBAGENT_DEPTH 拒绝 */
  depth?: number;
}

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
  /**
   * F-24 文件变更管理：提供时 write_file/edit_file 执行前后自动快照，
   * 支撑会话级 diff 汇总与一键回滚；缺省 = 不记录。
   */
  changes?: FileChangeStore;
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
  /**
   * F-26：父注册表结构视图（task 子代理工具在白名单内复用；缺省时 task 报 task_unavailable）。
   * 结构与 engine/roles.ts 的 RegistryLike 一致，此处就地定义避免循环依赖。
   */
  registry?: {
    definitions(): ToolDefinition[];
    executeAll(calls: ToolCall[], ctx: ToolContext): Promise<ToolResult[]>;
  };
  /** F-26 子代理运行时（provider/model/预算/深度）；缺省时 task 报 task_unavailable */
  subagent?: SubagentRuntime;
  /**
   * F-27 Hook 系统：PreToolUse（可阻断）/ PostToolUse（记录）挂接工具执行；
   * SessionStart/Stop/SessionEnd 由运行入口负责触发；缺省 = 不挂钩。
   */
  hooks?: HookManager;
  /**
   * F-30 执行沙箱（容器 / 本地执行后端）。
   * 缺省 = 历史行为：直接经 ShellAdapter 跑宿主 shell，不探测 Docker、不产出 meta（AC-30-1 零影响）。
   * 内置工具是模块级单例，故注入点只能在 ToolContext（与 permissions/changes/hooks 同构）。
   */
  sandbox?: import('../sandbox/executor.js').SandboxExecutor;
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
