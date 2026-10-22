/**
 * Worker Pool 并行调度（agent-modes-design §5）
 * - 共享队列分发任务，worker 竞争领取，天然负载均衡
 * - 审查/执行失败自动重试：回队首（unshift）优先于新任务
 * - 状态变化以 subtask_start/done/failed 事件推送
 * - 任务落库（租约 + 心跳），崩溃后可恢复
 * - checkpoint 幂等：文件变更清单执行期落库，重试/恢复时跳过已完成步骤
 */
import type { AgentEvent, Plan, TaskNode } from '@y-zero/shared';
import type { RunContext } from './react.js';
import { runSubTask } from './subtask.js';
import { HEARTBEAT_MS, LEASE_MS } from '../session/tasks.js';
import { isReady, maxParallelism, skipDownstream } from './plan.js';

/** 单节点执行重试上限（不含 Reviewer 打回的重规划） */
export const EXEC_RETRY_CAP = 2;

/** TS 版 asyncio.Queue：push/requeue 唤醒挂起 worker。 */
export class TaskQueue {
  private q: TaskNode[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(t: TaskNode): void {
    this.q.push(t);
    this.wake();
  }

  /** 审查失败/重试：回队首重新排队（优先级高于新任务）。 */
  requeue(t: TaskNode): void {
    this.q.unshift(t);
    this.wake();
  }

  /** 无任务时挂起；close 后队列排空返回 undefined（worker 退出信号）。 */
  async get(): Promise<TaskNode | undefined> {
    while (this.q.length === 0) {
      if (this.closed) return undefined;
      await new Promise<void>((r) => this.waiters.push(r));
    }
    return this.q.shift();
  }

  get size(): number {
    return this.q.length;
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters) w();
    this.waiters = [];
  }

  private wake(): void {
    this.waiters.splice(0).forEach((w) => w());
  }
}

export interface PoolHooks {
  onEvent?: (ev: AgentEvent) => void;
  /** 节点终态回调（编排层借此推进 Reviewer 阶段 / 播种后继） */
  onSettled?: (node: TaskNode) => void;
}

/**
 * 以 worker pool 执行整个 Plan（多-agent 主路径；Plan-and-Execute 复用）。
 * 解析就绪节点入队 → worker 竞争执行 → 终态后播种后继 → 全部终态返回。
 * 返回是否存在被跳过的节点。
 */
export async function runPlanWithPool(
  ctx: RunContext,
  plan: Plan,
  hooks: PoolHooks = {},
): Promise<{ skipped: boolean }> {
  const onEvent = hooks.onEvent ?? (() => {});
  const queue = new TaskQueue();
  const maxRetries = ctx.plan?.maxReviewRetries ?? 2;
  const workerCount = clampWorkers(ctx.plan?.workerCount ?? 4, plan);
  let skipped = false;

  const seedReady = (): void => {
    for (const n of plan.nodes) {
      if (n.status === 'pending' && isReady(n, plan.nodes)) {
        queue.push(n);
      }
    }
  };

  const markSkipped = (node: TaskNode): void => {
    const marked = skipDownstream(plan.nodes, node.id);
    if (marked.length > 0) {
      skipped = true;
      for (const m of marked) ctx.tasks?.skip(ctx.sessionId, m.id, `upstream ${node.id} failed`);
      onEvent({ type: 'plan_updated', plan: snapshot(plan), reason: `node ${node.id} failed; downstream skipped` });
    }
    // critical 失败 → 整个 Plan 终止（其余节点标 skipped，队列关闭）
    if (node.critical && node.status === 'failed') {
      skipped = true;
      for (const n of plan.nodes) {
        if (n.status === 'pending' || n.status === 'running') {
          n.status = 'skipped';
          n.error = `critical node ${node.id} failed`;
          ctx.tasks?.skip(ctx.sessionId, n.id, `critical node ${node.id} failed`);
        }
      }
      onEvent({ type: 'plan_updated', plan: snapshot(plan), reason: `critical node ${node.id} failed; plan aborted` });
      queue.close();
    }
  };

  const allTerminal = (): boolean =>
    plan.nodes.every((n) => n.status === 'done' || n.status === 'failed' || n.status === 'skipped');

  const closeIfDrained = (): void => {
    if (allTerminal() && queue.size === 0) queue.close();
  };

  seedReady();
  if (queue.size === 0) queue.close();

  const abortListener = () => queue.close();
  ctx.signal.addEventListener('abort', abortListener, { once: true });

  const workers = Array.from({ length: workerCount }, (_, i) =>
    workerLoop(`w${i + 1}`, queue, ctx, plan, {
      onEvent,
      maxRetries,
      onSettled: (node) => {
        hooks.onSettled?.(node);
        if (node.status === 'failed') markSkipped(node);
        seedReady();
        closeIfDrained();
      },
    }),
  );
  try {
    await Promise.all(workers);
  } finally {
    ctx.signal.removeEventListener('abort', abortListener);
    queue.close();
  }

  // 用户中止：未完成任务标 canceled
  if (ctx.signal.aborted) {
    for (const n of plan.nodes) {
      if (n.status === 'pending' || n.status === 'running') {
        n.status = 'failed';
        n.error = 'canceled by user';
        ctx.tasks?.skip(ctx.sessionId, n.id, 'canceled by user');
      }
    }
  }
  return { skipped };
}

export async function workerLoop(
  id: string,
  queue: TaskQueue,
  ctx: RunContext,
  plan: Plan,
  opts: {
    onEvent: (ev: AgentEvent) => void;
    maxRetries: number;
    onSettled: (node: TaskNode) => void;
  },
): Promise<void> {
  while (!ctx.signal.aborted) {
    const node = await queue.get();
    if (!node) return;

    // 依赖校验：上游未全部 done（如被 skip）→ 终止该节点
    if (!isReady(node, plan.nodes)) {
      node.status = 'skipped';
      node.error = 'upstream not completed';
      ctx.tasks?.skip(ctx.sessionId, node.id, 'upstream not completed');
      opts.onEvent({
        type: 'subtask_failed',
        nodeId: node.id,
        error: 'upstream not completed',
        retries: node.retries,
      });
      opts.onSettled(node);
      continue;
    }

    // 任务落库：queued → running（租约），多 worker 重复领取时仅一个成功
    const persisted = ctx.tasks
      ? ctx.tasks.claim(ctx.sessionId, node.id, id)
      : true;
    if (!persisted) {
      node.status = 'failed';
      node.error = 'task claimed by another worker';
      opts.onSettled(node);
      continue;
    }
    node.status = 'running';
    opts.onEvent({ type: 'subtask_start', nodeId: node.id, goal: node.goal, workerId: id });

    // 心跳（15s）
    const heartbeat = ctx.tasks
      ? setInterval(() => ctx.tasks!.heartbeat(ctx.sessionId, node.id, id), HEARTBEAT_MS)
      : undefined;

    let result;
    try {
      // 幂等重试：装载上一轮 checkpoint（首次执行为空），执行期增量落库
      const prevCheckpoint = ctx.tasks?.getCheckpoint(ctx.sessionId, node.id);
      result = await runSubTask(node, {
        parent: ctx,
        planGoal: plan.goal,
        upstream: upstreamOf(plan, node),
        maxTurns: ctx.plan?.maxSubTurns,
        onEvent: opts.onEvent,
        checkpoint: prevCheckpoint,
        onCheckpoint: (cp) => ctx.tasks?.checkpoint(ctx.sessionId, node.id, cp),
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    if (result.ok) {
      node.status = 'done';
      node.result = result.summary;
      node.error = undefined;
      ctx.tasks?.complete(ctx.sessionId, node.id, result.summary);
      opts.onEvent({ type: 'subtask_done', nodeId: node.id, summary: result.summary, ms: 0 });
      opts.onSettled(node);
      continue;
    }

    if (result.canceled) {
      node.status = 'failed';
      node.error = result.error;
      ctx.tasks?.fail(ctx.sessionId, node.id, node.retries, result.error ?? 'canceled');
      opts.onEvent({
        type: 'subtask_failed',
        nodeId: node.id,
        error: result.error ?? 'canceled',
        retries: node.retries,
      });
      opts.onSettled(node);
      return; // 中止：worker 退出
    }

    node.retries++;
    node.error = result.error;
    ctx.tasks?.fail(ctx.sessionId, node.id, node.retries, result.error ?? 'failed');
    opts.onEvent({
      type: 'subtask_failed',
      nodeId: node.id,
      error: result.error ?? 'failed',
      retries: node.retries,
    });

    if (node.retries < EXEC_RETRY_CAP) {
      ctx.tasks?.requeue(ctx.sessionId, node.id);
      queue.requeue(node); // 回队首优先重试
    } else {
      node.status = 'failed';
      opts.onSettled(node);
    }
  }
}

/** 上游结果摘要（只取直接依赖，控制 token）。 */
export function upstreamOf(plan: Plan, node: TaskNode): Map<string, string> {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const m = new Map<string, string>();
  for (const d of node.deps ?? []) {
    const dep = byId.get(d);
    if (dep?.result) m.set(d, dep.result);
  }
  return m;
}

function clampWorkers(want: number, plan: Plan): number {
  const cap = Math.max(1, Math.min(8, want)); // 设计：可配 1-8
  return Math.max(1, Math.min(cap, maxParallelism(plan.nodes)));
}

function snapshot(plan: Plan): Plan {
  return {
    ...plan,
    nodes: plan.nodes.map((n) => ({ ...n })),
  };
}
