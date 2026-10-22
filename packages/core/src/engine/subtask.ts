/**
 * 子任务执行（agent-modes-design §3.2 / §5）
 * 每个节点独立上下文：角色模板 + 总目标 + 本节点目标 + 上游结果摘要，
 * 复用 ReAct 主循环（预算/压缩/自愈同源），工具经角色白名单受限。
 */
import type { AgentEvent, TaskNode } from '@y-zero/shared';
import { runReAct, type RunContext } from './react.js';
import { roleSystemPrompt, RestrictedRegistry, type RegistryLike } from './roles.js';
import type { TaskRole } from '@y-zero/shared';

export interface SubTaskDeps {
  /** 父运行 RunContext（复用 provider/budget/toolContext/signal 等） */
  parent: RunContext;
  planGoal: string;
  /** 上游节点的结果摘要（id → summary） */
  upstream: Map<string, string>;
  /** 子任务单次最大轮数（默认 15） */
  maxTurns?: number;
  /** 内部事件转发（text_delta / tool_result 等，由编排层决定推送粒度） */
  onEvent?: (ev: AgentEvent) => void;
}

export interface SubTaskResult {
  ok: boolean;
  /** 终态文本（成功=结果汇报；失败=已产生的进展） */
  summary: string;
  error?: string;
  /** 用户中断（区别于普通失败：恢复时 canceled 语义） */
  canceled: boolean;
}

const SUMMARY_MAX_CHARS = 4_000;

/** 执行单个 DAG 节点（不修改 node.status，由调用方编排状态机）。 */
export async function runSubTask(node: TaskNode, deps: SubTaskDeps): Promise<SubTaskResult> {
  const { parent } = deps;
  const upstreamText =
    [...deps.upstream.entries()]
      .map(([id, s]) => `- ${id}: ${s}`)
      .join('\n') || '';
  const role = (node.role ?? 'worker') as TaskRole;
  const allow = new Set(node.suggestedTools?.length ? node.suggestedTools : []);
  const registry = allow.size
    ? new RestrictedRegistry(parent.registry as RegistryLike, allow)
    : parent.registry;
  const system = roleSystemPrompt(role, { planGoal: deps.planGoal, nodeGoal: node.goal, upstream: upstreamText });

  const ctx: RunContext = {
    ...parent,
    mode: 'react',
    maxTurns: deps.maxTurns ?? 15,
    systemPrompt: system,
    systemPromptParts: undefined,
    dynamicProvider: undefined,
    registry,
  };

  let summary = '';
  let error: string | undefined;
  try {
    for await (const ev of runReAct(ctx, [], node.goal)) {
      deps.onEvent?.(ev);
      switch (ev.type) {
        case 'text_delta':
          summary += ev.text;
          break;
        case 'error':
          error = ev.message;
          break;
        case 'budget_exhausted':
          error = 'budget exhausted';
          break;
        default:
          break;
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }

  const canceled = parent.signal.aborted;
  if (canceled) {
    return { ok: false, summary: clip(summary), error: error ?? 'canceled by user', canceled: true };
  }
  // 无 fatal error 且拿到非空汇报才算成功（空汇报视为执行异常）
  const ok = !error && summary.trim().length > 0;
  return {
    ok,
    summary: clip(summary || error || '(no output)'),
    error: ok ? undefined : error ?? 'empty result',
    canceled: false,
  };
}

function clip(s: string): string {
  return s.length > SUMMARY_MAX_CHARS ? `${s.slice(0, SUMMARY_MAX_CHARS)}\n...[truncated]` : s;
}
