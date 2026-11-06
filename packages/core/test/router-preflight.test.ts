/**
 * F-58 T2b：preflight 门禁单测（设计稿 §6④/§6⑥、AC4）。
 * 三条失败路径各 1 用例 + 登录态 + 只读档 + 「进程数为 0」断言。
 *
 * CI 不装真 CLI（计划·风险 1）：detect/probe/checkLogin 全部注入 fake——本文件从不
 * spawn 子进程，也不读 PATH/HOME（F-55 的 DELTA_EXTERNAL_<ID>_PATH 隔离手法在此不适用，
 * 因为探测入口本身是 fake，环境里即使有同名二进制也不会被碰到）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { findKnownAgent, type DetectedAgent } from '../src/external/detect.js';
import { registerExternalAdapterFactory } from '../src/external/registry.js';
import { runPreflight } from '../src/router/preflight.js';
import type { WorkerTaskRow } from '../src/router/types.js';
import {
  cleanupAllDirs,
  createDispatcherEnv,
  type DispatcherEnv,
} from './helpers/fake-hub.js';

const envs: DispatcherEnv[] = [];

afterEach(async () => {
  for (const e of envs.splice(0)) await e.dispose();
  await cleanupAllDirs();
});

/** fake 探测清单：codebuddy（Tier A，支持只读）与 codex（Tier C，无只读档） */
function fakeDetect(ids: string[]): () => Promise<DetectedAgent[]> {
  return async () =>
    ids.map((id) => {
      const def = findKnownAgent(id)!;
      return { def, command: `/fake/bin/${def.executable}`, version: '9.9.9', source: 'env' as const };
    });
}

/** 全局 adapter 注册表是进程级的：测试 id 用后即注册（同 id 覆盖，无清理 API，不影响其他用例） */
function registerFakeAdapter(id: string): void {
  registerExternalAdapterFactory(id, () => ({}) as never);
}

function task(overrides?: Partial<Pick<WorkerTaskRow, 'executor' | 'permission_mode'>>): WorkerTaskRow {
  return {
    executor: 'cli:codebuddy',
    permission_mode: 'default',
    ...overrides,
  } as WorkerTaskRow;
}

describe('runPreflight（纯函数层）', () => {
  it('内置引擎（executor 为空）直接放行，不触发任何探测', async () => {
    let detectCalls = 0;
    const r = await runPreflight(task({ executor: null }), {
      detect: async () => {
        detectCalls += 1;
        return [];
      },
    });
    expect(r.ok).toBe(true);
    expect(detectCalls).toBe(0);
  });

  it('① executor 解析不到 adapter → executor_unresolved（注册表优先，零探测）', async () => {
    let probeCalls = 0;
    const r = await runPreflight(task({ executor: 'cli:ghost' }), {
      probe: async () => {
        probeCalls += 1;
        return '1.0.0';
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('executor_unresolved');
    expect(probeCalls).toBe(0); // 注册表未命中时不碰探测（不拉进程）
  });

  it('② probe 失败（null）→ probe_failed', async () => {
    registerFakeAdapter('cli:codebuddy');
    const r = await runPreflight(task(), {
      detect: fakeDetect(['cli:codebuddy']),
      probe: async () => null,
      checkLogin: () => true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('probe_failed');
  });

  it('② probe 超时 → probe_failed（兜底 Promise.race 生效，不卡死调用方）', async () => {
    registerFakeAdapter('cli:codebuddy');
    const started = Date.now();
    const r = await runPreflight(task(), {
      detect: fakeDetect(['cli:codebuddy']),
      probe: () => new Promise(() => {}), // 永不 resolve 的注入 runner
      probeTimeoutMs: 20,
      checkLogin: () => true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('probe_failed');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('③ 登录态缺失 → login_required（checkLogin 与 /api/external-agents 同源口径）', async () => {
    registerFakeAdapter('cli:codebuddy');
    const r = await runPreflight(task(), {
      detect: fakeDetect(['cli:codebuddy']),
      probe: async () => '9.9.9',
      checkLogin: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('login_required');
  });

  it('④ plan 档 + Tier C 无只读档（codex plan flags 为空）→ plan_unsupported', async () => {
    registerFakeAdapter('cli:codex');
    const r = await runPreflight(task({ executor: 'cli:codex', permission_mode: 'plan' }), {
      detect: fakeDetect(['cli:codex']),
      probe: async () => '9.9.9',
      checkLogin: () => true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('plan_unsupported');
  });

  it('④ Tier A（ACP 可逐次拦截权限）在 plan 档下放行（§6⑥ 注，对齐引擎侧口径）', async () => {
    registerFakeAdapter('cli:codebuddy');
    const r = await runPreflight(task({ permission_mode: 'plan' }), {
      detect: fakeDetect(['cli:codebuddy']),
      probe: async () => '9.9.9',
      checkLogin: () => true,
    });
    expect(r.ok).toBe(true);
  });

  it('全通过 → ok:true（探测恰好一次）', async () => {
    registerFakeAdapter('cli:codebuddy');
    let probeCalls = 0;
    const r = await runPreflight(task(), {
      detect: fakeDetect(['cli:codebuddy']),
      probe: async () => {
        probeCalls += 1;
        return '9.9.9';
      },
      checkLogin: () => true,
    });
    expect(r.ok).toBe(true);
    expect(probeCalls).toBe(1);
  });
});

describe('preflight 失败 → needs_decision（AC4：不建会话、不拉进程、attempt 不递增）', () => {
  async function envWithGate(gate: (t: WorkerTaskRow) => Promise<{ ok: boolean; reason?: string; message?: string }>) {
    const e = await createDispatcherEnv({ preflight: gate });
    envs.push(e);
    return e;
  }

  it('executor_unresolved 路径：needs_decision + decision_json + inbox interrupt；零会话零 send 零探测', async () => {
    let probeCalls = 0;
    const e = await envWithGate((t) =>
      runPreflight(t, {
        // cli:ghost 未注册 adapter → 必然 executor_unresolved
        probe: async () => {
          probeCalls += 1;
          return '9.9.9';
        },
      }),
    );
    const t = e.dispatch({ executor: 'cli:ghost' });
    await e.dispatcher.claimSlot();

    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('needs_decision');
    expect(row.attempt).toBe(1); // 只被 claim 加过 1，preflight 失败路径自身不再递增
    expect(row.decision_json).toContain('executor_unresolved');
    // 不建会话、不拉进程、不发送
    expect(e.workerSessions).toHaveLength(0);
    expect(e.hub.sendCount()).toBe(0);
    expect(probeCalls).toBe(0); // 进程数为 0（探测 runner 从未被调用）
    const items = e.dispatcher.inbox.listUndelivered(e.routerId);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('needs_decision');
    expect(items[0]!.severity).toBe('interrupt');
  });

  it('probe_failed 路径：needs_decision 且 attempt 仍为 claim 的 1', async () => {
    registerFakeAdapter('cli:codebuddy');
    const e = await envWithGate((t) =>
      runPreflight(t, {
        detect: fakeDetect(['cli:codebuddy']),
        probe: async () => null,
        checkLogin: () => true,
      }),
    );
    const t = e.dispatch({ executor: 'cli:codebuddy' });
    await e.dispatcher.claimSlot();

    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('needs_decision');
    expect(row.attempt).toBe(1);
    expect(e.workerSessions).toHaveLength(0);
    expect(e.hub.sendCount()).toBe(0);
  });

  it('plan_unsupported 路径：needs_decision（codex + plan 档）', async () => {
    registerFakeAdapter('cli:codex');
    const e = await envWithGate((t) =>
      runPreflight(t, {
        detect: fakeDetect(['cli:codex']),
        probe: async () => '9.9.9',
        checkLogin: () => true,
      }),
    );
    const t = e.dispatch({ executor: 'cli:codex', permissionMode: 'plan' });
    await e.dispatcher.claimSlot();

    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('needs_decision');
    expect(row.decision_json).toContain('plan_unsupported');
    expect(e.workerSessions).toHaveLength(0);
  });

  it('preflight 通过 → running（对照路径）', async () => {
    registerFakeAdapter('cli:codebuddy');
    const e = await envWithGate((t) =>
      runPreflight(t, {
        detect: fakeDetect(['cli:codebuddy']),
        probe: async () => '9.9.9',
        checkLogin: () => true,
      }),
    );
    const t = e.dispatch({ executor: 'cli:codebuddy' });
    await e.dispatcher.claimSlot();

    const row = e.dispatcher.workerTasks.get(t.id);
    expect(row.status).toBe('running');
    expect(e.workerSessions[0]!.model).toBe('cli:codebuddy'); // 外部 executor 原样作 model（§7.5）
  });
});
