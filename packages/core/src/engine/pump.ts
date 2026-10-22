/**
 * 事件泵：worker pool 并发回调 → 实时 async 事件流（plan-execute / orchestrator 共用）。
 */
import type { AgentEvent } from '@y-zero/shared';

export interface EventPump {
  push: (ev: AgentEvent) => void;
  close: () => void;
  stream: () => AsyncGenerator<AgentEvent>;
}

export function createEventPump(): EventPump {
  const buf: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(ev) {
      buf.push(ev);
      const w = wake;
      wake = undefined;
      w?.();
    },
    close() {
      closed = true;
      const w = wake;
      wake = undefined;
      w?.();
    },
    async *stream() {
      while (true) {
        if (buf.length > 0) {
          yield buf.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}
