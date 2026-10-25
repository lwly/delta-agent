/**
 * F-30 容器级沙箱 —— 全量类型与默认常量（配置 / 探测 / 执行计划 / meta / notice）。
 *
 * 设计依据：docs/design-f30-container-sandbox.md
 *  - §3.1 配置类型与默认值
 *  - §4    探测结果类型
 *  - §7.1  执行计划（纯函数输入输出）
 *  - §8.2  meta.sandbox / badge
 *
 * 本文件**只放类型与常量**，没有副作用、不触碰 fs / 子进程，可被任意层安全导入。
 */
import type { ConfirmDecision, ConfirmRequest } from '@delta/shared';

// ── 配置 ────────────────────────────────────────────────────────────────────

/**
 * 用户可见的执行模式枚举（`auto` 只是降级算法的内部概念，不落盘）。
 *  - `local`：不隔离（默认，零影响）
 *  - `seatbelt`：macOS 原生 sandbox-exec（方案 C 的**默认隔离后端**，免安装免 daemon）
 *  - `docker`：容器隔离（可选后端，服务器 / Linux 场景保留）
 */
export type SandboxMode = 'local' | 'seatbelt' | 'docker';
export type SandboxNetwork = 'none' | 'bridge';
/** deny = fail-closed（默认）｜ask = 交互式询问｜local = 显式接受降级 */
export type SandboxFallback = 'deny' | 'ask' | 'local';
export type SandboxConfigSource = 'user' | 'project' | 'session';

/**
 * 默认镜像：固定到 minor 线（跟随安全补丁，不锁 patch），
 * 且自带 node / pnpm / npm —— delta 自身与绝大多数目标项目可直接跑。
 */
export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm-slim';

export interface SandboxConfig {
  /** 唯一执行模式真值源（不存在 enabled / auto 双真值源） */
  mode: SandboxMode;
  /** 仅项目级生效：true 时会话/单次覆盖只能更严，且 fallback 强制 deny */
  enforce: boolean;
  fallback: SandboxFallback;
  image: string;
  network: SandboxNetwork;
  /** --memory / --memory-swap（MB） */
  memoryMb: number;
  /** --cpus */
  cpus: number;
  /** --pids-limit，防 fork bomb */
  pidsLimit: number;
  /** 根文件系统只读 */
  readOnlyRoot: boolean;
  /** '1000:1000'；null = 使用镜像默认用户（自定义镜像默认如此） */
  user: string | null;
  /** 派生字段：是否有任一显式层写了 user（决定 image 换掉后要不要清空 user） */
  userExplicit: boolean;
  /** 可写临时区（随容器销毁，不污染宿主 HOME） */
  tmpfs: string[];
  /** 镜像拉取独立超时（不计入命令超时） */
  pullTimeoutMs: number;
  /** 宿主 env 名称白名单（默认 [] = 零继承；只透传名字，值由 docker 子进程 env 继承） */
  env: string[];
  /** true = 不传 --rm，也不做清理（供 inspect 调试） */
  keepContainer: boolean;
  /** P2 预留：本期解析但忽略（恒为 null，会产出 warning） */
  cacheVolume: string | null;
}

/**
 * 需要逐字段 merge 的字段（顺序无关，但测试依赖此清单做「来源」断言）。
 * `userExplicit` 是派生字段，不参与 merge。
 */
export const SANDBOX_MERGE_FIELDS = [
  'mode',
  'enforce',
  'fallback',
  'image',
  'network',
  'memoryMb',
  'cpus',
  'pidsLimit',
  'readOnlyRoot',
  'user',
  'tmpfs',
  'pullTimeoutMs',
  'env',
  'keepContainer',
  'cacheVolume',
] as const;

export type SandboxMergeField = (typeof SANDBOX_MERGE_FIELDS)[number];

/**
 * 全局默认值（PRD §6）。注意：`tmpfs` / `env` 数组在 merge 时若未被任何层覆盖，
 * 会与默认对象共享同一引用 —— 运行期只读，不做原地修改。
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mode: 'local',
  enforce: false,
  fallback: 'deny',
  image: DEFAULT_SANDBOX_IMAGE,
  network: 'none',
  memoryMb: 2048,
  cpus: 2,
  pidsLimit: 512,
  readOnlyRoot: true,
  user: '1000:1000',
  userExplicit: false,
  tmpfs: ['/tmp', '/home/node'],
  pullTimeoutMs: 300_000,
  env: [],
  keepContainer: false,
  cacheVolume: null,
};

/** 每个字段最终由谁决定（`sandbox status` 展示「来源」用）。 */
export type SandboxConfigProvenance = Record<SandboxMergeField, SandboxConfigSource | 'default'>;

/**
 * 单层配置：undefined = 未声明（继承下层）。
 * `null` 仅在 user / cacheVolume 上有语义（显式「用镜像默认用户」/「不要缓存卷」）。
 */
export type SandboxConfigLayer = Partial<Omit<SandboxConfig, 'userExplicit'>>;

export interface SandboxConfigWarning {
  source: SandboxConfigSource | 'cli';
  field?: string;
  message: string;
}

export interface SandboxConfigError {
  source: SandboxConfigSource | 'cli';
  message: string;
}

export interface ResolvedSandboxConfig {
  config: SandboxConfig;
  provenance: SandboxConfigProvenance;
  warnings: SandboxConfigWarning[];
  /** 硬拒（该层整体不生效）；非空时该层字段全部不参与 merge */
  errors: SandboxConfigError[];
  /** 是否被显式配置过（false = 纯默认：不显示徽标、headless 不输出 sandbox 段、不产出 meta） */
  explicit: boolean;
}

/**
 * 会话/单次覆盖（CLI flag / Web 会话设置）。
 * 前四个字段是设计 §3.1 的公开面；资源类字段为 T02 内部（及未来 Web 表单）预留，
 * `enforce` 下同样只能更严（见 config.ts:checkEnforce 的偏序表）。
 */
export interface SandboxSessionOverrides {
  mode?: SandboxMode;
  image?: string;
  network?: SandboxNetwork;
  fallback?: SandboxFallback;
  readOnlyRoot?: boolean;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
}

// ── 探测 ────────────────────────────────────────────────────────────────────

export type SandboxProbeReason =
  | 'cli_missing'
  | 'daemon_down'
  | 'permission_denied'
  | 'timeout'
  /** 仅由 runtime 合成（镜像拉取失败），probeDocker() 永不产出 */
  | 'image_unavailable'
  /** local 实现的 probe() 恒为此值 */
  | 'not_applicable';

export interface SandboxProbeResult {
  available: boolean;
  serverVersion?: string;
  reason?: SandboxProbeReason;
  /** 判定依据（进错误文案第一行）：如「daemon 未运行（docker version 退出码 1）」 */
  detail: string;
  probedAt: number;
  fromCache: boolean;
}

export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_TTL_MS = 30_000;

// ── 执行计划（纯函数）──────────────────────────────────────────────────────

export type ExecutionAction = 'local' | 'seatbelt' | 'docker' | 'deny' | 'ask';

export type ExecutionReason =
  | 'mode_local' // 配置 local：不探测、零开销
  | 'seatbelt_ready' // sandbox-exec 可用
  | 'docker_ready'
  | 'fallback_deny'
  | 'enforced_deny' // enforce 下不可用：唯一允许的动作
  | 'fallback_ask' // 交互式：等用户点头
  | 'fallback_ask_headless' // 非交互：ask ≡ deny
  | 'fallback_local' // 用户显式接受降级
  | 'degrade_approved'; // ask 已获准（本会话记忆）

export interface ExecutionPlan {
  action: ExecutionAction;
  reason: ExecutionReason;
}

// ── 结果 meta / 徽标 / notice ───────────────────────────────────────────────

/** 写入 `ToolResult.meta.sandbox`（只有显式启用或 docker 模式才出现，见设计 Z3/Z4）。 */
export interface SandboxMeta {
  mode: SandboxMode;
  image?: string;
  containerName?: string;
  /** seatbelt 模式：本次使用的 SBPL profile 文件路径（诊断用，每次运行可复用同一份） */
  profile?: string;
  network?: SandboxNetwork;
  exitCode: number | null;
  ms: number;
  pulled: boolean;
  degraded?: boolean;
  /** P1：透传的 env 变量个数（只给数量，不列名字） */
  passthroughEnv?: number;
}

/**
 * 确认卡 / 工具卡片徽标。**只读缓存，绝不触发探测**（D7）。
 *
 * 注：shared 包内有一份结构完全一致的 `SandboxBadge`（渲染契约在 shared，
 * 而 shared 不能反向依赖 core）；两处都是纯结构类型，赋值天然兼容。
 */
export interface SandboxBadge {
  mode: SandboxMode;
  image?: string;
  network?: SandboxNetwork;
  /** 缓存中的探测结论（undefined = 未知；false 时卡片加一行「当前不可用，将按 fallback 处理」） */
  available?: boolean;
}

export type SandboxNoticeKind = 'degraded' | 'pulled' | 'unavailable' | 'gc_suggest';

/** 与 `AgentEvent.sandbox_notice` 的 payload 同构（shared 侧由入口 sink 发出，引擎零改动）。 */
export interface SandboxNotice {
  kind: SandboxNoticeKind;
  detail: string;
}

/**
 * 降级确认请求：复用 `ConfirmRequest` 协议，但走独立通道（D9），
 * 并用 `variant='sandbox_degrade'` 让 UI 只渲染 允许/拒绝 两个选项。
 */
export interface SandboxConfirmRequest extends ConfirmRequest {
  sandbox?: SandboxBadge;
  variant?: 'permission' | 'sandbox_degrade';
}

export type SandboxConfirmDegrade = (req: SandboxConfirmRequest) => Promise<ConfirmDecision>;

// ── 状态快照（status / headless --json / Web）───────────────────────────────

export interface SandboxRunRecord {
  /** 命令头部（截断，供报告展示） */
  command: string;
  mode: SandboxMode;
  exitCode: number | null;
  ms: number;
  container?: string;
  denied?: boolean;
  degraded?: boolean;
}

export interface SandboxStatus {
  mode: SandboxMode;
  explicit: boolean;
  enforce: boolean;
  fallback: SandboxFallback;
  image: string;
  network: SandboxNetwork;
  /** 镜像是否已在本地（mode=local 或 docker 不可用时为 false） */
  imagePresent: boolean;
  /**
   * 当前后端的探测结论（字段名历史遗留：seatbelt 模式下是 sandbox-exec 的探测结果，
   * local 模式下恒 not_applicable）。改名会破坏既有 `sandbox status` 消费方，故保留。
   */
  docker: SandboxProbeResult;
  /** 残留容器名（label 前缀 delta-） */
  residues: string[];
  provenance: SandboxConfigProvenance;
  warnings: SandboxConfigWarning[];
  errors: SandboxConfigError[];
}

export interface PullResult {
  ok: boolean;
  image: string;
  /** true = 本次真的执行了 pull（false = 本地已有） */
  pulled: boolean;
  detail: string;
}

export interface GcResult {
  removed: number;
  names: string[];
}

export interface SandboxStateSnapshot {
  explicit: boolean;
  mode: SandboxMode;
  image: string;
  network: SandboxNetwork;
  enforced: boolean;
  degraded: boolean;
  probe: SandboxProbeResult | null;
  runs: SandboxRunRecord[];
}

// ── 错误类型 ────────────────────────────────────────────────────────────────

/**
 * 路径/工作区不安全：在**任何 docker 调用之前**抛出（AC-30-4 的断言点）。
 * 文案统一包含「sandbox 配置不允许」（PRD F-30.6）。
 */
export class SandboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxPathError';
  }
}

/**
 * 容器启动前置条件不满足（典型是镜像拉取失败）。
 * runtime 会把它合成为 `probe={available:false, reason:'image_unavailable'}` 再走降级链。
 */
export class SandboxUnavailableError extends Error {
  constructor(
    public readonly reason: SandboxProbeReason,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = 'SandboxUnavailableError';
  }
}
