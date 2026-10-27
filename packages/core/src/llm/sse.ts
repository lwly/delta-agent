import type { StreamEvent } from '@delta/shared';

// ── LLM 流式请求超时（网关挂死防护）────────────────────────────────────────
//
// 网关 TCP 挂死有两种形态，缺任一保护都会让引擎永久卡在 provider.chat：
//  1. 连接建立但不返回响应头 → 裸 fetch 永久 pending，流空闲超时根本不会启动
//     （由 openSseStream 的 connectMs 覆盖）；
//  2. 响应头已到但流里只发 keep-alive 注释行不发数据 → 每次读到字节都重置
//     空闲计时，永不超时（由 parseSse 只认有效帧的 idleMs 覆盖）。

export interface LlmTimeouts {
  /** 连接/响应头阶段超时（毫秒，0 = 关闭） */
  connectMs: number;
  /** 流空闲（无有效数据帧）超时（毫秒，0 = 关闭） */
  idleMs: number;
  /** 单次流式请求整体时长上限（毫秒，0 = 关闭） */
  maxDurationMs: number;
}

export const DEFAULT_LLM_TIMEOUTS: LlmTimeouts = {
  connectMs: 30_000,
  idleMs: 180_000,
  maxDurationMs: 600_000,
};

function envTimeoutMs(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** LLM 流式请求超时：显式配置 > DELTA_LLM_*_TIMEOUT_MS 环境变量 > 默认值。 */
export function resolveLlmTimeouts(overrides?: Partial<LlmTimeouts>): LlmTimeouts {
  return {
    connectMs:
      overrides?.connectMs ?? envTimeoutMs('DELTA_LLM_CONNECT_TIMEOUT_MS') ?? DEFAULT_LLM_TIMEOUTS.connectMs,
    idleMs:
      overrides?.idleMs ?? envTimeoutMs('DELTA_LLM_IDLE_TIMEOUT_MS') ?? DEFAULT_LLM_TIMEOUTS.idleMs,
    maxDurationMs:
      overrides?.maxDurationMs ?? envTimeoutMs('DELTA_LLM_MAX_DURATION_MS') ?? DEFAULT_LLM_TIMEOUTS.maxDurationMs,
  };
}

/**
 * Generic SSE parser shared by:
 *  - model providers (consuming vendor SSE streams)
 *  - local web server (pushing AgentEvent to the browser)
 *
 * Handles: `data:` frames (multi-line), `[DONE]`, CRLF, comment lines.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  opts?: { idleTimeoutMs?: number; maxDurationMs?: number },
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  // 空闲超时：上游挂死（连接不关也不发数据）时 reader.read() 永远 pending，
  // 引擎会永久卡死（abort 也无法穿透）。用 timer 竞争 read，超时抛错由上层重试/报错。
  // 计时只认「有效帧」（非注释行，含跨 chunk 半行）：keep-alive 注释行（`: ping`）
  // 不推进 deadline，否则周期性注释能喂饱计时器、挂死的流依旧永不超时。
  const idleTimeoutMs = opts?.idleTimeoutMs ?? 0;
  // 整体时长上限：兜底防流以极低速率无限滴漏（每个数据帧都续上空闲计时）。
  const maxDurationMs = opts?.maxDurationMs ?? 0;
  const startedAt = Date.now();
  let idleDeadline = idleTimeoutMs > 0 ? startedAt + idleTimeoutMs : 0;

  const flush = function* (): Generator<{ event?: string; data: string }> {
    if (dataLines.length > 0) {
      const data = dataLines.join('\n');
      dataLines = [];
      const ev = eventName;
      eventName = undefined;
      yield { event: ev, data };
    }
  };

  while (true) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onTimeout: (() => void) | undefined;
    const now = Date.now();
    const waitMs = Math.min(
      idleDeadline > 0 ? idleDeadline - now : Number.POSITIVE_INFINITY,
      maxDurationMs > 0 ? startedAt + maxDurationMs - now : Number.POSITIVE_INFINITY,
    );
    const guard = Number.isFinite(waitMs)
      ? new Promise<never>((_, reject) => {
          onTimeout = () => {
            if (maxDurationMs > 0 && Date.now() - startedAt >= maxDurationMs) {
              reject(new Error(`SSE max duration exceeded (${maxDurationMs}ms)`));
            } else {
              reject(new Error(`SSE idle timeout (${idleTimeoutMs}ms without data)`));
            }
          };
          timeout = setTimeout(onTimeout, Math.max(waitMs, 0));
        })
      : null;
    let chunk: { done: boolean; value?: Uint8Array };
    try {
      chunk = guard ? await Promise.race([reader.read(), guard]) : await reader.read();
    } catch (e) {
      // 超时路径：取消底层流，释放连接，不留悬挂 read
      reader.cancel().catch(() => {});
      throw e;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let meaningful = false;
    let nl: number;
    while ((nl = buffer.search(/\r?\n/)) >= 0) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer[nl] === '\r' ? 2 : 1));
      if (rawLine === '') {
        yield* flush();
        continue;
      }
      if (rawLine.startsWith(':')) continue; // comment / keep-alive
      meaningful = true;
      if (rawLine.startsWith('event:')) {
        eventName = rawLine.slice(6).trim();
      } else if (rawLine.startsWith('data:')) {
        dataLines.push(rawLine.slice(5).trimStart());
      }
    }
    // 跨 chunk 的未完结半行：只要不是注释开头就算有效活动
    if (buffer.length > 0 && !buffer.startsWith(':')) meaningful = true;
    if (meaningful && idleDeadline > 0) idleDeadline = Date.now() + idleTimeoutMs;
  }
  yield* flush();
}

/** Parse one vendor SSE `data:` frame into normalized StreamEvents. */
export function parseDataFrames(data: string): StreamEvent[] {
  if (data === '[DONE]') return [{ type: 'done' }];
  try {
    return [JSON.parse(data) as StreamEvent];
  } catch {
    return [{ type: 'error', message: `bad sse frame: ${data.slice(0, 120)}`, retriable: false }];
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/**
 * Open an SSE stream with connection-level retry (PRD F-04 断流重连):
 * network errors and retriable HTTP statuses (429/5xx) are retried once
 * after a short backoff before surfacing an error event.
 *
 * Non-retriable HTTP failures (e.g. 401) throw immediately with a `status`
 * property so callers can skip their own reconnect loops.
 *
 * connectTimeoutMs > 0 时给连接/响应头阶段加超时：网关 TCP 挂死（连接建立
 * 但不返回响应头）时裸 fetch 永久 pending。用独立 controller 定时 abort
 * 竞争 fetch；响应头一到即撤销计时，流体交给 parseSse 的空闲/总时长保护。
 * 连接超时按网络错误对待（可重试）。外部 signal 的中止始终原样穿透。
 */
export async function openSseStream(
  url: string,
  init: RequestInit,
  retries = 1,
  connectTimeoutMs = 0,
): Promise<Response> {
  let lastError: unknown;
  const outer = (init.signal as AbortSignal | undefined) ?? undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(500 * attempt, 2000), outer);
    const connectAc = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (connectTimeoutMs > 0) {
      timer = setTimeout(
        () => connectAc.abort(new Error(`SSE connect timeout (${connectTimeoutMs}ms)`)),
        connectTimeoutMs,
      );
    }
    let signal: AbortSignal = connectAc.signal;
    let onOuterAbort: (() => void) | undefined;
    if (outer) {
      if (typeof AbortSignal.any === 'function') {
        signal = AbortSignal.any([outer, connectAc.signal]);
      } else {
        onOuterAbort = () => connectAc.abort(outer.reason);
        outer.addEventListener('abort', onOuterAbort, { once: true });
      }
    }
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok && res.body) return res; // 响应头已到：撤销连接计时，流体由 parseSse 保护
      const text = await res.text().catch(() => '');
      const err = new Error(`http ${res.status}: ${text.slice(0, 200)}`) as Error & { status?: number };
      err.status = res.status;
      lastError = err;
      if (!(res.status === 429 || res.status >= 500)) throw err; // non-retriable
    } catch (e) {
      if (outer?.aborted) throw e; // 外部中止原样穿透
      if ((e as { status?: number }).status !== undefined) throw e; // non-retriable marker
      lastError = e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onOuterAbort) outer!.removeEventListener('abort', onOuterAbort);
    }
  }
  throw lastError;
}

/** True when a stream-open error is worth re-dialing (network / 429 / 5xx). */
export function isRetriableOpenError(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  if (status === undefined) return true; // network error, no HTTP status
  return status === 429 || status >= 500;
}
