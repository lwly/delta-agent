/**
 * F-39 会话绑定解析（纯函数，CLI / Web 共用）
 *
 * 注意（D5）：这里的 mode 强制只是**便利值**，用于 UI 预填与日志；
 * 落库以 `SessionService.createSession` 内部计算结果为准（唯一收口点）。
 */
import type { ExpertRecord, ExpertType } from './types.js';

export interface BindingInput {
  expert?: string | null;
  mode?: string;
}

export interface SessionBinding {
  name: string | null;
  type: ExpertType | null;
  /** 最终预期 mode（团队已强制 react） */
  mode: string;
  /** 绑定名在库里但磁盘上找不到 → 降级标记（不阻塞） */
  missing?: string;
}

export function resolveBinding(input: BindingInput, record: ExpertRecord | undefined): SessionBinding {
  const requested = input.expert?.trim() || null;
  const fallbackMode = input.mode ?? 'react';

  if (!requested) return { name: null, type: null, mode: fallbackMode };
  if (!record) return { name: null, type: null, mode: fallbackMode, missing: requested };

  if (record.expertType === 'team') {
    return { name: record.name, type: 'team', mode: 'react' };
  }
  return { name: record.name, type: 'agent', mode: fallbackMode };
}
