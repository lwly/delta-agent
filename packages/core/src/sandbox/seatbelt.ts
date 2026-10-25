/**
 * Seatbelt 沙箱执行器（macOS 原生 sandbox-exec）—— 方案 C 的**默认隔离后端**。
 *
 * 设计补充（docs/design-f30-container-sandbox.md §19）：
 *  - 零安装、免 daemon：macOS 自带 `/usr/bin/sandbox-exec`，探测 = 平台判断 + 文件存在性（不 spawn）
 *  - 隔离模型：`(deny default)` + 白名单 —— 读全放行、写仅限 项目工作区(realpath) + 系统临时目录 + /dev，
 *    network=none 时 `(deny network*)`；内存/CPU/pids 上限 Seatbelt 不支持（与 docker 的能力差异，进文档）
 *  - **路径必须用 realpath**：macOS 的 /tmp、/var 是软链（→ /private/tmp、/private/var），
 *    Seatbelt 按真实路径匹配 —— 本机实测未经 realpath 的 subpath 静默不生效
 *  - 复用 `DockerCli` 端口形状（exec/execSync + 超时 + AbortSignal），
 *    测试可直接注入 FakeDockerCli；生产用 `realSeatbeltCli`（spawn sandbox-exec，shell:false）
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertSafeWorkspaceRoot, realpathOr } from './config.js';
import { relativeCwdOf } from './args.js';
import {
  PROBE_TTL_MS,
  SandboxPathError,
  type SandboxBadge,
  type SandboxConfig,
  type SandboxMeta,
  type SandboxMode,
  type SandboxNetwork,
  type SandboxProbeResult,
} from './types.js';
import type { DockerCli, DockerInvokeOptions, DockerResult } from './docker-cli.js';
import type { ResolvedSandboxConfig } from './types.js';
import type { RunOptions, SandboxExecResult, SandboxExecutor } from './executor.js';

/** macOS 自带的 Seatbelt 前端（自 macOS 12 起固定在此路径）。 */
export const SEATBELT_EXEC = '/usr/bin/sandbox-exec';

// ── Profile 生成（纯函数，可表驱动单测）────────────────────────────────────

export interface SeatbeltProfileSpec {
  /** 项目工作区**真实路径**（调用方先 realpathOr；内部再校验一次防软链穿透） */
  projectRoot: string;
  /** 可写临时区**真实路径**（缺省 realpath(tmpdir())） */
  tmpRoot?: string;
  network: SandboxNetwork;
}

/**
 * 生成 SBPL profile 文本（§19 基线）。
 * 硬约束：
 *  - `(deny default)` 打头 —— 白名单模型，漏写的权限一律拒绝
 *  - 写入范围 = 项目工作区 + 系统临时目录 + /dev 基础设备（HOME **不可写**）
 *  - 路径里出现引号/换行会破坏 SBPL 语法 → 直接抛错（构造期早失败）
 */
export function buildSeatbeltProfile(spec: SeatbeltProfileSpec): string {
  const projectRoot = realpathOr(spec.projectRoot);
  const tmpRoot = realpathOr(spec.tmpRoot ?? tmpdir());
  for (const [label, p] of [
    ['projectRoot', projectRoot],
    ['tmpRoot', tmpRoot],
  ] as const) {
    if (/["\n\r]/.test(p)) {
      throw new SandboxPathError(`sandbox 配置不允许 ${label} 含引号或换行（Seatbelt profile 注入防护）: ${p}`);
    }
  }

  const networkRule = spec.network === 'none' ? '(deny network*)' : '(allow network*)';
  return [
    '(version 1)',
    '; delta-agent F-30 seatbelt 沙箱（自动生成，勿手改）',
    '(deny default)',
    '(allow file-read*)',
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow system-socket)',
    `(allow file-write*`,
    `  (subpath "${projectRoot}")`,
    `  (subpath "${tmpRoot}")`,
    `  (subpath "/dev/null")`,
    `  (subpath "/dev/urandom")`,
    `  (subpath "/dev/random"))`,
    networkRule,
    '',
  ].join('\n');
}

/** Seatbelt 执行的 argv（不含可执行文件本身，与 DockerCli 端口「args 不含程序名」口径一致）。 */
export function seatbeltArgv(spec: { profilePath: string; command: string }): string[] {
  return ['-f', spec.profilePath, '/bin/sh', '-c', spec.command];
}

// ── 探测（存在性检查，不 spawn）────────────────────────────────────────────

export interface SeatbeltPlatformInfo {
  platform: NodeJS.Platform;
  /** SEATBELT_EXEC 是否存在（缺省实时 existsSync；测试注入） */
  executableExists?: boolean;
}

/**
 * Seatbelt 探测分类（纯函数）。
 * sandbox-exec 是 rootless 系统组件，存在即可用 —— 不需要「打 daemon」级别的深探测。
 */
export function classifySeatbeltProbe(
  info: SeatbeltPlatformInfo,
): Omit<SandboxProbeResult, 'probedAt' | 'fromCache'> {
  if (info.platform !== 'darwin') {
    return {
      available: false,
      reason: 'cli_missing',
      detail: `Seatbelt 仅 macOS 提供（当前 ${info.platform}）：改用 docker 后端（.delta/sandbox.json → {"mode":"docker"}）或 fallback 配置`,
    };
  }
  if (info.executableExists === false) {
    return {
      available: false,
      reason: 'cli_missing',
      detail: `未找到 ${SEATBELT_EXEC}（macOS 自带，通常不会缺失）`,
    };
  }
  return { available: true, detail: 'sandbox-exec 可用（macOS 自带）' };
}

/**
 * 30s TTL 的存在性探测缓存（口径与 DockerProbe 一致：peek 只读、get 支持 force）。
 * 存在性检查本身极廉价，缓存主要为对齐「探测结论快照」语义（徽标/status 展示）。
 */
export class SeatbeltProbe {
  private last: SandboxProbeResult | null = null;

  constructor(
    private readonly opts: { ttlMs?: number; now?: () => number; platform?: NodeJS.Platform } = {},
  ) {}

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  peek(): SandboxProbeResult | null {
    return this.last;
  }

  invalidate(): void {
    this.last = null;
  }

  async get(force = false): Promise<SandboxProbeResult> {
    const cached = this.last;
    if (!force && cached && this.now() - cached.probedAt < (this.opts.ttlMs ?? PROBE_TTL_MS)) {
      return { ...cached, fromCache: true };
    }
    const r: SandboxProbeResult = {
      ...classifySeatbeltProbe({
        platform: this.opts.platform ?? process.platform,
        executableExists: existsSync(SEATBELT_EXEC),
      }),
      probedAt: this.now(),
      fromCache: false,
    };
    this.last = r;
    return r;
  }
}

// ── 执行器 ──────────────────────────────────────────────────────────────────

/** 真实 Seatbelt CLI 端口：`spawn(SEATBELT_EXEC, args, { shell: false })`，env 全量继承。 */
export const realSeatbeltCli: DockerCli = {
  exec(args: string[], opts: DockerInvokeOptions = {}): Promise<DockerResult> {
    return new Promise<DockerResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(SEATBELT_EXEC, args, {
          shell: false,
          windowsHide: true,
          env: opts.env,
          // §19：sandbox-exec 直接在宿主跑，命令工作目录必须显式透传
          //（docker 后端的 cwd 由容器 workdir 承担，这里缺省即继承宿主 cwd）
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
        });
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: String((e as Error).message), timedOut: false });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (r: DockerResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = (): void => {
        timedOut = false; // abort ≠ timeout（与 runWithShell / realDockerCli 口径一致）
        try {
          child.kill('SIGKILL');
        } catch {
          // 子进程已退出
        }
      };

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // 子进程已退出
          }
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (d) => {
        stdout += String(d);
      });
      child.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      child.on('error', (e) => {
        finish({ code: -1, stdout, stderr: stderr + String(e.message), timedOut });
      });
      child.on('close', (code) => {
        finish({ code, stdout, stderr, timedOut });
      });
    });
  },

  execSync(): DockerResult {
    // Seatbolt 执行器没有 docker 那样的「容器清理」需求（进程随命令结束，无残留物），
    // 同步端口仅为满足 DockerCli 接口形状，永不使用。
    return { code: null, stdout: '', stderr: 'realSeatbeltCli.execSync 不应被调用', timedOut: false };
  },
};

export interface SeatbeltExecutorOptions {
  resolved: ResolvedSandboxConfig;
  /** 宿主项目根（构造期 realpath） */
  projectRoot: string;
  /** 执行端口（测试注入 FakeDockerCli）。缺省 realSeatbeltCli */
  cli?: DockerCli;
  /** profile 落盘目录（缺省 os.tmpdir()/delta-sbx）；测试可注入临时目录 */
  profileRoot?: string;
  platform?: NodeJS.Platform;
  onDebugArgv?: (argv: string[]) => void;
  onWarning?: (message: string) => void;
  now?: () => number;
}

export class SeatbeltExecutor implements SandboxExecutor {
  readonly mode: SandboxMode = 'seatbelt';
  private readonly resolved: ResolvedSandboxConfig;
  private readonly cli: DockerCli;
  private readonly projectRoot: string;
  private readonly opts: SeatbeltExecutorOptions;
  private readonly probeCache: SeatbeltProbe;
  /** 本会话已写好的 profile 路径（构造懒执行：首次 run 才落盘） */
  private profilePath: string | null = null;

  constructor(opts: SeatbeltExecutorOptions) {
    this.opts = opts;
    this.resolved = opts.resolved;
    this.cli = opts.cli ?? realSeatbeltCli;
    this.projectRoot = realpathOr(opts.projectRoot);
    this.probeCache = new SeatbeltProbe({
      now: opts.now,
      ...(opts.platform ? { platform: opts.platform } : {}),
    });
  }

  private get config(): SandboxConfig {
    return this.resolved.config;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  resolveConfig(): SandboxConfig {
    return this.config;
  }

  async probeBackend(force = false): Promise<SandboxProbeResult> {
    return this.probeCache.get(force);
  }

  /** 兼容 SandboxExecutor 接口：探测由 runtime 路由到 probeBackend。 */
  async probe(): Promise<SandboxProbeResult> {
    return this.probeBackend();
  }

  /** 只读探测缓存（徽标用，绝不触发探测）。 */
  peek(): SandboxProbeResult | null {
    return this.probeCache.peek();
  }

  badge(): SandboxBadge {
    const cfg = this.config;
    const cached = this.probeCache.peek();
    const badge: SandboxBadge = { mode: 'seatbelt', network: cfg.network };
    if (cached) badge.available = cached.available;
    return badge;
  }

  async run(command: string, opts: RunOptions): Promise<SandboxExecResult> {
    const cfg = this.config;

    // ① 工作区守卫（与 DockerExecutor 同语义：在任何子进程之前拒绝，AC-30-4）
    assertSafeWorkspaceRoot(this.projectRoot);
    // cwd 必须在项目工作区内（路径守卫与 docker 后端对齐；越界属于调用方 bug）
    relativeCwdOf(this.projectRoot, opts.cwd);

    const profilePath = this.ensureProfile(cfg.network);
    const argv = seatbeltArgv({ profilePath, command });
    this.opts.onDebugArgv?.(argv);

    const started = this.now();
    const r = await this.cli.exec(argv, { timeoutMs: opts.timeoutMs, signal: opts.signal, cwd: opts.cwd });
    const ms = this.now() - started;

    const meta: SandboxMeta = {
      mode: 'seatbelt',
      network: cfg.network,
      profile: profilePath,
      exitCode: r.code,
      ms,
      pulled: false,
    };
    return {
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      hints: buildSeatbeltHints(r, cfg),
      sandbox: meta,
    };
  }

  /** 生成并落盘本会话 profile（同一 runtime 只写一次；失败直接抛错 → 走降级链）。 */
  private ensureProfile(network: SandboxNetwork): string {
    if (this.profilePath) return this.profilePath;
    const root = this.opts.profileRoot ?? join(tmpdir(), 'delta-sbx');
    const hash = createHash('sha256').update(`${this.projectRoot}\n${network}`).digest('hex').slice(0, 12);
    const dir = join(root, hash);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'profile.sb');
    writeFileSync(path, buildSeatbeltProfile({ projectRoot: this.projectRoot, network }), { mode: 0o600 });
    this.profilePath = path;
    return path;
  }
}

/**
 * Seatbelt 失败后的附加诊断（只做**失败后**分类，不做预判拦截）：
 *  - network=none 下的网络报错 → 指路 bridge
 *  - EPERM/Operation not permitted → Seatbelt 白名单拒了某操作（与 docker 126 语义对应）
 */
export function buildSeatbeltHints(r: DockerResult, cfg: SandboxConfig): string[] {
  const hints: string[] = [];
  const stderr = r.stderr ?? '';
  if (
    cfg.network === 'none' &&
    // curl exit 6 = 无法解析域名 / 7 = 连接被拒（-s 静默模式下 stderr 为空，退出码是唯一线索）
    (r.code === 6 || r.code === 7 || /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network|registry|getaddrinfo/i.test(stderr))
  ) {
    hints.push(
      '[sandbox] network=none 下网络被 Seatbelt 拒绝。若该命令确需联网：加 --sandbox-network bridge，' +
        '或设置 .delta/sandbox.json {"network":"bridge"}',
    );
  }
  if (r.code !== 0 && /Operation not permitted|EPERM/i.test(stderr)) {
    hints.push(
      '[sandbox] Seatbelt 白名单拒绝了某操作（写仅限项目工作区/临时目录，网络按配置）。' +
        '调试可临时用 --sandbox local 对比是否为沙箱所致',
    );
  }
  return hints;
}
