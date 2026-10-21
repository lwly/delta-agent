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
