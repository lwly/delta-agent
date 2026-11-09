/**
 * 架构收口 T5b —— useActivityStream 共享连接管理单测（stub 全局 EventSource，无网络）。
 * 覆盖：同 project 多消费者共享一条连接（引用计数）；activity_changed → onActivity；
 * onopen/onerror → onConnectionChange；disconnect 归零才关闭；无 EventSource 环境空句柄。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectActivityStream, __closeAllActivityStreams } from './useActivityStream';

/** EventSource 桩：记录实例，测试手动触发 onopen/onerror/onmessage */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0; // 0 connecting / 1 open / 2 closed
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  __closeAllActivityStreams();
  vi.unstubAllGlobals();
});

describe('connectActivityStream (T5b activity SSE 共享连接)', () => {
  it('同 project 两消费者共享一条连接；归零才关闭', () => {
    const h1 = connectActivityStream('p1', () => undefined, () => undefined);
    const h2 = connectActivityStream('p1', () => undefined, () => undefined);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/projects/p1/activity/stream');
    h1.disconnect();
    expect(FakeEventSource.instances[0]!.closed).toBe(false); // h2 仍持有
    h2.disconnect();
    expect(FakeEventSource.instances[0]!.closed).toBe(true); // 归零关闭
  });

  it('不同 project 各建连接', () => {
    const h1 = connectActivityStream('p1', () => undefined, () => undefined);
    const h2 = connectActivityStream('p2', () => undefined, () => undefined);
    expect(FakeEventSource.instances.map((e) => e.url).sort()).toEqual([
      '/api/projects/p1/activity/stream',
      '/api/projects/p2/activity/stream',
    ]);
    h1.disconnect();
    h2.disconnect();
  });

  it('activity_changed 帧触发 onActivity；其它帧不触发', () => {
    const fired: number[] = [];
    const h = connectActivityStream('p1', () => fired.push(Date.now()), () => undefined);
    const es = FakeEventSource.instances[0]!;
    es.onmessage?.({ data: JSON.stringify({ type: 'activity_snapshot' }) });
    es.onmessage?.({ data: JSON.stringify({ type: 'activity_changed' }) });
    expect(fired).toHaveLength(1);
    es.onmessage?.({ data: 'not-json' }); // 坏帧不炸
    expect(fired).toHaveLength(1);
    h.disconnect();
  });

  it('onopen/onerror → onConnectionChange(true/false)', () => {
    const states: boolean[] = [];
    const h = connectActivityStream('p1', () => undefined, (connected) => states.push(connected));
    const es = FakeEventSource.instances[0]!;
    es.onopen?.();
    es.onerror?.();
    expect(states).toEqual([true, false]);
    h.disconnect();
  });

  it('单消费者回调异常不影响其余消费者', () => {
    const fired: boolean[] = [];
    const h1 = connectActivityStream('p1', () => {
      throw new Error('boom');
    }, () => undefined);
    const h2 = connectActivityStream('p1', () => fired.push(true), () => undefined);
    FakeEventSource.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'activity_changed' }) });
    expect(fired).toEqual([true]);
    h1.disconnect();
    h2.disconnect();
  });

  it('无 EventSource 环境：返回空句柄不建连接', () => {
    vi.unstubAllGlobals(); // 模拟无 EventSource
    const h = connectActivityStream('p1', () => undefined, () => undefined);
    h.disconnect();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
