/**
 * F-55 P4 外部 agent 运行追踪（AC-55-5：serve dispose 后无孤儿进程）。
 *
 * 与 F-54 BackgroundTaskManager 的关系（同一路径语义的两面兜底）：
 *   - F-54 管 run_in_background 工具启动的会话内后台命令，dispose 收尾是
 *     BackgroundTaskManager.killAll()（server/runtime.ts）；
 *   - 本模块管外部 CLI agent 会话的子进程：engine/external.ts 每次 run 在 adapter
 *     实例化之后、run 之前 trackExternalRun 注册句柄，收尾 finally 反注册；
 *     serve dispose 时 cancelAllExternalRuns() 全杀在跑的外部 agent 进程。
 * 两者共用 dispose 收尾顺序，失败均不阻塞其余 dispose 步骤。
 */

/** 单个运行中外部 agent run 的取消句柄（cancel 语义与 adapter 实例的 spawnExternal.cancel 幂等一致） */
export interface ExternalRunHandle {
  cancel(): Promise<void>;
}

/** 运行中的外部 agent run 句柄集合（进程级；engine 每次 run 注册/反注册） */
const running = new Set<ExternalRunHandle>();

/** 注册运行中句柄（engine/external.ts 在 adapter 实例化之后、run 之前调用） */
export function trackExternalRun(handle: ExternalRunHandle): void {
  running.add(handle);
}

/** 反注册运行中句柄（run 收尾 finally 调用；dispose 全杀只覆盖在跑的 run） */
export function untrackExternalRun(handle: ExternalRunHandle): void {
  running.delete(handle);
}

/**
 * dispose 兜底：并行取消全部运行中的外部 agent run（幂等；单个失败不阻塞其余）。
 * 并行取消与 spawnExternal 的 300ms 宽限杀进程组语义一致，总耗时≈单个取消耗时。
 * 无论成败都移除句柄：dispose 是终态，不残留失败句柄（重复调用幂等）。
 */
export async function cancelAllExternalRuns(): Promise<void> {
  // 快照后遍历：cancel 过程中的 track/untrack 修改集合不影响本次全杀
  await Promise.all(
    [...running].map(async (handle) => {
      try {
        await handle.cancel();
      } catch {
        // 单个取消失败（如进程已退出后的竞态）不阻塞其余 run 的收敛
      }
      running.delete(handle);
    }),
  );
}
