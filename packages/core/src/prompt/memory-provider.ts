/**
 * MemoryProvider 接口 + 空实现（M3 解耦桩）。
 * 记忆系统在后续里程碑落地：届时提供真实 Provider 实现，
 * prompt 侧通过本接口接入（memory-design.md §5 召回评分）。
 */
import type { RecalledMemory } from './types.js';

export interface RecallQuery {
  /** 本轮用户输入（用于相关性召回） */
  query: string;
  /** 召回条数上限（默认 5） */
  topK?: number;
}

/**
 * 记忆召回提供方。
 * 实现方要求：返回条目按 score 降序；不得抛异常（失败时返回空数组并内部记录）。
 */
export interface MemoryProvider {
  recall(query: RecallQuery): Promise<RecalledMemory[]>;
}

/** 空实现：记忆系统未接入时使用，恒返回空（prompt 记忆段为空、自动隐藏） */
export class NullMemoryProvider implements MemoryProvider {
  async recall(_query: RecallQuery): Promise<RecalledMemory[]> {
    return [];
  }
}

/** 静态记忆 stub：恒定返回预置条目（测试 / 无记忆系统时的降级演示） */
export class StaticMemoryProvider implements MemoryProvider {
  constructor(private readonly entries: RecalledMemory[]) {}

  async recall(query: RecallQuery): Promise<RecalledMemory[]> {
    const topK = query.topK ?? 5;
    return [...this.entries]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
