/**
 * Docker 可用性探测（设计 §4）。
 *
 * 关键点：
 *  1. **必须打 Server 端**：`docker version --format {{.Server.Version}}`。
 *     本机 CLI 有、daemon 未运行时，只看 Client 版本会误判「可用」。
 *  2. 四类原因的判定顺序不可调换：先超时、再找不到 CLI，最后才判 daemon
 *     （`ENOENT` 也可能以 `exit 127` + "not found" 出现）。
 *  3. `DockerProbe` 提供 30s TTL 缓存 + 单飞（并发 get 共享同一个 inflight Promise）。
 */
import {
  PROBE_TIMEOUT_MS,
  PROBE_TTL_MS,
  type SandboxProbeResult,
} from './types.js';
import type { DockerCli, DockerResult } from './docker-cli.js';

const PROBE_ARGS = ['version', '--format', '{{.Server.Version}}'] as const;

/** 探测器使用的 argv（测试逐元素断言，防止有人改成只打 Client 版本）。 */
export function probeArgv(): string[] {
  return [...PROBE_ARGS];
}

/**
 * 结果分类（纯函数，便于表驱动单测）。
 * 表驱动顺序即设计 §4.1 的优先级，命中即返回。
 */
export function classifyProbeResult(
  r: DockerResult,
  timedOutFromCli: boolean,
): Omit<SandboxProbeResult, 'probedAt' | 'fromCache'> {
  const stderr = r.stderr ?? '';
  const stdout = r.stdout ?? '';

  // 1) 超时（daemon 无响应）
  if (timedOutFromCli || r.timedOut) {
    return {
      available: false,
      reason: 'timeout',
      detail: `docker version ${PROBE_TIMEOUT_MS / 1000}s 未返回（daemon 疑似无响应）`,
    };
  }

  // 2) 找不到 docker 命令（spawn ENOENT / exit 127 + not found）
  if (r.code === -1 || /ENOENT|not found|not recognized/i.test(stderr)) {
    return { available: false, reason: 'cli_missing', detail: '未找到 docker 命令（PATH 中不存在）' };
  }

  // 3) 访问 daemon socket 被拒
  if (/permission denied|EACCES|Got permission denied while trying to connect/i.test(stderr)) {
    return {
      available: false,
      reason: 'permission_denied',
      detail: '访问 daemon socket 被拒（需加入 docker 组或修 socket 权限）',
    };
  }

  // 4) 可用：退出码 0 且拿到了形如 28.5.1 的 Server 版本
  if (r.code === 0 && /^\d+\.\d+/.test(stdout.trim())) {
    return { available: true, serverVersion: stdout.trim(), detail: `Server 版本 ${stdout.trim()}` };
  }

  // 5) 退出码 0 但 Server 版本为空 —— 只拿到了 Client 信息
  if (r.code === 0) {
    return {
      available: false,
      reason: 'daemon_down',
      detail: 'Server 版本为空（只拿到了 Client 信息）',
    };
  }

  // 6) daemon 未运行（本机现状：CLI 28.5.1 装好、daemon 未启动）
  if (
    /Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|connection refused|dockerDesktopLinuxEngine|The system cannot find the file specified/i.test(
      stderr,
    )
  ) {
    return {
      available: false,
      reason: 'daemon_down',
      detail: `daemon 未运行（docker version 退出码 ${r.code}）`,
    };
  }

  // 7) 兜底：未知失败一律按 daemon 不可用处理（fail-closed）
  const firstLine = stderr.split(/\r?\n/)[0]?.trim() ?? '';
  return {
    available: false,
    reason: 'daemon_down',
    detail: `docker version 退出码 ${r.code}：${firstLine.slice(0, 200)}`,
  };
}

/** 单次探测（不走缓存）。 */
export async function probeDocker(
  cli: DockerCli,
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<SandboxProbeResult> {
  const now = opts.now ?? Date.now;
  const r = await cli.exec(probeArgv(), { timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS });
  const base = classifyProbeResult(r, r.timedOut);
  return { ...base, probedAt: now(), fromCache: false };
}

/**
 * 带 TTL + 单飞的探测缓存（每个 runtime 一个实例）。
 * `peek()` 只读缓存、绝不触发探测（确认卡徽标用，D7）。
 */
export class DockerProbe {
  private last: SandboxProbeResult | null = null;
  private inflight: Promise<SandboxProbeResult> | null = null;

  constructor(
    private readonly cli: DockerCli,
    private readonly opts: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {},
  ) {}

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  private get ttlMs(): number {
    return this.opts.ttlMs ?? PROBE_TTL_MS;
  }

  /** 只读缓存（不看 TTL：过期值也只是「上次已知」，足以渲染徽标）。 */
  peek(): SandboxProbeResult | null {
    return this.last;
  }

  /** "启动好了，重试" 入口：下次 get() 一定重新探测。 */
  invalidate(): void {
    this.last = null;
  }

  async get(force = false): Promise<SandboxProbeResult> {
    const cached = this.last;
    if (!force && cached && this.now() - cached.probedAt < this.ttlMs) {
      return { ...cached, fromCache: true };
    }
    // 单飞：并发 get() 共享同一个 inflight Promise（一轮多工具并行只探一次）
    if (this.inflight) return this.inflight;
    const p = probeDocker(this.cli, {
      timeoutMs: this.opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      now: this.now,
    })
      .then((r) => {
        this.last = r;
        return r;
      })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    this.inflight = p;
    return p;
  }
}
