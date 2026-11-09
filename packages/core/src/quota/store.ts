/**
 * 架构收口 T7 —— QuotaStore 统一预算判定（内存态）。
 *
 * 职责：
 *  - 把 chat（hub 会话）/ worker（委派子代理，按 Router 会话归属）/ cron（定时任务）
 *    三类调用方的「累计成本 vs 上限」判定收敛到一个实现（判据 1：同一行为）；
 *  - 判定核心是共享纯函数 quotaExceeded——BudgetManager 的硬停分支与 QuotaStore.check
 *    共用（判据 2：同一输入同一判定）；
 *  - 纯内存（进程内 Map），**不新增 DB 表**：worker_tasks 金额不入表（migrations.ts
 *    既有注释延续），费用真相始终在 usage 表按 session_id 聚合（判据 3：口径不变）。
 *
 * 红线：只做判定与累计，不做扣费、不做持久化；serve 重启后归零（跨进程持久化属 T7 之后的迭代）。
 */

export type QuotaKind = 'session' | 'subagent' | 'cron';

/**
 * 共享纯判定：累计成本（+ 本次预估增量）是否触达上限。
 *  - maxCostUsd <= 0 = 不限额（与 BudgetManager.usedCostPct 的 max>0 口径一致）；
 *  - 判据 2：BudgetManager.guard 的费用硬停分支与 QuotaStore.check 共用本函数。
 */
export function quotaExceeded(usedCostUsd: number, maxCostUsd: number, extraCostUsd = 0): boolean {
  if (maxCostUsd <= 0) return false; // 不限额
  return usedCostUsd + extraCostUsd >= maxCostUsd;
}

export interface QuotaSnapshot {
  usedCostUsd: number;
  maxCostUsd: number;
}

export interface QuotaCheckResult extends QuotaSnapshot {
  ok: boolean;
  /** 超出量（used + extra − max，下限 0）；ok 时恒 0 */
  overage: number;
}

/** key 规范：`${kind}:${key}` */
const quotaKey = (kind: QuotaKind, key: string): string => `${kind}:${key}`;

/**
 * 内存配额账本。record 累计成本（上限值随最近一次传入更新）；check 读时判定。
 * 线程模型：Node 单线程同步方法，无锁。
 */
export class QuotaStore {
  private readonly records = new Map<string, QuotaSnapshot>();

  /**
   * 记一笔成本（正数累加；负数按 0 处理——配额账本不做退费）。
   * maxCostUsd 提供时更新该 key 的上限（缺省沿用旧值，0 = 不限额）。
   */
  record(kind: QuotaKind, key: string, costUsd: number, maxCostUsd?: number): QuotaSnapshot {
    const k = quotaKey(kind, key);
    const prev = this.records.get(k) ?? { usedCostUsd: 0, maxCostUsd: maxCostUsd ?? 0 };
    const next: QuotaSnapshot = {
      usedCostUsd: prev.usedCostUsd + Math.max(0, costUsd),
      maxCostUsd: maxCostUsd !== undefined ? maxCostUsd : prev.maxCostUsd,
    };
    this.records.set(k, next);
    return next;
  }

  /**
   * 读时判定：累计成本（+ extraCostUsd 预留/预估增量）是否触达上限。
   * 无记录的 key = 未设上限 → ok（不过度拦截）。
   */
  check(kind: QuotaKind, key: string, extraCostUsd = 0): QuotaCheckResult {
    const snap = this.records.get(quotaKey(kind, key)) ?? { usedCostUsd: 0, maxCostUsd: 0 };
    const exceeded = quotaExceeded(snap.usedCostUsd, snap.maxCostUsd, extraCostUsd);
    return {
      ok: !exceeded,
      overage: exceeded && snap.maxCostUsd > 0
        ? Math.max(0, snap.usedCostUsd + extraCostUsd - snap.maxCostUsd)
        : 0,
      usedCostUsd: snap.usedCostUsd,
      maxCostUsd: snap.maxCostUsd,
    };
  }

  /** 重置某 key 的账本（会话重开 / 手动续额场景） */
  reset(kind: QuotaKind, key: string): void {
    this.records.delete(quotaKey(kind, key));
  }

  /** 只读快照（无记录返回 undefined） */
  snapshot(kind: QuotaKind, key: string): QuotaSnapshot | undefined {
    return this.records.get(quotaKey(kind, key));
  }
}
