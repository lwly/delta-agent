/**
 * F-58 调度工具（design-f58 §4.1 L-工具层 / §7.5 / §12）：
 *   - dispatch_task：派单不执行——仅把任务落库（queued）并交给 Dispatcher 派发泵，
 *     Worker 会话由 claimSlot 认领时才创建（T4 判据 2）。description 直接调用
 *     buildDispatchToolPrompt()（router/prompt.ts 是唯一提示词资产）。
 *   - task_status：纯只读（裁决 Q6——不承担 ack 等任何副作用），读任务列表/单条。
 *
 * 两工具归 read（裁决 Q3），Router 固定 plan 档不阻断派单。
 * ToolContext.dispatcher 未注入时报 dispatcher_unavailable（对齐 task.ts 的
 * task_unavailable 口径），工具定义仍对模型可见。
 */
import { fail, ok, type AgentTool, type ToolContext } from '../types.js';
import type { ToolResult } from '@delta/shared';
import { buildDispatchToolPrompt } from '../../router/prompt.js';
import { toWorkerTaskView } from '../../router/store.js';
import type { DispatchRequest } from '../../router/types.js';

/** task_status 列表默认条数（台账口径的轻量视图，避免一次拖全量） */
const TASK_LIST_LIMIT = 20;

const PERMISSION_MODES = ['plan', 'default', 'yolo'] as const;
/** 外部 executor 形态（§7.5：'cli:*' / 'acp:*'；NULL/缺省 = 内置引擎） */
const EXECUTOR_PREFIX = /^(cli|acp):/;

export type ParseDispatchResult =
  | { ok: true; value: DispatchRequest }
  | { ok: false; error: string };

/**
 * dispatch_task 入参 / 手工建任务 body 的共同校验与规范化（工具与 HTTP 端点共用）。
 * §7.5 三条硬约束中可在派单口校验的两条在此落地：
 *   - executor 只接受 'cli:*' / 'acp:*' 外部形态或缺省（内置），其余给清晰报错；
 *   - executor 为外部时 permission_mode 必须显式给值（不得依赖默认 'default'，
 *     否则 plan 档启动门禁会在不可见处生效）。
 * 硬约束 1（adapter 解析不到 → needs_decision 不建会话）由 preflight 在派发时落。
 */
export function parseDispatchArgs(body: Record<string, unknown>): ParseDispatchResult {
  const title = String(body.title ?? '').trim();
  const goal = String(body.goal ?? '').trim();
  if (!title) return { ok: false, error: '缺少 title：请给任务一个简短标题' };
  if (!goal) return { ok: false, error: '缺少 goal：做什么。原文就是 Worker 的首条用户消息，请写全背景、约束与期望产物' };

  const executorRaw = body.executor;
  let executor: string | null = null;
  if (executorRaw !== undefined && executorRaw !== null && String(executorRaw).trim() !== '') {
    executor = String(executorRaw).trim();
    if (!EXECUTOR_PREFIX.test(executor)) {
      return {
        ok: false,
        error: `executor 必须是 'cli:*' 或 'acp:*' 外部 agent 标识，或缺省（内置引擎）：${executor}`,
      };
    }
  }

  let permissionMode: DispatchRequest['permission_mode'];
  if (body.permission_mode !== undefined && body.permission_mode !== null) {
    const mode = String(body.permission_mode);
    if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
      return { ok: false, error: `permission_mode 必须是 plan / default / yolo：${mode}` };
    }
    permissionMode = mode as DispatchRequest['permission_mode'];
  }
  // §7.5 硬约束 3：外部 executor 必须显式给 permission_mode（不得静默落到默认档）
  if (executor && permissionMode === undefined) {
    return {
      ok: false,
      error: `executor 为外部 agent（${executor}）时必须显式指定 permission_mode（plan / default / yolo）`,
    };
  }

  let priority: number | undefined;
  if (body.priority !== undefined && body.priority !== null) {
    const n = Number(body.priority);
    if (!Number.isFinite(n)) return { ok: false, error: `priority 必须是数字：${String(body.priority)}` };
    priority = Math.trunc(n);
  }

  let dependsOn: string[] | undefined;
  if (body.depends_on !== undefined && body.depends_on !== null) {
    if (!Array.isArray(body.depends_on) || body.depends_on.some((d) => typeof d !== 'string')) {
      return { ok: false, error: 'depends_on 必须是任务 id 字符串数组' };
    }
    dependsOn = (body.depends_on as string[]).map(String);
  }

  return {
    ok: true,
    value: {
      title,
      goal,
      ...(body.acceptance !== undefined && body.acceptance !== null ? { acceptance: String(body.acceptance) } : {}),
      ...(body.role_label !== undefined && body.role_label !== null ? { role_label: String(body.role_label) } : {}),
      ...(executor ? { executor } : {}),
      ...(permissionMode ? { permission_mode: permissionMode } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(dependsOn ? { depends_on: dependsOn } : {}),
    },
  };
}

export const dispatchTaskTool: AgentTool = {
  name: 'dispatch_task',
  description: buildDispatchToolPrompt(),
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务简短标题（任务台/播报展示用）' },
      goal: { type: 'string', description: '做什么（原文即 Worker 的首条用户消息，请写全背景、约束、期望产物）' },
      acceptance: { type: 'string', description: '怎么算完（可空 = 由 title/goal 写清完成判据）' },
      executor: { type: 'string', description: "执行后端：'cli:*' / 'acp:*' = 外部 agent；缺省 = 内置引擎。派单后不可变" },
      permission_mode: { type: 'string', enum: ['plan', 'default', 'yolo'], description: '权限档位；executor 为外部时必填' },
      priority: { type: 'number', description: '数字越大越先派发，缺省 1' },
      depends_on: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id 数组；存在未完成依赖时不派发' },
      role_label: { type: 'string', description: '仅任务台展示标签（如「前端」「调研」），不影响行为' },
    },
    required: ['title', 'goal'],
  },
  danger: 'safe',
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.dispatcher) {
      return fail('dispatch_task 不可用：当前运行环境未装配调度器（Dispatcher），请直接在本会话完成任务', 'dispatcher_unavailable');
    }
    const parsed = parseDispatchArgs(args);
    if (!parsed.ok) return fail(parsed.error, 'invalid_args');
    const row = ctx.dispatcher.dispatch({
      ...parsed.value,
      projectId: ctx.projectId ?? '',
      routerSessionId: ctx.sessionId ?? '',
    });
    // 派发泵立即尝试认领（有槽位即建 Worker 会话并启动；fire-and-forget，不阻塞工具返回）
    void ctx.dispatcher.claimSlot().catch(() => {});
    return ok(
      `已派单（仅落库排队，Worker 会话由调度器认领时创建，完成后自动汇总回报）：\n${JSON.stringify({ task_id: row.id, status: row.status })}`,
      { task_id: row.id, status: row.status },
    );
  },
};

export const taskStatusTool: AgentTool = {
  name: 'task_status',
  description:
    '查询调度任务状态（纯只读，无任何副作用）。传 task_id 查单条（含状态、结论摘要、失败原因、待裁决内容）；' +
    '缺省列出本项目的任务（最近 20 条，按优先级与创建时间排序）。',
  schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '任务 id；缺省 = 列出本项目的任务' },
    },
  },
  danger: 'safe',
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.dispatcher) {
      return fail('task_status 不可用：当前运行环境未装配调度器（Dispatcher）', 'dispatcher_unavailable');
    }
    const store = ctx.dispatcher.workerTasks;
    const taskId = String(args['task_id'] ?? '').trim();
    if (taskId) {
      const row = store.find(taskId);
      if (!row) return fail(`任务不存在：${taskId}`, 'task_not_found');
      return ok(JSON.stringify(toWorkerTaskView(row), null, 2));
    }
    const rows = store.list({ ...(ctx.projectId ? { projectId: ctx.projectId } : {}), limit: TASK_LIST_LIMIT });
    return ok(JSON.stringify(rows.map(toWorkerTaskView), null, 2));
  },
};
