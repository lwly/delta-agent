/**
 * @delta/shared — protocol types shared by core, cli and web.
 * Keep this package dependency-free.
 */

// ── Model / chat primitives ────────────────────────────────────────────────

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  /** provider-assigned call id (may be empty for some vendors) */
  id: string;
  name: string;
  /** raw JSON string of arguments */
  argsJson: string;
  /** parsed arguments (filled after successful parse) */
  args?: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  /** textual observation fed back to the model */
  content: string;
  error?: string;
  meta?: Record<string, unknown>;
}

/** F-25 多模态：随消息发送的图片附件（base64，发送前已完成大小校验） */
export interface MessageImage {
  /** IANA media type，仅支持 image/png | image/jpeg | image/gif | image/webp */
  mediaType: string;
  /** 不含 data: 前缀的纯 base64 载荷 */
  base64: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant: tool calls requested in this message */
  toolCalls?: ToolCall[];
  /** tool role: which call this result answers */
  toolCallId?: string;
  /** F-25 多模态：user 消息可携带图片附件（视觉模型透传） */
  images?: MessageImage[];
  /** rough token estimate kept alongside the message */
  tokens?: number;
  /**
   * F-39：专家团成员的显示名（UI 本地字段，与 ts/ok/durationMs 同族）。
   * 实时来自 tool_result.meta.agent_name；回放由 content 前缀解析后回填。
   */
  agentName?: string;
  /**
   * F-53：服务端摘要化标记（仅消息分页端点下发）。
   * true = content 已截断（tool 大输出不随页传输），全文走 /messages/:seq/content 懒加载。
   */
  contentTruncated?: boolean;
  /** F-53：摘要化前的完整内容长度（字符；摘要化标记的展示口径） */
  contentLength?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

// ── Plan DAG / Multi-Agent (M5, agent-modes-design §3-5) ──────────────────

export type TaskNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** 执行层角色（四层十角色的 MVP 核心 + 动态启用，agent-modes-design §4.1） */
export type TaskRole = 'worker' | 'researcher' | 'writer' | 'tool-caller';

export interface TaskNode {
  id: string;
  /** 可独立执行的自然语言子任务目标 */
  goal: string;
  /** 依赖的上游节点 id */
  deps: string[];
  /** 规划者建议的工具白名单（空 = 全量） */
  suggestedTools: string[];
  /** 执行角色模板（默认 worker） */
  role?: TaskRole;
  /** 失败是否终止整个 Plan */
  critical?: boolean;
  status: TaskNodeStatus;
  retries: number;
  /** 执行结果摘要（回传给下游节点） */
  result?: string;
  error?: string;
}

export interface Plan {
  goal: string;
  /** 序列化友好：数组形态（运行时可转 Map） */
  nodes: TaskNode[];
  /** Reviewer 打回 / Planner 调整时递增 */
  revision: number;
  createdAt: number;
}

export interface ReviewFailure {
  nodeId: string;
  reason: string;
}

/** 主观审查（Reviewer）+ 客观验证（Verifier）合并裁决 */
export interface ReviewVerdict {
  pass: boolean;
  failures: ReviewFailure[];
  feedback?: string;
}

// ── 计划确认流（F-14：计划卡可编辑/删除节点/调整依赖后确认执行）────────────

export interface PlanApprovalRequest {
  id: string;
  plan: Plan;
}

export type PlanDecision =
  | { kind: 'approve' }
  | { kind: 'edit'; plan: Plan }
  | { kind: 'reject'; reason?: string };

// ── Streaming (normalized across vendors) ─────────────────────────────────

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsDelta: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'done' }
  | { type: 'error'; message: string; retriable: boolean };

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * E-4 prompt caching：系统提示的静态前缀（跨轮稳定可缓存段，M3 静态/动态分段）。
   * Provider 据此在静态/动态边界打缓存断点（Anthropic cache_control；
   * OpenAI 兼容网关的自动前缀缓存无需此字段）。缺省 = 整条系统消息视作可缓存。
   */
  systemStatic?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the parameters object */
  parameters: Record<string, unknown>;
}

export interface LLMProvider {
  readonly id: string;
  chat(req: ChatRequest): AsyncIterable<StreamEvent>;
  estimateTokens(messages: ChatMessage[]): number;
}

// ── Agent events (engine -> cli/web) ──────────────────────────────────────

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall; result: ToolResult; ms: number }
  | { type: 'compact_start' }
  | { type: 'compact_done'; beforeTokens: number; afterTokens: number }
  | { type: 'budget_alert'; level: 0.5 | 0.8 | 1.0; usedTokenPct: number; usedCostPct: number }
  | { type: 'budget_exhausted'; summary: string }
  /**
   * 预算耗尽降级续跑（仅 budgetDegrade 链路发出，headless 硬停协议不受影响）：
   * 子代理停用、单轮输出上限降到 1024，主循环继续到自然收敛；
   * summary 携带耗尽时的累计用量（与 budget_exhausted.summarize() 同口径）。
   */
  | { type: 'budget_degraded'; summary: string }
  | { type: 'confirm_request'; request: ConfirmRequest }
  | { type: 'plan_approval_request'; request: PlanApprovalRequest }
  | { type: 'plan_created'; plan: Plan }
  | { type: 'plan_updated'; plan: Plan; reason: string }
  | { type: 'subtask_start'; nodeId: string; goal: string; workerId: string }
  | { type: 'subtask_done'; nodeId: string; summary: string; ms: number }
  | { type: 'subtask_failed'; nodeId: string; error: string; retries: number }
  | { type: 'review_verdict'; verdict: ReviewVerdict; revision: number }
  /**
   * F-30：沙箱提示（降级 / 拉取 / 不可用 / 残留清理建议）。
   * 只走事件流（TUI addItem / Web SSE toast / headless stderr），**不落库、不进模型上下文**；
   * 发出者是入口注入的 sink（引擎零改动）。
   */
  | { type: 'sandbox_notice'; kind: 'degraded' | 'pulled' | 'unavailable' | 'gc_suggest'; detail: string }
  /** F-31：usage 事件附带当轮模型（引擎填 ctx.model；老消费端可忽略） */
  | { type: 'usage'; usage: Usage; model?: string }
  /**
   * F-39：专家团成员委派开始（不落库；回放靠 tool 消息 content 的 `[expert:<id>]` 前缀）。
   * goal = 目标摘要（≤120 字，来自 task 的 description / prompt 前 120 字）。
   */
  | {
      type: 'expert_delegate_start';
      memberId: string;
      memberName: string;
      profession: string;
      role: 'lead' | 'member';
      goal: string;
      startedAt: number;
    }
  /** F-39：专家团成员委派结束（summary = 成员最终汇报的截断，≤400 字） */
  | {
      type: 'expert_delegate_done';
      memberId: string;
      memberName: string;
      status: 'ok' | 'failed' | 'canceled';
      usage: Usage;
      ms: number;
      summary: string;
      /** 父会话为 plan 模式时的只读降级标记（成员卡角标） */
      readonlyDegraded?: boolean;
    }
  /**
   * done.usage 统一口径：主循环各轮 + 收尾轮 + 子代理（task 工具回传 meta.usage）。
   * subagents = 本次运行派生的子代理次数（> 0 时 UI 标注「含子代理 N 个」）。
   */
  | { type: 'done'; usage: Usage; subagents?: number }
  | { type: 'error'; message: string; fatal: boolean };

// ── Confirmation flow ─────────────────────────────────────────────────────

export type ConfirmDecision =
  | { kind: 'allow' }
  | { kind: 'allow_session'; tool: string } // F-23：本会话不再询问
  | { kind: 'reject'; reason?: string }
  | { kind: 'edit'; args: Record<string, unknown> };

/** 权限模式（F-23）：plan=只读 / default=写需确认 / yolo=全放行（双重开启） */
export type PermissionMode = 'plan' | 'default' | 'yolo';

/**
 * F-30 执行环境徽标（确认卡 / 工具卡片）：用户必须知道自己在给哪个环境授权。
 * 只读缓存的探测结论（`available` 为 undefined 表示未知），**绝不因此触发探测**。
 *
 * 与 `core/src/sandbox/types.ts` 的同名接口结构完全一致：渲染契约在 shared，
 * 而 shared 不能反向依赖 core，故两处各声明一份纯结构类型。
 */
export interface SandboxBadge {
  mode: 'local' | 'seatbelt' | 'docker';
  image?: string;
  network?: 'none' | 'bridge';
  /** 缓存中的探测结论（undefined = 未知；false 时卡片加一行「当前不可用，将按 fallback 处理」） */
  available?: boolean;
}

export interface ConfirmRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** human readable risk hint */
  reason: string;
  /** F-30：exec 类工具有值（沙箱徽标） */
  sandbox?: SandboxBadge;
  /** F-30：缺省 = permission（历史行为）；sandbox_degrade = 降级确认卡（只渲染允许/拒绝） */
  variant?: 'permission' | 'sandbox_degrade';
}

export type ConfirmResponder = (req: ConfirmRequest) => Promise<ConfirmDecision>;

// ── Budget ────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  /** session-level token budget (default 200k) */
  maxTokens: number;
  /** session-level cost budget in USD (default ¥5 ≈ 0.7 USD) */
  maxCostUsd: number;
  /** optional task-level budget; disabled by default (decision #7) */
  task?: { maxTokens: number; maxCostUsd: number };
}

export interface BudgetState {
  usedInputTokens: number;
  usedOutputTokens: number;
  usedCostUsd: number;
}

// ── Errors ────────────────────────────────────────────────────────────────

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly retriable: boolean = false,
    public readonly fatal: boolean = false,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
