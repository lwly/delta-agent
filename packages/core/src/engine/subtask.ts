/**
 * 子任务执行（agent-modes-design §3.2 / §5）
 * 每个节点独立上下文：角色模板 + 总目标 + 本节点目标 + 上游结果摘要，
 * 复用 ReAct 主循环（预算/压缩/自愈同源），工具经角色白名单受限。
 */
import type { AgentEvent, TaskNode, ToolCall, ToolResult } from '@y-zero/shared';
import { runReAct, type RunContext } from './react.js';
import { roleSystemPrompt, RestrictedRegistry, type RegistryLike } from './roles.js';
import type { TaskRole } from '@y-zero/shared';
import { emptyCheckpoint, type TaskCheckpoint } from '../session/tasks.js';

/** 产生文件变更的内置工具（checkpoint 跟踪对象）。 */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * 把一次成功的文件变更工具调用记入 checkpoint（幂等清单）。
 * 纯函数，便于单测；非变更工具/失败调用不改变 checkpoint。
 */
export function recordToolResult(
  cp: TaskCheckpoint,
  call: ToolCall,
  result: ToolResult,
): TaskCheckpoint {
  if (!MUTATING_TOOLS.has(call.name) || !result.ok) return cp;
  const p = String(call.args?.['path'] ?? '').trim();
  const step = p ? `${call.name}(${p})` : call.name;
  if (!cp.files.includes(p)) cp.files = [...cp.files, p];
  cp.steps = [...cp.steps, step];
  cp.updatedAt = Date.now();
  return cp;
}

/** 续跑提示：上一轮已完成的步骤/文件清单，要求子任务跳过不再重复执行。 */
export function resumeNote(cp: TaskCheckpoint): string {
  if (cp.steps.length === 0 && cp.files.length === 0) return '';
  const steps = cp.steps.length ? cp.steps.map((s) => `- ${s}`).join('\n') : '- (无)';
  const files = cp.files.length ? cp.files.join(', ') : '(无)';
  return `\n\n【断点续跑】以下内容在上一轮执行中已完成（checkpoint 记录），请勿重复执行，直接从中断处继续未完成部分：\n已完成步骤：\n${steps}\n已变更文件：${files}`;
}

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
  /** 上一轮 checkpoint（重试/崩溃恢复时传入，注入续跑提示实现幂等） */
  checkpoint?: TaskCheckpoint;
  /** 执行期间 checkpoint 更新回调（编排层落库，供下次重试使用） */
  onCheckpoint?: (cp: TaskCheckpoint) => void;
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

  // 幂等续跑：有 checkpoint 时在系统提示注入已完成清单，避免重复副作用
  const cp: TaskCheckpoint = deps.checkpoint
    ? { steps: [...deps.checkpoint.steps], files: [...deps.checkpoint.files], updatedAt: deps.checkpoint.updatedAt }
    : emptyCheckpoint();
  const systemWithResume = cp.steps.length || cp.files.length ? system + resumeNote(cp) : system;

  const ctx: RunContext = {
    ...parent,
    mode: 'react',
    maxTurns: deps.maxTurns ?? 15,
    systemPrompt: systemWithResume,
    systemPromptParts: undefined,
    dynamicProvider: undefined,
    registry,
  };

  let summary = '';
  let error: string | undefined;
  try {
    for await (const ev of runReAct(ctx, [], node.goal)) {
      // 生命周期事件不外传：done / error / budget_exhausted 由编排层统一以
      // subtask_done / subtask_failed 与最终 done 表达，避免消费端（TUI/Web/headless）
      // 把单个子任务的结束误判为整轮运行结束（用量与进度事件照常转发）。
      if (ev.type !== 'done' && ev.type !== 'error' && ev.type !== 'budget_exhausted') {
        deps.onEvent?.(ev);
      }
      switch (ev.type) {
        case 'text_delta':
          summary += ev.text;
          break;
        case 'tool_result': {
          const before = cp.steps.length + cp.files.length;
          recordToolResult(cp, ev.call, ev.result);
          if (cp.steps.length + cp.files.length !== before) deps.onCheckpoint?.({ ...cp });
          break;
        }
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
