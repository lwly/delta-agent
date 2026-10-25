/**
 * F-24 git 集成：建议分支 + 自动 commit 策略（只提交会话记录在案的文件）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { ToolCall } from '@delta/shared';
import { GitIntegration, SessionStore, ToolRegistry } from '../src/index.js';
import { FileChangeStore } from '../src/session/changes.js';
import type { ToolContext } from '../src/tools/types.js';

let tmpRoot = '';
let store: SessionStore;
let changes: FileChangeStore;

beforeEach(async () => {
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yz-git-'));
  store = new SessionStore(path.join(tmpRoot, 'test.db'));
  changes = new FileChangeStore(store.db);
});

/** 在 tmpRoot 内初始化 git 仓库（隔离身份 + 初始提交）。 */
function initRepo(): void {
  const run = (cmd: string) => execSync(cmd, { cwd: tmpRoot, stdio: 'pipe' });
  run('git init');
  run('git config user.email test@example.com');
  run('git config user.name tester');
  fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# init\n');
  run('git add .');
  run('git commit -m init');
}

function makeCtx(): ToolContext {
  return {
    projectRoot: tmpRoot,
    signal: new AbortController().signal,
    sessionId: 's1',
    confirm: async () => ({ kind: 'allow' }),
    askUser: async () => 'ok',
    todos: [],
    changes,
  };
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: 'c1', name, argsJson: JSON.stringify(args), args,
});

async function agentWritesFile(): Promise<void> {
  const registry = new ToolRegistry();
  await registry.executeAll([call('write_file', { path: 'src/a.ts', content: 'hello' })], makeCtx());
}

describe('GitIntegration 基础探测', () => {
  it('非 git 目录：isRepo=false，advisory=null', async () => {
    const git = new GitIntegration(tmpRoot, { mode: 'suggest' });
    expect(await git.isRepo()).toBe(false);
    expect(await git.advisory('s1')).toBeNull();
  });

  it('git 仓库：干净 → 建议为空串；脏 → 建议建分支', async () => {
    initRepo();
    const git = new GitIntegration(tmpRoot, { mode: 'suggest' });
    expect(await git.isRepo()).toBe(true);
    expect(await git.advisory('s1')).toBe('');

    fs.writeFileSync(path.join(tmpRoot, 'dirty.txt'), 'x');
    const note = await git.advisory('s1');
    expect(note).toContain('建议');
    expect(note).toContain(git.suggestBranchName('s1'));
    // 分支名格式：delta/<sessionId 前 8 位>
    expect(git.suggestBranchName('s1')).toMatch(/^delta\/s1$/);
  });

  it('createBranch 创建并切换分支', async () => {
    initRepo();
    const git = new GitIntegration(tmpRoot, { mode: 'suggest' });
    const res = await git.createBranch('delta/test');
    expect(res.ok).toBe(true);
    expect(await git.currentBranch()).toBe('delta/test');
  });
});

describe('autoCommitChanges（auto 策略）', () => {
  it('只提交会话记录在案的文件，不波及用户未托管改动', async () => {
    initRepo();
    const git = new GitIntegration(tmpRoot, { mode: 'auto' });
    await agentWritesFile(); // agent 写 src/a.ts（记录进 changes）
    fs.writeFileSync(path.join(tmpRoot, 'user-note.txt'), '用户的私人改动'); // 用户自己的

    const out = await git.autoCommitChanges('s1', changes, '实现 a 模块');
    expect(out.ok).toBe(true);
    expect(out.hash).toBeTruthy();

    const committed = execSync('git show --name-only --format=', { cwd: tmpRoot }).toString();
    expect(committed).toContain('src/a.ts');
    expect(committed).not.toContain('user-note.txt');
    const msg = execSync('git log -1 --format=%s', { cwd: tmpRoot }).toString();
    expect(msg).toContain('delta:');
    expect(msg).toContain('实现 a 模块');
  });

  it('无记录变更 / 记录路径无实际改动 → 不提交', async () => {
    initRepo();
    const git = new GitIntegration(tmpRoot, { mode: 'auto' });
    expect((await git.autoCommitChanges('s1', changes, '空任务')).reason).toBe('no recorded changes');

    // 记录了但文件内容与 HEAD 一致（如回滚后）→ nothing to commit
    await agentWritesFile();
    fs.rmSync(path.join(tmpRoot, 'src'), { recursive: true, force: true }); // 删掉后与 HEAD 一致
    const out = await git.autoCommitChanges('s1', changes, '回滚后');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('nothing to commit for recorded paths');
  });

  it('off 模式与非 git 目录静默降级', async () => {
    const off = new GitIntegration(tmpRoot, { mode: 'off' });
    expect((await off.autoCommitChanges('s1', changes, 'x')).reason).toBe('git policy off');

    initRepo();
    const nonRepo = new GitIntegration(os.tmpdir(), { mode: 'auto' });
    expect((await nonRepo.autoCommitChanges('s1', changes, 'x')).reason).toBe('not a git repository');
  });
});
