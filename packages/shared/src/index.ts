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

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant: tool calls requested in this message */
  toolCalls?: ToolCall[];
  /** tool role: which call this result answers */
  toolCallId?: string;
  /** rough token estimate kept alongside the message */
  tokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

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
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; message: string; fatal: boolean };

// ── Confirmation flow ─────────────────────────────────────────────────────

export type ConfirmDecision =
  | { kind: 'allow' }
  | { kind: 'allow_session'; tool: string } // P2 (F-23), reserved
  | { kind: 'reject'; reason?: string }
  | { kind: 'edit'; args: Record<string, unknown> };

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
