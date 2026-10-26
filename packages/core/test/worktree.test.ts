/**
 * F-37 WorktreeManager / resolveWorkRoot / v4 迁移测试：
 * 临时目录建真实 git 仓库，覆盖列分支、脏区拦截、worktree add 幂等、
 * 移除拒绝脏目录、prune、resolveWorkRoot 回退与会话绑定落库。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  SessionService,
  SessionStore,
  WorktreeManager,
  branchSwitchMessage,
  worktreeOnMessage,
  worktreeOffMessage,
  resolveWorkRoot,
} from '../src/index.js';

let tmpBase = ''; // 仓库父目录（worktree 容器落在这里）
let repoRoot = '';

beforeEach(async () => {
  tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yz-wt-'));
  repoRoot = path.join(tmpBase, 'my-repo');
  fs.mkdirSync(repoRoot);
});

afterEach(async () => {
  await fs.promises.rm(tmpBase, { recursive: true, force: true });
});

/** 在 repoRoot 初始化 git 仓库（隔离身份 + 初始提交 + 一个备用分支）。 */
function initRepo(): void {
  const run = (cmd: string) => execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
  run('git init -b main');
  run('git config user.email test@example.com');
  run('git config user.name tester');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# init\n');
  run('git add .');
  run('git commit -m init');
  run('git branch feature');
}

describe('WorktreeManager 基础探测', () => {
  it('非 git 目录：isRepo=false', async () => {
    const wm = new WorktreeManager(repoRoot);
    expect(await wm.isRepo()).toBe(false);
    expect(wm.repoName()).toBe('my-repo');
  });

  it('git 仓库：currentBranch / isDirty / listBranches（当前打勾 + 字母序）', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    expect(await wm.isRepo()).toBe(true);
    expect(await wm.currentBranch()).toBe('main');
    expect(await wm.isDirty()).toBe(false);

    const list = await wm.listBranches();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.branches.map((b) => b.name)).toEqual(['feature', 'main']);
      expect(list.branches.find((b) => b.name === 'main')?.current).toBe(true);
    }
  });

  it('detached HEAD：currentBranch 返回短 hash', async () => {
    initRepo();
    execSync('git checkout --detach HEAD', { cwd: repoRoot, stdio: 'pipe' });
    const wm = new WorktreeManager(repoRoot);
    const branch = await wm.currentBranch();
    expect(branch).toBeTruthy();
    expect(branch).toMatch(/^[0-9a-f]{7,}$/);
  });
});

describe('checkout（脏区拦截，D9）', () => {
  it('干净工作区：checkout 到既有分支', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    const r = await wm.checkout(repoRoot, { branch: 'feature' });
    expect(r.ok).toBe(true);
    expect(await wm.currentBranch()).toBe('feature');
  });

  it('branch 与 newBranch 同时给出 → 拒绝', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    const r = await wm.checkout(repoRoot, { branch: 'feature', newBranch: 'x' });
    expect(r.ok).toBe(false);
  });

  it('脏工作区：阻止 checkout 且不自动 stash', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'dirty.txt'), 'x');
    const r = await wm.checkout(repoRoot, { branch: 'feature' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('未提交改动');
    // 分支未被切换
    expect(await wm.currentBranch()).toBe('main');
    // 文件原样保留（未 stash）
    expect(fs.existsSync(path.join(repoRoot, 'dirty.txt'))).toBe(true);
  });

  it('脏 worktree 内 checkout 同样拦截（脏区口径作用于当前工作根）', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    const add = await wm.addWorktree('sess-dirty', { branch: 'feature' });
    expect(add.ok).toBe(true);
    const wt = add.path!;
    fs.writeFileSync(path.join(wt, 'wt-dirty.txt'), 'x');
    const r = await wm.checkout(wt, { branch: 'main' });
    expect(r.ok).toBe(false);
    expect(await wm.currentBranch(wt)).toBe('feature');
  });
});

describe('worktree add / list / remove / prune', () => {
  it('add：容器目录约定 ../<repo>.worktrees/delta-<sid8>，从指定分支检出', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    const sid = 'a1b2c3d4-5e6f-4a1b-8c2d-000000000001';
    const r = await wm.addWorktree(sid, { branch: 'feature' });
    expect(r.ok).toBe(true);
    // realpath 归一（macOS tmpdir 符号链接）：与 worktreePathFor 内部口径一致
    const expected = path.join(
      fs.realpathSync(tmpBase), 'my-repo.worktrees', 'delta-a1b2c3d4',
    );
    expect(r.path).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(await wm.currentBranch(expected)).toBe('feature');

    const list = await wm.listWorktrees();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.worktrees.some((w) => w.branch === 'feature')).toBe(true);
    }
  });

  it('add：-b 就地新建分支', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    const r = await wm.addWorktree('new-branch-sess', { newBranch: 'delta/work' });
    expect(r.ok).toBe(true);
    expect(await wm.currentBranch(r.path!)).toBe('delta/work');
  });

  it('add：缺省从当前 HEAD 检出（git 默认以目录名建分支，恰为 delta-<sid8>）', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    const r = await wm.addWorktree('head-sess');
    expect(r.ok).toBe(true);
    expect(await wm.currentBranch(r.path!)).toBe('delta-head-ses');
  });

  it('add 幂等（D10）：路径已在 worktree list → 直接重绑返回', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    const first = await wm.addWorktree('sess-idem', { branch: 'feature' });
    expect(first.ok).toBe(true);
    const second = await wm.addWorktree('sess-idem', { branch: 'feature' });
    expect(second.ok).toBe(true);
    expect(second.path).toBe(first.path);
  });

  it('add：目录存在但已脱管 → 结构化失败，不静默覆盖', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    const target = wm.worktreePathFor('sess-orphan');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'user-file.txt'), '用户目录');
    const r = await wm.addWorktree('sess-orphan', { branch: 'feature' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('未注册');
    // 用户文件未被破坏
    expect(fs.existsSync(path.join(target, 'user-file.txt'))).toBe(true);
  });

  it('remove：脏 worktree 拒绝；干净可移除；prune 清孤儿', async () => {
    initRepo();
    const wm = new WorktreeManager(repoRoot);
    const dirty = await wm.addWorktree('sess-dirty-rm');
    expect(dirty.ok).toBe(true);
    fs.writeFileSync(path.join(dirty.path!, 'x.txt'), '未提交');
    const refused = await wm.removeWorktree(dirty.path!);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('未提交改动');

    const clean = await wm.addWorktree('sess-clean-rm');
    expect(clean.ok).toBe(true);
    const removed = await wm.removeWorktree(clean.path!);
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(clean.path!)).toBe(false);

    // 模拟孤儿：手动删除注册目录后 prune 收敛
    const orphan = await wm.addWorktree('sess-orphan-prune');
    expect(orphan.ok).toBe(true);
    fs.rmSync(orphan.path!, { recursive: true, force: true });
    const pruned = await wm.prune();
    expect(pruned.ok).toBe(true);
    const list = await wm.listWorktrees();
    if (list.ok) {
      expect(list.worktrees.some((w) => w.path === orphan.path)).toBe(false);
    }
  });
});

describe('resolveWorkRoot 与会话绑定（v4）', () => {
  it('sessions 表 v4 列存在；setSessionWorktree 两列原子更新', () => {
    initRepo();
    const dbFile = path.join(tmpBase, 'test.db');
    const svc = new SessionService(dbFile);
    try {
      expect(svc.store.schemaVersion).toBe(5);
      const pid = svc.ensureProject(repoRoot).id;
      const s = svc.createSession(pid);
      // 默认两列为 NULL（主工作区）
      expect(s.worktree_path).toBeNull();
      expect(s.worktree_branch).toBeNull();

      const wt = new WorktreeManager(repoRoot).worktreePathFor(s.id);
      svc.setSessionWorktree(s.id, { worktreePath: wt, worktreeBranch: 'feature' });
      const bound = svc.getSession(s.id)!;
      expect(bound.worktree_path).toBe(wt);
      expect(bound.worktree_branch).toBe('feature');

      // 解绑 = 两列同置 NULL
      svc.setSessionWorktree(s.id, { worktreePath: null, worktreeBranch: null });
      expect(svc.getSession(s.id)!.worktree_path).toBeNull();
      // 不存在的会话拒绝
      expect(() => svc.setSessionWorktree('nope', { worktreePath: null })).toThrow('session not found');
    } finally {
      svc.close();
    }
  });

  it('resolveWorkRoot：绑定目录存活 → worktree；目录丢失 → 回退项目根', async () => {
    initRepo();
    const svc = new SessionService(path.join(tmpBase, 'test.db'));
    try {
      const pid = svc.ensureProject(repoRoot).id;
      const s = svc.createSession(pid);
      // 无绑定 → 项目根
      expect(resolveWorkRoot(s, repoRoot)).toBe(repoRoot);

      const wm = new WorktreeManager(repoRoot);
      const add = await wm.addWorktree(s.id, { branch: 'feature' });
      svc.setSessionWorktree(s.id, { worktreePath: add.path, worktreeBranch: 'feature' });
      const bound = svc.getSession(s.id)!;
      expect(resolveWorkRoot(bound, repoRoot)).toBe(add.path!);

      // 目录被手动删除 → 回退主工作根
      fs.rmSync(add.path!, { recursive: true, force: true });
      expect(resolveWorkRoot(bound, repoRoot)).toBe(repoRoot);
    } finally {
      svc.close();
    }
  });
});

describe('切换注入消息文案（D5 两端一致）', () => {
  it('三类消息格式', () => {
    expect(branchSwitchMessage('main', '/repo')).toBe(
      '（系统提示：[环境] 工作根已切换：分支 main @ /repo；后续文件读写与命令执行均以该目录为基准）',
    );
    expect(worktreeOnMessage('feature', '/wt')).toBe(
      '（系统提示：[环境] 工作根已切换：分支 feature @ /wt（独立 worktree，主工作区改动不受影响））',
    );
    expect(worktreeOffMessage('/repo', '/wt')).toBe(
      '（系统提示：[环境] 已切回主工作区：/repo；worktree 目录已保留（/wt），可用 delta worktree remove 清理）',
    );
  });
});
