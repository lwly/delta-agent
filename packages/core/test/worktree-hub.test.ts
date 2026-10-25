/**
 * F-37 补充测试（QA 第 1 轮补缺口）：
 * 既有 worktree.test.ts 覆盖 WorktreeManager 原语层，本文件补齐实现方自测未覆盖的两块：
 * 1. SessionHub 编排四方法：非 git 降级 / 运行中禁切 / 注入系统提示落库 / git_notice 推送 /
 *    worktreeState 目录丢失回退
 * 2. HTTP 4 端点语义分离：运行中 409（状态拒绝）vs git 失败 200 {ok:false}（结构化失败）vs 404
 * 3. WorktreeManager 边界：分支名带空格/特殊字符（shellQuote）、目标分支被另一 worktree
 *    占用时 git 原生 reason 透传、remove 不存在目录
 * 全部使用临时目录真实 git 仓库，测试间相互独立。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent, ToolCall } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ProviderManager } from '../src/llm/manager.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import type { SessionHubDeps } from '../src/server/hub.js';
import { WorktreeManager } from '../src/index.js';

/** Scripted mock provider（与 server.test.ts 同思路；delayMs 模拟慢响应制造运行中窗口） */
class MockProvider implements LLMProvider {
  readonly id = 'mock';
  constructor(
    private script: Array<{ text?: string }>,
    public delayMs = 0,
  ) {}
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const next = this.script.shift();
    if (!next) {
      yield { type: 'error', message: 'mock exhausted', retriable: false };
      return;
    }
    for (const chunk of (next.text ?? '').match(/.{1,4}/gs) ?? []) {
      yield { type: 'text_delta', text: chunk };
    }
    yield { type: 'usage', input: 10, output: 4 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

let tmpBase = ''; // 仓库父目录
let repoRoot = '';
let service: SessionService;
let projectId: string;
let sessionId: string;
let hub: SessionHub;
let server: ReturnType<typeof createWebServer>;
let provider: MockProvider;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-wt-hub-'));
  repoRoot = path.join(tmpBase, 'my-repo');
  fs.mkdirSync(repoRoot);
  const run = (cmd: string): void => execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
  run('git init -b main');
  run('git config user.email test@example.com');
  run('git config user.name tester');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# init\n');
  run('git add .');
  run('git commit -m init');
  run('git branch feature');

  service = new SessionService(path.join(tmpBase, 'db.sqlite'));
  projectId = service.ensureProject(repoRoot).id;
  sessionId = service.createSession(projectId, { title: 'f37' }).id;
  provider = new MockProvider([{ text: 'ok' }]);
  const deps: SessionHubDeps = {
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => provider,
  };
  hub = new SessionHub(deps);
  server = createWebServer({
    service,
    hub,
    port: 0,
    providers: new ProviderManager(path.join(tmpBase, 'models.json')),
  });
});

afterEach(async () => {
  service.close();
  await fs.promises.rm(tmpBase, { recursive: true, force: true });
});

/** 轮询等待条件成立（制造/等待「运行中」窗口用，避免固定 sleep） */
async function waitFor(cond: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── WorktreeManager 边界补充 ─────────────────────────────────────────────────

describe('WorktreeManager 边界（QA 补充）', () => {
  it('checkout 不存在的分支 → 结构化失败，git stderr 透传', async () => {
    const wm = new WorktreeManager(repoRoot);
    const r = await wm.checkout(repoRoot, { branch: 'no-such-branch' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no-such-branch');
    expect(await wm.currentBranch()).toBe('main'); // 未被切换
  });

  it('分支名带空格：git refname 规则原生拒绝 → 结构化失败，无 shell 注入副作用', async () => {
    // git 本身禁止 refname 含空格；正确行为 = 拒绝并以 stderr 为 reason（而非命令拼接出错）
    const wm = new WorktreeManager(repoRoot);
    const r = await wm.checkout(repoRoot, { newBranch: 'feat space; touch pwned' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not a valid branch name');
    expect(await wm.currentBranch()).toBe('main'); // 未被切换
    expect(fs.existsSync(path.join(repoRoot, 'pwned'))).toBe(false); // 无 shell 注入
  });

  it('分支名带合法特殊字符（unicode/单引号/点）：checkout -b 成功（shellQuote 转义）', async () => {
    const wm = new WorktreeManager(repoRoot);
    const r = await wm.checkout(repoRoot, { newBranch: "feat'引.用_v1" });
    expect(r.ok).toBe(true);
    expect(await wm.currentBranch()).toBe("feat'引.用_v1");
  });

  it('目标分支已被另一 worktree checkout → git 原生拒绝，reason 透传', async () => {
    const wm = new WorktreeManager(repoRoot);
    const w1 = await wm.addWorktree('sess-holder', { branch: 'feature' });
    expect(w1.ok).toBe(true);
    const w2 = await wm.addWorktree('sess-attacker'); // 从 HEAD 检出（delta-sess-att 分支）
    expect(w2.ok).toBe(true);
    const r = await wm.checkout(w2.path!, { branch: 'feature' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already (checked out|used)/);
    expect(await wm.currentBranch(w2.path!)).not.toBe('feature');
  });

  it('removeWorktree：目录不存在 → 结构化失败', async () => {
    const wm = new WorktreeManager(repoRoot);
    const r = await wm.removeWorktree(path.join(tmpBase, 'not-exist-wt'));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('目录不存在');
  });
});

// ── SessionHub 编排四方法 ────────────────────────────────────────────────────

describe('SessionHub F-37 编排（QA 补充）', () => {
  it('非 git 目录降级：worktreeState isRepo=false；checkout/setWorktree 结构化拒绝', async () => {
    const plain = path.join(tmpBase, 'plain-dir');
    fs.mkdirSync(plain);
    const pid = service.ensureProject(plain).id;
    const sid = service.createSession(pid).id;

    const st = await hub.worktreeState(sid);
    expect(st.isRepo).toBe(false);
    expect(st.branch).toBeNull();
    expect(st.worktree.enabled).toBe(false);
    expect(st.running).toBe(false);

    expect(await hub.checkoutBranch(sid, { branch: 'main' })).toMatchObject({
      ok: false,
      reason: 'not a git repository',
    });
    expect(await hub.setWorktree(sid, true)).toMatchObject({
      ok: false,
      reason: 'not a git repository',
    });
  });

  it('checkout 成功 → 注入系统提示落库（role=user）+ git_notice 推送', async () => {
    const notices: string[] = [];
    hub.subscribe(sessionId, (ev) => {
      if (ev.type === 'git_notice') notices.push(ev.message);
    });

    const r = await hub.checkoutBranch(sessionId, { branch: 'feature' });
    expect(r.ok).toBe(true);
    expect(r.branch).toBe('feature');

    // 注入消息落库：role='user' +「（系统提示：…）」惯例（D5/共享知识 4）
    const history = service.getHistory(sessionId);
    const last = history[history.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toContain('（系统提示：[环境] 工作根已切换：分支 feature @');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(last.content);
  });

  it('worktree 开：落库绑定 + worktreeOn 注入 + worktreeState enabled；开：解绑 + 目录保留', async () => {
    const on = await hub.setWorktree(sessionId, true, { branch: 'feature' });
    expect(on.ok).toBe(true);
    expect(on.path).toBe(
      path.join(fs.realpathSync(tmpBase), 'my-repo.worktrees', `delta-${sessionId.slice(0, 8)}`),
    );
    expect(on.branch).toBe('feature');

    const bound = service.getSession(sessionId)!;
    expect(bound.worktree_path).toBe(on.path);
    expect(bound.worktree_branch).toBe('feature');

    const st = await hub.worktreeState(sessionId);
    expect(st.worktree).toMatchObject({ enabled: true, path: on.path, branch: 'feature' });
    expect(st.branch).toBe('feature'); // 当前工作根 = worktree
    expect(fs.existsSync(on.path!)).toBe(true);
    const history = service.getHistory(sessionId);
    expect(history[history.length - 1]!.content).toContain('（系统提示：[环境] 工作根已切换：分支 feature @');

    const off = await hub.setWorktree(sessionId, false);
    expect(off.ok).toBe(true);
    const unbound = service.getSession(sessionId)!;
    expect(unbound.worktree_path).toBeNull();
    expect(unbound.worktree_branch).toBeNull();
    const st2 = await hub.worktreeState(sessionId);
    expect(st2.worktree.enabled).toBe(false);
    expect(st2.branch).toBe('main'); // 回到主工作区
    // 目录保留（PRD 裁决 #3），且注入切回提示
    expect(fs.existsSync(on.path!)).toBe(true);
    const history2 = service.getHistory(sessionId);
    expect(history2[history2.length - 1]!.content).toContain('已切回主工作区');
    expect(history2[history2.length - 1]!.content).toContain('worktree 目录已保留');
  });

  it('worktree 目录被手动删除 → worktreeState enabled=false 且分支回主工作区', async () => {
    const on = await hub.setWorktree(sessionId, true, { branch: 'feature' });
    expect(on.ok).toBe(true);
    fs.rmSync(on.path!, { recursive: true, force: true });

    const st = await hub.worktreeState(sessionId);
    expect(st.worktree.enabled).toBe(false);
    expect(st.branch).toBe('main'); // resolveWorkRoot 回退主工作根
  });

  it('运行中禁切（P0 安全规则）：checkoutBranch / setWorktree 一律拒绝', async () => {
    const p = hub.send(sessionId, 'slow run').catch(() => undefined);
    await waitFor(() => hub.isRunning(sessionId), 5000, 'enter running state');
    expect(await hub.checkoutBranch(sessionId, { branch: 'feature' })).toMatchObject({
      ok: false,
    });
    expect((await hub.checkoutBranch(sessionId, { branch: 'feature' })).reason).toContain('会话运行中');
    const wt = await hub.setWorktree(sessionId, true, { branch: 'feature' });
    expect(wt.ok).toBe(false);
    expect(wt.reason).toContain('会话运行中');
    // 运行全程绑定未变
    expect(service.getSession(sessionId)!.worktree_path).toBeNull();
    await p;
  });
});

// ── HTTP 4 端点语义（409 vs 200{ok:false} vs 404 vs 400）─────────────────────

describe('F-37 HTTP 端点语义（QA 补充）', () => {
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  };

  let base = '';
  beforeEach(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    // 仅关闭 HTTP 监听（DB / 临时目录由外层 afterEach 统一回收）
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('GET /git：200 SessionGitState；未知会话 404', async () => {
    const r = await api('GET', `/api/sessions/${sessionId}/git`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      isRepo: true,
      projectName: 'my-repo',
      running: false,
      worktree: { enabled: false },
    });
    expect((r.json as { branch: string }).branch).toBe('main');

    expect((await api('GET', '/api/sessions/no-such/git')).status).toBe(404);
  });

  it('GET /branches：repo 会话 200 列表；非 repo 会话 400（失败原因）', async () => {
    const r = await api('GET', `/api/sessions/${sessionId}/branches`);
    expect(r.status).toBe(200);
    const names = (r.json as { branches: Array<{ name: string }> }).branches.map((b) => b.name);
    expect(names).toEqual(expect.arrayContaining(['main', 'feature']));

    const plain = path.join(tmpBase, 'plain-dir');
    fs.mkdirSync(plain);
    const pid = service.ensureProject(plain).id;
    const sid = service.createSession(pid).id;
    const bad = await api('GET', `/api/sessions/${sid}/branches`);
    expect(bad.status).toBe(400);
    expect(bad.json.reason ?? bad.json.error).toBeTruthy();
  });

  it('POST /checkout：git 失败 → 200 {ok:false}（结构化失败，非 4xx）；缺参数 400', async () => {
    const r = await api('POST', `/api/sessions/${sessionId}/checkout`, { branch: 'no-such-branch' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: false });
    expect(String(r.json.reason)).toContain('no-such-branch');

    expect((await api('POST', `/api/sessions/${sessionId}/checkout`, {})).status).toBe(400);
  });

  it('POST /worktree enabled=true：200 {ok:true,path}；目录约定生效', async () => {
    const r = await api('POST', `/api/sessions/${sessionId}/worktree`, { enabled: true, branch: 'feature' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, branch: 'feature' });
    expect(r.json.path).toBe(
      path.join(fs.realpathSync(tmpBase), 'my-repo.worktrees', `delta-${sessionId.slice(0, 8)}`),
    );
  });

  it('运行中：POST /checkout 与 POST /worktree → 409（状态拒绝，区别于 git 失败 200）', async () => {
    provider.delayMs = 400;
    const kicked = await api('POST', `/api/sessions/${sessionId}/messages`, { input: '慢任务' });
    expect(kicked.status).toBe(202);
    await waitFor(() => hub.isRunning(sessionId), 5000, 'enter running state');

    const co = await api('POST', `/api/sessions/${sessionId}/checkout`, { branch: 'feature' });
    expect(co.status).toBe(409);

    const wt = await api('POST', `/api/sessions/${sessionId}/worktree`, { enabled: true });
    expect(wt.status).toBe(409);

    await waitFor(() => !hub.isRunning(sessionId), 5000, 'run finished');
  });
});
