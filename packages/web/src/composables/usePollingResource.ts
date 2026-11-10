/**
 * 架构收口 T5 —— 轮询资源工厂（stores/tasks.ts / stores/bgTasks.ts 共用）。
 *
 * 抽出两 store 此前各自复制的轮询机制：
 *  - watch(id) → stop → 立即 refresh + interval 定期 refresh；
 *  - 切 id 清态防串台（in-flight 旧响应按「当前 id ≠ 捕获 id」丢弃）；
 *  - 失败静默（保持现状，下一轮重试）；
 *  - T5 降级：activity SSE 在线时可 setIntervalMs 放宽轮询（10s），断线回 2s。
 * 纯命令式工厂（非 Vue 组合式 ref）：Pinia options store 与 node 单测均可直用。
 */

export interface PollingResourceOptions<T> {
  /** 拉取当前 id 的数据（单参调用，便于 mock 断言） */
  fetch: (id: string) => Promise<T>;
  /** 应用数据到调用方状态（仅在 id 未变时被调用——过期响应由本工厂丢弃） */
  apply: (data: T) => void;
  /** 基础轮询间隔（ms）；可经 setIntervalMs 动态调整（activity 降级） */
  intervalMs: number;
}

export interface PollingResourceHandle {
  /** 开始轮询（等价旧 watch(id)：先立即刷一轮再起 interval）；重复 start 幂等换 id */
  start(id: string): void;
  /** 停止轮询（in-flight 响应一并作废） */
  stop(): void;
  /** 手动刷一轮（裁决/kill 等动作后调用；过期响应同样被丢弃） */
  refresh(): Promise<void>;
  /** 动态调整轮询间隔（activity SSE 连接状态切换时调用；运行中即时生效） */
  setIntervalMs(ms: number): void;
  /** 当前资源 id（null = 已停止） */
  readonly id: string | null;
}

export function createPollingResource<T>(opts: PollingResourceOptions<T>): PollingResourceHandle {
  let currentId: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let interval = opts.intervalMs;
  /** 同一 id 下并发 tick 的发起序号；仅最新一轮允许 apply（防旧轮询覆盖 dispatch 后的新列表） */
  let tickGen = 0;

  const tick = async (): Promise<void> => {
    const captured = currentId;
    if (!captured) return;
    const gen = ++tickGen;
    try {
      const data = await opts.fetch(captured);
      // 资源已切换/停止，或已有更新的 tick 在进行：丢弃过期响应（不串台、不回滚）
      if (currentId === captured && gen === tickGen) opts.apply(data);
    } catch {
      /* 瞬时失败静默：保持现状，下一轮重试（对齐两 store 既有口径） */
    }
  };

  const restartTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = currentId ? setInterval(() => void tick(), interval) : null;
  };

  return {
    start(id: string): void {
      currentId = id;
      void tick(); // start 即刷一轮（对齐旧 watch 行为）
      restartTimer();
    },
    stop(): void {
      currentId = null; // in-flight 响应按 id 不匹配丢弃
      tickGen++;
      if (timer) clearInterval(timer);
      timer = null;
    },
    async refresh(): Promise<void> {
      await tick();
    },
    setIntervalMs(ms: number): void {
      if (!Number.isFinite(ms) || ms <= 0 || ms === interval) return;
      interval = ms;
      restartTimer();
    },
    get id(): string | null {
      return currentId;
    },
  };
}
