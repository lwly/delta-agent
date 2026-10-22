/**
 * @y-zero/shared — protocol types shared by core, cli and web.
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
  | { type: 'budget_warning'; usedPct: number }
  | { type: 'budget_exhausted'; summary: string }
  | { type: 'confirm_request'; request: ConfirmRequest }
  | { type: 'plan_approval_request'; request: PlanApprovalRequest }
  | { type: 'plan_created'; plan: Plan }
  | { type: 'plan_updated'; plan: Plan; reason: string }
  | { type: 'subtask_start'; nodeId: string; goal: string; workerId: string }
  | { type: 'subtask_done'; nodeId: string; summary: string; ms: number }
  | { type: 'subtask_failed'; nodeId: string; error: string; retries: number }
  | { type: 'review_verdict'; verdict: ReviewVerdict; revision: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; message: string; fatal: boolean };

// ── Confirmation flow ─────────────────────────────────────────────────────

export type ConfirmDecision =
  | { kind: 'allow' }
  | { kind: 'allow_session'; tool: string } // F-23：本会话不再询问
  | { kind: 'reject'; reason?: string }
  | { kind: 'edit'; args: Record<string, unknown> };

/** 权限模式（F-23）：plan=只读 / default=写需确认 / yolo=全放行（双重开启） */
export type PermissionMode = 'plan' | 'default' | 'yolo';

export interface ConfirmRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** human readable risk hint */
  reason: string;
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
