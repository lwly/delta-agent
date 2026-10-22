/**
 * SSE 客户端：订阅 /api/sessions/:id/events，回传 HubEvent 流。
 * 原生 EventSource 断线自动重连；组件卸载时 close()。
 */
import type { HubEvent } from './client';

export function subscribeSession(sessionId: string, onEvent: (ev: HubEvent) => void): () => void {
  const es = new EventSource(`/api/sessions/${sessionId}/events`);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as HubEvent);
    } catch {
      // 忽略坏帧
    }
  };
  return () => es.close();
}
