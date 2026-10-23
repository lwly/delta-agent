/**
 * F-29 Headless / SDK 形态 —— 非交互任务运行内核。
 *
 * 职责：以既有引擎（ReAct / Plan-and-Execute / Multi-Agent）驱动一次完整任务，
 * 面向 CI 流水线与脚本集成提供：
 * - 非交互语义：高危确认自动拒绝、ask_user 自动应答、计划自动批准（均有记录）
 * - 退出码协议（headlessExitCode）：0 成功 / 2 引擎致命错误 / 3 达最大轮次 / 4 预算耗尽 / 5 被中断
 *   （1 为 CLI 层配置/参数错误，在引擎启动前由入口直接设置）
 * - 结构化输出（buildHeadlessReport）：最终结果 + 用量 + 工具调用 + 确认拒绝记录
 *
 * 本模块不触碰 stdio / process（便于测试与 SDK 复用），终端交互由 CLI 入口承担。
 */
import type {
  AgentEvent,
  ChatMessage,
  ConfirmDecision,
  ConfirmRequest,
  MessageImage,
  PlanApprovalRequest,
  PlanDecision,
  ToolCall,
} from '@y-zero/shared';
import type { RunContext } from './engine/react.js';

// ── 类型 ────────────────────────────────────────────────────────────────────

export type HeadlessStatus =
  | 'completed' // 任务正常完成
  | 'failed' // 引擎致命错误
  | 'max_turns' // 达最大轮次未完成
  | 'budget_exhausted' // 预算耗尽
  | 'aborted'; // 被 SIGINT / 外部信号中断

export interface HeadlessDeniedConfirmation {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface HeadlessToolCallSummary {
  id: string;
  name: string;
  ok: boolean;
}

/**
 * F-30 沙箱段（`--json` 的 `sandbox` 键）。
 * **只在沙箱显式启用时输出**（未配置沙箱的用户 JSON 报告不新增任何字段，AC-30-1）；
 * 不含 cost/token —— 容器耗时与镜像不进 F-31 用量口径。
 */
export interface HeadlessSandboxRun {
  command_head: string;
  exit_code: number | null;
  ms: number;
  container?: string;
}

export interface HeadlessSandboxState {
  /** 'seatbelt' = macOS 原生 sandbox-exec（方案 C 默认隔离后端） */
  mode: 'local' | 'seatbelt' | 'docker';
  image: string;
  network: 'none' | 'bridge';
  enforced: boolean;
  degraded: boolean;
  runs: HeadlessSandboxRun[];
}

export interface HeadlessOutcome {
  status: HeadlessStatus;
  /** 最终助手文本（最后一个工具调用之后的文本块；全程无工具调用则为全部文本） */
  result: string;
  /** 完整流式转写（各轮助手文本顺序拼接，供调试） */
  transcript: string;
  turns: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  toolCalls: HeadlessToolCallSummary[];
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>;
  deniedConfirmations: HeadlessDeniedConfirmation[];
  /** ask_user 提问记录（headless 下自动应答） */
  askUserQuestions: string[];
  /** 自动批准的计划数 */
  planApprovals: number;
  /** F-30：仅沙箱显式启用时存在（缺省 = 不输出、不新增字段） */
  sandbox?: HeadlessSandboxState;
  error: string | null;
  durationMs: number;
  sessionId: string;
  projectId: string;
}

/** runHeadless 依赖的会话持久化最小接口（SessionService 结构性满足，测试可伪造）。 */
export interface HeadlessService {
  appendMessage(sessionId: string, m: ChatMessage): void;
  getHistory(sessionId: string): ChatMessage[];
  recordUsage(sessionId: string, turn: number, input: number, output: number, costUsd: number, model?: string): void;
  recordCompaction(sessionId: string, before: number, after: number, summary: string): void;
}

export interface HeadlessDeps {
  /** 已构建好的运行上下文；confirm/askUser/planApproval/signal 由 runHeadless 覆盖 */
  base: RunContext;
  service: HeadlessService;
  /** 引擎分发器（CLI 按模式传 runReAct/runPlanExecute/runMultiAgent；测试传伪造） */
  engine: (ctx: RunContext, history: ChatMessage[], input: string, images?: MessageImage[]) => AsyncIterable<AgentEvent>;
  /** 外部中断信号（CLI SIGINT / SDK 调用方控制）；缺省仅内部 AbortController */
  externalSignal?: AbortSignal;
  /** 事件旁路钩子（CLI 进度输出到 stderr；不影响主流程，钩子抛错被吞掉） */
  onEvent?: (ev: AgentEvent) => void;
  /**
   * F-30：沙箱状态读取器（入口在 runtime 显式启用时提供；缺省 = 报告不含 sandbox 段）。
   * 支持函数形态：runs[] 在任务执行过程中累积，报告需要在结束时读取最终快照。
   */
  sandboxState?: HeadlessSandboxState | (() => HeadlessSandboxState | undefined);
}

// ── headless 非交互应答 ─────────────────────────────────────────────────────

const AUTO_ANSWER =
  '（headless 非交互模式：无可用用户输入，请基于已有上下文自行决策并继续）';

const AUTO_REJECT_REASON =
  'headless 非交互模式自动拒绝高危操作；如需放行请使用 --allow 工具白名单或 --permission yolo + --yolo';

// ── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * 以非交互语义运行一次任务：把 user 输入落库 → 驱动引擎消费事件流 →
 * 落库助手/工具消息 → 返回结构化结果。退出码经 headlessExitCode 映射。
 */
export async function runHeadless(
  deps: HeadlessDeps,
  task: string,
  images?: MessageImage[],
): Promise<HeadlessOutcome> {
  const { base, service, engine } = deps;
  const startedAt = Date.now();

  const ac = new AbortController();
  const onExternalAbort = () => ac.abort();
  if (deps.externalSignal) {
    if (deps.externalSignal.aborted) ac.abort();
    else deps.externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const deniedConfirmations: HeadlessDeniedConfirmation[] = [];
  const askUserQuestions: string[] = [];
  let planApprovals = 0;

  // headless 语义注入：确认自动拒绝 / 提问自动应答 / 计划自动批准
  const confirm = async (req: ConfirmRequest): Promise<ConfirmDecision> => {
    deniedConfirmations.push({ id: req.id, tool: req.tool, args: req.args ?? {}, reason: req.reason });
    return { kind: 'reject', reason: AUTO_REJECT_REASON };
  };
  const askUser = async (question: string): Promise<string> => {
    askUserQuestions.push(question);
    return AUTO_ANSWER;
  };
  const planApproval = async (req: PlanApprovalRequest): Promise<PlanDecision> => {
    planApprovals++;
    void req;
    return { kind: 'approve' };
  };

  const ctx: RunContext = {
    ...base,
    signal: ac.signal,
    planApproval,
    toolContext: {
      ...base.toolContext,
      signal: ac.signal,
      confirm,
      askUser,
      todos: base.toolContext.todos ?? [],
    },
  };

  const history = service.getHistory(ctx.sessionId);
  const userMessage: ChatMessage = { role: 'user', content: task };
  if (images && images.length > 0) userMessage.images = images; // F-25 图片附件随 user 消息落库
  service.appendMessage(ctx.sessionId, userMessage);

  // ── 事件消费状态 ──
  const collectedCalls: ToolCall[] = [];
  const toolCalls: HeadlessToolCallSummary[] = [];
  const blocks: string[] = []; // 文本块：每个工具轮次切分一段
  let current = '';
  let savedCallCount = 0; // 已随助手消息落库的调用数（assistant 消息按轮落库）
  let turnCount = 0;
  let finalText = '';
  let usageTotal = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let fatalMessage: string | null = null;
  let maxTurnsReached = false;
  let budgetExhausted = false;

  // assistant 消息按轮落库：本轮文本 + 自上次落库以来的 toolCalls 一起写入
  const saveAssistantWithCalls = () => {
    if (savedCallCount >= collectedCalls.length && !current) return;
    service.appendMessage(ctx.sessionId, {
      role: 'assistant',
      content: current,
      toolCalls: collectedCalls.slice(savedCallCount),
    });
    savedCallCount = collectedCalls.length;
    current = '';
  };

  try {
    for await (const ev of engine(ctx, history, task, images)) {
      if (deps.onEvent) {
        try {
          deps.onEvent(ev);
        } catch {
          // 进度旁路失败不影响主流程
        }
      }
      switch (ev.type) {
        case 'turn_start':
          turnCount = ev.turn;
          break;
        case 'text_delta':
          current += ev.text;
          break;
        case 'tool_call_start':
          collectedCalls.push(ev.call);
          break;
        case 'tool_result':
          // 落库本轮助手消息（文本 + 本轮 calls），文本块归档供最终结果回退
          if (current) blocks.push(current);
          saveAssistantWithCalls();
          toolCalls.push({ id: ev.call.id, name: ev.call.name, ok: ev.result.ok });
          service.appendMessage(ctx.sessionId, {
            role: 'tool',
            content: ev.result.content,
            toolCallId: ev.call.id,
          });
          break;
        case 'compact_done':
          service.recordCompaction(ctx.sessionId, ev.beforeTokens, ev.afterTokens, '');
          break;
        case 'usage':
          usageTotal = {
            inputTokens: usageTotal.inputTokens + ev.usage.inputTokens,
            outputTokens: usageTotal.outputTokens + ev.usage.outputTokens,
            costUsd: usageTotal.costUsd + (ev.usage.costUsd ?? 0),
          };
          if (turnCount > 0) {
            service.recordUsage(
              ctx.sessionId,
              turnCount,
              ev.usage.inputTokens,
              ev.usage.outputTokens,
              ev.usage.costUsd ?? 0,
              ev.model ?? ctx.model,
            );
          }
          break;
        case 'budget_exhausted':
          budgetExhausted = true;
          break;
        case 'error':
          if (ev.fatal) {
            fatalMessage = ev.message;
          } else if (/reached max turns/i.test(ev.message)) {
            maxTurnsReached = true;
          }
          break;
        default:
          break;
      }
    }
  } catch (e) {
    fatalMessage = (e as Error).message;
  } finally {
    finalText = current; // 先捕获最后一段文本，再落库（落库会重置 current）
    saveAssistantWithCalls();
    deps.externalSignal?.removeEventListener('abort', onExternalAbort);
  }

  // ── 状态判定（优先级：预算耗尽 > 致命错误 > 中断 > 达轮次上限 > 完成） ──
  const status: HeadlessStatus = budgetExhausted
    ? 'budget_exhausted'
    : fatalMessage !== null
      ? 'failed'
      : ac.signal.aborted
        ? 'aborted'
        : maxTurnsReached
          ? 'max_turns'
          : 'completed';

  // 最终结果：最后一个工具轮次之后的文本；为空时回退到最后一个文本块
  const result = finalText || (blocks.length > 0 ? blocks[blocks.length - 1]! : '');

  // F-30：只在入口显式提供时输出 sandbox 段（默认用户 JSON 不多任何字段）
  const sandbox = resolveSandboxState(deps.sandboxState);

  return {
    status,
    result,
    transcript: [...blocks, finalText].filter((t) => t.length > 0).join(''),
    turns: turnCount,
    usage: usageTotal,
    toolCalls,
    todos: ctx.toolContext.todos ?? [],
    deniedConfirmations,
    askUserQuestions,
    planApprovals,
    ...(sandbox ? { sandbox } : {}),
    error: fatalMessage,
    durationMs: Date.now() - startedAt,
    sessionId: ctx.sessionId,
    projectId: ctx.projectId,
  };
}

/** 读取沙箱快照（函数形态在读失败时降级为「无 sandbox 段」，绝不影响报告生成）。 */
function resolveSandboxState(
  source: HeadlessSandboxState | (() => HeadlessSandboxState | undefined) | undefined,
): HeadlessSandboxState | undefined {
  if (!source) return undefined;
  if (typeof source === 'function') {
    try {
      return source();
    } catch {
      return undefined;
    }
  }
  return source;
}

// ── 退出码协议 ──────────────────────────────────────────────────────────────

/**
 * F-29 退出码协议（供 CI 判定）：
 * - 0 completed：任务完成
 * - 1 usage：配置/参数错误（provider 未配置、会话不存在等，引擎启动前由 CLI 设置）
 * - 2 failed：引擎致命错误（LLM 连续失败、工具崩溃外溢等）
 * - 3 max_turns：达最大轮次未完成（可用 --max-turns 调大）
 * - 4 budget_exhausted：Token/费用预算耗尽
 * - 5 aborted：被 SIGINT / 外部信号中断
 */
export function headlessExitCode(status: HeadlessStatus): 0 | 2 | 3 | 4 | 5 {
  switch (status) {
    case 'completed':
      return 0;
    case 'failed':
      return 2;
    case 'max_turns':
      return 3;
    case 'budget_exhausted':
      return 4;
    case 'aborted':
      return 5;
  }
}

// ── 结构化输出（--json）────────────────────────────────────────────────────

export interface HeadlessJsonReport {
  ok: boolean;
  status: HeadlessStatus;
  exit_code: number;
  session_id: string;
  project_id: string;
  result: string;
  turns: number;
  duration_ms: number;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  tool_calls: HeadlessToolCallSummary[];
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>;
  denied_confirmations: HeadlessDeniedConfirmation[];
  ask_user_questions: string[];
  plan_approvals: number;
  /** F-30：仅沙箱显式启用时输出（缺省字段不出现） */
  sandbox?: HeadlessSandboxState;
  error: string | null;
}

/** HeadlessOutcome → --json 报告（字段 snake_case，供脚本稳定消费）。 */
export function buildHeadlessReport(outcome: HeadlessOutcome): HeadlessJsonReport {
  return {
    ok: outcome.status === 'completed',
    status: outcome.status,
    exit_code: headlessExitCode(outcome.status),
    session_id: outcome.sessionId,
    project_id: outcome.projectId,
    result: outcome.result,
    turns: outcome.turns,
    duration_ms: outcome.durationMs,
    usage: {
      input_tokens: outcome.usage.inputTokens,
      output_tokens: outcome.usage.outputTokens,
      cost_usd: outcome.usage.costUsd,
    },
    tool_calls: outcome.toolCalls,
    todos: outcome.todos,
    denied_confirmations: outcome.deniedConfirmations,
    ask_user_questions: outcome.askUserQuestions,
    plan_approvals: outcome.planApprovals,
    // F-30：沙箱未显式启用时该键完全不出现（AC-30-1 / AC-30-10 后半）
    ...(outcome.sandbox ? { sandbox: outcome.sandbox } : {}),
    error: outcome.error,
  };
}
