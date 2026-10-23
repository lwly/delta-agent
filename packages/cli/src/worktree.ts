/**
 * F-37 P1 顺手件：yzero worktree list/remove/prune 子命令组（PRD F-37-8）。
 * - list：注册清单（含主工作区），标注当前目录归属
 * - remove：显式移除（脏目录拒绝在 WorktreeManager 内拦截，--force 不暴露给一期）
 * - prune：清理孤儿（目录已不存在的注册项）
 * git 调用全部走 core WorktreeManager（G3 单点沉淀），CLI 仅做展示壳。
 */
import { WorktreeManager } from '@y-zero/core';

/** yzero worktree list */
export async function worktreeListCommand(): Promise<void> {
  const wm = new WorktreeManager(process.cwd());
  if (!(await wm.isRepo())) {
    console.error('✘ 当前目录不是 git 仓库');
    process.exitCode = 1;
    return;
  }
  const r = await wm.listWorktrees();
  if (!r.ok) {
    console.error(`✘ ${r.reason}`);
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  console.log(`仓库 ${wm.repoName()} 的 worktree 注册清单（${r.worktrees.length} 个）：`);
  for (const w of r.worktrees) {
    const here = cwd === w.path ? '（当前目录）' : '';
    console.log(`  ${w.path}${here}\n    分支 ${w.branch ?? '（detached HEAD）'} · HEAD ${w.head}`);
  }
  console.log('\n清理入口：yzero worktree remove <路径> / yzero worktree prune');
}

/** yzero worktree remove <path> */
export async function worktreeRemoveCommand(wtPath: string): Promise<void> {
  const wm = new WorktreeManager(process.cwd());
  const r = await wm.removeWorktree(wtPath);
  if (!r.ok) {
    console.error(`✘ ${r.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✔ 已移除 worktree：${wtPath}`);
}

/** yzero worktree prune */
export async function worktreePruneCommand(): Promise<void> {
  const wm = new WorktreeManager(process.cwd());
  if (!(await wm.isRepo())) {
    console.error('✘ 当前目录不是 git 仓库');
    process.exitCode = 1;
    return;
  }
  const r = await wm.prune();
  if (!r.ok) {
    console.error(`✘ ${r.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log('✔ 孤儿 worktree 注册项已清理');
}
