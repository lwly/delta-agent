/**
 * F-55 外部 CLI Agent 事件映射引擎（docs/design-f55-external-cli-agents.md §4）。
 *
 * 职责切分红线：
 *   - 本文件只懂映射（ExternalEvent → AgentEvent + 落库语义），
 *     不 import 任何协议解析（ACP/JSONL）模块 —— 协议细节只属于 adapter。
 *   - history / images 参数仅为对齐既有引擎签名（runReAct 等）：外部会话的上下文
 *     由 CLI 进程自管，delta 只把本次 prompt（input）交给 CLI，二者在此刻意忽略。
 *
 * 禁止产出的事件（黑盒 CLI 无法承载的语义，见设计稿 §4 末行）：
 *   compact_*（CLI 自己管上下文）、budget_alert / budget_exhausted / budget_degraded
 *   （无法对黑盒降级）、subtask_* / review_verdict（无 DAG）。
 */
import type { AgentEvent, ChatMessage, MessageImage, Plan, TaskNode, ToolCall, ToolResult, Usage } from '@delta/shared';
import type { RunContext } from './react.js';
import type { ExternalEvent } from '../external/types.js';
import { resolveExternalAdapter } from '../external/registry.js';
import { buildDeltaMcpFile } from '../external/mcp-passthrough.js';

/** tool_result.content 保尾截断上限（字符；与 F-54 task_output 的 MAX_BG_OUTPUT 同口径） */
const TOOL_RESULT_MAX_CHARS = 50_000;

/**
 * 外部会话主循环：消费 adapter 的 ExternalEvent 流，产出 AgentEvent。
 * done 必达：无论上游是否发过 done、是否异常退出，流结束时都会产出一次
 * {type:'done', usage}（hub 的 saveTurnAssistant() 依赖收尾）。
 */
export async function* runExternalAgent(
  ctx: RunContext,
  history: ChatMessage[],
  input: string,
  images?: MessageImage[],
): AsyncGenerator<AgentEvent> {
  // 见文件头注释：两参数仅为对齐引擎签名，外部会话不使用
  void history;
  void images;

  const usageTotal: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  if (ctx.signal.aborted) {
    yield { type: 'error', message: 'aborted by user', fatal: false };
    yield { type: 'done', usage: usageTotal };
    return;
  }

  const adapter = resolveExternalAdapter(ctx.model);
  if (!adapter) {
    yield { type: 'error', message: `external_agent_not_found: ${ctx.model}`, fatal: true };
    yield { type: 'done', usage: usageTotal };
    return;
  }

  // 权限档位存于 PermissionState.policy.mode；缺省（未装配权限体系）= default
  const permissionMode = ctx.toolContext.permissions?.policy.mode ?? 'default';

  // 启动门禁（设计稿 §5.1）：plan 档要求上游具备只读能力。
  // Tier A（ACP）内建 request_permission 逐次拦截，不受此限；Tier B/C 靠 permissionArgs.plan
  // flags 降档，flags 为空说明上游没有只读档 → 拒绝启动（能力降级必须显式告知，不静默放行）。
  if (permissionMode === 'plan' && adapter.spec.tier !== 'A' && adapter.spec.permissionArgs.plan.length === 0) {
    yield {
      type: 'error',
      message: `external_no_plan_mode: 外部 agent ${adapter.spec.id} 不支持只读档，拒绝启动（plan 档）`,
      fatal: true,
    };
    yield { type: 'done', usage: usageTotal };
    return;
  }

  // headless 按 turn 记 usage 需要 turn_start；外部会话单 prompt 单 turn
  yield { type: 'turn_start', turn: 1 };

  /** tool_use 打点：id → 收到时间，tool_result 时算耗时；无配对 start 则 ms=0 */
  const toolStarts = new Map<string, number>();
  /** tool_use 缓存：id → 原始 ToolCall（tool_result 事件要回填完整 call） */
  const toolCalls = new Map<string, ToolCall>();
  /** 上游是否有过 text/thinking 产出（决定非零退出的 fatal 判定） */
  let produced = false;
  /** 上游退出码（ExternalEvent done 携带；流结束但没发 done 视作异常） */
  let exitCode: number | undefined;
  /** 上游是否已发过 fatal error（去重：进程非零退出时不再重复报错） */
  let upstreamFatal = false;

  // MCP 透传（设计稿 §6）：spec 声明了 mcpArgs 才生成临时配置文件（delta- 前缀别名），
  // 经 mcpConfigPath 交给 adapter 展开 --mcp-config 类参数；finally（收尾区）在 done 产出后、
  // return 前删除临时文件——覆盖正常收尾 / abort / 消费方提前 break 全部路径。
  const mcpFile = adapter.spec.mcpArgs
    ? buildDeltaMcpFile({ projectRoot: ctx.toolContext.projectRoot, sessionId: ctx.sessionId })
    : null;

  try {
    const stream = adapter.run({
      prompt: input,
      cwd: ctx.toolContext.projectRoot,
      permissionMode,
      resumeSessionId: undefined, // P3 会话续跑阶段接入
      mcpConfigPath: mcpFile?.configPath ?? undefined,
      signal: ctx.signal,
    });

    try {
      for await (const ev of stream) {
        switch (ev.type) {
          case 'text':
            produced = true;
            yield { type: 'text_delta', text: ev.text };
            break;
          case 'thinking':
            // thinking 只透传展示，不进上下文（hub/headless 本就忽略 thinking_delta）
            produced = true;
            yield { type: 'thinking_delta', text: ev.text };
            break;
          case 'tool_use': {
            // argsJson 原样透传，不 parse —— 避免二次序列化改变字节
            const call: ToolCall = { id: ev.id, name: ev.name, argsJson: ev.argsJson };
            toolCalls.set(ev.id, call);
            toolStarts.set(ev.id, Date.now());
            yield { type: 'tool_call_start', call };
            break;
          }
          case 'tool_result': {
            const start = toolStarts.get(ev.id);
            const ms = start !== undefined ? Math.max(0, Date.now() - start) : 0;
            toolStarts.delete(ev.id);
            const result: ToolResult = {
              callId: ev.id,
              name: toolCalls.get(ev.id)?.name ?? '',
              ok: ev.ok,
              content: truncateTail(ev.content),
            };
            yield { type: 'tool_result', call: toolCalls.get(ev.id) ?? { id: ev.id, name: '', argsJson: '' }, result, ms };
            break;
          }
          case 'permission_request': {
            // 权限三档映射（设计稿 §5.1）——与 PermissionState.check（tools/permissions.ts）同语义：
            //   plan：只读自动放行、写/执行直接拒绝（不走确认流）；
            //   default：会话记忆（allow_session）/ allowlist 已放行 → 自动 allow，否则走确认流；
            //   yolo：全放行。
            const permissions = ctx.toolContext.permissions;

            // ── plan 档 ──
            if (permissionMode === 'plan') {
              // 只读类 kind（ACP toolCall.kind）自动放行，不弹确认卡。
              // 依据：PermissionState.check 在 plan 档对只读工具（toolCapability === 'read'）
              // 直接 { action: 'allow' }，从不走确认 —— 外部映射保持同语义。
              if (ev.toolKind === 'read' || ev.toolKind === 'search' || ev.toolKind === 'think' || ev.toolKind === 'fetch') {
                adapter.respondPermission?.(ev.id, 'allow');
                break;
              }
              // 其余 kind（edit/delete/execute/move）及未知 kind 一律拒绝。
              // 未知即拒（安全默认）：无法证明该请求只读，宁可拒绝也不放行写/执行类副作用。
              adapter.respondPermission?.(ev.id, 'reject');
              yield {
                type: 'error',
                message: `外部 agent 的 ${ev.tool} 请求在 plan 档被拒绝（写/执行类操作）`,
                fatal: false,
              };
              break;
            }

            // ── yolo 档：全放行，不调 confirm、不发确认事件 ──
            if (permissionMode === 'yolo') {
              adapter.respondPermission?.(ev.id, 'allow');
              break;
            }

            // ── default 档 ──
            // 会话记忆（allow_session）或 allowlist 已含该工具 → 自动 allow（与 F-23 会话记忆语义一致）
            if (permissions?.isSessionAllowed(ev.tool) || permissions?.isAllowlisted(ev.tool)) {
              adapter.respondPermission?.(ev.id, 'allow');
              break;
            }
            // 确认卡 publish 由 hub 注入的 toolContext.confirm 负责（hub.ts 737 行），
            // 这里不再重复产出 confirm_request 事件 —— 与 react 引擎同一路径。
            // headless 形态下 hub 注入的 confirm 自动 reject，default 档自然收敛为拒绝，无需特判。
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(ev.argsJson) as Record<string, unknown>;
            } catch {
              // 解析失败按空参数确认（卡片至少展示工具名与风险提示）
            }
            const decision = await ctx.toolContext.confirm({
              id: ev.id,
              tool: ev.tool,
              args,
              reason: '外部 agent 请求执行 ' + ev.tool,
            });
            if (decision.kind === 'allow_session') {
              // F-23 会话记忆：先记入 PermissionState 再回包（口径与 tools/registry.ts 一致——
              // 记被请求的工具名），同工具后续请求在本会话内不再弹卡。
              permissions?.allowSession(ev.tool);
            }
            // ConfirmDecision 四值 → 回包三值：edit 视作 reject（外部 agent 无法回填编辑参数）
            const reply = decision.kind === 'allow' ? 'allow' : decision.kind === 'allow_session' ? 'allow_session' : 'reject';
            adapter.respondPermission?.(ev.id, reply);
            break;
          }
          case 'plan': {
            // 只展示，不进 DAG：占位节点 + external 标记，UI 据此禁用编辑/重执行
            const nodes: TaskNode[] = ev.steps.map((s, i) => ({
              id: `ext-plan-${i}`,
              goal: s.title,
              deps: i > 0 ? [`ext-plan-${i - 1}`] : [],
              suggestedTools: [],
              status: mapExternalStatus(s.status),
              retries: 0,
            }));
            const plan: Plan = {
              goal: ev.steps.map((s) => s.title).join(' → '),
              nodes,
              revision: 0,
              createdAt: Date.now(),
              external: true,
            };
            yield { type: 'plan_created', plan };
            break;
          }
          case 'usage': {
            const usage: Usage = { inputTokens: ev.input, outputTokens: ev.output, costUsd: 0 };
            usageTotal.inputTokens += ev.input;
            usageTotal.outputTokens += ev.output;
            yield { type: 'usage', usage, model: ctx.model, billing: 'subscription' };
            break;
          }
          case 'external_session':
            // TODO(F-55 P3)：会话续跑阶段使用（--resume），当前仅记 debug 语义，直接忽略
            break;
          case 'error':
            if (ev.fatal) upstreamFatal = true;
            yield { type: 'error', message: ev.message, fatal: ev.fatal };
            break;
          case 'done':
            exitCode = ev.exitCode;
            break;
        }
        if (exitCode !== undefined) break; // 上游已宣告退出，流随即结束
      }
    } catch (e) {
      yield { type: 'error', message: (e as Error).message, fatal: true };
    }

    // ── 收尾：done 必达 ──
    if (ctx.signal.aborted) {
      // 用户 abort：文案与三引擎逐字一致
      yield { type: 'error', message: 'aborted by user', fatal: false };
      yield { type: 'done', usage: usageTotal };
      return;
    }
    const code = exitCode ?? -1;
    if (code !== 0 && !upstreamFatal) {
      // 设计稿 §9：进程异常时把 stderr 环形缓冲前 20 行随 error 带出（adapter 可缺省）
      const stderrLines = adapter.stderrTail?.().slice(0, 20) ?? [];
      const stderrNote = stderrLines.length > 0 ? `：${stderrLines.join(' ⏎ ')}` : '';
      yield {
        type: 'error',
        message: `外部 agent 进程退出（exit ${code}）${stderrNote}`,
        // 无任何产出且非零退出 = 真失败；有产出则模型已给出结果，仅进程异常收尾
        fatal: !produced,
      };
    }
    yield { type: 'done', usage: usageTotal };
  } finally {
    mcpFile?.cleanup(); // done 产出之后、return 前删除临时 MCP 配置文件（幂等）
  }
}

/** 内容过长时保尾截断（与 F-54 同口径：保留末尾，头部加标记行） */
function truncateTail(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_CHARS) return content;
  const omitted = content.length - TOOL_RESULT_MAX_CHARS;
  return `（内容过长，前 ${omitted} 字符已截断，仅保留末尾 ${TOOL_RESULT_MAX_CHARS} 字符）\n${content.slice(-TOOL_RESULT_MAX_CHARS)}`;
}

/** 外部 plan step 状态 → TaskNodeStatus（未知值安全回退 pending） */
function mapExternalStatus(status: string): TaskNode['status'] {
  switch (status) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'done';
    case 'in_progress':
    case 'running':
      return 'running';
    case 'failed':
    case 'error':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}
