/**
 * Git 集成（PRD F-24 后半段）：建议分支 + 自动 commit 策略。
 * - off：不做任何 git 操作
 * - suggest：会话启动时给出建议（仓库脏 → 建议建工作分支），纯提示
 * - auto：任务结束后自动 commit 本会话记录在案的文件变更
 *   （以 F-24 FileChangeStore 为准，绝不 git add -A 波及用户未托管的改动）
 * 所有 git 调用复用 ShellAdapter（M5 跨平台），失败静默降级为 reason，不阻塞交付。
 */
import { runWithShell } from '../engine/shell.js';
import type { FileChangeStore } from '../session/changes.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type GitPolicyMode = 'off' | 'suggest' | 'auto';

export interface GitPolicy {
  mode: GitPolicyMode;
  /** 建议分支前缀（默认 `delta/`） */
  branchPrefix?: string;
}

export interface GitOutcome {
  ok: boolean;
  /** committed=true 时为 commit hash */
  hash?: string;
  /** ok=false / 未执行时的原因 */
  reason?: string;
}

const GIT_TIMEOUT_MS = 15_000;

/** shell 引号包装（darwin/linux 单引号，win32 PowerShell 兼容双引号）。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** commit message 单行化并截断。 */
function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export class GitIntegration {
  constructor(
    // F-37（D4）：去 readonly —— 切换工作根后经 updateRoot() 跟随（auto commit 以当前工作根为基准）
    private projectRoot: string,
    private readonly policy: GitPolicy,
    private readonly signal: AbortSignal = new AbortController().signal,
  ) {}

  /** F-37：切换分支/worktree 后重绑工作根（仅影响后续 git 调用，行为零改动）。 */
  updateRoot(root: string): void {
    this.projectRoot = path.resolve(root);
  }

  get mode(): GitPolicyMode {
    return this.policy.mode;
  }

  private async git(args: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const r = await runWithShell(`git ${args}`, this.projectRoot, GIT_TIMEOUT_MS, this.signal);
    return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  }

  async isRepo(): Promise<boolean> {
    const r = await this.git('rev-parse --is-inside-work-tree');
    return r.code === 0 && r.stdout === 'true';
  }

  /** 当前分支名（detached HEAD 返回 null）。 */
  async currentBranch(): Promise<string | null> {
    const r = await this.git('rev-parse --abbrev-ref HEAD');
    if (r.code !== 0 || r.stdout === 'HEAD') return null;
    return r.stdout || null;
  }

  /** 工作区是否有未提交改动。 */
  async isDirty(): Promise<boolean> {
    const r = await this.git('status --porcelain');
    return r.code === 0 && r.stdout.length > 0;
  }

  /** 建议工作分支名：delta/<sessionId 前 8 位>。 */
  suggestBranchName(sessionId: string): string {
    return `${this.policy.branchPrefix ?? 'delta/'}${sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8)}`;
  }

  async createBranch(name: string): Promise<GitOutcome> {
    const r = await this.git(`checkout -b ${shellQuote(name)}`);
    return r.code === 0
      ? { ok: true }
      : { ok: false, reason: r.stderr || `git checkout -b ${name} 失败` };
  }

  /**
   * suggest 模式的启动建议（非 repo 返回 null）：
   * - 脏工作区 → 建议创建会话工作分支
   * - 干净 → 无需提示（空串）
   */
  async advisory(sessionId: string): Promise<string | null> {
    if (this.policy.mode !== 'suggest' && this.policy.mode !== 'auto') return null;
    if (!(await this.isRepo())) return null;
    if (await this.isDirty()) {
      const branch = this.suggestBranchName(sessionId);
      return `建议：当前仓库有未提交改动，可先建工作分支隔离本次任务的修改（git checkout -b ${branch}）`;
    }
    return '';
  }

  /**
   * auto 模式：任务结束后提交本会话记录在案的文件。
   * - 只 add FileChangeStore 中该会话涉及的路径（绝不 git add -A）
   * - 这些路径无实际改动（status 干净）→ 不提交
   * - 仓库无 user.email 配置时用 -c 兜底身份
   */
  async autoCommitChanges(
    sessionId: string,
    changes: FileChangeStore,
    label: string,
  ): Promise<GitOutcome> {
    if (this.policy.mode !== 'auto') return { ok: false, reason: 'git policy off' };
    if (!(await this.isRepo())) return { ok: false, reason: 'not a git repository' };

    const paths = [...new Set(changes.summary(sessionId).map((i) => i.path))];
    if (paths.length === 0) return { ok: false, reason: 'no recorded changes' };
    // 只 add 磁盘上仍存在的记录路径（路径消失 = 已回滚/被外部删除，无需提交）
    const existing: string[] = [];
    for (const p of paths) {
      const abs = path.join(this.projectRoot, p);
      if (await fs.stat(abs).then(() => true, () => false)) existing.push(p);
    }
    if (existing.length === 0) return { ok: false, reason: 'nothing to commit for recorded paths' };
    const pathArgs = existing.map((p) => shellQuote(p)).join(' ');

    const add = await this.git(`add -- ${pathArgs}`);
    if (add.code !== 0) return { ok: false, reason: add.stderr || 'git add failed' };

    const staged = await this.git(`status --porcelain -- ${pathArgs}`);
    if (staged.code !== 0 || staged.stdout.length === 0) {
      return { ok: false, reason: 'nothing to commit for recorded paths' };
    }

    // 身份兜底：仓库未配置 user.email 时用 -c 注入（不污染用户配置）
    const identity = await this.git('config user.email');
    const cfg = identity.code === 0 && identity.stdout ? '' : '-c user.name=delta-agent -c user.email=delta@local';
    const msg = `delta: ${oneLine(label)} (${paths.length} file${paths.length > 1 ? 's' : ''})`;
    const commit = await this.git(`commit -m ${shellQuote(msg)} ${cfg}`.trim());
    if (commit.code !== 0) return { ok: false, reason: commit.stderr || 'git commit failed' };
    return { ok: true, hash: commit.stdout.split('\n')[0]?.trim() || undefined };
  }
}
