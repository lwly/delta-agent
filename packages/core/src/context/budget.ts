import type { BudgetConfig, BudgetState, ChatMessage, Usage } from '@y-zero/shared';

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

/**
 * Session-level budget manager (decision #7: session budget primary,
 * task-level budget optional and off by default).
 */
export class BudgetManager {
  readonly config: BudgetConfig;
  state: BudgetState = { usedInputTokens: 0, usedOutputTokens: 0, usedCostUsd: 0 };

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

  /** Whether to emit a budget_warning event this turn. */
  shouldWarn(): boolean {
    return this.usedTokenPct() >= 0.8 || this.usedCostPct() >= 0.8;
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
