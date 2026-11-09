/**
 * 架构收口 T7 —— WatchdogRegistry 看护 timer 注册表单测（fake timers）。
 * 判据 4：同 kind+id 重复注册只保留一个 timer；取消后不触发；TTL 变化才重置。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchdogRegistry } from '../src/router/watchdog-registry.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WatchdogRegistry（T7 判据 4）', () => {
  it('同 kind+id 同 TTL 重复注册：只保留一个 timer（fn 保留首个，不重启）', () => {
    const reg = new WatchdogRegistry();
    const first = vi.fn();
    const second = vi.fn();
    expect(reg.register('decision', 's1', first, 30_000)).toBe(true);
    expect(reg.register('decision', 's1', second, 30_000)).toBe(false); // 幂等
    expect(reg.size).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('不同 kind 或不同 id 各自独立', () => {
    const reg = new WatchdogRegistry();
    const a = vi.fn();
    const b = vi.fn();
    reg.register('decision', 's1', a, 1000);
    reg.register('decision', 's2', b, 1000);
    reg.register('preflight', 's1', vi.fn(), 1000);
    expect(reg.size).toBe(3);
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('TTL 变化才重置（新 TTL + 新 fn 生效）', () => {
    const reg = new WatchdogRegistry();
    const first = vi.fn();
    const second = vi.fn();
    reg.register('decision', 's1', first, 30_000);
    reg.register('decision', 's1', second, 5_000); // TTL 变化 → 重置
    vi.advanceTimersByTime(5_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancel 后 fn 不触发；cancel 幂等（不存在返回 false）', () => {
    const reg = new WatchdogRegistry();
    const fn = vi.fn();
    reg.register('decision', 's1', fn, 1000);
    expect(reg.cancel('decision', 's1')).toBe(true);
    expect(reg.cancel('decision', 's1')).toBe(false);
    expect(reg.has('decision', 's1')).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('回调异常不影响注册表状态与其它 timer', () => {
    const reg = new WatchdogRegistry();
    reg.register('k', 'a', () => {
      throw new Error('boom');
    }, 100);
    const ok = vi.fn();
    reg.register('k', 'b', ok, 100);
    vi.advanceTimersByTime(150);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(0); // 触发后即出表
  });

  it('disposeAll 清空全部（宿主关闭用）', () => {
    const reg = new WatchdogRegistry();
    reg.register('k', 'a', vi.fn(), 1000);
    reg.register('k', 'b', vi.fn(), 1000);
    reg.disposeAll();
    expect(reg.size).toBe(0);
    vi.advanceTimersByTime(5000);
    // 无异常抛出即通过（timer 已 clear）
  });
});
