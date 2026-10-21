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
