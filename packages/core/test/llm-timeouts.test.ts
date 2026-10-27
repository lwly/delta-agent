import { describe, expect, it, vi } from 'vitest';
import { parseSse, openSseStream, resolveLlmTimeouts, DEFAULT_LLM_TIMEOUTS } from '../src/llm/sse.js';
import { OpenAICompatibleProvider } from '../src/llm/providers/openai-compatible.js';

const encoder = new TextEncoder();

/** 流式产出文本块后保持打开不 close（模拟挂死的上游）。 */
function hangingStream(chunks: Array<{ delayMs: number; text: string }>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(c) {
      for (const ch of chunks) {
        await new Promise((r) => setTimeout(r, ch.delayMs));
        c.enqueue(encoder.encode(ch.text));
      }
      // 故意不 close
    },
  });
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  opts?: Parameters<typeof parseSse>[1],
  take?: number,
) {
  const frames: Array<{ event?: string; data: string }> = [];
  for await (const f of parseSse(stream, opts)) {
    frames.push(f);
    if (take !== undefined && frames.length >= take) break; // 流保持打开（模拟挂死），按帧数提前退出
  }
  return frames;
}

describe('llm stream timeouts (网关挂死防护)', () => {
  it('周期性 keep-alive 注释帧不能喂饱空闲计时器', async () => {
    // 每 20ms 一条注释行、持续 1s（旧实现会被不断重置 → ~1.06s 才超时；
    // 新实现只认有效帧 → ~60ms 即超时）
    const chunks = Array.from({ length: 50 }, (_, i) => ({
      delayMs: i === 0 ? 0 : 20,
      text: ': keep-alive\n\n',
    }));
    const t0 = Date.now();
    await expect(drain(hangingStream(chunks), { idleTimeoutMs: 60 })).rejects.toThrow('SSE idle timeout');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('有效数据帧持续推进空闲计时（不误杀慢流）', async () => {
    // 累计 120ms > 100ms 空闲窗口：若数据帧不重置 deadline，第四帧前就会误报
    const frames = await drain(
      hangingStream([
        { delayMs: 0, text: 'data: {"a":1}\n\n' },
        { delayMs: 40, text: 'data: {"a":2}\n\n' },
        { delayMs: 40, text: 'data: {"a":3}\n\n' },
        { delayMs: 40, text: 'data: [DONE]\n\n' },
      ]),
      { idleTimeoutMs: 100 },
      4,
    );
    expect(frames.map((f) => f.data)).toEqual(['{"a":1}', '{"a":2}', '{"a":3}', '[DONE]']);
  });

  it('整体时长上限兜底：低速滴漏的流也会被截断', async () => {
    // 每 15ms 一个有效帧，空闲计时一直在续，但整体超 80ms 上限
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      delayMs: i === 0 ? 0 : 15,
      text: 'data: {"a":1}\n\n',
    }));
    await expect(
      drain(hangingStream(chunks), { idleTimeoutMs: 100, maxDurationMs: 80 }),
    ).rejects.toThrow('SSE max duration exceeded');
  });

  it('openSseStream 连接阶段超时（fetch 永久 pending）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject((init.signal as AbortSignal).reason ?? new Error('aborted')),
              { once: true },
            );
          }),
      ),
    );
    try {
      await expect(openSseStream('http://gateway.test/v1', { method: 'POST' }, 0, 50)).rejects.toThrow(
        'SSE connect timeout',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('连接超时按可重试网络错误上报 error 事件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject((init.signal as AbortSignal).reason ?? new Error('aborted')),
              { once: true },
            );
          }),
      ),
    );
    try {
      const provider = new OpenAICompatibleProvider({
        id: 'stuck-gateway',
        apiKey: 'k',
        timeouts: { connectMs: 30 },
      });
      const events: Array<{ type: string; retriable?: boolean; message?: string }> = [];
      for await (const ev of provider.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [], model: '' })) {
        events.push(ev as { type: string; retriable?: boolean; message?: string });
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error', retriable: true });
      expect(events[0]!.message).toContain('SSE connect timeout');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('外部中止优先于连接超时，原样穿透', async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject((init.signal as AbortSignal).reason ?? new Error('aborted')),
              { once: true },
            );
          }),
      ),
    );
    try {
      const p = openSseStream('http://gateway.test/v1', { method: 'POST', signal: ac.signal }, 0, 60_000);
      setTimeout(() => ac.abort(new Error('user aborted')), 10);
      await expect(p).rejects.toThrow('user aborted');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolveLlmTimeouts：显式配置 > 环境变量 > 默认值', () => {
    expect(resolveLlmTimeouts()).toEqual(DEFAULT_LLM_TIMEOUTS);
    vi.stubEnv('DELTA_LLM_IDLE_TIMEOUT_MS', '5000');
    expect(resolveLlmTimeouts().idleMs).toBe(5000);
    expect(resolveLlmTimeouts().connectMs).toBe(DEFAULT_LLM_TIMEOUTS.connectMs);
    expect(resolveLlmTimeouts({ idleMs: 1 }).idleMs).toBe(1); // 显式配置最优先
    vi.stubEnv('DELTA_LLM_IDLE_TIMEOUT_MS', 'not-a-number');
    expect(resolveLlmTimeouts().idleMs).toBe(DEFAULT_LLM_TIMEOUTS.idleMs); // 非法值忽略
    vi.unstubAllEnvs();
  });
});
