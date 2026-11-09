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

/** F-41 运行日志实时流（/api/logs/stream；连入即补发尾部，此后逐条推送；断线自动重连）。
 *  T6：opts.projectId 传入时按项目作用域过滤（切项目/切作用域由调用方重连换口径）。 */
export function subscribeLogs(onEntry: (e: LogEntryView) => void, opts?: { projectId?: string }): () => void {
  const params = new URLSearchParams();
  if (opts?.projectId) params.set('project_id', opts.projectId);
  // authQuery 返回 '?auth=…'（未配置 token 时空串）：并成单个查询串避免出现两个 '?'
  const auth = authQuery();
  if (auth) for (const [k, v] of new URLSearchParams(auth.slice(1))) params.set(k, v);
  const qs = params.toString();
  const es = new EventSource(`/api/logs/stream${qs ? `?${qs}` : ''}`);
  es.onmessage = (msg) => {
    try {
      onEntry(JSON.parse(msg.data) as LogEntryView);
    } catch {
      // 忽略坏帧
    }
  };
  return () => es.close();
}
