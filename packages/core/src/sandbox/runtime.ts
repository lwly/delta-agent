/**
 * `SandboxRuntime` —— 降级编排（设计 §1.1 第 3 层 / §7 / D2）。
 *
 * 职责：probe → `resolveExecutionPlan` → local / docker / deny / ask（含降级确认），
 * 并维护会话内状态（`degradeApproved`、runs、首次残留检查）。
 * 与 `LocalExecutor` / `DockerExecutor` 实现同一个 `SandboxExecutor` 接口 ——
 * 因此 `ToolContext.sandbox` 一处类型即可，测试可任选注入哪一层。
 */
import { loadSandboxConfig } from './config.js';
import { realDockerCli, type DockerCli } from './docker-cli.js';
import { DockerProbe } from './probe.js';
import { DockerExecutor, LocalExecutor, type RunOptions, type SandboxExecutor, type SandboxExecResult } from './executor.js';
import { buildUnavailableMessage, resolveExecutionPlan } from './plan.js';
import {
  SandboxPathError,
  SandboxUnavailableError,
  type GcResult,
  type PullResult,
  type ResolvedSandboxConfig,
  type SandboxBadge,
  type SandboxConfig,
  type SandboxConfirmDegrade,
  type SandboxConfirmRequest,
  type SandboxMode,
  type SandboxNotice,
  type SandboxProbeResult,
  type SandboxRunRecord,
  type SandboxSessionOverrides,
  type SandboxStateSnapshot,
  type SandboxStatus,
} from './types.js';

export interface SandboxRuntimeDeps {
  projectRoot: string;
  sessionId: string;
  projectId: string;
  homeDir?: string;
  /** CLI flag / Web 会话设置（受 enforce 约束；调用方先用 checkEnforce 校验） */
  session?: SandboxSessionOverrides;
  /** 交互式入口（TUI / Web）。headless 传 false → ask ≡ deny */
  interactive?: boolean;
  /** 命令执行端口（测试注入 FakeDockerCli）。缺省 realDockerCli */
  cli?: DockerCli;
  /**
   * 降级确认**独立通道**（D9）：不复用 ctx.confirm，避免 allow_session 污染
   * 「本会话免确认 run_command」的权限语义。
   */
  confirmDegrade?: SandboxConfirmDegrade;
  /** 通知出口（入口注入：TUI addItem / Web publish / headless stderr） */
  onNotice?: (n: SandboxNotice) => void;
  onPullProgress?: (line: string) => void;
  onDebugArgv?: (argv: string[]) => void;
  onWarning?: (message: string) => void;
  now?: () => number;
  /** 已解析配置（入口/测试复用；缺省自行 loadSandboxConfig） */
  resolved?: ResolvedSandboxConfig;
  /** 注入探测缓存（测试用） */
  probeCache?: DockerProbe;
}

const MAX_RUN_RECORDS = 200;

export class SandboxRuntime implements SandboxExecutor {
  readonly mode: SandboxMode;

  private readonly deps: SandboxRuntimeDeps;
  private readonly resolved: ResolvedSandboxConfig;
  private readonly local: LocalExecutor;
  private readonly docker: DockerExecutor;
  private readonly probeCache: DockerProbe;
  /** 降级确认已获准（本会话记忆；每次运行新建 runtime → 跨运行自然重置） */
  private degradeApproved = false;
  private readonly runs: SandboxRunRecord[] = [];
  /** 镜像拉取失败后合成的 probe（本会话内不再重试该镜像） */
  private imageProbe: SandboxProbeResult | null = null;
  private residueChecked = false;
  private degradedOnce = false;
  private readonly noticedUnavailable = new Set<string>();

  constructor(deps: SandboxRuntimeDeps) {
    this.deps = deps;
    this.resolved =
      deps.resolved ??
      loadSandboxConfig({
        projectRoot: deps.projectRoot,
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(deps.session ? { session: deps.session } : {}),
      });
    this.mode = this.resolved.config.mode;
    const now = deps.now ?? Date.now;
    this.local = new LocalExecutor({ resolved: this.resolved, now });
    this.docker = new DockerExecutor({
      resolved: this.resolved,
      projectRoot: deps.projectRoot,
      sessionId: deps.sessionId,
      projectId: deps.projectId,
      cli: deps.cli ?? realDockerCli,
      now,
      ...(deps.onNotice ? { onNotice: deps.onNotice } : {}),
      ...(deps.onPullProgress ? { onPullProgress: deps.onPullProgress } : {}),
      ...(deps.onDebugArgv ? { onDebugArgv: deps.onDebugArgv } : {}),
      ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
    });
    this.probeCache = deps.probeCache ?? new DockerProbe(deps.cli ?? realDockerCli, { now });
  }

  /** 生效配置（构造期解析一次，运行期只读）。 */
  private get config(): SandboxConfig {
    return this.resolved.config;
  }

  private get interactive(): boolean {
    return this.deps.interactive === true;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private notice(n: SandboxNotice): void {
    this.deps.onNotice?.(n);
  }

  resolveConfig(): SandboxConfig {
    return this.config;
  }

  /** 是否显式配置过（false = 纯默认：不显示徽标、headless 不输出 sandbox 段、不产出 meta）。 */
  get explicit(): boolean {
    return this.resolved.explicit;
  }

  /**
   * 探测（mode=local 不 spawn；docker 走 30s 缓存 + 单飞）。
   * 镜像拉取失败过的会话内结论优先（本会话不再重试）。
   */
  async probe(force = false): Promise<SandboxProbeResult> {
    if (this.config.mode === 'local') return this.local.probe();
    if (force) {
      this.imageProbe = null;
      this.probeCache.invalidate();
    }
    if (this.imageProbe) return this.imageProbe;
    return this.probeCache.get(force);
  }

  /** 徽标（确认卡/工具卡片）：只读缓存，绝不触发探测。 */
  badge(): SandboxBadge {
    const cfg = this.config;
    const cached = this.imageProbe ?? this.probeCache.peek();
    const badge: SandboxBadge = { mode: cfg.mode, network: cfg.network };
    if (cfg.mode === 'docker') badge.image = cfg.image;
    if (cached) badge.available = cached.available;
    return badge;
  }

  // ── 执行 ──────────────────────────────────────────────────────────────────

  async run(command: string, opts: RunOptions): Promise<SandboxExecResult> {
    const cfg = this.config;

    // mode=local：不探测、零开销（Z3）
    if (cfg.mode === 'local') {
      const r = await this.local.run(command, opts);
      return this.record(command, r, 'local', false);
    }

    const probe = await this.probe();
    const plan = resolveExecutionPlan({
      config: cfg,
      probe,
      interactive: this.interactive,
      degradeApproved: this.degradeApproved,
    });

    if (plan.action === 'deny') return this.deniedResult(command, probe, plan.reason);
    if (plan.action === 'ask') {
      const approved = await this.askDegrade(command, probe);
      if (!approved) return this.deniedResult(command, probe, 'fallback_ask');
      this.degradeApproved = true;
      return this.runLocalDegraded(command, opts, probe, 'degrade_approved');
    }
    if (plan.action === 'local') {
      return this.runLocalDegraded(command, opts, probe, plan.reason);
    }

    // docker：首次真正进容器前做一次残留检查（整会话 ≤1 次额外 docker 调用）
    await this.checkResiduesOnce();
    try {
      const r = await this.docker.run(command, opts);
      // daemon 中途挂掉 → 让下一次立即重探，而不是用 30s 内的旧结论
      if (/Cannot connect to the Docker daemon|error during connect|connection refused/i.test(r.stderr)) {
        this.probeCache.invalidate();
      }
      return this.record(command, r, 'docker', false);
    } catch (e) {
      if (e instanceof SandboxUnavailableError) {
        return this.handleImageUnavailable(command, opts, e);
      }
      if (e instanceof SandboxPathError) {
        // 工作区守卫 / cwd 逃逸：在任何 docker 调用之前拒绝（AC-30-4）
        const denied: SandboxExecResult = {
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          denied: true,
          diagnostic: e.message,
          hints: [],
          sandbox: { mode: 'docker', image: cfg.image, network: cfg.network, exitCode: null, ms: 0, pulled: false },
        };
        return this.record(command, denied, 'docker', false);
      }
      throw e;
    }
  }

  /** 镜像不可用 → 合成 probe（image_unavailable）后重走降级链，本会话不再重试该镜像。 */
  private async handleImageUnavailable(
    command: string,
    opts: RunOptions,
    e: SandboxUnavailableError,
  ): Promise<SandboxExecResult> {
    const cfg = this.config;
    const synthesized: SandboxProbeResult = {
      available: false,
      reason: 'image_unavailable',
      detail: e.detail,
      probedAt: this.now(),
      fromCache: false,
    };
    this.imageProbe = synthesized;

    const plan = resolveExecutionPlan({
      config: cfg,
      probe: synthesized,
      interactive: this.interactive,
      degradeApproved: this.degradeApproved,
    });
    if (plan.action === 'local') return this.runLocalDegraded(command, opts, synthesized, plan.reason);
    if (plan.action === 'ask') {
      const approved = await this.askDegrade(command, synthesized);
      if (!approved) return this.deniedResult(command, synthesized, 'fallback_ask');
      this.degradeApproved = true;
      return this.runLocalDegraded(command, opts, synthesized, 'degrade_approved');
    }
    return this.deniedResult(command, synthesized, plan.reason);
  }

  private async runLocalDegraded(
    command: string,
    opts: RunOptions,
    probe: SandboxProbeResult | null,
    reason: string,
  ): Promise<SandboxExecResult> {
    if (reason === 'fallback_local' && !this.degradedOnce) {
      this.degradedOnce = true;
      this.notice({
        kind: 'degraded',
        detail: `Docker 不可用（${probe?.detail ?? '未知原因'}），已按 fallback=local 在本地执行——容器隔离本次未生效`,
      });
    }
    const r = await this.local.run(command, opts);
    r.sandbox = {
      mode: 'local',
      exitCode: r.code,
      ms: r.sandbox?.ms ?? 0,
      pulled: false,
      degraded: true,
    };
    return this.record(command, r, 'local', true);
  }

  private deniedResult(
    command: string,
    probe: SandboxProbeResult | null,
    reason: string,
  ): SandboxExecResult {
    const cfg = this.config;
    const detail = probe?.detail ?? 'Docker 不可用（尚未探测到可用 daemon）';
    const diagnostic = buildUnavailableMessage({
      reason: probe?.reason ?? 'daemon_down',
      detail,
      fallback: cfg.fallback,
      image: cfg.image,
      enforced: cfg.enforce || reason === 'enforced_deny',
      interactive: this.interactive,
    });
    if (!this.noticedUnavailable.has(detail)) {
      this.noticedUnavailable.add(detail);
      this.notice({ kind: 'unavailable', detail });
    }
    const denied: SandboxExecResult = {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      denied: true,
      diagnostic,
      hints: [],
      sandbox: {
        mode: cfg.mode,
        image: cfg.mode === 'docker' ? cfg.image : undefined,
        network: cfg.network,
        exitCode: null,
        ms: 0,
        pulled: false,
      },
    };
    return this.record(command, denied, cfg.mode, false);
  }

  private async askDegrade(command: string, probe: SandboxProbeResult | null): Promise<boolean> {
    const confirm = this.deps.confirmDegrade;
    // 无确认通道（headless / 未接 Web 交互）→ 等价 deny，绝不静默降级
    if (!confirm) return false;
    const cfg = this.config;
    const req: SandboxConfirmRequest = {
      id: `sandbox-degrade-${this.now()}`,
      tool: 'run_command',
      args: { command },
      reason: buildUnavailableMessage({
        reason: probe?.reason ?? 'daemon_down',
        detail: probe?.detail ?? 'Docker 不可用',
        fallback: cfg.fallback,
        image: cfg.image,
        enforced: cfg.enforce,
        interactive: true,
      }),
      variant: 'sandbox_degrade',
      sandbox: this.badge(),
    };
    try {
      const decision = await confirm(req);
      return decision.kind === 'allow' || decision.kind === 'allow_session';
    } catch {
      // 确认通道异常 → 保守拒绝（不静默降级）
      return false;
    }
  }

  /** 首次真正进 docker 前的残留检查（PRD F-30.9 崩溃兜底；整会话最多一次）。 */
  private async checkResiduesOnce(): Promise<void> {
    if (this.residueChecked) return;
    this.residueChecked = true;
    try {
      const names = await this.docker.listContainers();
      if (names.length > 0) {
        this.notice({
          kind: 'gc_suggest',
          detail: `发现 ${names.length} 个残留容器（上次运行未正常退出），建议执行 yzero sandbox gc`,
        });
      }
    } catch {
      // 兜底检查失败不影响主流程
    }
  }

  private record(
    command: string,
    r: SandboxExecResult,
    mode: SandboxMode,
    degraded: boolean,
  ): SandboxExecResult {
    this.runs.push({
      command: command.slice(0, 120),
      mode,
      exitCode: r.code,
      ms: r.sandbox?.ms ?? 0,
      ...(r.sandbox?.containerName ? { container: r.sandbox.containerName } : {}),
      ...(r.denied ? { denied: true } : {}),
      ...(degraded ? { degraded: true } : {}),
    });
    if (this.runs.length > MAX_RUN_RECORDS) this.runs.shift();
    return r;
  }

  // ── 运维（CLI / Web 共用同一数据源）──────────────────────────────────────

  async status(opts: { refresh?: boolean } = {}): Promise<SandboxStatus> {
    const cfg = this.config;
    const docker = await this.probe(opts.refresh === true);
    let imagePresent = false;
    let residues: string[] = [];
    if (cfg.mode === 'docker' && docker.available) {
      imagePresent = await this.docker.hasImage(cfg.image);
      residues = await this.docker.listContainers();
    }
    return {
      mode: cfg.mode,
      explicit: this.resolved.explicit,
      enforce: cfg.enforce,
      fallback: cfg.fallback,
      image: cfg.image,
      network: cfg.network,
      imagePresent,
      docker,
      residues,
      provenance: this.resolved.provenance,
      warnings: this.resolved.warnings,
      errors: this.resolved.errors,
    };
  }

  async pull(image?: string): Promise<PullResult> {
    return this.docker.pullImage(image ?? this.config.image, {
      pullTimeoutMs: this.config.pullTimeoutMs,
    });
  }

  async gc(): Promise<GcResult> {
    return this.docker.gc();
  }

  state(): SandboxStateSnapshot {
    return {
      explicit: this.resolved.explicit,
      mode: this.config.mode,
      image: this.config.image,
      network: this.config.network,
      enforced: this.config.enforce,
      degraded: this.runs.some((r) => r.degraded === true),
      probe: this.imageProbe ?? this.probeCache.peek(),
      runs: [...this.runs],
    };
  }
}

/** 入口唯一出口（cli / hub / headless 共用）：`cli ?? realDockerCli`。 */
export function createSandboxRuntime(deps: SandboxRuntimeDeps): SandboxRuntime {
  return new SandboxRuntime(deps);
}
