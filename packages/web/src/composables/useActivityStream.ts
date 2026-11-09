/**
 * 架构收口 T5 —— 项目级 activity SSE 共享连接管理。
 *
 * 设计：
 *  - 同一 projectId 的多个消费者（tasks store / bgTasks store / 未来页面）共享一条
 *    /api/projects/:id/activity/stream 连接（引用计数，最后一个 disconnect 关闭）；
 *  - 服务端 500ms 差分：activity_changed 帧到达 → onActivity 回调（调用方立即 refresh，
 *    之后由调用方把轮询放宽到 10s——「订阅后轮询降级，断线回 2s」的 T5 口径）；
 *  - onopen → onConnectionChange(true)；onerror → onConnectionChange(false)
 *    （EventSource 自动重连，无需手动重建）；
 *  - 无 EventSource 环境（旧浏览器 / 测试 node）静默不连接。
 */
import { authQuery } from '../api/auth';

export interface ActivityStreamHandle {
  /** 释放本消费者（引用计数归零才真正关闭连接） */
  disconnect(): void;
}

interface StreamEntry {
  es: EventSource;
  consumers: number;
  onActivity: Set<() => void>;
  onConnectionChange: Set<(connected: boolean) => void>;
}

/** projectId → 共享连接（模块级单例；store 与页面同 project 自动合流） */
const streams = new Map<string, StreamEntry>();

function openStream(projectId: string): StreamEntry {
  let entry = streams.get(projectId);
  if (entry) return entry;
  // desktop 宿主带 authToken：经 authQuery() 追加鉴权查询串（未配置 token 时空串）
  const es = new EventSource(`/api/projects/${projectId}/activity/stream${authQuery()}`);
  entry = { es, consumers: 0, onActivity: new Set(), onConnectionChange: new Set() };
  streams.set(projectId, entry);
  es.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data) as { type?: string };
      if (data.type === 'activity_changed') {
        for (const fn of entry!.onActivity) {
          try {
            fn();
          } catch {
            /* 单个消费者异常不影响其余 */
          }
        }
      }
    } catch {
      /* 坏帧忽略 */
    }
  };
  es.onopen = () => {
    for (const fn of entry!.onConnectionChange) {
      try {
        fn(true);
      } catch {
        /* 忽略 */
      }
    }
  };
  es.onerror = () => {
    for (const fn of entry!.onConnectionChange) {
      try {
        fn(false);
      } catch {
        /* 忽略 */
      }
    }
  };
  return entry;
}

/** 连接（或加入）某项目的 activity stream。返回句柄；disconnect 后引用计数归零才关闭。 */
export function connectActivityStream(
  projectId: string,
  onActivity: () => void,
  onConnectionChange: (connected: boolean) => void,
): ActivityStreamHandle {
  if (typeof EventSource === 'undefined') {
    // 无 EventSource 环境：返回空句柄（调用方按「未连接」处理，轮询保持基础间隔）
    return { disconnect: () => undefined };
  }
  const entry = openStream(projectId);
  entry.consumers += 1;
  entry.onActivity.add(onActivity);
  entry.onConnectionChange.add(onConnectionChange);
  if (entry.es.readyState === 1) onConnectionChange(true); // 已在线：新消费者立即进入降级口径
  return {
    disconnect(): void {
      entry!.onActivity.delete(onActivity);
      entry!.onConnectionChange.delete(onConnectionChange);
      entry!.consumers -= 1;
      if (entry!.consumers <= 0) {
        entry!.es.close();
        streams.delete(projectId);
      }
    },
  };
}

/** 测试辅助：清空全部共享连接（勿在产品代码使用） */
export function __closeAllActivityStreams(): void {
  for (const entry of streams.values()) entry.es.close();
  streams.clear();
}
