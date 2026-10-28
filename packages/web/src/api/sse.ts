/**
 * SSE 客户端：订阅 /api/sessions/:id/events，回传 HubEvent 流。
 * 原生 EventSource 断线自动重连；组件卸载时 close()。
 */
import type { HubEvent, LogEntryView } from './client';
import { authQuery } from './auth';

export function subscribeSession(sessionId: string, onEvent: (ev: HubEvent) => void): () => void {
  const es = new EventSource(`/api/sessions/${sessionId}/events${authQuery()}`);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as HubEvent);
    } catch {
      // 忽略坏帧
    }
  };
  return () => es.close();
}

/** F-41 运行日志实时流（/api/logs/stream；连入即补发尾部，此后逐条推送；断线自动重连） */
export function subscribeLogs(onEntry: (e: LogEntryView) => void): () => void {
  const es = new EventSource(`/api/logs/stream${authQuery()}`);
  es.onmessage = (msg) => {
    try {
      onEntry(JSON.parse(msg.data) as LogEntryView);
    } catch {
      // 忽略坏帧
    }
  };
  return () => es.close();
}
