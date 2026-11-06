/**
 * F-58 看门狗 L1/L2（设计稿 §9）+ L3 标记接口（P0 不接模型，§9.2 / 计划 T2d）。
 *
 *   L1 存活：peekRunning(workerSessionId)===false 且任务仍 running → failed(runtime) + inbox。
 *           只兜底——收敛主路径是 hub 的 onRunFinished 回调（§9.3）。
 *   L2 越界（客观事实，立即 kill 不重试）：
 *     (a) 内置 Worker：file_changes.path 越出会话 work_root → hub.abort + failed(watchdog_l2)。
 *     (c) 会话仍存活但 ≥20 分钟无任何 AgentEvent 产出（静默死循环特征）→ 同 L2 处置。
 *         阈值必须 <30min：否则会被既有 zombieReap 先杀掉，L2c 永远观察不到（§9.3）。
 *   L3 偏离：P0 只落 markSuspect 标记接口（写 watchdog_flag + silent inbox），不接模型、不判偏离。
 *
 * ⚠️ 红线（D15/§9.3）：本文件只准用 peekRunning，任何地方不得调用 isRunning——
 * isRunning 内部 zombieReap 会把超 30 分钟的会话当僵尸回收，看门狗若调用它等于给
 * 自己的 Worker 判 30 分钟死刑（有 grep 自检 + fake hub 计数用例双重守卫）。
 */
import * as path from 'node:path';

import type { Dispatcher } from './dispatcher.js';

/** L2c 静默阈值（§9：必须 <30min，避开既有 zombieReap） */
export const WATCHDOG_L2C_SILENT_MS = 20 * 60_000;

/** 看门狗可注入依赖（runtime 装配；缺省的检查项自动跳过，不误杀） */
export interface WatchdogDeps {
  /** L2a：会话的文件变更清单（runtime 注入 FileChangeStore.list） */
  listFileChanges?: (sessionId: string) => { path: string }[];
  /** L2a：会话的 work_root（runtime 注入 resolveWorkRoot；返回 null = 无法判定，跳过） */
  getWorkRoot?: (sessionId: string) => string | null;
  /** L2c：会话最近一次 AgentEvent 时间戳；未注入 = 无法观察事件流，跳过 L2c（不误杀） */
  lastEventAt?: (sessionId: string) => number | null;
}

/**
 * L2a 判据：p 是否越出 workRoot。必须用 path.relative 判 `..` 前缀，
 * 不得用 startsWith——`/repo` 与 `/repoEvil` 前缀相同但越界；Windows 盘符大小写
 * （`C:\` vs `c:\`）与分隔符差异会让 startsWith 误判（计划·风险 3）。
 * Windows 绝对路径统一走 path.win32（纯 JS，任意宿主平台可判）；相对路径先按
 * workRoot resolve（file_changes.path 相对 projectRoot 记录，`../` 开头即越界形态）。
 */
export function isPathOutsideWorkRoot(workRoot: string, p: string): boolean {
  if (p === '') return false;
  const WIN_ABS = /^[a-zA-Z]:[\\/]/;
  if (WIN_ABS.test(workRoot) && WIN_ABS.test(p)) {
    const rel = path.win32.relative(path.win32.normalize(workRoot), path.win32.normalize(p));
    return rel === '..' || rel.startsWith('..\\') || path.win32.isAbsolute(rel);
  }
  const abs = path.isAbsolute(p) ? p : path.resolve(workRoot, p);
  const rel = path.relative(workRoot, abs);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * 看门狗 tick：与 pumpDigest 共用 dispatcher 的 60s tick（设计稿 §9/§10.1）。
 * 逐个检查 running 任务：L1 → L2c → L2a，命中即处置并跳过该任务的后续检查。
 */
export async function watchdogTick(dispatcher: Dispatcher, deps: WatchdogDeps = {}): Promise<void> {
  const now = dispatcher.now();
  const running = dispatcher.workerTasks.list({ status: 'running' });
  for (const task of running) {
    const wsId = task.worker_session_id;

    // L1 存活：会话已死但任务仍 running（onRunFinished 丢失时的兜底，不 abort——进程已不在）
    if (!wsId || !dispatcher.peekRunning(wsId)) {
      dispatcher.convergeFailure(task, 'runtime', 'Worker 会话已死但任务仍标记运行中（看门狗 L1）', 'batch');
      continue;
    }

    // L2c 静默：会话活着但 ≥20 分钟无任何 AgentEvent（参照点取「最后事件 vs started_at」较新者）
    if (deps.lastEventAt) {
      const lastEvent = deps.lastEventAt(wsId);
      const ref = Math.max(lastEvent ?? 0, task.started_at ?? 0);
      if (now - ref >= WATCHDOG_L2C_SILENT_MS) {
        dispatcher.abortWorker(wsId);
        dispatcher.convergeFailure(
          task,
          'watchdog_l2',
          `已 ≥20 分钟无任何事件产出（看门狗 L2c，静默死循环特征）`,
          'interrupt',
        );
        continue;
      }
    }

    // L2a 路径越界：仅内置 Worker（外部 CLI 的写操作不经 delta registry，无 file_changes 落点，
    // 路径判据不可靠 → 外部 Worker 同场景走 L3 suspect 标记，§9.1）
    if (task.executor === null && deps.listFileChanges && deps.getWorkRoot) {
      const workRoot = deps.getWorkRoot(wsId);
      if (workRoot) {
        const bad = deps.listFileChanges(wsId).find((c) => isPathOutsideWorkRoot(workRoot, c.path));
        if (bad) {
          dispatcher.abortWorker(wsId);
          dispatcher.convergeFailure(
            task,
            'watchdog_l2',
            `写入越界路径 ${bad.path}（work_root=${workRoot}，看门狗 L2a，结构性错误不重试）`,
            'interrupt',
          );
          continue;
        }
      }
    }
  }
}
