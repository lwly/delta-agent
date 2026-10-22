import type { StreamEvent } from '@y-zero/shared';

/**
 * Generic SSE parser shared by:
 *  - model providers (consuming vendor SSE streams)
 *  - local web server (pushing AgentEvent to the browser)
 *
 * Handles: `data:` frames (multi-line), `[DONE]`, CRLF, comment lines.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

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
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.search(/\r?\n/)) >= 0) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer[nl] === '\r' ? 2 : 1));
      if (rawLine === '') {
        yield* flush();
        continue;
      }
      if (rawLine.startsWith(':')) continue; // comment / keep-alive
      if (rawLine.startsWith('event:')) {
        eventName = rawLine.slice(6).trim();
      } else if (rawLine.startsWith('data:')) {
        dataLines.push(rawLine.slice(5).trimStart());
      }
    }
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
 */
export async function openSseStream(
  url: string,
  init: RequestInit,
  retries = 1,
): Promise<Response> {
  let lastError: unknown;
  const signal = (init.signal as AbortSignal | undefined) ?? undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(500 * attempt, 2000), signal);
    try {
      const res = await fetch(url, init);
      if (res.ok && res.body) return res;
      const text = await res.text().catch(() => '');
      const err = new Error(`http ${res.status}: ${text.slice(0, 200)}`) as Error & { status?: number };
      err.status = res.status;
      lastError = err;
      if (!(res.status === 429 || res.status >= 500)) throw err; // non-retriable
    } catch (e) {
      if (signal?.aborted) throw e;
      if ((e as { status?: number }).status !== undefined) throw e; // non-retriable marker
      lastError = e;
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
