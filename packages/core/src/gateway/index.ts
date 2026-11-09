/**
 * 架构收口 T4 —— RunGateway 门禁编排入口（纯策略）。
 *
 * authorizeRun(req, deps)：按 workRoot → permission（含 external 收敛 step）→
 * quota → scope → lifecycle 固定顺序执行，任一步拒绝即短路；全部通过时产出
 * RunPolicy（权限归一 + yolo 双 flag 序列化单点）。
 *
 * 无状态纯策略：不持 DB 连接、不 import `server/` / `router/`（判据 4 的硬约束）；
 * 跨进程同输入同输出——测试以纯输入断言。
 */
import type { PermissionMode } from '@delta/shared';
import type {
  GateResult,
  GateStep,
  RunGatewayDeps,
  RunPolicy,
  RunRequest,
} from './types.js';

export type {
  GateReason,
  GateResult,
  GateStep,
  RunGatewayDeps,
  RunOrigin,
  RunPolicy,
  RunRequest,
} from './types.js';

/** 非法权限档输入的归一（未知值 → default，与 CLI resolvePermissionMode 口径一致） */
function normalizeMode(mode: PermissionMode | null | undefined): PermissionMode {
  return mode === 'plan' || mode === 'yolo' ? mode : 'default';
}

/**
 * yolo 双 flag 的 spawn 参数序列化（**单点产出**——判据 2：spawn-executor 等
 * 非交互路径唯一来源）。
 *   plan   → ['--permission', 'plan']
 *   yolo   → ['--permission', 'yolo', '--yolo']（缺一会被 CLI resolvePermissionMode 降级）
 *   default → []（沿用 CLI 默认）
 */
export function spawnPermissionArgsFor(mode: PermissionMode): string[] {
  if (mode === 'plan') return ['--permission', 'plan'];
  if (mode === 'yolo') return ['--permission', 'yolo', '--yolo'];
  return [];
}

/**
 * RunPolicy 产出（权限归一）：
 *  - 任务级 permissionMode 优先，缺省回退会话级 sessionPermissionMode，再缺省 default；
 *  - yolo 双重确认：origin=cron 视为已确认（Web 建 cron 时的 yolo 二次确认已在
 *    任务级落库，F-22b 既有口径）；其余 origin 需 yoloConfirmed === true，
 *    否则 permission_denied（gate 拒绝，不产出 policy）。
 */
export function buildRunPolicy(req: RunRequest): { ok: true; policy: RunPolicy } | { ok: false; reason: 'permission_denied'; message: string } {
  // 任务级显式请求（含显式 default）优先；未提供时回退会话级，再缺省 default
  const requested: PermissionMode = req.permissionMode
    ? normalizeMode(req.permissionMode)
    : normalizeMode(req.sessionPermissionMode ?? undefined);
  if (requested === 'yolo' && req.origin !== 'cron' && req.yoloConfirmed !== true) {
    return {
      ok: false,
      reason: 'permission_denied',
      message: 'yolo 模式需双重确认（Web 二次确认 / CLI --permission yolo + --yolo），本次拒绝运行',
    };
  }
  return {
    ok: true,
    policy: {
      permissionMode: requested,
      spawnPermissionArgs: spawnPermissionArgsFor(requested),
      readOnly: requested === 'plan',
    },
  };
}

/** 单步执行 helper：步骤缺省 = 放行 */
async function runStep(
  step: ((req: RunRequest) => GateStep | Promise<GateStep>) | undefined,
  req: RunRequest,
): Promise<GateStep> {
  if (!step) return { ok: true };
  return step(req);
}

/**
 * 运行前门禁总入口。顺序固定：workRoot → permission（policy 产出 + external 收敛
 * step）→ quota → scope → lifecycle；任一步拒绝即短路（后续步骤不执行、不产生任何
 * 副作用——LLM 调用 / spawn / 消息落库由调用方在 gate.ok 后才发起）。
 */
export async function authorizeRun(req: RunRequest, deps: RunGatewayDeps = {}): Promise<GateResult> {
  // ① workRoot（成本最低的目录/归属检查）
  const workRoot = await runStep(deps.checkWorkRoot, req);
  if (!workRoot.ok) return workRoot;

  // ② permission：RunPolicy 产出（含 yolo 双确认拒绝）+ plan/external 能力对齐
  const policy = buildRunPolicy(req);
  if (!policy.ok) return { ok: false, reason: policy.reason, message: policy.message };
  if (
    req.origin === 'external' &&
    policy.policy.readOnly &&
    deps.externalPlanSupported?.(req) === false
  ) {
    return {
      ok: false,
      reason: 'plan_unsupported',
      message: '任务要求只读（plan 档），但目标 agent 不支持只读档',
    };
  }

  // ③ quota（T7 QuotaStore 后统一注入；当前调用方可注入并发/预算判定）
  const quota = await runStep(deps.checkQuota, req);
  if (!quota.ok) return quota;

  // ④ scope（work_root 白名单 / 沙箱作用域支持）
  const scope = await runStep(deps.checkScope, req);
  if (!scope.ok) return scope;

  // ⑤ lifecycle（终态拒绝 / external-model-as-router 等结构性拦截）
  const lifecycle = await runStep(deps.checkLifecycle, req);
  if (!lifecycle.ok) return lifecycle;

  // ⑥ external origin：preflight 4 门禁收敛为一个 step（reason 一一对应透传，判据 3）
  if (req.origin === 'external') {
    const external = await runStep(deps.checkExternal, req);
    if (!external.ok) return external;
  }

  return { ok: true, policy: policy.policy };
}
