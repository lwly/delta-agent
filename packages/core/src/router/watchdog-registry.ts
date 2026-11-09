/**
 * 架构收口 T7 —— WatchdogRegistry：调度链路定时看护的统一注册表。
 *
 * 背景：派发链路的看护定时（hub 决策等待超时等）此前各自裸写 setTimeout，
 * 同 kind+id 重复注册会叠加多个 timer（旧 timer 无法取消、泄漏）。
 * 本注册表收敛为单点：
 *  - register(kind, id, fn, ttlMs)：同 kind+id **同一 TTL 只保留一个 timer**
 *    （重复注册不重启，幂等）；TTL 变化才重置（fn 亦更新）；
 *  - cancel(kind, id)：取消后 fn 不触发；
 *  - timer.unref：不阻止进程退出（对齐 hub 既有决策等待超时的 unref 语义）。
 *
 * 用途（当前接线）：hub 决策等待超时（kind='decision'，id=会话+等待类别）。
 * dispatcher 看门狗 L1/L2 仍是 60s tick 扫描（非 timer 语义，红线：不改变 L1 30 分钟
 * 收敛口径），不在本注册表范围。
 */

interface WatchdogEntry {
  timer: ReturnType<typeof setTimeout>;
  ttlMs: number;
  fn: () => void;
}

export class WatchdogRegistry {
  private readonly entries = new Map<string, WatchdogEntry>();

  private static key(kind: string, id: string): string {
    return `${kind}:${id}`;
  }

  /**
   * 注册（或确认）一个看护 timer。
   * 返回 true = 本次新建了 timer；false = 同 kind+id 同 TTL 已存在（幂等，不重复起 timer，
   * fn 保留首个注册值——判据 4：同 kind+id 重复注册只保留一个 timer）。
   */
  register(kind: string, id: string, fn: () => void, ttlMs: number): boolean {
    const key = WatchdogRegistry.key(kind, id);
    const existing = this.entries.get(key);
    if (existing && existing.ttlMs === ttlMs) return false;
    if (existing) {
      clearTimeout(existing.timer); // TTL 变化：重置（换 fn + 换间隔）
    }
    const timer = setTimeout(() => {
      this.entries.delete(key);
      try {
        fn();
      } catch {
        /* 看护回调异常不影响注册表状态 */
      }
    }, ttlMs);
    timer.unref?.(); // 不阻止进程退出（对齐既有决策等待超时语义）
    this.entries.set(key, { timer, ttlMs, fn });
    return true;
  }

  /** 取消（返回 true = 确实存在并已取消）；取消后 fn 不触发 */
  cancel(kind: string, id: string): boolean {
    const key = WatchdogRegistry.key(kind, id);
    const entry = this.entries.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(key);
    return true;
  }

  has(kind: string, id: string): boolean {
    return this.entries.has(WatchdogRegistry.key(kind, id));
  }

  get size(): number {
    return this.entries.size;
  }

  /** 清空全部（测试/宿主关闭用） */
  disposeAll(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }
}
