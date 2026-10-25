import type { BudgetConfig, BudgetState, ChatMessage, Usage } from '@delta/shared';

export const DEFAULT_SESSION_BUDGET: BudgetConfig = {
  maxTokens: 200_000,
  maxCostUsd: 0.7, // ≈ ¥5
};

export interface BudgetGuardResult {
  exceeded: boolean;
  reason?: string;
  usedTokenPct: number;
  usedCostPct: number;
}

/** F-31 分级告警阈值（PRD 裁决 #3：本期硬编码，不暴露配置） */
export const BUDGET_ALERT_LEVELS = [0.5, 0.8, 1.0] as const;

export type BudgetAlertLevel = (typeof BUDGET_ALERT_LEVELS)[number];

export interface BudgetAlert {
  level: BudgetAlertLevel;
  usedTokenPct: number;
  usedCostPct: number;
}

/**
 * Session-level budget manager (decision #7: session budget primary,
 * task-level budget optional and off by default).
 */
export class BudgetManager {
  readonly config: BudgetConfig;
  state: BudgetState = { usedInputTokens: 0, usedOutputTokens: 0, usedCostUsd: 0 };
  /** F-31：已发出告警的最高级别（0 = 从未告警）；一次性语义的状态位，实例内共享（父子代理同实例去重免费） */
  private alertedLevel: BudgetAlertLevel | 0 = 0;

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_SESSION_BUDGET, ...config };
  }

  /** Record usage from one LLM round-trip. */
  record(usage: Usage): void {
    this.state.usedInputTokens += usage.inputTokens;
    this.state.usedOutputTokens += usage.outputTokens;
    this.state.usedCostUsd += usage.costUsd ?? 0;
  }

  usedTokens(): number {
    return this.state.usedInputTokens + this.state.usedOutputTokens;
  }

  /** 0..1 fraction of token budget consumed. */
  usedTokenPct(): number {
    return this.config.maxTokens > 0 ? this.usedTokens() / this.config.maxTokens : 0;
  }

  usedCostPct(): number {
    return this.config.maxCostUsd > 0 ? this.state.usedCostUsd / this.config.maxCostUsd : 0;
  }

  /**
   * Pre-turn check. Warn at >=80% of either dimension, hard-stop at >=100%.
   */
  guard(): BudgetGuardResult {
    const usedTokenPct = this.usedTokenPct();
    const usedCostPct = this.usedCostPct();
    if (usedTokenPct >= 1) {
      return { exceeded: true, reason: 'token', usedTokenPct, usedCostPct };
    }
    if (usedCostPct >= 1) {
      return { exceeded: true, reason: 'cost', usedTokenPct, usedCostPct };
    }
    return { exceeded: false, usedTokenPct, usedCostPct };
  }

  /**
   * F-31 分级告警判定（替代 shouldWarn，一次性语义）：
   * 取 token/费用两维度的更高级别；仅当高于历史已告警级别时返回告警并推进状态位，
   * 否则返回 null。跨级跳变（40%→90%）只发 0.8 一条；未超 50% 零告警。
   * guard() 的 100% 硬停逻辑与本方法完全独立（退出码 4 协议不变）。
   */
  takeAlert(): BudgetAlert | null {
    const usedTokenPct = this.usedTokenPct();
    const usedCostPct = this.usedCostPct();
    const pct = Math.max(usedTokenPct, usedCostPct);
    let level: BudgetAlertLevel | 0 = 0;
    for (const l of BUDGET_ALERT_LEVELS) if (pct >= l) level = l;
    if (level === 0 || level <= this.alertedLevel) return null;
    this.alertedLevel = level;
    return { level, usedTokenPct, usedCostPct };
  }

  /** Human-readable summary used on graceful termination (US-09). */
  summarize(): string {
    const t = this.usedTokens();
    return [
      `预算耗尽，任务已安全停止。`,
      `Token: ${t.toLocaleString()} / ${this.config.maxTokens.toLocaleString()} (${(this.usedTokenPct() * 100).toFixed(1)}%)`,
      `费用: $${this.state.usedCostUsd.toFixed(4)} / $${this.config.maxCostUsd.toFixed(2)}`,
    ].join('\n');
  }

  /** Estimate current context-window occupation from the message list. */
  static contextTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += m.tokens ?? 0;
    }
    return total;
  }
}
