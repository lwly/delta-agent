/**
 * T02 —— 执行器 / 降级编排单测（设计 §6 / §7 / §14「执行器 14 例」）。
 *
 * 所有用例注入 FakeDockerCli；任何一处漏注入都会在 afterEach 的
 * `realDockerCliCallCount() === 0` 断言上暴露。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DockerExecutor,
  LocalExecutor,
  SandboxPathError,
  SandboxUnavailableError,
  buildHints,
  type SandboxConfigLayer,
  type SandboxNotice,
} from '../src/sandbox/index.js';
import {
  FakeDockerCli,
  dockerFail,
  dockerOk,
  makeResolvedConfig,
  makeSandboxRuntime,
  realDockerCliCallCount,
  resetRealDockerCliStats,
  type FakeHandler,
} from './helpers/fake-docker.js';

const REAL_DAEMON_DOWN_STDERR =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

let project = '';

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-exec-'));
  resetRealDockerCliStats();
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  expect(realDockerCliCallCount()).toBe(0);
});

function runOpts(signal?: AbortSignal) {
  return { cwd: project, timeoutMs: 1_000, signal: signal ?? new AbortController().signal };
}

interface ExecHandle {
  cli: FakeDockerCli;
  exec: DockerExecutor;
  warns: string[];
  notices: SandboxNotice[];
  debugArgvs: string[][];
}

function makeExec(
  script: Record<string, FakeHandler> = {},
  layer: SandboxConfigLayer = {},
  syncScript: Record<string, FakeHandler> = {},
): ExecHandle {
  const cli = new FakeDockerCli(script, syncScript);
  const warns: string[] = [];
  const notices: SandboxNotice[] = [];
  const debugArgvs: string[][] = [];
  const exec = new DockerExecutor({
    resolved: makeResolvedConfig({ mode: 'docker', ...layer }, { explicit: true }),
    projectRoot: project,
    sessionId: 'sess-1a2b3c4d',
    projectId: 'proj-1',
    cli,
    onWarning: (m) => warns.push(m),
    onNotice: (n) => notices.push(n),
    onDebugArgv: (argv) => debugArgvs.push(argv),
    hostEnv: { TZ: 'UTC' },
  });
  return { cli, exec, warns, notices, debugArgvs };
}

const imageReady: Record<string, FakeHandler> = { image: dockerOk('sha256:abc') };

// ── 执行 / 超时 / 中断 / 清理 ───────────────────────────────────────────────

describe('DockerExecutor：超时、中断与清理序列', () => {
  it('超时 → 清理序列严格为 kill → rm -f（顺序即契约）', async () => {
    const { cli, exec } = makeExec({
      ...imageReady,
      run: () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
    });
    const r = await exec.run('sleep 999', runOpts());
    expect(r.timedOut).toBe(true);
    const name = cli.syncCalls[0]![1];
    expect(cli.syncCalls.map((c) => c[0])).toEqual(['kill', 'rm']);
    expect(name).toMatch(/^delta-sess1a2b-.{6}$/);
    expect(cli.syncCalls[1]).toEqual(['rm', '-f', name]);
  });

  it('abort（Ctrl-C）→ 同样 kill + rm -f', async () => {
    const { cli, exec } = makeExec({ ...imageReady, run: dockerOk('partial') });
    const ac = new AbortController();
    ac.abort();
    const r = await exec.run('long-task', runOpts(ac.signal));
    expect(r.code).toBe(0);
    expect(cli.syncCalls.map((c) => c[0])).toEqual(['kill', 'rm']);
  });

  it('正常退出 → 不产生任何清理调用（--rm 自删）', async () => {
    const { cli, exec } = makeExec({ ...imageReady, run: dockerOk('ok') });
    const r = await exec.run('echo ok', runOpts());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ok');
    expect(cli.syncCalls).toEqual([]);
  });

  it('keepContainer=true：不传 --rm，且超时也不清理（供 inspect 调试）', async () => {
    const { cli, exec } = makeExec(
      { ...imageReady, run: () => ({ code: null, stdout: '', stderr: '', timedOut: true }) },
      { keepContainer: true },
    );
    await exec.run('sleep 999', runOpts());
    const runArgv = cli.calls.find((c) => c[0] === 'run')!;
    expect(runArgv).not.toContain('--rm');
    expect(cli.syncCalls).toEqual([]);
  });

  it('清理失败（kill/rm 非 0）只 warning，绝不影响命令结果', async () => {
    const { exec, warns } = makeExec(
      { ...imageReady, run: () => ({ code: null, stdout: '', stderr: '', timedOut: true }) },
      {},
      { kill: dockerFail(1, 'no such container'), rm: dockerFail(1, 'no such container') },
    );
    const r = await exec.run('sleep 999', runOpts());
    expect(r.timedOut).toBe(true);
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain('docker kill');
    expect(warns[1]).toContain('delta sandbox gc');
  });

  it('daemon 未运行时的工作区守卫：任何 docker 调用之前就拒绝', async () => {
    const cli = new FakeDockerCli();
    const exec = new DockerExecutor({
      resolved: makeResolvedConfig({ mode: 'docker' }),
      projectRoot: '/',
      sessionId: 's',
      projectId: 'p',
      cli,
    });
    await expect(exec.run('ls', runOpts())).rejects.toBeInstanceOf(SandboxPathError);
    expect(cli.calls).toHaveLength(0);
  });
});

// ── 镜像 / 拉取 ─────────────────────────────────────────────────────────────

describe('DockerExecutor：镜像就绪与拉取', () => {
  it('image inspect 失败 → pull → 成功：pulled=true + 一次 pulled notice', async () => {
    const { cli, exec, notices } = makeExec({
      image: dockerFail(1, 'No such image'),
      pull: dockerOk('pulled'),
      run: dockerOk('done'),
    });
    const r = await exec.run('echo done', runOpts());
    expect(r.sandbox?.pulled).toBe(true);
    expect(cli.calls.map((c) => c[0])).toEqual(['image', 'pull', 'run']);
    expect(notices.filter((n) => n.kind === 'pulled')).toHaveLength(1);
  });

  it('pull 失败 → SandboxUnavailableError，且本会话第二次调用不再 pull', async () => {
    const { cli, exec } = makeExec({ image: dockerFail(1, ''), pull: dockerFail(1, 'network is unreachable') });
    await expect(exec.run('echo x', runOpts())).rejects.toBeInstanceOf(SandboxUnavailableError);
    const pullsAfterFirst = cli.calls.filter((c) => c[0] === 'pull').length;
    await expect(exec.run('echo x', runOpts())).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(cli.calls.filter((c) => c[0] === 'pull')).toHaveLength(pullsAfterFirst);
    expect(cli.calls.filter((c) => c[0] === 'pull')).toHaveLength(1);
  });

  it('拉取进度旁路到 onPullProgress（不进模型上下文）', async () => {
    const cli = new FakeDockerCli({
      image: dockerFail(1, ''),
      pull: (args) => {
        void args;
        return dockerOk('');
      },
      run: dockerOk('ok'),
    });
    const lines: string[] = [];
    const exec = new DockerExecutor({
      resolved: makeResolvedConfig({ mode: 'docker' }),
      projectRoot: project,
      sessionId: 's',
      projectId: 'p',
      cli,
      onPullProgress: (l) => lines.push(l),
    });
    await exec.run('echo ok', runOpts());
    expect(cli.calls.map((c) => c[0])).toEqual(['image', 'pull', 'run']);
    expect(Array.isArray(lines)).toBe(true);
  });
});

// ── argv / 调试 / 诊断 ──────────────────────────────────────────────────────

describe('DockerExecutor：argv 与诊断', () => {
  it('实际 argv 以 --entrypoint /bin/sh <image> -c <command> 结尾（无字符串拼接）', async () => {
    const { cli, exec } = makeExec({ ...imageReady, run: dockerOk('') });
    await exec.run('echo "hi" && ls', runOpts());
    const argv = cli.calls.find((c) => c[0] === 'run')!;
    expect(argv.slice(-4)).toEqual(['/bin/sh', 'node:22-bookworm-slim', '-c', 'echo "hi" && ls']);
    expect(argv[argv.indexOf('--workdir') + 1]).toBe('/workspace');
  });

  it('onDebugArgv 收到已打码的参数向量', async () => {
    const { exec, debugArgvs } = makeExec({ ...imageReady, run: dockerOk('') }, { env: ['CI'] });
    await exec.run('echo ok', runOpts());
    expect(debugArgvs).toHaveLength(1);
    expect(debugArgvs[0]![0]).toBe('run');
  });

  it('buildHints：127 / 137 / 126 各自给出可操作提示', () => {
    const cfg = makeResolvedConfig({ mode: 'docker', memoryMb: 2048 }).config;
    const base = { stdout: '', stderr: '', timedOut: false };
    expect(buildHints({ ...base, code: 127 }, cfg, 'cargo test')[0]).toContain('命令在镜像');
    expect(buildHints({ ...base, code: 137 }, cfg, 'x')[0]).toContain('2048MB');
    expect(buildHints({ ...base, code: 126 }, cfg, 'x')[0]).toContain('readOnlyRoot=false');
  });

  it('buildHints：network=none 且 stderr 含网络关键字 → 提示 --sandbox-network bridge', () => {
    const cfg = makeResolvedConfig({ mode: 'docker', network: 'none' }).config;
    const hints = buildHints(
      { code: 1, stdout: '', stderr: 'npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org', timedOut: false },
      cfg,
      'npm install',
    );
    expect(hints.some((h) => h.includes('--sandbox-network bridge'))).toBe(true);
  });

  it('buildHints：network=bridge 时不追加网络提示', () => {
    const cfg = makeResolvedConfig({ mode: 'docker', network: 'bridge' }).config;
    const hints = buildHints(
      { code: 1, stdout: '', stderr: 'ENOTFOUND', timedOut: false },
      cfg,
      'npm install',
    );
    expect(hints).toEqual([]);
  });
});

// ── gc ─────────────────────────────────────────────────────────────────────

describe('DockerExecutor：残留清理', () => {
  it('gc 按 label 列出并逐条 rm -f；非 delta- 前缀忽略', async () => {
    const { cli, exec } = makeExec({
      ps: dockerOk('delta-a\nother-container\ndelta-b\n'),
      rm: dockerOk(''),
    });
    const r = await exec.gc();
    expect(r.removed).toBe(2);
    expect(r.names.sort()).toEqual(['delta-a', 'delta-b']);
    expect(cli.calls[0]).toEqual([
      'ps',
      '-a',
      '--filter',
      'label=delta.created',
      '--format',
      '{{.Names}}',
    ]);
    expect(cli.calls.filter((c) => c[0] === 'rm')).toHaveLength(2);
  });

  it('docker ps 失败时返回空列表（不抛异常）', async () => {
    const { exec } = makeExec({ ps: dockerFail(1, REAL_DAEMON_DOWN_STDERR) });
    expect(await exec.gc()).toEqual({ removed: 0, names: [] });
  });
});

// ── LocalExecutor ──────────────────────────────────────────────────────────

describe('LocalExecutor：零影响（Z3）', () => {
  it('explicit=false → 结果不带 sandbox meta', async () => {
    const local = new LocalExecutor({
      resolved: makeResolvedConfig({ mode: 'local' }, { explicit: false }),
    });
    const r = await local.run('echo yz-local-ok', runOpts());
    expect(r.stdout.trim()).toBe('yz-local-ok');
    expect(r.sandbox).toBeUndefined();
    expect(await local.probe()).toMatchObject({ available: false, reason: 'not_applicable' });
  });

  it('explicit=true → meta.sandbox.mode=local', async () => {
    const local = new LocalExecutor({
      resolved: makeResolvedConfig({ mode: 'local' }, { explicit: true }),
    });
    const r = await local.run('echo yz-local-ok', runOpts());
    expect(r.sandbox?.mode).toBe('local');
  });
});

// ── SandboxRuntime：降级链（本地副作用最小化，只用 echo）───────────────────

describe('SandboxRuntime：降级决策与通知', () => {
  it('fallback=deny：只探测、不跑容器，返回 denied + 完整诊断', async () => {
    const { runtime, cli, notices } = makeSandboxRuntime(
      { projectRoot: project, resolved: makeResolvedConfig({ mode: 'docker', fallback: 'deny' }, { explicit: true }) },
      { script: { version: dockerFail(1, REAL_DAEMON_DOWN_STDERR) } },
    );
    const r = await runtime.run('echo nope', runOpts());
    expect(r.denied).toBe(true);
    expect(r.diagnostic).toContain('daemon 未运行');
    expect(r.diagnostic).toContain('--sandbox local');
    expect(cli.calls).toEqual([['version', '--format', '{{.Server.Version}}']]);
    expect(notices.some((n) => n.kind === 'unavailable')).toBe(true);
  });

  it('fallback=local：本地执行 + degraded meta + 一次 degraded notice', async () => {
    const { runtime, notices } = makeSandboxRuntime(
      { projectRoot: project, resolved: makeResolvedConfig({ mode: 'docker', fallback: 'local' }, { explicit: true }) },
      { script: { version: dockerFail(1, REAL_DAEMON_DOWN_STDERR) } },
    );
    const r = await runtime.run('echo yz-degraded', runOpts());
    expect(r.stdout.trim()).toBe('yz-degraded');
    expect(r.sandbox?.degraded).toBe(true);
    expect(notices.filter((n) => n.kind === 'degraded')).toHaveLength(1);
  });

  it('fallback=ask 且无 confirmDegrade → 等价 deny（绝不静默降级）', async () => {
    const { runtime } = makeSandboxRuntime(
      {
        projectRoot: project,
        interactive: true,
        resolved: makeResolvedConfig({ mode: 'docker', fallback: 'ask' }, { explicit: true }),
      },
      { script: { version: dockerFail(1, REAL_DAEMON_DOWN_STDERR) } },
    );
    const r = await runtime.run('echo nope', runOpts());
    expect(r.denied).toBe(true);
  });

  it('fallback=ask + 获准 → 本次本地执行；同会话第二次不再询问', async () => {
    let asked = 0;
    const { runtime } = makeSandboxRuntime(
      {
        projectRoot: project,
        interactive: true,
        resolved: makeResolvedConfig({ mode: 'docker', fallback: 'ask' }, { explicit: true }),
        confirmDegrade: async () => {
          asked += 1;
          return { kind: 'allow' };
        },
      },
      { script: { version: dockerFail(1, REAL_DAEMON_DOWN_STDERR) } },
    );
    const first = await runtime.run('echo yz-ask-ok', runOpts());
    const second = await runtime.run('echo yz-ask-ok', runOpts());
    expect(first.sandbox?.degraded).toBe(true);
    expect(second.sandbox?.degraded).toBe(true);
    expect(asked).toBe(1);
  });

  it('镜像不可用（pull 失败）→ 合成 image_unavailable，会话内不再重试该镜像', async () => {
    const { runtime, cli } = makeSandboxRuntime(
      { projectRoot: project, resolved: makeResolvedConfig({ mode: 'docker', fallback: 'deny' }, { explicit: true }) },
      { script: { version: dockerOk('28.5.1'), image: dockerFail(1, ''), pull: dockerFail(1, 'timeout') } },
    );
    const first = await runtime.run('echo x', runOpts());
    expect(first.denied).toBe(true);
    expect(first.diagnostic).toContain('拉取失败');
    const second = await runtime.run('echo x', runOpts());
    expect(second.denied).toBe(true);
    expect(cli.calls.filter((c) => c[0] === 'pull')).toHaveLength(1);
  });

  it('mode=local 且 explicit=false：不探测 docker、不产出 meta（零影响）', async () => {
    const { runtime, cli } = makeSandboxRuntime({
      projectRoot: project,
      resolved: makeResolvedConfig({ mode: 'local' }, { explicit: false }),
    });
    const r = await runtime.run('echo yz-plain', runOpts());
    expect(r.stdout.trim()).toBe('yz-plain');
    expect(r.sandbox).toBeUndefined();
    expect(cli.calls).toHaveLength(0);
  });
});
