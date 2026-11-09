/**
 * 架构收口 T4 —— RunGateway 纯策略单测。
 *
 * 判据对照：
 *  1. 任一步拒绝即短路：后续步骤（含 fake executor 计数器）零执行——拒绝时零副作用；
 *  2. 同一 plan 档输入在 Web / cron 两条路径产出一致的 RunPolicy；yolo 双 flag
 *     由 spawnPermissionArgsFor 单点产出；
 *  4. 无状态纯策略：纯输入断言（无 DB / 无 server /router import——编译期红线），
 *     同输入跨调用同输出。
 */
import { describe, expect, it, vi } from 'vitest';
import { authorizeRun, buildRunPolicy, spawnPermissionArgsFor } from '../src/gateway/index.js';
import type { RunRequest } from '../src/gateway/types.js';

describe('T4 spawnPermissionArgs（yolo 双 flag 单点产出，判据 2）', () => {
  it('plan / yolo / default 三档序列化', () => {
    expect(spawnPermissionArgsFor('plan')).toEqual(['--permission', 'plan']);
    expect(spawnPermissionArgsFor('yolo')).toEqual(['--permission', 'yolo', '--yolo']);
    expect(spawnPermissionArgsFor('default')).toEqual([]);
  });
});

describe('T4 buildRunPolicy（权限归一）', () => {
  it('任务级优先于会话级；显式 default 也优先', () => {
    expect(buildRunPolicy({ origin: 'chat', permissionMode: 'plan', sessionPermissionMode: 'yolo' }).policy?.permissionMode).toBe('plan');
    expect(buildRunPolicy({ origin: 'chat', permissionMode: 'default', sessionPermissionMode: 'yolo' }).policy?.permissionMode).toBe('default');
    expect(buildRunPolicy({ origin: 'chat', sessionPermissionMode: 'plan' }).policy?.permissionMode).toBe('plan');
    expect(buildRunPolicy({ origin: 'chat' }).policy?.permissionMode).toBe('default');
  });

  it('非法输入归一 default（不抛错）', () => {
    const req = { origin: 'cron', permissionMode: 'sudo' } as unknown as RunRequest;
    expect(buildRunPolicy(req).policy?.permissionMode).toBe('default');
  });

  it('yolo 双确认：cron 视为已确认；其它 origin 未确认 → permission_denied', () => {
    // cron：Web 建 cron 时的 yolo 二次确认已在任务级落库（F-22b 既有口径）
    const cron = buildRunPolicy({ origin: 'cron', permissionMode: 'yolo' });
    expect(cron.ok).toBe(true);
    // chat / worker / external：未确认拒绝
    for (const origin of ['chat', 'worker', 'external'] as const) {
      const denied = buildRunPolicy({ origin, permissionMode: 'yolo' });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.reason).toBe('permission_denied');
    }
    // 显式确认后放行
    const confirmed = buildRunPolicy({ origin: 'chat', permissionMode: 'yolo', yoloConfirmed: true });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.policy?.spawnPermissionArgs).toEqual(['--permission', 'yolo', '--yolo']);
  });

  it('同一 plan 档输入：Web（chat）与 cron 两条路径 RunPolicy 一致（判据 2）', () => {
    const web = buildRunPolicy({ origin: 'chat', permissionMode: 'plan', yoloConfirmed: true });
    const cron = buildRunPolicy({ origin: 'cron', permissionMode: 'plan' });
    expect(web.ok && cron.ok).toBe(true);
    expect(web.policy).toEqual(cron.policy);
    expect(web.policy?.readOnly).toBe(true);
    expect(web.policy?.spawnPermissionArgs).toEqual(['--permission', 'plan']);
  });
});

describe('T4 authorizeRun（步骤短路编排，判据 1）', () => {
  it('workRoot 拒绝 → 后续步骤（permission/quota/scope/lifecycle/fake executor）零执行', async () => {
    const executor = vi.fn();
    const gate = await authorizeRun(
      { origin: 'chat' },
      {
        checkWorkRoot: () => ({ ok: false, reason: 'workroot_missing', message: '目录不存在' }),
        checkQuota: () => ({ ok: false, reason: 'quota_exceeded', message: '超额' }),
        checkLifecycle: () => ({ ok: false, reason: 'lifecycle_stale', message: '终态' }),
        checkExternal: () => (executor() as unknown as { ok: true }) ?? { ok: true },
      },
    );
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe('workroot_missing');
    expect(gate.policy).toBeUndefined();
    expect(executor).not.toHaveBeenCalled();
  });

  it('4 类 origin 各自经注入步骤拒绝时短路，policy 不产出（拒绝时零副作用口径）', async () => {
    // chat：lifecycle 拒绝（external-model-as-router 口径）
    const chat = await authorizeRun(
      { origin: 'chat', permissionMode: 'default' },
      { checkLifecycle: () => ({ ok: false, reason: 'external_router_model', message: 'Router 会话不允许使用外部模型' }) },
    );
    expect(chat.ok).toBe(false);
    expect(chat.reason).toBe('external_router_model');
    // worker：quota 拒绝
    const worker = await authorizeRun(
      { origin: 'worker', permissionMode: 'default' },
      { checkQuota: () => ({ ok: false, reason: 'quota_exceeded', message: '并发槽位已满' }) },
    );
    expect(worker.ok).toBe(false);
    expect(worker.reason).toBe('quota_exceeded');
    // cron：scope 拒绝
    const cron = await authorizeRun(
      { origin: 'cron', permissionMode: 'default' },
      { checkScope: () => ({ ok: false, reason: 'scope_unsupported', message: '作用域不支持' }) },
    );
    expect(cron.ok).toBe(false);
    expect(cron.reason).toBe('scope_unsupported');
    // external：收敛 step 拒绝（preflight reason 透传）
    const external = await authorizeRun(
      { origin: 'external', executor: 'cli:foo', permissionMode: 'default' },
      { checkExternal: () => ({ ok: false, reason: 'login_required', message: '未登录' }) },
    );
    expect(external.ok).toBe(false);
    expect(external.reason).toBe('login_required');
    expect([chat, worker, cron, external].every((g) => g.policy === undefined)).toBe(true);
  });

  it('external + plan + externalPlanSupported=false → plan_unsupported（与 preflight ④ 同判据）', async () => {
    const gate = await authorizeRun(
      { origin: 'external', executor: 'cli:foo', permissionMode: 'plan' },
      { externalPlanSupported: () => false },
    );
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe('plan_unsupported');
  });

  it('全部通过 → ok + policy；步骤顺序固定（workRoot→permission→quota→scope→lifecycle→external）', async () => {
    const order: string[] = [];
    const gate = await authorizeRun(
      { origin: 'external', executor: 'cli:foo', permissionMode: 'default' },
      {
        checkWorkRoot: () => (order.push('workRoot'), { ok: true }),
        checkQuota: () => (order.push('quota'), { ok: true }),
        checkScope: () => (order.push('scope'), { ok: true }),
        checkLifecycle: () => (order.push('lifecycle'), { ok: true }),
        checkExternal: () => (order.push('external'), { ok: true }),
      },
    );
    expect(gate.ok).toBe(true);
    expect(gate.policy?.permissionMode).toBe('default');
    expect(order).toEqual(['workRoot', 'quota', 'scope', 'lifecycle', 'external']);
  });

  it('无状态：同输入跨调用同输出（判据 4）', async () => {
    const req: RunRequest = { origin: 'cron', permissionMode: 'plan' };
    const a = await authorizeRun(req, {});
    const b = await authorizeRun(req, {});
    expect(a).toEqual(b);
  });
});
