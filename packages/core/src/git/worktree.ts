/**
 * F-37 WorktreeManager：git 分支切换 + worktree 会话级隔离的 git 原语层。
 * - 列本地分支（含当前分支标识）/ 会话级 checkout（脏区拦截，D9）
 * - git worktree add（基于指定分支或就地新建分支）/ list / remove / prune
 * - 当前工作根查询（分支名 / 脏区 / 仓库探测）
 * worktree 目录约定（设计文档 §8 共享知识 1）：
 *   容器 = <仓库父目录>/<repoName>.worktrees/；会话目录 = yzero-<sessionId 前 8 位>
 * 所有 git 调用复用 runWithShell（跨平台 ShellAdapter，15s 超时口径同 GitIntegration），
 * 失败一律 {ok:false, reason} 结构化返回，不 throw、不中断 UI。
 */
import { runWithShell } from '../engine/shell.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface GitOutcomeLike {
  ok: boolean;
  /** ok=false 时的可展示原因（git stderr 已提炼） */
  reason?: string;
}

export interface BranchInfo {
  name: string;
  /** 是否为当前工作根所在分支 */
  current: boolean;
}

export interface WorktreeInfo {
  /** 绝对路径 */
  path: string;
  /** detached HEAD 时 null */
  branch: string | null;
  /** 短 hash */
  head: string;
}

const GIT_TIMEOUT_MS = 15_000;

/** shell 引号包装（与 repo.ts 同口径：darwin/linux 单引号，win32 双引号兼容）。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class WorktreeManager {
  private readonly root: string;
  private readonly signal: AbortSignal;

  /**
   * @param mainRoot 仓库主工作区（项目 root_path）；worktree 容器固定其兄弟目录
   * @param signal   中止信号（缺省永不中止；git 调用均有 15s 超时兜底）
   */
  constructor(mainRoot: string, signal: AbortSignal = new AbortController().signal) {
    this.root = path.resolve(mainRoot);
    this.signal = signal;
  }

  private async git(
    args: string,
    cwd: string = this.root,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const r = await runWithShell(`git ${args}`, cwd, GIT_TIMEOUT_MS, this.signal);
    return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  }

  async isRepo(): Promise<boolean> {
    const r = await this.git('rev-parse --is-inside-work-tree');
    return r.code === 0 && r.stdout === 'true';
  }

  /** 仓库目录名（worktree 容器命名用）；非 repo 返回 path.basename(mainRoot)。 */
  repoName(): string {
    return path.basename(this.root);
  }

  /**
   * 当前根的分支；detached HEAD 返回短 hash（底栏显示口径）；git 失败返回 null。
   * @param root 缺省主工作区；worktree 内查询显式传入
   */
  async currentBranch(root: string = this.root): Promise<string | null> {
    const r = await this.git('rev-parse --abbrev-ref HEAD', root);
    if (r.code !== 0) return null;
    if (r.stdout === 'HEAD') {
      // detached HEAD：显示短 hash
      const h = await this.git('rev-parse --short HEAD', root);
      return h.code === 0 ? h.stdout || null : null;
    }
    return r.stdout || null;
  }

  /** 当前根是否脏（D9：主工作区 / worktree 一视同仁）。 */
  async isDirty(root: string = this.root): Promise<boolean> {
    const r = await this.git('status --porcelain', root);
    return r.code === 0 && r.stdout.length > 0;
  }

  /** 本地分支列表（字母序，当前打勾标识）；非 repo → { ok:false }。 */
  async listBranches(
    root: string = this.root,
  ): Promise<{ ok: true; branches: BranchInfo[] } | { ok: false; reason: string }> {
    const r = await this.git('branch --no-color', root);
    if (r.code !== 0) return { ok: false, reason: r.stderr || 'git branch 失败' };
    const branches: BranchInfo[] = [];
    for (const line of r.stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const current = t.startsWith('* ');
      branches.push({ name: current ? t.slice(2) : t, current });
    }
    branches.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, branches };
  }

  /**
   * 会话工作根内 checkout（D9：脏区阻止，不自动 stash）。
   * branch 与 newBranch 二选一：newBranch = 就地 `checkout -b`。
   */
  async checkout(
    root: string,
    opts: { branch?: string; newBranch?: string },
  ): Promise<GitOutcomeLike & { branch?: string }> {
    const branch = opts.branch ?? opts.newBranch;
    if (!branch) return { ok: false, reason: '缺少目标分支（branch 或 newBranch 二选一）' };
    if (opts.branch && opts.newBranch) {
      return { ok: false, reason: 'branch 与 newBranch 只能二选一' };
    }
    if (await this.isDirty(root)) {
      return {
        ok: false,
        reason: '当前工作区有未提交改动，切换分支前请先提交或 stash（不会自动 stash）',
      };
    }
    const r = opts.newBranch
      ? await this.git(`checkout -b ${shellQuote(opts.newBranch)}`, root)
      : await this.git(`checkout ${shellQuote(opts.branch!)}`, root);
    if (r.code !== 0) {
      return { ok: false, reason: r.stderr || `git checkout ${branch} 失败` };
    }
    return { ok: true, branch };
  }

  /** 会话 worktree 目录约定路径：../<repoName>.worktrees/yzero-<sessionId 前 8 位>。 */
  worktreePathFor(sessionId: string): string {
    const sid8 = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8);
    // 容器目录 realpath 归一：macOS tmpdir 是符号链接（/var → /private/var），
    // 而 git worktree list 输出真实路径，不归一会导致 D10 幂等判重失配
    let base = path.dirname(this.root);
    try {
      base = fs.realpathSync(base);
    } catch {
      // 目录尚不存在时保持原路径
    }
    return path.join(base, `${this.repoName()}.worktrees`, `yzero-${sid8 || 'session'}`);
  }

  /**
   * 创建并返回 worktree 绝对路径（D10 幂等：路径已在 worktree list → 直接返回）。
   * opts 三选一语义：branch（从既有分支检出）/ newBranch（-b 新建）/ 缺省（从当前 HEAD）。
   * 目录存在但已脱管（不在 worktree list 中）→ {ok:false}，不静默删除用户目录。
   * 新目录从分支 HEAD 干净检出，不做脏区检查（D9）。
   */
  async addWorktree(
    sessionId: string,
    opts?: { branch?: string; newBranch?: string },
  ): Promise<GitOutcomeLike & { path?: string }> {
    if (!(await this.isRepo())) return { ok: false, reason: 'not a git repository' };
    const wtPath = this.worktreePathFor(sessionId);
    const exists = fs.existsSync(wtPath);
    if (exists) {
      // D10：目录存在时先查注册状态，已注册直接重绑返回
      const list = await this.listWorktrees();
      if (!list.ok) return { ok: false, reason: list.reason };
      if (list.worktrees.some((w) => path.resolve(w.path) === wtPath)) {
        return { ok: true, path: wtPath };
      }
      return {
        ok: false,
        reason: `目录已存在但未注册为 worktree：${wtPath}（请手动确认后删除，不会自动覆盖用户目录）`,
      };
    }

    // 容器目录确保存在（git worktree add 会创建目标目录，父目录显式补齐更稳）
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const quoted = shellQuote(wtPath);
    let cmd: string;
    if (opts?.newBranch) {
      cmd = `worktree add -b ${shellQuote(opts.newBranch)} ${quoted}`;
    } else if (opts?.branch) {
      cmd = `worktree add ${quoted} ${shellQuote(opts.branch)}`;
    } else {
      cmd = `worktree add ${quoted}`;
    }
    const r = await this.git(cmd);
    if (r.code !== 0) return { ok: false, reason: r.stderr || 'git worktree add 失败' };
    return { ok: true, path: wtPath };
  }

  /** worktree 注册清单（porcelain 解析）；非 repo / git 失败 → {ok:false}。 */
  async listWorktrees(): Promise<
    { ok: true; worktrees: WorktreeInfo[] } | { ok: false; reason: string }
  > {
    const r = await this.git('worktree list --porcelain');
    if (r.code !== 0) return { ok: false, reason: r.stderr || 'git worktree list 失败' };
    const worktrees: WorktreeInfo[] = [];
    let cur: Partial<WorktreeInfo> = {};
    const flush = (): void => {
      if (cur.path) {
        worktrees.push({
          path: cur.path,
          branch: cur.branch ?? null,
          head: cur.head ?? '',
        });
      }
      cur = {};
    };
    for (const line of r.stdout.split('\n')) {
      if (line === '') {
        flush();
        continue;
      }
      if (line.startsWith('worktree ')) cur.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length).slice(0, 8);
      else if (line.startsWith('branch ')) {
        cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
      // detached 行无 branch 字段 → branch 保持 undefined → null
    }
    flush();
    return { ok: true, worktrees };
  }

  /** 显式移除（P1）；目录有未提交改动时拒绝（--force 不暴露给一期）。 */
  async removeWorktree(wtPath: string): Promise<GitOutcomeLike> {
    const target = path.resolve(wtPath);
    if (!fs.existsSync(target)) return { ok: false, reason: `目录不存在：${target}` };
    if (await this.isDirty(target)) {
      return {
        ok: false,
        reason: 'worktree 内有未提交改动，为防误删已拒绝移除（请先提交或手动删除）',
      };
    }
    const r = await this.git(`worktree remove ${shellQuote(target)}`);
    if (r.code !== 0) return { ok: false, reason: r.stderr || 'git worktree remove 失败' };
    return { ok: true };
  }

  /** 清理孤儿（目录已不存在的注册项）。 */
  async prune(): Promise<GitOutcomeLike> {
    const r = await this.git('worktree prune');
    if (r.code !== 0) return { ok: false, reason: r.stderr || 'git worktree prune 失败' };
    return { ok: true };
  }
}

// ── 切换注入消息（D5：两端一致文案，role='user' +「（系统提示：…）」惯例）──────

/** 切分支成功（主工作区或 worktree 内 checkout 通用）。 */
export function branchSwitchMessage(branch: string, root: string): string {
  return `（系统提示：[环境] 工作根已切换：分支 ${branch} @ ${root}；后续文件读写与命令执行均以该目录为基准）`;
}

/** 勾选 worktree（切入独立目录）。 */
export function worktreeOnMessage(branch: string, wtPath: string): string {
  return `（系统提示：[环境] 工作根已切换：分支 ${branch} @ ${wtPath}（独立 worktree，主工作区改动不受影响））`;
}

/** 取消 worktree（切回主工作区；目录保留）。 */
export function worktreeOffMessage(projectRoot: string, wtPath: string): string {
  return `（系统提示：[环境] 已切回主工作区：${projectRoot}；worktree 目录已保留（${wtPath}），可用 yzero worktree remove 清理）`;
}
