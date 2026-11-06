/**
 * F-58 T2c：pumpDigest 主动播报单测（设计稿 §10.1，AC9 主力）。
 * 四条件逐条单变量 + 幂等（连调 4 次只 send 1 次）+ 防自激（先标记后发送）+ 失败回滚。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupAllDirs,
  createDispatcherEnv,
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

/**
 * 造一个已收敛的失败任务（→ batch 条目）。
 * onRunFinished 内部会自动 pumpDigest（§13 第 15 步）：期间把 Router 置为「运行中」
 * 屏蔽自动播报（C3），让用例对显式 pumpDigest 调用做单变量控制。
 */
async function convergeFailed(e: DispatcherEnv, title: string, message = '模型超时') {
  const t = e.dispatch({ title });
  await e.dispatcher.claimSlot();
  const ws = e.dispatcher.workerTasks.get(t.id).worker_session_id!;
  e.hub.running.add(e.routerId);
  e.dispatcher.onRunFinished(ws, e.outcome({ runError: message }));
  e.hub.running.delete(e.routerId);
  await new Promise((r) => setTimeout(r, 0)); // 让自动 claimSlot 的微任务落地
  return t;
}

/** 发给 Router 的播报（过滤掉 Worker 会话的首发消息） */
function routerSends(e: DispatcherEnv) {
  return e.hub.sends.filter((s) => s.sessionId === e.routerId);
}

describe('C1：silent 永不触发（AC9：单任务成功不自动触发 Router）', () => {
  it('单个任务 done（silent 条目）→ pumpDigest 不发送', async () => {
    const e = await env();
    const t = e.dispatch();
    await e.dispatcher.claimSlot();
    const ws = e.dispatcher.workerTasks.get(t.id).worker_session_id!;
    e.dispatcher.onRunFinished(ws, e.outcome()); // done → silent

    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(false);
    expect(e.hub.sendCount(e.routerId)).toBe(0);
  });

  it('无任何条目 → 不发送', async () => {
    const e = await env();
    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(false);
    expect(e.hub.sendCount()).toBe(0);
  });
});

describe('C2：窗口判定（batch 需终态数≥2 或距上次播报>15min；interrupt 立即）', () => {
  it('窗口未关闭（上次播报 5min 前 + 仅 1 条终态）→ 不发送', async () => {
    const e = await env();
    // 上次播报 = 5 分钟前（一条已送达的历史条目）
    const hist = e.dispatcher.inbox.append({
      routerSessionId: e.routerId,
      kind: 'digest',
      severity: 'batch',
      payload: {},
    });
    e.dispatcher.inbox.markDelivered([hist.id], Date.now() - 5 * 60_000);
    // 之后 1 条终态 → batch 条目
    await convergeFailed(e, '任务A');

    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(false);
    expect(e.hub.sendCount(e.routerId)).toBe(0);
  });

  it('窗口打开（距上次播报>15min）→ 发送', async () => {
    const e = await env();
    const hist = e.dispatcher.inbox.append({
      routerSessionId: e.routerId,
      kind: 'digest',
      severity: 'batch',
      payload: {},
    });
    e.dispatcher.inbox.markDelivered([hist.id], Date.now() - 16 * 60_000);
    await convergeFailed(e, '任务A');

    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(true);
    expect(e.hub.sendCount(e.routerId)).toBe(1);
  });

  it('窗口打开（自上次播报起 ≥2 条终态）→ 发送，且 2 条都在 digest 里', async () => {
    const e = await env();
    const hist = e.dispatcher.inbox.append({
      routerSessionId: e.routerId,
      kind: 'digest',
      severity: 'batch',
      payload: {},
    });
    e.dispatcher.inbox.markDelivered([hist.id], Date.now() - 5 * 60_000);
    await convergeFailed(e, '任务A');
    await convergeFailed(e, '任务B');

    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(true);
    expect(routerSends(e)).toHaveLength(1);
    expect(routerSends(e)[0]!.input).toContain('任务A');
    expect(routerSends(e)[0]!.input).toContain('任务B');
    expect(routerSends(e)[0]!.input).toContain('[系统] 任务播报');
  });

  it('interrupt 立即播报：窗口未关闭也发送（needs_decision / 依赖取消）', async () => {
    const e = await env();
    const hist = e.dispatcher.inbox.append({
      routerSessionId: e.routerId,
      kind: 'digest',
      severity: 'batch',
      payload: {},
    });
    e.dispatcher.inbox.markDelivered([hist.id], Date.now() - 5 * 60_000);
    // 依赖失败 → 子任务取消 → interrupt 条目（窗口未关闭：仅 1 条终态）
    const dep = e.dispatch({ title: '依赖任务' });
    await e.dispatcher.claimSlot();
    const depWs = e.dispatcher.workerTasks.get(dep.id).worker_session_id!;
    e.dispatcher.onRunFinished(depWs, e.outcome({ runError: '炸了' }));
    const child = e.dispatch({ title: '子任务', dependsOn: [dep.id] });
    await e.dispatcher.claimSlot();

    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(true);
    expect(routerSends(e)).toHaveLength(1);
    expect(routerSends(e)[0]!.input).toContain('子任务');
  });
});

describe('C3：Router 运行中不发送，条目留 inbox（delivered_at IS NULL）', () => {
  it('peekRunning(routerId)===true → 不发送、条目原样保留', async () => {
    const e = await env();
    await convergeFailed(e, '任务A');
    await convergeFailed(e, '任务B');
    e.hub.running.add(e.routerId); // Router 正在运行（比如正在播上一轮）

    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(false);
    expect(e.hub.sendCount(e.routerId)).toBe(0);
    const undelivered = e.dispatcher.inbox.listUndelivered(e.routerId);
    expect(undelivered).toHaveLength(2);
    // Router 空闲后可正常播出
    e.hub.running.clear();
    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(true);
  });
});

describe('C4：60s 防抖', () => {
  it('距上次播报 30s（<60s）→ 不发送；超过 60s → 发送', async () => {
    const e = await env();
    const hist = e.dispatcher.inbox.append({
      routerSessionId: e.routerId,
      kind: 'digest',
      severity: 'batch',
      payload: {},
    });
    e.dispatcher.inbox.markDelivered([hist.id], Date.now() - 30_000);
    // interrupt 条目（绕过 C2，单变量隔离 C4）
    e.dispatcher.inbox.append({
      routerSessionId: e.routerId,
      kind: 'needs_decision',
      severity: 'interrupt',
      payload: { taskId: 't-x', title: '待裁决' },
    });

    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(false);
    expect(e.hub.sendCount(e.routerId)).toBe(0);

    // 把上次播报时间挪到 61s 前 → C4 通过
    e.dispatcher.inbox.unmarkDelivered([hist.id]);
    e.dispatcher.inbox.markDelivered([hist.id], Date.now() - 61_000);
    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(true);
    expect(e.hub.sendCount(e.routerId)).toBe(1);
  });
});

describe('幂等与防自激（先标记后发送）', () => {
  it('同批条目连调 4 次 pumpDigest 只 send 1 次（AC9 幂等）', async () => {
    const e = await env();
    await convergeFailed(e, '任务A');
    await convergeFailed(e, '任务B');

    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(false);
    }
    expect(e.hub.sendCount(e.routerId)).toBe(1);
  });

  it('防自激：send 期间注入的新条目不被本轮重复播报，下一轮单独播出', async () => {
    const e = await env();
    await convergeFailed(e, '任务A');
    await convergeFailed(e, '任务B');
    const firstBatchIds = e.dispatcher.inbox.listUndelivered(e.routerId).map((i) => i.id); // A、B

    e.hub.sendImpl = () => {
      // 模拟自激源：Router 运行期间新的 needs_decision（interrupt）落进 inbox
      e.dispatcher.inbox.append({
        routerSessionId: e.routerId,
        kind: 'needs_decision',
        severity: 'interrupt',
        payload: { taskId: 't-c', title: '任务C（send 期间注入）' },
      });
    };
    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(true);
    expect(routerSends(e)).toHaveLength(1);

    // 本轮 digest 不含注入条目（先标记后发送：本批 id 已在标记时定格）
    expect(routerSends(e)[0]!.input).not.toContain('任务C');
    expect(routerSends(e)[0]!.input).toContain('任务A');
    // 注入条目仍在 inbox（未送达）
    expect(e.dispatcher.inbox.listUndelivered(e.routerId)).toHaveLength(1);

    // 下一轮不会立刻播：C4 防抖（距上次播报 <60s）——这正是防自激的第二道防线
    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(false);
    expect(routerSends(e)).toHaveLength(1);

    // 把上次播报时间挪到 61s 前（等价于时间流逝）→ 下一轮只播新条目
    e.dispatcher.inbox.unmarkDelivered(firstBatchIds);
    e.dispatcher.inbox.markDelivered(firstBatchIds, Date.now() - 61_000);
    e.hub.sendImpl = undefined;
    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(true);
    expect(routerSends(e)).toHaveLength(2);
    expect(routerSends(e)[1]!.input).toContain('任务C');
    expect(routerSends(e)[1]!.input).not.toContain('任务A');
  });

  it('send 失败 → delivered_at 回滚为 NULL，等下一 tick 重播（不丢条目）', async () => {
    const e = await env();
    await convergeFailed(e, '任务A');
    await convergeFailed(e, '任务B');

    e.hub.sendError = new Error('router busy');
    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(false);
    // 回滚：两条都退回未送达
    const undelivered = e.dispatcher.inbox.listUndelivered(e.routerId);
    expect(undelivered).toHaveLength(2);
    expect(e.dispatcher.inbox.lastDeliveredAt(e.routerId)).toBeNull();

    // 下一次 tick 成功播出全部条目（此前只有 1 次失败的发送尝试）
    e.hub.sends = [];
    expect(await e.dispatcher.pumpDigest(e.routerId)).toBe(true);
    expect(routerSends(e)).toHaveLength(1);
    expect(e.dispatcher.inbox.listUndelivered(e.routerId)).toHaveLength(0);
  });
});

describe('tick（60s 循环入口）', () => {
  it('tick = 派发泵 + 逐 Router 播报：窗口打开时播 1 次', async () => {
    const e = await env();
    await convergeFailed(e, '任务A');
    await convergeFailed(e, '任务B');

    await e.dispatcher.tick();
    expect(e.hub.sendCount(e.routerId)).toBe(1);
    // 再 tick：防抖挡住，不重复
    await e.dispatcher.tick();
    expect(e.hub.sendCount(e.routerId)).toBe(1);
  });

  it('tick 顺带把 queued 任务派发出去', async () => {
    const e = await env();
    const t = e.dispatch();
    await e.dispatcher.tick();
    expect(e.dispatcher.workerTasks.get(t.id).status).toBe('running');
  });
});
