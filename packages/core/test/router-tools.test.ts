/**
 * F-58 T4a：调度工具单测（dispatch_task / task_status，design-f58 §4.1/§7.5/§19 裁决 Q3/Q6）
 * 复用 T2 的 fake-hub 脚手架（不 spawn 进程），另含 exitCode 通路（计划 r2 补入项，§6③）：
 *   - 外部引擎 done{exitCode≠0, 无产出} → error{fatal:true}（→ onRunFinished runError 收敛 failed(runtime)）
 *   - exit≠0 但有产出 → 非致命（任务可 done，错误仅随流提示）
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent, ConfirmDecision, ConfirmRequest } from '@delta/shared';
import { dispatchTaskTool, taskStatusTool, parseDispatchArgs } from '../src/tools/builtin/dispatch.js';
import type { ToolContext } from '../src/tools/types.js';
import { runExternalAgent } from '../src/engine/external.js';
import type { RunContext } from '../src/engine/react.js';
import { registerExternalAdapterFactory } from '../src/external/registry.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from '../src/external/types.js';
import {
  cleanupAllDirs,
  createDispatcherEnv,
  preflightPass,
  type DispatcherEnv,
} from './helpers/fake-hub.js';
import { QuotaStore } from '../src/quota/store.js';

function makeCtx(env: DispatcherEnv, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: '/tmp/fake-project',
    signal: new AbortController().signal,
    confirm: async () => ({ kind: 'allow' }) as ConfirmDecision,
    askUser: async () => '',
    todos: [],
    projectId: env.projectId,
    sessionId: env.routerId,
    dispatcher: env.dispatcher,
    ...overrides,
  } as ToolContext;
}

// ── 能力未装配口径（对齐 task.ts 的 task_unavailable）────────────────────────

describe('调度工具：dispatcher 未装配', () => {
  it('dispatch_task / task_status 报 dispatcher_unavailable，定义仍可见', async () => {
    const env = await createDispatcherEnv();
    try {
      const noDispatcher = makeCtx(env, { dispatcher: undefined, projectId: undefined, sessionId: undefined });
      const d = await dispatchTaskTool.execute({ title: 't', goal: 'g' }, noDispatcher);
      expect(d.ok).toBe(false);
      expect(d.error).toBe('dispatcher_unavailable');
      const s = await taskStatusTool.execute({}, noDispatcher);
      expect(s.ok).toBe(false);
      expect(s.error).toBe('dispatcher_unavailable');
      // 定义仍对模型可见（Router 收窄集合内的两个工具）
      expect(dispatchTaskTool.name).toBe('dispatch_task');
      expect(taskStatusTool.name).toBe('task_status');
      expect(dispatchTaskTool.description).toContain('派单不执行');
    } finally {
      await env.dispose();
    }
  });
});

// ── dispatch_task：落库不建会话 + §7.5 硬约束 ────────────────────────────────

describe('dispatch_task', () => {
  it('落库返回 {task_id, status:queued}，不创建会话（创建发生在 claimSlot）', async () => {
    const env = await createDispatcherEnv();
    try {
      env.dispatcher.claimSlot = async () => {}; // 隔离派发泵：本用例只验证「派单 ≠ 执行」
      const res = await dispatchTaskTool.execute({ title: '登录页', goal: '实现登录页与表单校验' }, makeCtx(env));
      expect(res.ok).toBe(true);
      expect(res.meta).toMatchObject({ status: 'queued' });
      const taskId = (res.meta as { task_id: string }).task_id;
      expect(taskId).toBeTruthy();
      expect(env.workerSessions).toHaveLength(0); // 未建任何会话
      const row = env.svc.workerTasks.get(taskId);
      expect(row.status).toBe('queued');
      expect(row.router_session_id).toBe(env.routerId);
    } finally {
      await env.dispose();
    }
  });

  it('claimSlot 认领后建 Worker 会话并 running；首条消息 = goal 原文（不含 role_label）', async () => {
    const env = await createDispatcherEnv({ preflight: preflightPass });
    try {
      const res = await dispatchTaskTool.execute(
        { title: '登录页', goal: '实现登录页与表单校验', role_label: '前端' },
        makeCtx(env),
      );
      expect(res.ok).toBe(true);
      await env.dispatcher.claimSlot();
      expect(env.workerSessions).toHaveLength(1);
      const row = env.svc.workerTasks.get((res.meta as { task_id: string }).task_id);
      expect(row.status).toBe('running');
      expect(row.worker_session_id).toBe(env.workerSessions[0]!.id);
      expect(env.hub.sends).toHaveLength(1);
      expect(env.hub.sends[0]!.input).toContain('实现登录页与表单校验');
      // §1.4 红线：role_label 只做 UI 标签，不进 Worker 消息
      expect(env.hub.sends[0]!.input).not.toContain('前端');
    } finally {
      await env.dispose();
    }
  });

  it('硬约束：executor 必须是 cli:*/acp:* 形态；外部时 permission_mode 必须显式', async () => {
    const env = await createDispatcherEnv();
    try {
      // 非法 executor 形态
      const bad = await dispatchTaskTool.execute({ title: 't', goal: 'g', executor: 'claude-code' }, makeCtx(env));
      expect(bad.ok).toBe(false);
      expect(bad.error).toBe('invalid_args');
      expect(bad.content).toContain('cli:');
      // 外部 executor 缺 permission_mode（§7.5 硬约束 3：不得静默落默认档）
      const missing = await dispatchTaskTool.execute({ title: 't', goal: 'g', executor: 'cli:codebuddy' }, makeCtx(env));
      expect(missing.ok).toBe(false);
      expect(missing.content).toContain('permission_mode');
      expect(env.svc.workerTasks.list({ projectId: env.projectId })).toHaveLength(0); // 校验失败不落库
      // 合法：外部 executor + 显式 permission_mode
      env.dispatcher.claimSlot = async () => {};
      const good = await dispatchTaskTool.execute(
        { title: 't', goal: 'g', executor: 'acp:claude', permission_mode: 'plan' },
        makeCtx(env),
      );
      expect(good.ok).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  it('硬约束 1：preflight 失败 → needs_decision，不建会话、attempt 不再递增', async () => {
    const env = await createDispatcherEnv({
      preflight: () => Promise.resolve({ ok: false, reason: 'probe_failed', message: '探测不到' }),
    });
    try {
      const res = await dispatchTaskTool.execute(
        { title: 't', goal: 'g', executor: 'cli:codebuddy', permission_mode: 'default' },
        makeCtx(env),
      );
      expect(res.ok).toBe(true);
      await env.dispatcher.claimSlot();
      const row = env.svc.workerTasks.get((res.meta as { task_id: string }).task_id);
      expect(row.status).toBe('needs_decision');
      expect(row.attempt).toBe(1); // claimSlot 的 +1；preflight 失败路径不再递增
      expect(env.workerSessions).toHaveLength(0); // 不建会话
      const undelivered = env.svc.inbox.listUndelivered(env.routerId);
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0]!.severity).toBe('interrupt');
    } finally {
      await env.dispose();
    }
  });
});

// ── task_status：纯只读（裁决 Q6）────────────────────────────────────────────

describe('task_status', () => {
  it('列出项目任务 / 按 task_id 查单条；无任何副作用（状态与 inbox 零变化）', async () => {
    const env = await createDispatcherEnv();
    try {
      env.dispatcher.claimSlot = async () => {};
      await dispatchTaskTool.execute({ title: '任务A', goal: 'ga' }, makeCtx(env));
      await dispatchTaskTool.execute({ title: '任务B', goal: 'gb', priority: 5 }, makeCtx(env));
      const before = env.svc.workerTasks.list({ projectId: env.projectId }).map((r) => [r.id, r.status]);

      const list = await taskStatusTool.execute({}, makeCtx(env));
      expect(list.ok).toBe(true);
      const items = JSON.parse(list.content) as Array<{ title: string; status: string }>;
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.title)).toEqual(['任务B', '任务A']); // priority DESC 排序
      expect(items.every((i) => i.status === 'queued')).toBe(true);

      const singleId = (JSON.parse(list.content) as Array<{ id: string }>)[0]!.id;
      const single = await taskStatusTool.execute({ task_id: singleId }, makeCtx(env));
      expect(single.ok).toBe(true);
      expect((JSON.parse(single.content) as { title: string }).title).toBe('任务B');

      const missing = await taskStatusTool.execute({ task_id: 'wt-nope' }, makeCtx(env));
      expect(missing.ok).toBe(false);
      expect(missing.error).toBe('task_not_found');

      // 纯只读：状态与 inbox 与调用前一致
      const after = env.svc.workerTasks.list({ projectId: env.projectId }).map((r) => [r.id, r.status]);
      expect(after).toEqual(before);
      expect(env.svc.inbox.listUndelivered(env.routerId)).toHaveLength(0);
      expect(env.hub.sends).toHaveLength(0);
    } finally {
      await env.dispose();
    }
  });
});

// ── parseDispatchArgs（工具与 HTTP 端点共用的校验）───────────────────────────

describe('parseDispatchArgs', () => {
  it('title/goal 必填；priority/depends_on 类型校验；可选字段规范化', () => {
    expect(parseDispatchArgs({}).ok).toBe(false);
    expect(parseDispatchArgs({ title: 't' }).ok).toBe(false);
    const badPriority = parseDispatchArgs({ title: 't', goal: 'g', priority: 'abc' });
    expect(badPriority.ok).toBe(false);
    const badDeps = parseDispatchArgs({ title: 't', goal: 'g', depends_on: 'x' });
    expect(badDeps.ok).toBe(false);
    const ok = parseDispatchArgs({ title: ' t ', goal: ' g ', priority: 2, depends_on: ['wt-1'], acceptance: '跑通' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.title).toBe('t');
      expect(ok.value.goal).toBe('g');
      expect(ok.value.priority).toBe(2);
      expect(ok.value.depends_on).toEqual(['wt-1']);
      expect(ok.value.acceptance).toBe('跑通');
    }
  });
});

// ── AC5：一次派 10 个任务，running 数恒 ≤ maxConcurrentWorkers ───────────────

describe('AC5：并发上限', () => {
  it('派 10 个任务 → 恰好 3 个 running、7 个 queued（fake hub 计数）', async () => {
    const env = await createDispatcherEnv({ maxConcurrentWorkers: 3, preflight: preflightPass });
    try {
      for (let i = 0; i < 10; i++) {
        env.dispatcher.dispatch({
          projectId: env.projectId,
          routerSessionId: env.routerId,
          title: `任务${i}`,
          goal: `g${i}`,
        });
      }
      expect(env.svc.workerTasks.list({ projectId: env.projectId, status: 'queued' })).toHaveLength(10);
      await env.dispatcher.claimSlot();
      const running = env.svc.workerTasks.list({ projectId: env.projectId, status: 'running' });
      const queued = env.svc.workerTasks.list({ projectId: env.projectId, status: 'queued' });
      expect(running.length).toBe(3);
      expect(running.length).toBeLessThanOrEqual(3);
      expect(queued.length).toBe(7);
      expect(env.workerSessions).toHaveLength(3);
      expect(env.hub.isRunningCalls).toBe(0); // 调度层不得触碰 isRunning（红线自检）
    } finally {
      await env.dispose();
    }
  });
});

// ── exitCode 通路（计划 r2 补入项，§6③ / AC3 判定核心）──────────────────────

const EXIT_MODEL = 'cli:exit-fake';

function baseSpec(overrides: Partial<ExternalAgentSpec> = {}): ExternalAgentSpec {
  return {
    id: EXIT_MODEL,
    kind: 'stream-json-jsonl',
    command: 'fake-cli',
    args: [],
    tier: 'B',
    version: '0.0.0-test',
    permissionArgs: { plan: [], default: [], yolo: [] },
    ...overrides,
  };
}

function scriptAdapter(script: ExternalEvent[]): ExternalAgentAdapter {
  return {
    spec: baseSpec(),
    run: async function* () {
      for (const ev of script) yield ev;
    },
  };
}

function makeEngineCtx(): RunContext {
  const controller = new AbortController();
  return {
    sessionId: 's_test',
    projectId: 'p_test',
    mode: 'react',
    model: EXIT_MODEL,
    systemPrompt: '',
    maxTurns: 1,
    signal: controller.signal,
    provider: {} as never,
    registry: {} as never,
    toolContext: {
      projectRoot: '/tmp/fake-project',
      signal: controller.signal,
      confirm: async () => ({ kind: 'allow' }) as ConfirmDecision,
    },
    budget: {} as never,
    windowTokens: 100_000,
  } as unknown as RunContext;
}

async function collectEngine(ctx: RunContext, input = '跑'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of runExternalAgent(ctx, [], input)) events.push(ev);
  return events;
}

describe('exitCode 通路（§6③）', () => {
  it('done{exitCode≠0, 无产出} → error{fatal:true} + done 带 exitCode；收敛 failed(runtime)', async () => {
    registerExternalAdapterFactory(EXIT_MODEL, () => scriptAdapter([{ type: 'done', exitCode: 3 }]));
    const events = await collectEngine(makeEngineCtx());
    const errs = events.filter((e) => e.type === 'error') as Array<{ type: 'error'; message: string; fatal: boolean }>;
    expect(errs).toEqual([{ type: 'error', message: '外部 agent 进程退出（exit 3）', fatal: true }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', exitCode: 3 });

    // AC3 收敛链：fatal 消息作为 runError 进入 onRunFinished → failed(runtime)
    const env = await createDispatcherEnv({ preflight: preflightPass });
    try {
      const task = env.dispatcher.dispatch({ projectId: env.projectId, routerSessionId: env.routerId, title: 't', goal: 'g' });
      await env.dispatcher.claimSlot();
      const wsId = env.workerSessions[0]!.id;
      env.dispatcher.onRunFinished(wsId, { runError: errs[0]!.message, aborted: false, durationMs: 10 });
      const row = env.svc.workerTasks.get(task.id);
      expect(row.status).toBe('failed');
      expect(row.failure_kind).toBe('runtime');
    } finally {
      await env.dispose();
    }
  });

  it('exit≠0 但有产出 → 非致命（error fatal:false，任务可 done），done 仍带 exitCode', async () => {
    registerExternalAdapterFactory(EXIT_MODEL, () =>
      scriptAdapter([{ type: 'text', text: '部分结果已经给出' }, { type: 'done', exitCode: 3 }]),
    );
    const events = await collectEngine(makeEngineCtx());
    const errs = events.filter((e) => e.type === 'error') as Array<{ type: 'error'; message: string; fatal: boolean }>;
    expect(errs).toEqual([{ type: 'error', message: '外部 agent 进程退出（exit 3）', fatal: false }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', exitCode: 3 });

    // 有产出 → runError 为空 → 任务 done（错误仅随流提示，不判失败）
    const env = await createDispatcherEnv({ preflight: preflightPass, getResultSummary: () => '部分结果已经给出' });
    try {
      const task = env.dispatcher.dispatch({ projectId: env.projectId, routerSessionId: env.routerId, title: 't', goal: 'g' });
      await env.dispatcher.claimSlot();
      const wsId = env.workerSessions[0]!.id;
      env.dispatcher.onRunFinished(wsId, { aborted: false, durationMs: 10 });
      const row = env.svc.workerTasks.get(task.id);
      expect(row.status).toBe('done');
      expect(row.result_summary).toBe('部分结果已经给出');
    } finally {
      await env.dispose();
    }
  });

  it('exit 0 → done 带 exitCode:0；流异常结束（无 done）→ 不加 exitCode 字段', async () => {
    registerExternalAdapterFactory(EXIT_MODEL, () => scriptAdapter([{ type: 'text', text: 'ok' }, { type: 'done', exitCode: 0 }]));
    const events = await collectEngine(makeEngineCtx());
    const done = events.at(-1)!;
    expect(done.type).toBe('done');
    expect((done as { exitCode?: number }).exitCode).toBe(0); // 已知退出码如实带出（含 0）

    // 流异常结束（adapter 未发 done 即返回）→ exitCode undefined → 不写字段，深比较形状与历史一致
    registerExternalAdapterFactory(EXIT_MODEL, () => scriptAdapter([{ type: 'text', text: '断了' }]));
    const events2 = await collectEngine(makeEngineCtx());
    const done2 = events2.at(-1)!;
    expect(done2.type).toBe('done');
    expect('exitCode' in done2).toBe(false);
  });
});

afterAll(cleanupAllDirs);

// ── 架构收口 T7：dispatch_task 子代理配额最后闸门 ─────────────────────────────

describe('调度工具：T7 QuotaStore 派单闸门', () => {
  it('subagent 账本超限 → 派单直接拒绝（quota_exceeded），不落库', async () => {
    const env = await createDispatcherEnv();
    try {
      const quota = new QuotaStore();
      quota.record('subagent', env.routerId, 5, 4); // 已用 5 > 上限 4
      const before = env.dispatcher.workerTasks.list().length;
      const ctx = makeCtx(env, { quota });
      const res = await dispatchTaskTool.execute({ title: 't', goal: 'g' }, ctx);
      expect(res.ok).toBe(false);
      expect((res as { error?: string }).error).toContain('quota_exceeded');
      expect(env.dispatcher.workerTasks.list().length).toBe(before); // 不落库
    } finally {
      cleanupAllDirs();
    }
  });

  it('未超限 → 正常派单；运行成本经 record 累计后触发闸门', async () => {
    const env = await createDispatcherEnv();
    try {
      const quota = new QuotaStore();
      const ctx = makeCtx(env, { quota });
      const res = await dispatchTaskTool.execute({ title: '正常派单', goal: 'g' }, ctx);
      expect(res.ok).toBe(true);
      // 模拟 Worker 运行结束归账（runtime onRunFinished 的 record 路径）
      quota.record('subagent', env.routerId, 10, 4);
      const res2 = await dispatchTaskTool.execute({ title: '第二单', goal: 'g' }, ctx);
      expect(res2.ok).toBe(false);
      expect((res2 as { error?: string }).error).toContain('quota_exceeded');
    } finally {
      cleanupAllDirs();
    }
  });
});
