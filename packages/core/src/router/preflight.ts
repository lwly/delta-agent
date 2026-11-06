/**
 * F-58 派单前置门禁（设计稿 §6④/§6⑥、D7）：外部 executor 的 Worker 在启动前必须
 * 显式通过四道检查，任何一道失败 → needs_decision（不建会话、不拉进程、禁止静默重试）：
 *   ① executor 解析不到已注册的 adapter（未探测/未启用）→ executor_unresolved
 *   ② probeAgent 失败/超时（--version 探测，缺省 PROBE_TIMEOUT_MS=3000）→ probe_failed
 *   ③ 登录态缺失 → login_required
 *   ④ 任务要求 plan 档但目标 agent 不支持只读 → plan_unsupported
 *
 * 数据源与 GET /api/external-agents（http.ts:1310）同源：同一份 detect 结果 + 同一个
 * loginState 判据 + 同一条 planSupported 口径（permissionArgs.plan 非空）。差异只有一处：
 * Tier A（ACP）在 plan 档下不被本门禁拒绝——它能逐次拦截 session/request_permission
 * （对齐引擎侧启动门禁 external.ts 的 tier !== 'A' 口径，§6⑥ 注）。
 *
 * 测试红线（计划·风险 1）：CI 不装真 CLI——detect/probe/login 全部可注入，
 * 单测一律 fake，PATH 上即使恰好有同名二进制也不会被拉起。
 */
import {
  type DetectedAgent,
  type KnownAgentDef,
  PROBE_TIMEOUT_MS,
  checkLoginState,
  detectExternalAgents,
  findKnownAgent,
  probeAgent,
} from '../external/detect.js';
import { resolveExternalAdapter } from '../external/registry.js';
import type { PreflightResult, WorkerTaskRow } from './types.js';

/** preflight 可注入依赖（缺省走真实探测；测试注入 fake，进程数为 0） */
export interface PreflightDeps {
  /** 探测入口（缺省 detectExternalAgents；返回 def + command 供 probe 与门禁共用） */
  detect?: () => Promise<DetectedAgent[]>;
  /** 版本探测（缺省 probeAgent；注入点 = 「进程数为 0」断言的落点） */
  probe?: typeof probeAgent;
  /** 登录态判据（缺省 checkLoginState(def)，与 /api/external-agents 同源） */
  checkLogin?: (def: KnownAgentDef) => boolean;
  /** 探测超时（缺省 PROBE_TIMEOUT_MS=3000，与 F-55 §10 同值） */
  probeTimeoutMs?: number;
}

/** 带超时的探测：probe 自身有超时，这里再加一层兜底（防止注入的 probe 永不 resolve 卡死泵） */
async function probeWithTimeout(
  probe: typeof probeAgent,
  def: KnownAgentDef,
  command: string,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([probe(def, command, { probeTimeoutMs: timeoutMs }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 派单前置门禁主入口。内置引擎（executor 为空）无外部前置，直接放行。
 * 检查顺序 = 成本从低到高：注册表（纯内存）→ 探测清单（可能 spawn）→ probe（spawn）
 * → 登录态（本地 fs）→ 三档能力（纯元数据）。
 */
export async function runPreflight(
  task: Pick<WorkerTaskRow, 'executor' | 'permission_mode'>,
  deps: PreflightDeps = {},
): Promise<PreflightResult> {
  if (!task.executor) return { ok: true }; // 内置引擎

  // ① 注册表解析：adapter 未注册 = 该 agent 未探测到或被禁用，绝不留一个跑不起来的外部会话
  const factory = resolveExternalAdapter(task.executor);
  if (!factory) {
    return {
      ok: false,
      reason: 'executor_unresolved',
      message: `executor ${task.executor} 未注册（未探测到或未启用），请先在「外部 Agent」面板确认`,
    };
  }
  const def = findKnownAgent(task.executor);
  if (!def) {
    return {
      ok: false,
      reason: 'executor_unresolved',
      message: `executor ${task.executor} 不是已知模板（KNOWN_AGENTS 无此 id）`,
    };
  }

  // ② 探测：detect 清单命中 + --version 探测通过（超时/非零退出/输出口号文案都算失败）
  const detected = await (deps.detect ?? detectExternalAgents)();
  const hit = detected.find((d) => d.def.id === task.executor);
  if (!hit) {
    return {
      ok: false,
      reason: 'probe_failed',
      message: `${task.executor} 探测不到（未安装或 ${def.executable} --version 失败）`,
    };
  }
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probe = deps.probe ?? probeAgent;
  const version = await probeWithTimeout(probe, hit.def, hit.command, timeoutMs);
  if (version === null) {
    return {
      ok: false,
      reason: 'probe_failed',
      message: `${task.executor} 版本探测失败或超时（${timeoutMs}ms）`,
    };
  }

  // ③ 登录态（与 /api/external-agents 的 loginState 同判据）
  const checkLogin = deps.checkLogin ?? ((d: KnownAgentDef) => checkLoginState(d));
  if (!checkLogin(def)) {
    return {
      ok: false,
      reason: 'login_required',
      message: `${def.label} 未登录，请先完成 CLI 登录再派单`,
    };
  }

  // ④ 只读档门禁（§6⑥）：Tier A 能逐次拦截权限请求，不在拒绝之列（对齐引擎侧口径）；
  // 其余 tier 的 plan flags 为空 = 该 CLI 没有只读档，plan 档任务停住等人裁决
  if (task.permission_mode === 'plan' && def.tier !== 'A' && def.permissionArgs.plan.length === 0) {
    return {
      ok: false,
      reason: 'plan_unsupported',
      message: `任务要求只读（plan 档），但 ${def.label} 不支持只读档（UI 文案：已请求只读，实际尽力而为）`,
    };
  }

  return { ok: true };
}
