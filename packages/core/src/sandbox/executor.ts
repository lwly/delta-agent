/**
 * 执行器（设计 §2.1 / §6）：
 *  - `SandboxExecutor`：怎么跑（local / docker）
 *  - `LocalExecutor`：直接复用 `runWithShell`（同一函数，不复制截断逻辑，Z3）
 *  - `DockerExecutor`：唯一挂载 + 加固基线 + 独立 pull 超时 + 同步清理路径
 *
 * 策略与机制分离（D2）：`exec.ts` 只调 `sandbox.run()`；测试可注入裸执行器断言 argv，
 * 也可注入 `SandboxRuntime` 断言降级决策 —— 两者同接口。
 */
import { runWithShell } from '../engine/shell.js';
import { assertSafeWorkspaceRoot, realpathOr } from './config.js';
import { LABELS } from '../paths.js';
import {
  buildDockerRunArgs,
  containerName,
  passthroughEnvNames,
  redactArgv,
  relativeCwdOf,
} from './args.js';
import {
  SandboxUnavailableError,
  type GcResult,
  type PullResult,
  type ResolvedSandboxConfig,
  type SandboxBadge,
  type SandboxConfig,
  type SandboxMeta,
  type SandboxMode,
  type SandboxNotice,
  type SandboxProbeResult,
} from './types.js';
import type { DockerCli, DockerResult } from './docker-cli.js';

export interface RunOptions {
  /** 宿主绝对路径 cwd，调用方已过 resolveInSandbox */
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** 执行结果（`denied`/`hints`/`sandbox` 全部可选，缺省即历史行为）。 */
export interface SandboxExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** true = 策略层拒绝执行（未产生任何 docker run）。exec.ts 直接渲染 diagnostic，不走 trimOutput */
  denied?: boolean;
  /** denied 时的完整可诊断文案（判定依据 + 后果 + ≥2 个可执行动作） */
  diagnostic?: string;
  /** 附加诊断（127/137/126、网络不可达），由 exec.ts 追加在结果末尾 */
  hints?: string[];
  /** 有值才写进 ToolResult.meta.sandbox（local 未显式配置时不出现，见 Z3） */
  sandbox?: SandboxMeta;
}

export interface SandboxExecutor {
  readonly mode: SandboxMode;
  /** 生效配置（构造期解析一次，运行期只读） */
  resolveConfig(): SandboxConfig;
  /** Docker 可用性探测（local 实现：不 spawn，恒返回 available=false / not_applicable） */
  probe(force?: boolean): Promise<SandboxProbeResult>;
  /** 徽标（确认卡用）：只读缓存，绝不触发探测 */
  badge(): SandboxBadge;
  /** command → 单个字符串（不做任何转义处理；转义由 argv 数组承担） */
  run(command: string, opts: RunOptions): Promise<SandboxExecResult>;
}

// ── LocalExecutor ───────────────────────────────────────────────────────────

export class LocalExecutor implements SandboxExecutor {
  readonly mode = 'local' as const;

  constructor(
    private readonly opts: {
      resolved: ResolvedSandboxConfig;
      now?: () => number;
    },
  ) {}

  private get config(): SandboxConfig {
    return this.opts.resolved.config;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  resolveConfig(): SandboxConfig {
    return this.config;
  }

  async probe(): Promise<SandboxProbeResult> {
    return {
      available: false,
      reason: 'not_applicable',
      detail: 'mode=local：未使用 Docker，未做探测',
      probedAt: this.now(),
      fromCache: false,
    };
  }

  badge(): SandboxBadge {
    return { mode: 'local' };
  }

  async run(command: string, opts: RunOptions): Promise<SandboxExecResult> {
    const started = this.now();
    const r = await runWithShell(command, opts.cwd, opts.timeoutMs, opts.signal);
    const out: SandboxExecResult = {
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      hints: [],
    };
    // Z3：未显式配置时不产出 sandbox meta（输出与历史逐字节一致）
    if (this.opts.resolved.explicit) {
      out.sandbox = { mode: 'local', exitCode: r.code, ms: this.now() - started, pulled: false };
    }
    return out;
  }
}

// ── DockerExecutor ──────────────────────────────────────────────────────────

export interface DockerExecutorOptions {
  resolved: ResolvedSandboxConfig;
  /** 宿主项目根（构造期 realpath） */
  projectRoot: string;
  sessionId: string;
  projectId: string;
  cli: DockerCli;
  onNotice?: (n: SandboxNotice) => void;
  /** 拉取进度（每行一条，旁路到用户侧，不进模型上下文） */
  onPullProgress?: (line: string) => void;
  /** `--debug` 参数向量（已打码） */
  onDebugArgv?: (argv: string[]) => void;
  /** 清理失败等 warning（只提示，绝不影响命令结果） */
  onWarning?: (message: string) => void;
  now?: () => number;
  /** 宿主 env（env 白名单存在性判断；缺省 process.env） */
  hostEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const IMAGE_INSPECT_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const LIST_TIMEOUT_MS = 10_000;

export class DockerExecutor implements SandboxExecutor {
  readonly mode = 'docker' as const;
  private readonly cli: DockerCli;
  private readonly resolved: ResolvedSandboxConfig;
  private readonly projectRoot: string;
  private readonly sessionId: string;
  private readonly projectId: string;
  /** 本会话拉取失败过的镜像（不再重试，PRD §5.2） */
  private readonly imageFailed = new Set<string>();
  /** 已就绪并通知过的镜像（`sandbox_notice kind=pulled` 只发一次） */
  private readonly notifiedPulled = new Set<string>();

  constructor(private readonly opts: DockerExecutorOptions) {
    this.cli = opts.cli;
    this.resolved = opts.resolved;
    this.projectRoot = realpathOr(opts.projectRoot);
    this.sessionId = opts.sessionId;
    this.projectId = opts.projectId;
  }

  private get config(): SandboxConfig {
    return this.resolved.config;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private warn(message: string): void {
    this.opts.onWarning?.(message);
  }

  resolveConfig(): SandboxConfig {
    return this.config;
  }

  /** docker 执行器的探测由 runtime 的 DockerProbe 承担；此处保守返回不可用（不应被直接调用）。 */
  async probe(): Promise<SandboxProbeResult> {
    return {
      available: false,
      reason: 'daemon_down',
      detail: 'DockerExecutor 不自行探测，请通过 SandboxRuntime.probe() 调用',
      probedAt: this.now(),
      fromCache: false,
    };
  }

  badge(): SandboxBadge {
    return { mode: 'docker', image: this.config.image, network: this.config.network };
  }

  async run(command: string, opts: RunOptions): Promise<SandboxExecResult> {
    const cfg = this.config;

    // ① 工作区守卫与 cwd 归一：全部早于任何 docker 调用（AC-30-4）
    assertSafeWorkspaceRoot(this.projectRoot);
    const relCwd = relativeCwdOf(this.projectRoot, opts.cwd);

    const name = containerName(this.sessionId);
    const started = this.now();

    // ② 镜像就绪检查（拉取不计入命令超时）
    const pull = await this.ensureImage(cfg, opts.signal);
    if (!pull.ok) throw new SandboxUnavailableError('image_unavailable', pull.detail);

    // ③ 参数向量（有序数组；shell 恒为 false）
    const argv = buildDockerRunArgs({
      config: cfg,
      projectRoot: this.projectRoot,
      relativeCwd: relCwd,
      command,
      containerName: name,
      labels: {
        session: this.sessionId,
        project: this.projectId,
        created: new Date(this.now()).toISOString(),
      },
      ...(this.opts.hostEnv ? { hostEnv: this.opts.hostEnv } : {}),
      ...(this.opts.platform ? { platform: this.opts.platform } : {}),
    });
    this.opts.onDebugArgv?.(redactArgv(argv));

    // ④ 执行 + 超时/中断清理（同步、短超时、失败只 warning）
    let r: DockerResult;
    try {
      r = await this.cli.exec(argv, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    } catch (e) {
      if (!cfg.keepContainer) this.cleanup(name);
      throw e;
    }
    if ((r.timedOut || opts.signal.aborted) && !cfg.keepContainer) this.cleanup(name);

    const hints = buildHints(r, cfg, command);
    const ms = this.now() - started;
    return {
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      hints,
      sandbox: {
        mode: 'docker',
        image: cfg.image,
        containerName: name,
        network: cfg.network,
        exitCode: r.code,
        ms,
        pulled: pull.pulled,
        passthroughEnv: passthroughEnvNames(cfg, this.opts.hostEnv ?? process.env).length,
      },
    };
  }

  /** 镜像是否已在本地。 */
  async hasImage(image: string = this.config.image): Promise<boolean> {
    const r = await this.cli.exec(['image', 'inspect', image, '--format', '{{.Id}}'], {
      timeoutMs: IMAGE_INSPECT_TIMEOUT_MS,
    });
    return r.code === 0 && r.stdout.trim() !== '';
  }

  /**
   * 镜像就绪检查：inspect（5s）→ 缺失则 pull（独立 pullTimeoutMs）。
   * 拉取失败 → 本会话标记该镜像不可用（不再重试），返回 ok:false 由 runtime 合成 probe。
   */
  async ensureImage(cfg: SandboxConfig, signal?: AbortSignal): Promise<PullResult> {
    const image = cfg.image;
    if (this.imageFailed.has(image)) {
      return {
        ok: false,
        image,
        pulled: false,
        detail: `镜像 ${image} 本会话拉取失败过，不再重试（可用 delta sandbox pull 手动预热）`,
      };
    }
    if (await this.hasImage(image)) {
      return { ok: true, image, pulled: false, detail: `镜像 ${image} 已在本地` };
    }
    return this.pullImage(image, { signal, pullTimeoutMs: cfg.pullTimeoutMs });
  }

  /** 显式拉取（`delta sandbox pull` / ensureImage 共用）。 */
  async pullImage(
    image: string,
    opts: { signal?: AbortSignal; pullTimeoutMs?: number } = {},
  ): Promise<PullResult> {
    const timeoutMs = opts.pullTimeoutMs ?? this.config.pullTimeoutMs;
    const r = await this.cli.exec(['pull', image], {
      timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      onStderrLine: (line) => this.opts.onPullProgress?.(line),
    });
    if (r.code !== 0) {
      this.imageFailed.add(image);
      const firstLine = (r.stderr ?? '').split(/\r?\n/)[0]?.trim() ?? '';
      return {
        ok: false,
        image,
        pulled: false,
        detail: `镜像 ${image} 拉取失败（docker pull 退出码 ${r.code}）：${firstLine.slice(0, 200)}`,
      };
    }
    if (!this.notifiedPulled.has(image)) {
      this.notifiedPulled.add(image);
      this.opts.onNotice?.({ kind: 'pulled', detail: `镜像 ${image} 已就绪` });
    }
    return { ok: true, image, pulled: true, detail: `镜像 ${image} 已拉取` };
  }

  /**
   * 清理序列（顺序即契约）：`kill` → `rm -f`。
   * 全程同步（execSync + 2s 超时 + 不抛），清理失败只 warning，绝不改变命令结果。
   */
  cleanup(name: string): void {
    try {
      const killed = this.cli.execSync(['kill', name], { timeoutMs: CLEANUP_TIMEOUT_MS });
      if (killed.code !== 0) {
        this.warn(`[sandbox] 清理容器失败（docker kill ${name} 退出码 ${killed.code}），继续尝试 rm -f`);
      }
    } catch (e) {
      this.warn(`[sandbox] 清理容器失败（docker kill ${name}）：${(e as Error).message}`);
    }
    try {
      const removed = this.cli.execSync(['rm', '-f', name], { timeoutMs: CLEANUP_TIMEOUT_MS });
      if (removed.code !== 0) {
        this.warn(
          `[sandbox] 清理容器失败（docker rm -f ${name} 退出码 ${removed.code}），可用 delta sandbox gc 兜底`,
        );
      }
    } catch (e) {
      this.warn(`[sandbox] 清理容器失败（docker rm -f ${name}）：${(e as Error).message}`);
    }
  }

  /** 残留容器（label 锚点 + 名称前缀双保险）。 */
  async listContainers(): Promise<string[]> {
    const r = await this.cli.exec(
      ['ps', '-a', '--filter', `label=${LABELS.created}`, '--format', '{{.Names}}'],
      { timeoutMs: LIST_TIMEOUT_MS },
    );
    if (r.code !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((name) => name !== '' && name.startsWith('delta-'));
  }

  /** 清理全部残留（并发 4 条；失败跳过并计数）。 */
  async gc(): Promise<GcResult> {
    const names = await this.listContainers();
    const removed: string[] = [];
    for (let i = 0; i < names.length; i += 4) {
      const batch = names.slice(i, i + 4);
      await Promise.all(
        batch.map(async (name) => {
          const r = await this.cli.exec(['rm', '-f', name], { timeoutMs: LIST_TIMEOUT_MS });
          if (r.code === 0) removed.push(name);
          else this.warn(`[sandbox] gc 未能删除 ${name}（退出码 ${r.code}）`);
        }),
      );
    }
    return { removed: removed.length, names: removed };
  }
}

// ── 诊断增强（纯函数）──────────────────────────────────────────────────────

/**
 * 127 / 137 / 126 / 网络不可达的附加诊断（追加在结果末尾，进模型上下文）。
 * 只做**失败后**分类：不对「疑似安装类命令」做预判拦截（PRD F-30.7）。
 */
export function buildHints(r: DockerResult, cfg: SandboxConfig, command: string): string[] {
  void command; // 保留参数：未来做「命令级」诊断时使用，本期只按退出码/stderr 分类
  const hints: string[] = [];
  if (r.code === 127) {
    hints.push(
      `[sandbox] 命令在镜像 ${cfg.image} 中不存在（容器内通常只有 node/pnpm/npm 等）。` +
        '如需该命令：换 sandbox.image，或本次用 --sandbox local',
    );
  }
  if (r.code === 137) {
    hints.push(`[sandbox] 疑似超出内存上限（${cfg.memoryMb}MB）被 OOM kill；可调 sandbox.memoryMb`);
  }
  if (r.code === 126) {
    hints.push('[sandbox] 权限不足（只读根文件系统或 --user 限制）；调试可临时设 readOnlyRoot=false');
  }
  if (
    cfg.network === 'none' &&
    /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network|registry|getaddrinfo/i.test(r.stderr ?? '')
  ) {
    hints.push(
      '[sandbox] network=none 下网络不可达。若该命令确需联网：加 --sandbox-network bridge，' +
        '或设置 .delta/sandbox.json {"network":"bridge"}',
    );
  }
  return hints;
}
