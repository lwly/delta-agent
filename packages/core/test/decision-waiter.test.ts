import { describe, expect, it, vi } from 'vitest';
import { createDecisionWaiter, DECISION_TIMEOUT_MS } from '../src/server/hub.js';

/** 捕获 register 回调塞进 waiters 表的 entry，供测试手动回填 */
function captureEntry() {
  const captured: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  const unregistered: unknown[] = [];
  return {
    captured,
    unregistered,
    register: (e: { resolve: (v: unknown) => void; reject: (e: Error) => void }) => captured.push(e),
    unregister: (e: unknown) => unregistered.push(e),
  };
}

describe('createDecisionWaiter（问题2/5修复：等人决策可收尾）', () => {
  it('正常回填 resolve，且触发 unregister', async () => {
    const { captured, unregistered, register, unregister } = captureEntry();
    const p = createDecisionWaiter<string>('confirm', new AbortController().signal, {
      timeoutMs: 60_000,
      register,
      unregister,
    });
    expect(captured).toHaveLength(1);
    captured[0]!.resolve('allow');
    await expect(p).resolves.toBe('allow');
    expect(unregistered).toHaveLength(1);
  });

  it('超时以 reject 收尾（不再永久悬挂）', async () => {
    vi.useFakeTimers();
    try {
      const p = createDecisionWaiter('confirm', new AbortController().signal, { timeoutMs: 1_000 });
      const assertion = expect(p).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort 以 reject 收尾（点「停止」立即穿透等人等待）', async () => {
    const ac = new AbortController();
    const p = createDecisionWaiter('ask', ac.signal, { timeoutMs: 60_000 });
    const assertion = expect(p).rejects.toThrow(/中止/);
    ac.abort();
    await assertion;
  });

  it('已 settle 后的重复 resolve / 超时 / abort 一律忽略', async () => {
    vi.useFakeTimers();
    try {
      const { captured, register, unregister } = captureEntry();
      const ac = new AbortController();
      const p = createDecisionWaiter('plan', ac.signal, { timeoutMs: 500, register, unregister });
      captured[0]!.resolve({ kind: 'approve' });
      await expect(p).resolves.toEqual({ kind: 'approve' });
      // settle 后触发超时与 abort：不得产生 unhandled rejection
      await vi.advanceTimersByTimeAsync(600);
      ac.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it('默认超时上限为 30 分钟', () => {
    expect(DECISION_TIMEOUT_MS).toBe(30 * 60_000);
  });
});
