/**
 * 测试用 Docker 端口实现（设计 §2.2 / §14 单测铁律）。
 *
 * 任何会走到 `DockerExecutor` 的用例**必须**注入 `FakeDockerCli`；
 * 每个用例结束时用 `realDockerCliCallCount()` 断言真实 CLI 从未被调用（防漏注入）。
 */
import {
  createSandboxRuntime,
  mergeSandboxLayers,
  realDockerCliCallCount,
  resetRealDockerCliStats,
  SandboxRuntime,
  type DockerCli,
  type DockerInvokeOptions,
  type DockerResult,
  type ResolvedSandboxConfig,
  type SandboxConfigLayer,
  type SandboxNotice,
  type SandboxRuntimeDeps,
} from '../../src/sandbox/index.js';

export type FakeHandler = DockerResult | ((args: string[]) => DockerResult);

export function dockerOk(stdout = '', stderr = ''): DockerResult {
  return { code: 0, stdout, stderr, timedOut: false };
}

export function dockerFail(code: number, stderr = ''): DockerResult {
  return { code, stdout: '', stderr, timedOut: false };
}

export class FakeDockerCli implements DockerCli {
  /** exec 的参数向量（按调用顺序） */
  readonly calls: string[][] = [];
  /** execSync 的参数向量（清理序列；顺序敏感） */
  readonly syncCalls: string[][] = [];
  /** 每次 exec 收到的选项（断言 timeoutMs / signal 用） */
  readonly execOptions: Array<DockerInvokeOptions | undefined> = [];

  constructor(
    private readonly script: Record<string, FakeHandler> = {},
    private readonly syncScript: Record<string, FakeHandler> = {},
  ) {}

  async exec(args: string[], opts?: DockerInvokeOptions): Promise<DockerResult> {
    this.calls.push([...args]);
    this.execOptions.push(opts);
    return this.resolve(this.script, args);
  }

  execSync(args: string[], opts?: { timeoutMs?: number }): DockerResult {
    void opts;
    this.syncCalls.push([...args]);
    return this.resolve(this.syncScript, args);
  }

  private resolve(script: Record<string, FakeHandler>, args: string[]): DockerResult {
    const key = args[0] ?? '';
    const handler = script[key] ?? script['*'];
    if (typeof handler === 'function') return handler(args);
    return handler ?? dockerOk();
  }

  reset(): void {
    this.calls.length = 0;
    this.syncCalls.length = 0;
    this.execOptions.length = 0;
  }
}

/** 真实 CLI 调用总数（测试护栏，见 §14「单测铁律」）。 */
export { realDockerCliCallCount, resetRealDockerCliStats };

/** 便捷：构造一份已解析配置（默认值 + 给定层）。 */
export function makeResolvedConfig(
  layer: SandboxConfigLayer = {},
  opts: { explicit?: boolean } = {},
): ResolvedSandboxConfig {
  const { config, provenance } = mergeSandboxLayers([{ source: 'project', layer }]);
  return {
    config,
    provenance,
    warnings: [],
    errors: [],
    explicit: opts.explicit ?? Object.keys(layer).length > 0,
  };
}

export interface FakeRuntimeHandle {
  runtime: SandboxRuntime;
  cli: FakeDockerCli;
  notices: SandboxNotice[];
  warns: string[];
  debugArgvs: string[][];
}

/**
 * 构造注入了 FakeDockerCli 的 SandboxRuntime（不产生任何真实 docker 调用）。
 * 默认 config: mode=docker（explicit=true，便于断言 meta）。
 */
export function makeSandboxRuntime(
  deps: Partial<SandboxRuntimeDeps> = {},
  opts: { layer?: SandboxConfigLayer; script?: Record<string, FakeHandler> } = {},
): FakeRuntimeHandle {
  const cli = new FakeDockerCli(opts.script ?? {});
  const notices: SandboxNotice[] = [];
  const warns: string[] = [];
  const debugArgvs: string[][] = [];
  const runtime = createSandboxRuntime({
    projectRoot: deps.projectRoot ?? process.cwd(),
    sessionId: deps.sessionId ?? 'sess-1a2b3c4d',
    projectId: deps.projectId ?? 'proj-1',
    resolved: deps.resolved ?? makeResolvedConfig(opts.layer ?? { mode: 'docker' }, { explicit: true }),
    interactive: deps.interactive ?? false,
    cli,
    ...(deps.confirmDegrade ? { confirmDegrade: deps.confirmDegrade } : {}),
    ...(deps.onPullProgress ? { onPullProgress: deps.onPullProgress } : {}),
    onNotice: (n) => {
      notices.push(n);
      deps.onNotice?.(n);
    },
    onWarning: (m) => {
      warns.push(m);
      deps.onWarning?.(m);
    },
    onDebugArgv: (argv) => {
      debugArgvs.push(argv);
      deps.onDebugArgv?.(argv);
    },
  });
  return { runtime, cli, notices, warns, debugArgvs };
}
