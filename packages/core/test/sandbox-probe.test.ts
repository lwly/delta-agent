/**
 * T01 —— Docker 探测单测（设计 §4 / §14「探测 12 例」）。
 *
 * 全部用例注入 FakeDockerCli：本机 daemon 未运行也不影响任何断言。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DockerProbe,
  classifyProbeResult,
  probeArgv,
  probeDocker,
  PROBE_TTL_MS,
} from '../src/sandbox/index.js';
import {
  FakeDockerCli,
  dockerFail,
  dockerOk,
  realDockerCliCallCount,
  resetRealDockerCliStats,
} from './helpers/fake-docker.js';

const REAL_DAEMON_DOWN_STDERR =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

beforeEach(() => {
  resetRealDockerCliStats();
});

afterEach(() => {
  // 单测铁律：真实 CLI 从未被调用（本机 daemon 未运行，漏注入会立刻暴露）
  expect(realDockerCliCallCount()).toBe(0);
});

describe('probeDocker：四类原因判定', () => {
  it('可用：必须打 Server 端版本，argv 是固定契约', async () => {
    const cli = new FakeDockerCli({ version: dockerOk('28.5.1\n') });
    const r = await probeDocker(cli);
    expect(cli.calls[0]).toEqual(['version', '--format', '{{.Server.Version}}']);
    expect(probeArgv()).toEqual(['version', '--format', '{{.Server.Version}}']);
    expect(r.available).toBe(true);
    expect(r.serverVersion).toBe('28.5.1');
    expect(r.fromCache).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it('daemon_down：本机真实输出样本（cli 有、daemon 未运行，AC-30-6 核心用例）', async () => {
    const cli = new FakeDockerCli({ version: dockerFail(1, REAL_DAEMON_DOWN_STDERR) });
    const r = await probeDocker(cli);
    expect(r.available).toBe(false);
    expect(r.reason).toBe('daemon_down');
    expect(r.detail).toBe('daemon 未运行（docker version 退出码 1）');
  });

  it('cli_missing：spawn ENOENT（code -1）', async () => {
    const cli = new FakeDockerCli({ version: dockerFail(-1, 'spawn docker ENOENT') });
    const r = await probeDocker(cli);
    expect(r.reason).toBe('cli_missing');
    expect(r.detail).toContain('未找到 docker 命令');
  });

  it('cli_missing：exit 127 + "not found"（优先级高于 daemon 判定）', async () => {
    const cli = new FakeDockerCli({ version: dockerFail(127, '/bin/sh: 1: docker: not found') });
    const r = await probeDocker(cli);
    expect(r.reason).toBe('cli_missing');
  });

  it('permission_denied：socket 权限被拒', async () => {
    const cli = new FakeDockerCli({
      version: dockerFail(
        1,
        'Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
      ),
    });
    const r = await probeDocker(cli);
    expect(r.reason).toBe('permission_denied');
    expect(r.detail).toContain('daemon socket 被拒');
  });

  it('timeout：3s 未返回（daemon 无响应）', async () => {
    const cli = new FakeDockerCli({
      version: () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
    });
    const r = await probeDocker(cli);
    expect(r.reason).toBe('timeout');
    expect(r.detail).toContain('未返回');
  });

  it('code 0 但 Server 版本为空 → daemon_down（只拿到 Client 信息）', async () => {
    const cli = new FakeDockerCli({ version: dockerOk('') });
    const r = await probeDocker(cli);
    expect(r.available).toBe(false);
    expect(r.reason).toBe('daemon_down');
    expect(r.detail).toContain('Server 版本为空');
  });

  it('未知非 0 兜底：detail 带退出码与 stderr 首行（截断 200 字）', async () => {
    const cli = new FakeDockerCli({ version: dockerFail(125, 'unknown failure\nsecond line') });
    const r = await probeDocker(cli);
    expect(r.reason).toBe('daemon_down');
    expect(r.detail).toContain('125');
    expect(r.detail).toContain('unknown failure');
    expect(r.detail).not.toContain('second line');
  });

  it('classifyProbeResult：timedOut 参数与 result.timedOut 等价', () => {
    const a = classifyProbeResult({ code: null, stdout: '', stderr: '', timedOut: true }, false);
    const b = classifyProbeResult({ code: null, stdout: '', stderr: '', timedOut: false }, true);
    expect(a.reason).toBe('timeout');
    expect(b.reason).toBe('timeout');
  });
});

describe('DockerProbe：TTL 缓存与单飞', () => {
  it('30s 内二次 get() 不再 exec，且标记 fromCache', async () => {
    const cli = new FakeDockerCli({ version: dockerOk('28.5.1') });
    const probe = new DockerProbe(cli);
    const first = await probe.get();
    const second = await probe.get();
    expect(cli.calls).toHaveLength(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.available).toBe(true);
  });

  it('TTL 过期后重新探测', async () => {
    let clock = 1_000;
    const cli = new FakeDockerCli({ version: dockerOk('28.5.1') });
    const probe = new DockerProbe(cli, { now: () => clock });
    await probe.get();
    clock += PROBE_TTL_MS - 1;
    await probe.get();
    expect(cli.calls).toHaveLength(1);
    clock += 2;
    await probe.get();
    expect(cli.calls).toHaveLength(2);
  });

  it('force 绕过缓存；invalidate 让下次重探', async () => {
    const cli = new FakeDockerCli({ version: dockerOk('28.5.1') });
    const probe = new DockerProbe(cli);
    await probe.get();
    await probe.get(true);
    expect(cli.calls).toHaveLength(2);
    probe.invalidate();
    expect(probe.peek()).toBeNull();
    await probe.get();
    expect(cli.calls).toHaveLength(3);
  });

  it('单飞：并发 get() 只打一次 docker', async () => {
    const cli = new FakeDockerCli({ version: dockerOk('28.5.1') });
    const probe = new DockerProbe(cli);
    const [a, b, c] = await Promise.all([probe.get(), probe.get(), probe.get()]);
    expect(cli.calls).toHaveLength(1);
    expect(a.available && b.available && c.available).toBe(true);
  });

  it('peek 只读缓存：未探测时为 null，探测后返回上次结论且不触发调用', async () => {
    const cli = new FakeDockerCli({ version: dockerFail(1, REAL_DAEMON_DOWN_STDERR) });
    const probe = new DockerProbe(cli);
    expect(probe.peek()).toBeNull();
    await probe.get();
    expect(probe.peek()?.reason).toBe('daemon_down');
    expect(probe.peek()?.reason).toBe('daemon_down');
    expect(cli.calls).toHaveLength(1);
  });
});
