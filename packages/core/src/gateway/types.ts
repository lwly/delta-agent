/**
 * 架构收口 T4 —— RunGateway 运行前门禁：类型与策略产出（纯模块）。
 *
 * 职责边界（收口红线）：
 *  - 本目录是**运行前**门禁的纯策略层：只做判定编排与 RunPolicy 产出，
 *    不持 DB 连接、不 import `server/` / `router/`（依赖方向红线）；
 *    文件/进程/DB 等真实探测全部由调用方经 deps 注入；
 *  - 与工具级权限（tools/permissions.ts 的 PermissionState / registry.executeOne
 *    管线）是**两层并存**：本模块管「这轮运行能不能开始」，工具管线管「运行中每个
 *    工具调用是否放行」。工具级判定不收敛进 gateway（红线：不动 registry.executeOne）；
 *  - 顺序固定：workRoot → permission（含 external 4 门禁收敛 step）→ quota → scope
 *    → lifecycle；任一步拒绝即短路返回，后续步骤不执行（判据 1：拒绝时零副作用）。
 */
import type { PermissionMode } from '@delta/shared';

/** 运行发起方（4 类消费路径 + external 目标形态） */
export type RunOrigin = 'chat' | 'worker' | 'router' | 'cron' | 'external';

/** 运行请求（纯数据；探测所需的真实 IO 由 deps 注入） */
export interface RunRequest {
  origin: RunOrigin;
  sessionId?: string;
  projectId?: string;
  /** 会话模型（external-model-as-router lifecycle 门禁输入） */
  model?: string | null;
  /** 外部 executor 标识（origin=external 时 checkExternal 步骤输入；NULL = 内置引擎） */
  executor?: string | null;
  /** 任务级权限档请求（cron job.permission / worker task.permission_mode） */
  permissionMode?: PermissionMode | null;
  /** 会话级权限档（chat/web 路径当前生效档；任务级缺省时回退到此） */
  sessionPermissionMode?: PermissionMode | null;
  /** yolo 双重开启确认（Web 二次确认 / CLI 双 flag 归一后的布尔） */
  yoloConfirmed?: boolean;
}

/** 运行策略（gateway 的正向产出：权限归一 + 非交互 spawn 参数单点） */
export interface RunPolicy {
  permissionMode: PermissionMode;
  /**
   * 非交互 spawn 路径的权限参数（yolo 双 flag **单点产出**——判据 2：
   * spawn-executor 等 CLI 子进程路径唯一来源，禁止旁路再写一份）。
   * plan → ['--permission','plan']；yolo → ['--permission','yolo','--yolo']；default → []。
   */
  spawnPermissionArgs: string[];
  /** plan 档只读（Web PermissionState 与 cron/worker 非交互路径共用的判定来源） */
  readOnly: boolean;
}

/** 门禁拒绝原因（机器码；preflight ①–④ 的 reason 与此处并列收敛） */
export type GateReason =
  | 'workroot_missing'
  | 'permission_denied'
  | 'plan_unsupported'
  | 'quota_exceeded'
  | 'scope_unsupported'
  | 'lifecycle_stale'
  | 'external_router_model'
  | 'executor_unresolved'
  | 'probe_failed'
  | 'login_required';

/** 单步判定结果 */
export type GateStep = { ok: true } | { ok: false; reason: GateReason; message: string };

/** 门禁总结果：ok 时携带 RunPolicy */
export interface GateResult {
  ok: boolean;
  reason?: GateReason;
  message?: string;
  policy?: RunPolicy;
}

/** 可注入依赖（全部可选；缺省 = 该步骤放行） */
export interface RunGatewayDeps {
  /** 工作根目录检查（目录存在 / 归属；真实 fs 探测由调用方注入） */
  checkWorkRoot?(req: RunRequest): GateStep | Promise<GateStep>;
  /** 配额检查（会话预算 / 子代理预留 / 并发槽位等；T7 QuotaStore 后统一注入） */
  checkQuota?(req: RunRequest): GateStep | Promise<GateStep>;
  /** 作用域检查（work_root 白名单 / 沙箱作用域支持） */
  checkScope?(req: RunRequest): GateStep | Promise<GateStep>;
  /** 生命周期检查（终态拒绝 / external-model-as-router 等结构性拦截） */
  checkLifecycle?(req: RunRequest): GateStep | Promise<GateStep>;
  /**
   * external origin：preflight 4 门禁（executor_unresolved / probe_failed /
   * login_required / plan_unsupported）**收敛为这一个 step**（判据 3：reason
   * 一一对应透传）；dispatcher 注入 runPreflight 适配器，gateway 不 import router/。
   */
  checkExternal?(req: RunRequest): GateStep | Promise<GateStep>;
  /**
   * external origin 的 plan 档支持判定（tier / permissionArgs.plan 口径；
   * 与 preflight ④ 同源。缺省 = 支持（不在 gateway 层重复拒绝，由 checkExternal 判）。
   */
  externalPlanSupported?(req: RunRequest): boolean;
}
