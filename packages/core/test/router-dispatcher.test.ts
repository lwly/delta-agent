/**
 * F-58 T2a：Dispatcher 任务状态机单测（设计稿 §7.4 每条边 + §13 时序）。
 * 全部走 fake hub（test/helpers/fake-hub.ts），不 spawn 进程、不依赖网络。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { defaultModelFor } from '../src/llm/defaults.js';
import type { PreflightResult } from '../src/router/types.js';
import {
  cleanupAllDirs,
  createDispatcherEnv,
  preflightPass,
  type DispatcherEnv,
} from './helpers/fake-hub.js';

const envs: DispatcherEnv[] = [];

async function env(opts?: Parameters<typeof createDispatcherEnv>[0]): Promise<DispatcherEnv> {
  const e = await createDispatcherEnv(opts);
  envs.push(e);
  return e;
}

afterEach(async () => {
  for (const e of envs.splice(0)) await e.dispose();
  await cleanupAllDirs();
});

describe('dispatch / claimSlot（queued → preflight → running）', () => {
  it('dispatch 仅落库 queued：不建会话、不 send、attempt=0', async () => {
    const e = await env();
    const t = e.dispatch();
    expect(t.status).toBe('queued');
    expect(t.attempt).toBe(0);
    expect(e.workerSessions).toHaveLength(0);
    expect(e.hub.sendCount()).toBe(0);
  });

  it('claimSlot：queued → preflight（attempt+1）→ preflight 通过 → running + 建 Worker 会话 + send(goal 原文)', async () => {
    const e = await env({ routerModel: 'glm-5.3', preflight: preflightPass });
    const t = e.dispatch({ goal: '做登录页' });
    await e.dispatcher.claimSlot();

    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('running');
    expect(row.attempt).toBe(1);
    expect(row.worker_session_id).toBe('ws-1');
    expect(e.workerSessions).toHaveLength(1);
    expect(e.workerSessions[0]).toMatchObject({ taskId: t.id, model: 'glm-5.3' });
    expect(e.hub.sendCount('ws-1')).toBe(1);
    expect(e.hub.sends[0]!.input).toContain('做登录页');
  });

  it('内置 Worker model 推导链（§7.5）：Router model → defaultModel → defaultModelFor 兜底', async () => {
    const withDefault = await env({ defaultModel: 'deepseek-chat', preflight: preflightPass });
    const t1 = withDefault.dispatch();
    await withDefault.dispatcher.claimSlot();
    expect(withDefault.workerSessions[0]!.model).toBe('deepseek-chat');

    const bare = await env({ preflight: preflightPass });
    const t2 = bare.dispatch();
    await bare.dispatcher.claimSlot();
    // 无任何注入时退到 defaultModelFor(undefined)（与 hub 默认推导链同源的 anthropic 缺省）
    expect(bare.workerSessions[0]!.model).toBe(defaultModelFor(undefined));
    expect(bare.dispatcher.workerTasks.get(t2.id).status).toBe('running');
  });

  it('§7.4 非法迁移：终态行无出边，onRunFinished 重复到达不二次迁移', async () => {
    const e = await env({ preflight: preflightPass });
    const t = e.dispatch();
    await e.dispatcher.claimSlot();
    e.dispatcher.onRunFinished('ws-1', e.outcome());
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('done');

    // 同一会话再收敛一次（理论上 hub 不会发，防御性）：必须 no-op 不抛错
    e.dispatcher.onRunFinished('ws-1', e.outcome({ runError: 'late error' }));
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('done');
    expect(e.dispatcher.workerTasks.get(t.id).failure_kind).toBeNull();
  });

  it('并发上限：maxConcurrentWorkers=1 时第二个任务保持 queued；needs_decision 不占槽位', async () => {
    const e = await env({ maxConcurrentWorkers: 1, preflight: preflightPass });
    const a = e.dispatch({ title: '任务A' });
    const b = e.dispatch({ title: '任务B' });
    await e.dispatcher.claimSlot();
    expect(e.dispatcher.workerTasks.get(a.id).status).toBe('running');
    expect(e.dispatcher.workerTasks.get(b.id).status).toBe('queued');

    // A 收敛后槽位释放，B 继续派发（onRunFinished 内部泵）
    e.dispatcher.onRunFinished('ws-1', e.outcome());
    await new Promise((r) => setTimeout(r, 0));
    expect(e.dispatcher.workerTasks.get(b.id).status).toBe('running');
    expect(e.dispatcher.workerTasks.get(b.id).worker_session_id).toBe('ws-2');
  });

  it('needs_decision 不占并发槽位：preflight 失败的任务不算 running，后续任务照常派发', async () => {
    const e = await env({
      maxConcurrentWorkers: 1,
      preflight: () => Promise.resolve({ ok: false, reason: 'probe_failed', message: 'CLI 不存在' }),
    });
    const a = e.dispatch({ title: '任务A', executor: 'cli:ghost' });
    await e.dispatcher.claimSlot();
    expect(e.dispatcher.workerTasks.get(a.id).status).toBe('needs_decision');
    // 不建会话、不 send、attempt 只被 claim 加过 1（preflight 失败路径自身不递增）
    expect(e.workerSessions).toHaveLength(0);
    expect(e.hub.sendCount()).toBe(0);
    expect(e.dispatcher.workerTasks.get(a.id).attempt).toBe(1);

    const b = e.dispatch({ title: '任务B' }); // 内置引擎，无 preflight
    await e.dispatcher.claimSlot();
    expect(e.dispatcher.workerTasks.get(b.id).status).toBe('running');
  });

  it('depends_on 有未终态项不派发：依赖 queued 时本任务保持 queued', async () => {
    const e = await env({ preflight: preflightPass });
    const dep = e.dispatch({ title: '依赖任务' });
    const child = e.dispatch({ title: '子任务', dependsOn: [dep.id] });
    await e.dispatcher.claimSlot();
    // 槽位够（max=3），但依赖未终态 → 子任务不派发
    expect(e.dispatcher.workerTasks.get(child.id).status).toBe('queued');
    expect(e.dispatcher.workerTasks.get(dep.id).status).toBe('running');
  });

  it('depends_on 依赖失败 → 子任务取消（§7.4 queued→canceled 依赖失败边）+ inbox interrupt', async () => {
    const e = await env({ preflight: preflightPass });
    const dep = e.dispatch({ title: '依赖任务' });
    const child = e.dispatch({ title: '子任务', dependsOn: [dep.id] });
    await e.dispatcher.claimSlot();
    e.dispatcher.onRunFinished('ws-1', e.outcome({ runError: '炸了' }));
    await new Promise((r) => setTimeout(r, 0));

    const childRow = e.dispatcher.workerTasks.get(child.id);
    expect(childRow.status).toBe('canceled');
    const items = e.dispatcher.inbox.listUndelivered(e.routerId);
    const item = items.find((i) => i.task_id === child.id);
    expect(item?.severity).toBe('interrupt');
    expect(item?.kind).toBe('task_failed');
  });
});

describe('onRunFinished 收敛（done / failed(runtime) / aborted）', () => {
  it('done：终态 + result_summary（注入时）+ inbox silent（AC8：单任务成功不产生 interrupt）', async () => {
    const e = await env({ preflight: preflightPass, getResultSummary: () => '登录页完成' });
    const t = e.dispatch();
    await e.dispatcher.claimSlot();
    e.dispatcher.onRunFinished('ws-1', e.outcome({ durationMs: 2000 }));

    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('done');
    expect(row.result_summary).toBe('登录页完成');
    expect(row.finished_at).not.toBeNull();
    const items = e.dispatcher.inbox.listUndelivered(e.routerId);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('silent');
    expect(items[0]!.kind).toBe('task_done');
  });

  it('runError → failed(runtime)；aborted → failed(aborted)；均写 inbox', async () => {
    const e = await env({ preflight: preflightPass });
    const a = e.dispatch({ title: '任务A' });
    await e.dispatcher.claimSlot();
    e.dispatcher.onRunFinished('ws-1', e.outcome({ runError: '模型超时' }));
    expect(e.dispatcher.workerTasks.get(a.id).status).toBe('failed');
    expect(e.dispatcher.workerTasks.get(a.id).failure_kind).toBe('runtime');

    const b = e.dispatch({ title: '任务B' });
    await e.dispatcher.claimSlot();
    e.dispatcher.onRunFinished('ws-2', e.outcome({ aborted: true }));
    expect(e.dispatcher.workerTasks.get(b.id).status).toBe('failed');
    expect(e.dispatcher.workerTasks.get(b.id).failure_kind).toBe('aborted');

    const items = e.dispatcher.inbox.listUndelivered(e.routerId);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'task_failed')).toBe(true);
  });

  it('未知 sessionId 的 onRunFinished 是 no-op', async () => {
    const e = await env({ preflight: preflightPass });
    expect(() => e.dispatcher.onRunFinished('ws-none', e.outcome())).not.toThrow();
  });
});

describe('decide / cancel（needs_decision 裁决）', () => {
  /** 造一个 needs_decision 任务：外部 executor + 必失败 preflight */
  async function needsDecisionTask() {
    const e = await env({
      preflight: () => Promise.resolve({ ok: false, reason: 'probe_failed', message: 'CLI 不存在' }),
    });
    const t = e.dispatch({ executor: 'cli:ghost' });
    await e.dispatcher.claimSlot();
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('needs_decision');
    return { e, t };
  }

  it('decide retry → queued 且 attempt+1，并可再次派发（新 Worker 会话）', async () => {
    // 门禁结果可切换：首派失败 → 裁决 retry 后放行
    let gate: PreflightResult = { ok: false, reason: 'probe_failed', message: 'CLI 不存在' };
    const e = await env({ preflight: () => Promise.resolve(gate) });
    const t = e.dispatch({ executor: 'cli:ghost' });
    await e.dispatcher.claimSlot();
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('needs_decision');

    gate = { ok: true };
    const after = e.dispatcher.decide(t.id, 'retry');
    expect(after.status).toBe('queued');
    expect(after.attempt).toBe(2);
    // retry 后立即泵：这次 preflight 放行 → running
    await new Promise((r) => setTimeout(r, 0));
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('running');
  });

  it('decide cancel → canceled；decide accept → done + silent inbox', async () => {
    const a = await needsDecisionTask();
    expect(a.e.dispatcher.decide(a.t.id, 'cancel').status).toBe('canceled');

    const b = await needsDecisionTask();
    const done = b.e.dispatcher.decide(b.t.id, 'accept');
    expect(done.status).toBe('done');
    const items = b.e.dispatcher.inbox.listUndelivered(b.e.routerId);
    expect(items.some((i) => i.task_id === b.t.id && i.severity === 'silent')).toBe(true);
  });

  it('decide 对非 needs_decision 任务抛错（非法迁移防线）', async () => {
    const e = await env();
    const t = e.dispatch();
    expect(() => e.dispatcher.decide(t.id, 'retry')).toThrow(/needs_decision/);
  });
});

describe('cancel（幂等）', () => {
  it('queued 任务取消 → canceled；重复取消幂等不抛错', async () => {
    const e = await env();
    const t = e.dispatch();
    expect(e.dispatcher.cancel(t.id).status).toBe('canceled');
    expect(e.dispatcher.cancel(t.id).status).toBe('canceled');
  });

  it('running 任务取消 → 先 abort Worker 会话再迁移 canceled', async () => {
    const e = await env({ preflight: preflightPass });
    const t = e.dispatch();
    await e.dispatcher.claimSlot();
    const ws = e.dispatcher.workerTasks.get(t.id).worker_session_id!;
    e.dispatcher.cancel(t.id);
    expect(e.hub.aborted).toContain(ws);
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('canceled');
    // abort 后 onRunFinished(aborted=true) 到达：任务已是终态，no-op
    e.dispatcher.onRunFinished(ws, e.outcome({ aborted: true }));
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('canceled');
  });

  it('preflight 行不可直接取消（§14：仅 queued/running/needs_decision）', async () => {
    // 挂在 preflight 中（外部 executor + 永不 resolve 的门禁）：claimSlot 停在 await 上，行停在 preflight
    const e = await env({ preflight: () => new Promise(() => {}) });
    const t = e.dispatch({ executor: 'cli:ghost' });
    void e.dispatcher.claimSlot();
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('preflight');
    expect(() => e.dispatcher.cancel(t.id)).toThrow(/preflight/);
  });
});

describe('bootstrap（§18-1 重启收敛）', () => {
  it('running 且进程已死 → failed(runtime) + inbox batch；进程仍活着 → 不动', async () => {
    const e = await env({ preflight: preflightPass });
    const alive = e.dispatch({ title: '活任务' });
    await e.dispatcher.claimSlot();
    // 模拟重启后 hub 不再持有 ws-1，但新的运行又起来了
    const aliveWs = e.dispatcher.workerTasks.get(alive.id).worker_session_id!;
    const dead = e.dispatch({ title: '死任务' });
    await e.dispatcher.claimSlot();
    const deadWs = e.dispatcher.workerTasks.get(dead.id).worker_session_id!;
    e.hub.running.clear();
    e.hub.running.add(aliveWs); // 只有 deadWs 真正死了

    e.dispatcher.bootstrap();
    expect(e.dispatcher.workerTasks.get(dead.id).status).toBe('failed');
    expect(e.dispatcher.workerTasks.get(dead.id).failure_kind).toBe('runtime');
    expect(e.dispatcher.workerTasks.get(alive.id).status).toBe('running');
    const items = e.dispatcher.inbox.listUndelivered(e.routerId);
    expect(items.some((i) => i.task_id === dead.id && i.severity === 'batch')).toBe(true);
  });

  it('preflight 行（还没建会话）→ failed(runtime)', async () => {
    const e = await env();
    const t = e.dispatch({ executor: 'cli:ghost' });
    // 直接把行推到 preflight（模拟重启时正卡在门禁），不注入 preflight
    e.dispatcher.workerTasks.claimSlot(t.id);
    e.dispatcher.bootstrap();
    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('failed');
    expect(row.failure_kind).toBe('runtime');
  });
});

describe('§1.4 role_label 红线', () => {
  it('role_label 只落库：Worker 首条消息与 dispatch 提示词均不含它', async () => {
    const { buildDispatchToolPrompt } = await import('../src/router/prompt.js');
    const e = await env({ preflight: preflightPass });
    const t = e.dispatch({ roleLabel: '前端专家' });
    await e.dispatcher.claimSlot();
    expect(e.dispatcher.workerTasks.get(t.id).role_label).toBe('前端专家');
    expect(e.hub.sends[0]!.input).not.toContain('前端专家');
    expect(e.hub.sends[0]!.input).not.toContain('role_label');
    expect(buildDispatchToolPrompt()).not.toContain('role_label');
  });
});

describe('红线自检：isRunning 恒不被调用（§9.3 / D15）', () => {
  it('全流程（claimSlot + 收敛 + bootstrap + cancel）后 isRunningCalls === 0', async () => {
    const e = await env({ preflight: preflightPass });
    const t = e.dispatch();
    await e.dispatcher.claimSlot();
    e.dispatcher.onRunFinished(e.dispatcher.workerTasks.get(t.id).worker_session_id!, e.outcome());
    const t2 = e.dispatch();
    await e.dispatcher.claimSlot();
    e.dispatcher.cancel(t2.id);
    e.dispatcher.bootstrap();
    expect(e.hub.isRunningCalls).toBe(0);
  });
});
