/**
 * 架构收口 T5b —— usePollingResource 工厂单测（无 DOM、无后端，fake timers）。
 * 覆盖：start 即刷一轮 + interval；切 id 丢弃过期响应；失败静默保持现状；
 * setIntervalMs 运行中动态调整（activity 降级 2s↔10s 的底层机制）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPollingResource } from './usePollingResource';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPollingResource (T5b 轮询工厂)', () => {
  it('start 立即刷一轮并起 interval；数据按 id 应用', async () => {
    const fetch = vi.fn(async (id: string) => ({ id, v: 1 }));
    const applied: Array<{ id: string; v: number }> = [];
    const r = createPollingResource<{ id: string; v: number }>({
      fetch,
      apply: (d) => applied.push(d),
      intervalMs: 100,
    });
    r.start('p1');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('p1');
    expect(applied).toEqual([{ id: 'p1', v: 1 }]);
    // interval tick
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).toHaveBeenCalledTimes(4); // 1 + 3 ticks
    r.stop();
  });

  it('切 id 后旧 in-flight 响应被丢弃（不串台）', async () => {
    let resolveA!: (v: unknown) => void;
    const fetch = vi.fn((id: string) => {
      if (id === 'a') return new Promise((r) => (resolveA = r));
      return Promise.resolve({ id, v: 2 });
    });
    const applied: Array<{ id: string; v: number }> = [];
    const r = createPollingResource<{ id: string; v: number }>({
      fetch: fetch as (id: string) => Promise<{ id: string; v: number }>,
      apply: (d) => applied.push(d),
      intervalMs: 100,
    });
    r.start('a');
    r.start('b'); // 未等 a 返回就切换
    resolveA({ id: 'a', v: 1 }); // 旧响应迟到
    await vi.advanceTimersByTimeAsync(0);
    expect(applied.every((d) => d.id === 'b')).toBe(true);
    expect(applied).toHaveLength(1); // a 的响应被丢弃，b 的已应用
    r.stop();
  });

  it('stop 后 in-flight 响应作废、timer 停止', async () => {
    let resolveA!: (v: { id: string }) => void;
    const fetch = vi.fn(
      () => new Promise<{ id: string }>((r) => (resolveA = r)),
    );
    const applied: Array<{ id: string }> = [];
    const r = createPollingResource<{ id: string }>({ fetch, apply: (d) => applied.push(d), intervalMs: 50 });
    r.start('a');
    r.stop();
    resolveA({ id: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(0);
    const calls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch.mock.calls.length).toBe(calls); // 无 tick
  });

  it('fetch 失败静默保持现状，下一轮重试', async () => {
    let failing = false;
    const fetch = vi.fn(async () => {
      if (failing) throw new Error('HTTP 501');
      return { v: applied.length };
    });
    const applied: Array<{ v: number }> = [];
    const r = createPollingResource<{ v: number }>({ fetch, apply: (d) => applied.push(d), intervalMs: 50 });
    r.start('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(1);
    failing = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(applied).toHaveLength(1); // 失败轮保持现状
    failing = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(applied).toHaveLength(2);
    r.stop();
  });

  it('setIntervalMs 运行中动态调整（2s↔10s 降级机制的底层）', async () => {
    const fetch = vi.fn(async () => ({ v: 1 }));
    const r = createPollingResource<{ v: number }>({ fetch, apply: () => undefined, intervalMs: 2_000 });
    r.start('p1');
    await vi.advanceTimersByTimeAsync(0);
    const base = fetch.mock.calls.length;
    // 降级到 10s：10s 内只 tick 一次
    r.setIntervalMs(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch.mock.calls.length).toBe(base + 1);
    // 回到 2s：10s 内 tick 5 次
    r.setIntervalMs(2_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch.mock.calls.length).toBe(base + 1 + 5);
    r.stop();
  });
});
