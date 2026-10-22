/**
 * T02 —— 降级链纯函数单测（设计 §7.2 决策表 9 行 + §7.4 文案要素 / §14「plan 14 例」）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildUnavailableMessage,
  resolveExecutionPlan,
  type SandboxConfigLayer,
  type SandboxProbeResult,
} from '../src/sandbox/index.js';
import { makeResolvedConfig } from './helpers/fake-docker.js';

const DAEMON_DOWN_DETAIL = 'daemon 未运行（docker version 退出码 1）';

function config(layer: SandboxConfigLayer) {
  return makeResolvedConfig({ mode: 'docker', ...layer }).config;
}

function probe(available: boolean, detail = DAEMON_DOWN_DETAIL): SandboxProbeResult {
  return available
    ? { available: true, serverVersion: '28.5.1', detail: 'Server 版本 28.5.1', probedAt: 0, fromCache: false }
    : { available: false, reason: 'daemon_down', detail, probedAt: 0, fromCache: false };
}

describe('resolveExecutionPlan：§7.2 决策表逐格', () => {
  const rows: Array<{
    name: string;
    layer: SandboxConfigLayer;
    probeValue: SandboxProbeResult | null;
    interactive: boolean;
    approved: boolean;
    action: string;
    reason: string;
  }> = [
    {
      name: '#1 mode=local → 本地执行，不探测',
      layer: { mode: 'local' },
      probeValue: null,
      interactive: false,
      approved: false,
      action: 'local',
      reason: 'mode_local',
    },
    {
      name: '#2 docker 可用 → 容器执行',
      layer: { mode: 'docker' },
      probeValue: probe(true),
      interactive: false,
      approved: false,
      action: 'docker',
      reason: 'docker_ready',
    },
    {
      name: '#3 docker 不可用 + fallback=deny → 拒绝',
      layer: { mode: 'docker', fallback: 'deny' },
      probeValue: probe(false),
      interactive: true,
      approved: false,
      action: 'deny',
      reason: 'fallback_deny',
    },
    {
      name: '#4 docker 不可用 + ask + 交互式 → 询问',
      layer: { mode: 'docker', fallback: 'ask' },
      probeValue: probe(false),
      interactive: true,
      approved: false,
      action: 'ask',
      reason: 'fallback_ask',
    },
    {
      name: '#5 docker 不可用 + ask + headless → 等价 deny',
      layer: { mode: 'docker', fallback: 'ask' },
      probeValue: probe(false),
      interactive: false,
      approved: false,
      action: 'deny',
      reason: 'fallback_ask_headless',
    },
    {
      name: '#6 docker 不可用 + fallback=local → 本地执行',
      layer: { mode: 'docker', fallback: 'local' },
      probeValue: probe(false),
      interactive: false,
      approved: false,
      action: 'local',
      reason: 'fallback_local',
    },
    {
      name: '#7 镜像不可用（probe 由 runtime 合成）→ 同不可用分支',
      layer: { mode: 'docker', fallback: 'deny' },
      probeValue: { available: false, reason: 'image_unavailable', detail: '拉取失败', probedAt: 0, fromCache: false },
      interactive: false,
      approved: false,
      action: 'deny',
      reason: 'fallback_deny',
    },
    {
      name: '#8 docker + enforce 不可用 → 只允许 deny',
      layer: { mode: 'docker', enforce: true, fallback: 'deny' },
      probeValue: probe(false),
      interactive: true,
      approved: true,
      action: 'deny',
      reason: 'enforced_deny',
    },
    {
      name: '#9 docker 不可用 + ask + 已获准 → 本地执行',
      layer: { mode: 'docker', fallback: 'ask' },
      probeValue: probe(false),
      interactive: true,
      approved: true,
      action: 'local',
      reason: 'degrade_approved',
    },
  ];

  it.each(rows)('$name', ({ layer, probeValue, interactive, approved, action, reason }) => {
    expect(
      resolveExecutionPlan({
        config: config(layer),
        probe: probeValue,
        interactive,
        degradeApproved: approved,
      }),
    ).toEqual({ action, reason });
  });

  it('probe=null + mode=docker：保守按不可用处理（绝不静默降级）', () => {
    expect(
      resolveExecutionPlan({
        config: config({ mode: 'docker', fallback: 'deny' }),
        probe: null,
        interactive: false,
        degradeApproved: false,
      }),
    ).toEqual({ action: 'deny', reason: 'fallback_deny' });
  });
});

describe('buildUnavailableMessage：判定依据 + 后果 + ≥2 动作', () => {
  const base = {
    reason: 'daemon_down' as const,
    detail: DAEMON_DOWN_DETAIL,
    fallback: 'deny' as const,
    image: 'node:22-bookworm-slim',
    enforced: false,
    interactive: true,
  };

  it('三段俱在：判定依据 / 后果 / 三个可执行动作', () => {
    const msg = buildUnavailableMessage(base);
    expect(msg).toContain('[sandbox] Docker 不可用：daemon 未运行（docker version 退出码 1）');
    expect(msg).toContain('命令未执行');
    expect(msg).toContain('fallback=deny');
    expect(msg).toContain('1)');
    expect(msg).toContain('2)');
    expect(msg).toContain('3)');
    expect(msg).toContain('yzero sandbox status');
    expect(msg).toContain('--sandbox local');
  });

  it('enforce=true：不给「设置 fallback:ask」这类必然被拒的假动作', () => {
    const msg = buildUnavailableMessage({ ...base, enforced: true });
    expect(msg).toContain('联系项目维护者调整 .y-zero/sandbox.json');
    expect(msg).not.toContain('{"fallback":"ask"}');
  });

  it('headless 下 fallback=ask 的后果文案说明「等价 deny」', () => {
    const msg = buildUnavailableMessage({ ...base, fallback: 'ask', interactive: false });
    expect(msg).toContain('headless');
    expect(msg).toContain('fallback=ask');
  });

  it('image_unavailable：首个动作指向 yzero sandbox pull，并带镜像名', () => {
    const msg = buildUnavailableMessage({
      ...base,
      reason: 'image_unavailable',
      detail: '镜像 node:22-bookworm-slim 拉取失败',
    });
    expect(msg).toContain('yzero sandbox pull');
    expect(msg).toContain('node:22-bookworm-slim');
  });

  it('permission_denied / cli_missing 各有可照做的首个动作', () => {
    const perm = buildUnavailableMessage({ ...base, reason: 'permission_denied', detail: 'socket 被拒' });
    expect(perm).toContain('docker 组');
    const missing = buildUnavailableMessage({ ...base, reason: 'cli_missing', detail: '未找到 docker 命令' });
    expect(missing).toContain('Docker Desktop');
  });

  it('timeout：首个动作是重启 Docker Desktop', () => {
    const msg = buildUnavailableMessage({ ...base, reason: 'timeout', detail: '3s 未返回' });
    expect(msg).toContain('重启 Docker Desktop');
  });
});
