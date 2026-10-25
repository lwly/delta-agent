/**
 * §19 方案 C —— Seatbelt 沙箱（macOS sandbox-exec）单测。
 *
 * 覆盖面：
 *  - buildSeatbeltProfile 纯函数（deny default / 写范围 realpath / network 规则 / 注入防护）
 *  - seatbeltArgv 形状
 *  - classifySeatbeltProbe 三分支（非 macOS / 缺二进制 / 可用）
 *  - 决策表 seatbelt 行（可用 / enforce 不可用 / fallback 三档）
 *  - Runtime 路由（mode=seatbelt → fake cli 收到 sandbox-exec argv；路径逃逸零调用）
 *  - config：mode=seatbelt 合法性 + enforce 偏序（local < seatbelt < docker）
 *
 * 真实 sandbox-exec 行为本机已人工核验（macOS 13）：项目内写/项目外拒/断网生效。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSeatbeltProfile,
  classifySeatbeltProbe,
  createSandboxRuntime,
  checkEnforce,
  mergeSandboxLayers,
  normalizeSandboxLayer,
  realpathOr,
  resolveExecutionPlan,
  seatbeltArgv,
  SeatbeltExecutor,
  SeatbeltProbe,
  type SandboxConfigWarning,
  type SandboxProbeResult,
} from '../src/sandbox/index.js';
import {
  FakeDockerCli,
  makeResolvedConfig,
  realDockerCliCallCount,
  type SandboxRuntimeDeps,
} from './helpers/fake-docker.js';

/**
 * 项目根必须是**真实存在**的目录：realpathOr 对不存在的路径退化为 path.resolve
 * （不会补 /private 前缀），而 Seatbelt 与 relativeCwdOf 都按真实路径判定。
 */
function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'delta-sbx-project-'));
}
const PROBE_OK: SandboxProbeResult = {
  available: true,
  detail: 'sandbox-exec 可用（macOS 自带）',
  probedAt: 0,
  fromCache: false,
};
const PROBE_MISSING: SandboxProbeResult = {
  available: false,
  reason: 'cli_missing',
  detail: '未找到 /usr/bin/sandbox-exec',
  probedAt: 0,
  fromCache: false,
};

describe('buildSeatbeltProfile（纯函数）', () => {
  const PROJECT = mkdtempSync(join(tmpdir(), 'delta-sbx-prof-'));
  const REAL = realpathOr(PROJECT);

  it('deny default 打头 + 读全放行 + 进程/系统调用白名单', () => {
    const p = buildSeatbeltProfile({ projectRoot: PROJECT, network: 'none' });
    expect(p).toContain('(version 1)');
    expect(p).toContain('(deny default)');
    expect(p).toContain('(allow file-read*)');
    expect(p).toContain('(allow process-exec*)');
    expect(p).toContain('(allow process-fork)');
  });

  it('写范围：项目工作区与临时目录必须是 realpath（/tmp、/var 软链修正）', () => {
    const p = buildSeatbeltProfile({ projectRoot: PROJECT, network: 'none' });
    expect(p).toContain(`(subpath "${REAL}")`);
    expect(p).toContain('(subpath "/private/');
    expect(p).not.toContain('(subpath "/tmp/');
    expect(p).not.toContain('(subpath "/var/');
  });

  it('network=none → deny network*；bridge → allow network*', () => {
    expect(buildSeatbeltProfile({ projectRoot: PROJECT, network: 'none' })).toContain('(deny network*)');
    expect(buildSeatbeltProfile({ projectRoot: PROJECT, network: 'bridge' })).toContain('(allow network*)');
  });

  it('路径含引号/换行 → 直接抛错（SBPL 注入防护）', () => {
    expect(() =>
      buildSeatbeltProfile({ projectRoot: '/tmp/bad"quote', network: 'none' }),
    ).toThrow(/sandbox 配置不允许/);
    expect(() =>
      buildSeatbeltProfile({ projectRoot: '/tmp/bad\nnewline', network: 'none' }),
    ).toThrow(/sandbox 配置不允许/);
  });
});

describe('seatbeltArgv / classifySeatbeltProbe', () => {
  it('argv：-f profile + /bin/sh -c command', () => {
    expect(seatbeltArgv({ profilePath: '/p.sb', command: 'echo hi' })).toEqual([
      '-f',
      '/p.sb',
      '/bin/sh',
      '-c',
      'echo hi',
    ]);
  });

  it('非 macOS → cli_missing 且指向 docker 后端', () => {
    const r = classifySeatbeltProbe({ platform: 'linux', executableExists: true });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('cli_missing');
    expect(r.detail).toContain('docker');
  });

  it('macOS 但缺二进制 → cli_missing', () => {
    const r = classifySeatbeltProbe({ platform: 'darwin', executableExists: false });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('cli_missing');
  });

  it('macOS + 二进制存在 → 可用', () => {
    const r = classifySeatbeltProbe({ platform: 'darwin', executableExists: true });
    expect(r.available).toBe(true);
  });
});

describe('决策表：seatbelt 行', () => {
  const cfg = makeResolvedConfig({ mode: 'seatbelt' }).config;

  it('seatbelt 可用 → {seatbelt, seatbelt_ready}', () => {
    expect(resolveExecutionPlan({ config: cfg, probe: PROBE_OK, interactive: true, degradeApproved: false })).toEqual({
      action: 'seatbelt',
      reason: 'seatbelt_ready',
    });
  });

  it('seatbelt 不可用 + enforce → {deny, enforced_deny}', () => {
    const enforced = makeResolvedConfig({ mode: 'seatbelt', enforce: true, fallback: 'deny' }).config;
    expect(
      resolveExecutionPlan({ config: enforced, probe: PROBE_MISSING, interactive: true, degradeApproved: false }),
    ).toEqual({ action: 'deny', reason: 'enforced_deny' });
  });

  it('seatbelt 不可用 + fallback=local → 降级本地（文案生成不抛错）', () => {
    const fb = makeResolvedConfig({ mode: 'seatbelt', fallback: 'local' }).config;
    expect(
      resolveExecutionPlan({ config: fb, probe: PROBE_MISSING, interactive: false, degradeApproved: false }),
    ).toEqual({ action: 'local', reason: 'fallback_local' });
  });

  it('seatbelt 不可用 + fallback=deny + 非交互 → 拒绝', () => {
    const fb = makeResolvedConfig({ mode: 'seatbelt', fallback: 'deny' }).config;
    expect(
      resolveExecutionPlan({ config: fb, probe: PROBE_MISSING, interactive: false, degradeApproved: false }),
    ).toEqual({ action: 'deny', reason: 'fallback_deny' });
  });
});

describe('Runtime 路由（mode=seatbelt）', () => {
  function makeSeatbeltRuntime(
    script: Record<string, unknown>,
    deps: Partial<SandboxRuntimeDeps> = {},
  ) {
    const cli = new FakeDockerCli(script);
    const notices: string[] = [];
    const projectRoot = deps.projectRoot ?? mkdtempSync(join(tmpdir(), 'delta-sbx-rt-'));
    const runtime = createSandboxRuntime({
      projectRoot,
      sessionId: 's-1',
      projectId: 'p-1',
      interactive: false,
      resolved: makeResolvedConfig({ mode: 'seatbelt' }),
      seatbeltCli: cli,
      onNotice: (n) => notices.push(n.kind),
      ...deps,
    });
    return { cli, notices, runtime, projectRoot };
  }

  it('探测可用 → 经 sandbox-exec 执行，meta.mode=seatbelt 且带 profile 路径', async () => {
    const { cli, runtime, projectRoot } = makeSeatbeltRuntime({});
    const r = await runtime.run('echo hi', {
      cwd: projectRoot,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0]).toEqual(['-f', expect.any(String), '/bin/sh', '-c', 'echo hi']);
    expect(r.sandbox?.mode).toBe('seatbelt');
    expect(r.sandbox?.profile).toMatch(/profile\.sb$/);
    expect(r.sandbox?.network).toBe('none');
    expect(realDockerCliCallCount()).toBe(0);
  });

  it('cwd 逃逸（项目外绝对路径）→ 拒绝且零子进程调用（AC-30-4）', async () => {
    const { cli, runtime } = makeSeatbeltRuntime({});
    const r = await runtime.run('echo hi', {
      cwd: '/tmp/outside-delta-sbx-project',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(r.denied).toBe(true);
    expect(r.diagnostic).toContain('sandbox 配置不允许');
    expect(cli.calls).toHaveLength(0);
  });

  it('Seatbelt 不可用（非 macOS 注入）+ fallback=deny → 拒绝且文案指向 docker 后端', async () => {
    const cli = new FakeDockerCli({});
    let t = 1_000;
    const projectRoot = mkdtempSync(join(tmpdir(), 'delta-sbx-rt-'));
    const runtime = createSandboxRuntime({
      projectRoot,
      sessionId: 's-1',
      projectId: 'p-1',
      interactive: false,
      resolved: makeResolvedConfig({ mode: 'seatbelt', fallback: 'deny' }),
      seatbeltCli: cli,
      now: () => t++,
    });
    // 注入「非 macOS」探测结论：整体替换 executor 内的探测缓存（平台参数在构造期固定）
    const seatbelt = (runtime as unknown as { seatbelt: SeatbeltExecutor })['seatbelt'];
    (seatbelt as unknown as { probeCache: SeatbeltProbe }).probeCache = new SeatbeltProbe({
      platform: 'linux',
      now: () => t++,
    });
    const r = await runtime.run('echo hi', {
      cwd: projectRoot,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(r.denied).toBe(true);
    expect(r.diagnostic).toContain('Seatbelt 沙箱 不可用');
    expect(r.diagnostic).toContain('{"mode":"docker"}');
    expect(cli.calls).toHaveLength(0);
  });

  it('profile 文件真实落盘且内容含 deny default（0600）', async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'delta-sbx-test-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'delta-sbx-rt-'));
    try {
      const cli = new FakeDockerCli({});
      const runtime = createSandboxRuntime({
        projectRoot,
        sessionId: 's-1',
        projectId: 'p-1',
        interactive: false,
        resolved: makeResolvedConfig({ mode: 'seatbelt' }),
        seatbeltCli: cli,
        profileRoot,
      });
      await runtime.run('echo hi', {
        cwd: projectRoot,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      });
      const used = cli.calls[0]![1]!; // -f 后的 profile 路径
      expect(used).toContain(profileRoot);
      const content = readFileSync(used, 'utf8');
      expect(content).toContain('(deny default)');
      expect(content).toContain('(deny network*)');
      expect(content).toContain(realpathOr(projectRoot));
    } finally {
      rmSync(profileRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('config：mode=seatbelt 与 enforce 偏序', () => {
  it('mode=seatbelt 合法且进 provenance', () => {
    const { config, provenance } = mergeSandboxLayers([{ source: 'project', layer: { mode: 'seatbelt' } }]);
    expect(config.mode).toBe('seatbelt');
    expect(provenance.mode).toBe('project');
  });

  it('mode 非法值告警文案包含 seatbelt', () => {
    const warnings: SandboxConfigWarning[] = [];
    normalizeSandboxLayer({ mode: 'nope' }, 'project', warnings, []);
    expect(warnings.some((w) => w.field === 'mode' && w.message.includes('seatbelt'))).toBe(true);
  });

  it('loadSandboxConfig 接受 {"mode":"seatbelt"}', () => {
    // 直接走 merge 层（文件加载在 sandbox-config.test.ts 已覆盖），此处验证枚举放行
    const merged = mergeSandboxLayers([{ source: 'project', layer: { mode: 'seatbelt' } }]);
    expect(merged.config.mode).toBe('seatbelt');
  });

  it('enforce 偏序：project=docker 时会话覆盖 seatbelt/local 都算削弱', () => {
    const violations = checkEnforce({ mode: 'docker', enforce: true }, { mode: 'seatbelt' });
    expect(violations.some((v) => v.field === 'mode')).toBe(true);
    const violations2 = checkEnforce({ mode: 'docker', enforce: true }, { mode: 'local' });
    expect(violations2.some((v) => v.field === 'mode')).toBe(true);
  });

  it('enforce 偏序：project=seatbelt 时会话可升到 docker，不可降 local', () => {
    expect(checkEnforce({ mode: 'seatbelt', enforce: true }, { mode: 'docker' })).toHaveLength(0);
    expect(checkEnforce({ mode: 'seatbelt', enforce: true }, { mode: 'local' }).length).toBeGreaterThan(0);
  });
});
