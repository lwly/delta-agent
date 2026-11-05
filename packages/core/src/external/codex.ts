// F-55 Tier C 外部适配器：Codex app-server v2（JSON-RPC 2.0 over stdio，换行分隔）。
//
// 职责切分（务必遵守，与 acp.ts 同构）：
//   - 本文件只懂 codex app-server 协议（JSON-RPC 线上消息 → ExternalEvent）
//   - ExternalEvent → AgentEvent 的映射归 engine/external.ts（改映射不必动协议层）
//   - 进程生命周期底座归 spawn.ts（本文件不直接碰 child_process）
//
// 协议权威（codex-cli 0.162.0-alpha.17.2，2026-11-05 实测回写）：
//   - `codex app-server generate-json-schema` 生成 v2 schema；本文件字段名以 schema + 真机
//     probe 双重确认（probe：initialize/thread/start 握手与回包拼写与 schema 完全一致）。
//   - method 名实测：客户端请求 `initialize` / `thread/start` / `thread/resume` / `turn/start` /
//     `turn/interrupt`；客户端通知 `initialized`；服务端通知用斜杠拼写
//     `thread/started` / `turn/started` / `turn/completed` / `item/started` / `item/completed` /
//     `item/agentMessage/delta` / `item/reasoning/textDelta` / `item/reasoning/summaryTextDelta` /
//     `thread/tokenUsage/updated` / `error`；服务端审批请求
//     `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`（v2）与
//     `execCommandApproval` / `applyPatchApproval`（legacy API）。
//   - 运行时对未知字段宽容：未知通知方法、未知 item 类型、未知回包字段一律忽略/透传。
//
// Tier C 权限语义（设计稿 §5.1）：无 ACP 级逐次 option 协商，但 v2 有 server→client 审批请求
// （桥接为 permission_request，toolKind 必填——plan 档拦截依赖映射引擎的同一通道）。
//   - default 档不追加 flags：上游审批请求走桥接确认流；headless 下 confirm 自动 reject。
//   - yolo 档 `--dangerously-bypass-approvals-and-sandbox`（codex --help 实测存在，0.162.0-alpha.17.2）。
//   - plan 档无只读模式 → permissionArgs.plan=[]，由映射引擎 external_no_plan_mode 门禁拒绝启动。
import { spawnExternal, type SpawnedProcess } from './spawn.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from './types.js';

/**
 * env 白名单：与 ACP（acp.ts ACP_ENV_WHITELIST）/ stream-json（PROVIDER_ENV_WHITELIST）同口径的
 * provider 自身变量清单。不改 acp.ts（红线），故在此单独列出、注释互指。订阅登录态 CLI 自行管理，
 * delta 不注入任何密钥——白名单之外的变量一律不透传给子进程。
 */
const CODEX_ENV_WHITELIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
] as const;

/** 审批请求类别：决定 respondPermission 的 decision 拼写（v2 与 legacy 枚举不同，见 schema） */
type ApprovalKind = 'execV2' | 'fileChangeV2' | 'execLegacy' | 'patchLegacy';

/**
 * decision 映射（schema 实测枚举）：
 *   - v2：CommandExecutionApprovalDecision / FileChangeApprovalDecision =
 *     accept / acceptForSession / decline / cancel → allow / allow_session / reject 取安全者
 *     （acceptForSession 是会话级记忆、非跨会话提权，语义与 ACP allow_always 对齐）。
 *   - legacy：ReviewDecision = approved / approved_for_session / denied / … 同理。
 * allow_session 的记忆归映射引擎（engine/external.ts），adapter 只管回包拼写。
 */
const DECISION_MAP: Record<ApprovalKind, Record<'allow' | 'allow_session' | 'reject', string>> = {
  execV2: { allow: 'accept', allow_session: 'acceptForSession', reject: 'decline' },
  fileChangeV2: { allow: 'accept', allow_session: 'acceptForSession', reject: 'decline' },
  execLegacy: { allow: 'approved', allow_session: 'approved_for_session', reject: 'denied' },
  patchLegacy: { allow: 'approved', allow_session: 'approved_for_session', reject: 'denied' },
};

/** JSON-RPC 线上消息的宽松形状（只声明用到的部分，未知字段宽容） */
interface CodexIncomingMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class CodexExternalAdapter implements ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec;

  constructor(spec: ExternalAgentSpec) {
    this.spec = spec;
  }

  /** 最近一次 run() 的进程句柄（stderrTail 供映射引擎收尾带出 stderr 摘要） */
  private lastProc: SpawnedProcess | null = null;
  /** 我方发出的 JSON-RPC 请求等待表：key = String(id)，value = 回包 resolve/reject */
  private pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  /** server→client 审批请求等待表：key = permissionId（JSON-RPC 请求 id 字符串化） */
  private pendingPermissions = new Map<string, { rpcId: number | string; kind: ApprovalKind }>();
  private nextId = 1;
  private threadId: string | null = null;
  /** 当前 turn id（turn/start 回包 turn.id；turn/interrupt 必须带 threadId+turnId，schema required） */
  private turnId: string | null = null;
  private exitSeen = false;

  stderrTail(): string[] {
    return this.lastProc?.stderrTail() ?? [];
  }

  /**
   * 权限应答：把 delta 确认流的决定映射回审批 decision（v2 accept 系 / legacy approved 系）。
   * permissionId 已不在等待表（已答复 / 超时 / 会话已结束）→ 静默忽略，不崩。
   */
  respondPermission(permissionId: string, decision: 'allow' | 'allow_session' | 'reject'): void {
    const entry = this.pendingPermissions.get(permissionId);
    if (!entry) return;
    this.pendingPermissions.delete(permissionId);
    this.respond(entry.rpcId, { decision: DECISION_MAP[entry.kind][decision] });
  }

  async *run(req: {
    prompt: string;
    cwd: string;
    permissionMode: 'plan' | 'default' | 'yolo';
    resumeSessionId?: string;
    mcpConfigPath?: string;
    signal: AbortSignal;
  }): AsyncGenerator<ExternalEvent> {
    // 每 run 重置会话态（adapter 实例可串行复用）
    this.pending.clear();
    this.pendingPermissions.clear();
    this.nextId = 1;
    this.threadId = null;
    this.turnId = null;
    this.exitSeen = false;

    const proc = spawnExternal({
      command: this.spec.command,
      // 'app-server' 子命令由本适配器按协议静态携带（kind 'app-server-jsonl' 的协议知识，
      // 不进 detect 探测层——与 stream-json 适配器自行组装 '-p/--output-format' 同原则）；
      // 测试 spec.args 指向 fixture 脚本时 fixture 忽略多余 argv。
      args: [...this.spec.args, 'app-server', ...(this.spec.permissionArgs[req.permissionMode] ?? [])],
      cwd: req.cwd,
      envWhitelist: [...CODEX_ENV_WHITELIST],
      signal: req.signal,
      onAbort: () => {
        // abort → 先发 turn/interrupt（threadId+turnId 都已知才有意义）；宽限期后由
        // spawnExternal 杀进程组兜底（Tier C 无 ACP 级 cancel 的优雅度，协议+杀进程双层收敛）。
        // fire-and-forget：不 await 回包（宽限期只有 300ms），pending 拒绝由 abort 钩子兜底。
        if (this.threadId !== null && this.turnId !== null) {
          this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
        }
      },
      // 测试支撑（对齐 FAKE_ACP_SCRIPT / FAKE_CLAUDE_SCRIPT 先例）：FAKE_CODEX_SCRIPT 指向
      // fixture 场景 JSON 时镜像注入子进程 env；生产不设置该变量，零影响。
      extraEnv: process.env.FAKE_CODEX_SCRIPT ? { FAKE_CODEX_SCRIPT: process.env.FAKE_CODEX_SCRIPT } : undefined,
    });
    this.lastProc = proc;

    // ---- 出站事件汇聚队列：行分派与协议驱动并发跑，经此串行产出给消费方（同 acp.ts） ----
    const outQueue: ExternalEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (ev: ExternalEvent): void => {
      outQueue.push(ev);
      const w = wake;
      wake = null;
      w?.();
    };

    // abort 时拒绝所有挂起请求，避免协议驱动在回包上悬挂
    const rejectAllPending = (message: string): void => {
      for (const entry of this.pending.values()) entry.reject(new Error(message));
      this.pending.clear();
    };
    const onAbortReject = (): void => rejectAllPending('aborted');
    if (req.signal.aborted) queueMicrotask(onAbortReject);
    else req.signal.addEventListener('abort', onAbortReject, { once: true });

    // ---- 行分派：消费进程事件流，JSON-RPC 分派（独立于协议驱动，保证不因等回包而停读） ----
    const dispatch = async (): Promise<void> => {
      for await (const ev of proc.events) {
        if (ev.type === 'line') {
          this.handleLine(ev.text, push);
        } else if (ev.type === 'exit') {
          this.exitSeen = true;
          rejectAllPending(`外部 agent 进程已退出（exit ${ev.code ?? -1}）`);
          push({ type: 'done', exitCode: ev.code ?? -1 });
          return;
        }
        // stderr_line：已进环形缓冲（stderrTail 透传），不上抛
      }
    };
    let dispatchSettled = false;
    const dispatchPromise = dispatch()
      .catch((err: Error) => {
        if (!this.exitSeen) push({ type: 'error', message: `codex 行分派异常：${err.message}`, fatal: false });
      })
      .finally(() => {
        dispatchSettled = true;
        wake?.();
        wake = null;
      });

    // ---- 协议驱动：initialize → thread/start|thread/resume → turn/start；靠 pending 表等回包 ----
    const driver = async (): Promise<void> => {
      try {
        // 握手第一步必须在读 stdout 首行前发出（spawn stdin 即写，管道缓冲保证顺序）
        await this.request('initialize', {
          clientInfo: { name: 'delta-agent', version: this.spec.version },
          capabilities: {},
        });
        this.notify('initialized', {});
        // resume：thread/resume 按 threadId 恢复（协议级，不经 CLI flags；spec.resumeArgs 不设）
        const startResult = await this.request(
          req.resumeSessionId ? 'thread/resume' : 'thread/start',
          req.resumeSessionId ? { threadId: req.resumeSessionId, cwd: req.cwd } : { cwd: req.cwd },
        );
        const threadId = (startResult?.thread as Record<string, unknown> | undefined)?.id;
        if (typeof threadId !== 'string') throw new Error('thread/start 回包缺少 thread.id');
        this.threadId = threadId;
        push({ type: 'external_session', id: threadId });
        const turnResult = await this.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: req.prompt }],
        });
        const turnId = (turnResult?.turn as Record<string, unknown> | undefined)?.id;
        if (typeof turnId === 'string') this.turnId = turnId;
        // turn/start 回包到达：等 turn/completed 通知（行分派产出事件），收到后关 stdin 让 agent 自然退出
      } catch (err) {
        if (req.signal.aborted) return; // abort 路径：done 由行分派产出，abort 语义归映射引擎
        if (this.exitSeen) return; // 进程已退出：done 已带退出码，不再补 error
        push({
          type: 'error',
          message: `codex 会话失败：${err instanceof Error ? err.message : String(err)}`,
          fatal: true,
        });
        proc.endStdin(); // 尽量让进程自行收敛；不退由消费方 abort / cancel 兜底
      }
    };
    void driver();

    try {
      for (;;) {
        while (outQueue.length > 0) yield outQueue.shift()!;
        if (dispatchSettled) return; // done 已产出且队列清空
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      req.signal.removeEventListener('abort', onAbortReject);
      // 消费方提前 return（收到 done 即 break）时确保子进程收敛；已退出时幂等
      await proc.cancel();
      await dispatchPromise;
    }
  }

  // ---- JSON-RPC 发送侧 ----

  /** 发送 JSON-RPC 请求并等回包；stdin 不可写（进程已死）立即抛错 */
  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      const ok = this.lastProc?.writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      if (!ok) {
        this.pending.delete(String(id));
        reject(new Error(`写入 stdin 失败（进程已退出或不可写）：${method}`));
      }
    });
  }

  /** 发送 JSON-RPC 通知（无需回包；写失败静默——通知本就无回执） */
  private notify(method: string, params: unknown): void {
    this.lastProc?.writeLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** 对 server→client 的请求回 result（审批应答） */
  private respond(id: number | string, result: unknown): void {
    this.lastProc?.writeLine(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  /** 对 server→client 的请求回错误（本任务只桥接审批类；动态工具调用 / elicitation 等后续按需开放） */
  private respondError(id: number | string, method: string | undefined): void {
    this.lastProc?.writeLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not supported by delta: ${method ?? '<unknown>'}` },
      }),
    );
  }

  // ---- JSON-RPC 接收侧 ----

  private handleLine(text: string, push: (ev: ExternalEvent) => void): void {
    let msg: CodexIncomingMessage;
    try {
      msg = JSON.parse(text) as CodexIncomingMessage;
    } catch {
      // 非法 JSON 行不致命：透出原始行，会话继续（宽容原则；超长截断由 spawn.ts 处理）
      push({ type: 'error', message: `codex 输出行不是合法 JSON：${text}`, fatal: false });
      return;
    }
    if (typeof msg !== 'object' || msg === null) {
      push({ type: 'error', message: `codex 输出行不是合法 JSON：${text}`, fatal: false });
      return;
    }

    // 1) response（我方请求的回包，无 method 字段）
    if (msg.method === undefined && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(String(msg.id));
      if (!entry) return; // 未知 id 的回包：忽略（宽容）
      this.pending.delete(String(msg.id));
      if (msg.error !== undefined) {
        entry.reject(new Error(`codex 请求失败（${msg.error.code}）：${msg.error.message}`));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    // 2) request（server→client，必须回包）
    if (msg.method !== undefined && msg.id !== undefined) {
      this.handleServerRequest(msg, push);
      return;
    }

    // 3) notification
    if (msg.method !== undefined) {
      this.mapNotification(msg.method, msg.params ?? {}, push);
    }
  }

  /** server→client 请求分派：只桥接四类审批请求，其余 method-not-found（宽容） */
  private handleServerRequest(msg: CodexIncomingMessage, push: (ev: ExternalEvent) => void): void {
    const params = msg.params ?? {};
    const method = msg.method!;
    let kind: ApprovalKind | null = null;
    let tool = 'tool';
    let argsJson = '';
    let toolKind: string | undefined;

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        // v2 形状：{itemId, command?, cwd?, reason?, ...}（schema CommandExecutionRequestApprovalParams）
        kind = 'execV2';
        toolKind = 'execute';
        tool = firstWord(typeof params.command === 'string' ? params.command : '') || 'command';
        argsJson = JSON.stringify(pickDefined({ command: params.command, cwd: params.cwd, reason: params.reason }));
        break;
      }
      case 'item/fileChange/requestApproval': {
        // v2 形状：{itemId, reason?, grantRoot?, ...}（schema FileChangeRequestApprovalParams）
        kind = 'fileChangeV2';
        toolKind = 'edit';
        tool = 'fileChange';
        argsJson = JSON.stringify(pickDefined({ reason: params.reason, grantRoot: params.grantRoot }));
        break;
      }
      case 'execCommandApproval': {
        // legacy 形状：{callId, command: string[], cwd, parsedCmd, reason?}（schema ExecCommandApprovalParams）
        kind = 'execLegacy';
        toolKind = 'execute';
        const cmd = Array.isArray(params.command) ? (params.command as string[]).join(' ') : '';
        tool = firstWord(cmd) || 'execCommand';
        argsJson = JSON.stringify(pickDefined({ command: params.command, cwd: params.cwd, reason: params.reason }));
        break;
      }
      case 'applyPatchApproval': {
        // legacy 形状：{callId, fileChanges, grantRoot?, reason?}（schema ApplyPatchApprovalParams）
        kind = 'patchLegacy';
        toolKind = 'edit';
        tool = 'applyPatch';
        const files = params.fileChanges && typeof params.fileChanges === 'object' ? Object.keys(params.fileChanges) : [];
        argsJson = JSON.stringify(pickDefined({ files, grantRoot: params.grantRoot, reason: params.reason }));
        break;
      }
      default:
        // 其他 server→client 请求（item/tool/call、elicitation、permissions/requestApproval 等）：
        // 一律 method-not-found（P3 范围外；codex MCP 透传 P4+ 再议）
        this.respondError(msg.id!, method);
        return;
    }

    // permissionId 用 JSON-RPC 请求 id 字符串化：respondPermission 回包时按它回查审批类别
    const permissionId = String(msg.id);
    this.pendingPermissions.set(permissionId, { rpcId: msg.id!, kind });
    push({
      type: 'permission_request',
      id: permissionId,
      tool,
      argsJson,
      // delta 确认流的语义选项（allow_session 的记忆归映射引擎）
      options: ['allow', 'reject'],
      // toolKind 必填：plan 档拦截依赖映射引擎对 execute/edit 的判定（Tier C 吃同一映射引擎）
      toolKind,
    });
  }

  /** turn/completed 后缓存的 usage：thread/tokenUsage/updated 通知 → {input, output}（按 turnId 去重） */
  private usageByTurn = new Map<string, { input: number; output: number }>();

  /**
   * 服务端通知 → ExternalEvent（未知方法忽略——宽容原则，schema 演进中）。
   * method 拼写为 2026-11-05 真机 probe 实测（斜杠式，与 schema 一致）。
   */
  private mapNotification(method: string, params: Record<string, unknown>, push: (ev: ExternalEvent) => void): void {
    switch (method) {
      case 'item/agentMessage/delta': {
        // 完整 agentMessage item 由 delta 覆盖，item/completed 不重复产出
        if (typeof params.delta === 'string' && params.delta !== '') {
          push({ type: 'text', text: params.delta });
        }
        break;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        // 思考类 delta（schema ReasoningTextDelta / ReasoningSummaryTextDelta 通知）→ thinking
        if (typeof params.delta === 'string' && params.delta !== '') {
          push({ type: 'thinking', text: params.delta });
        }
        break;
      }
      case 'item/started': {
        const item = asRecord(params.item);
        if (item?.type === 'commandExecution') {
          // 命令执行 item：name 取 command 首词，argsJson 为输入摘要
          const command = typeof item.command === 'string' ? item.command : '';
          push({
            type: 'tool_use',
            id: typeof item.id === 'string' ? item.id : '',
            name: firstWord(command) || 'command',
            argsJson: JSON.stringify(pickDefined({ command, cwd: item.cwd })),
          });
        } else if (item?.type === 'fileChange') {
          push({
            type: 'tool_use',
            id: typeof item.id === 'string' ? item.id : '',
            name: 'fileChange',
            argsJson: JSON.stringify(item.changes ?? []),
          });
        }
        // 其他 item 类型（reasoning/agentMessage/plan/…）：delta 已覆盖或不适用，忽略
        break;
      }
      case 'item/completed': {
        const item = asRecord(params.item);
        if (item?.type === 'commandExecution') {
          // ok：exitCode 优先（null 宽容回退 status）；输出取 aggregatedOutput
          const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
          const ok = exitCode !== null ? exitCode === 0 : item.status === 'completed';
          push({
            type: 'tool_result',
            id: typeof item.id === 'string' ? item.id : '',
            ok,
            content: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
          });
        } else if (item?.type === 'fileChange') {
          push({
            type: 'tool_result',
            id: typeof item.id === 'string' ? item.id : '',
            ok: item.status === 'completed',
            content: JSON.stringify(item.changes ?? []),
          });
        }
        break;
      }
      case 'error': {
        // ErrorNotification：{error: TurnError{message, codexErrorInfo?}, threadId, turnId, willRetry}
        const error = asRecord(params.error);
        const message = typeof error?.message === 'string' ? error.message : '未知错误';
        // codexErrorInfo 枚举（unauthorized/contextWindowExceeded/usageLimitExceeded/…）随文案带出，
        // 便于用户定位（auth 类问题一眼可辨）；对象形状取首键宽容处理
        const info = error?.codexErrorInfo;
        const infoText = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] ?? '' : '';
        const text = infoText !== '' ? `codex_error:${infoText}：${message}` : `codex: ${message}`;
        // fatal 固定 false：fatal 判定归映射引擎（turn/completed error / 非零退出 / 无产出兜底）。
        // unauthorized 建议同样不 fatal：willRetry=true 的瞬时错误同走此通道，且上游失败会在
        // turn/completed(turn.error) 与退出码上体现，映射引擎据「无产出」判 fatal 更可靠。
        push({ type: 'error', message: text, fatal: false });
        break;
      }
      case 'thread/tokenUsage/updated': {
        // TokenCount 通知：{threadId, turnId, tokenUsage:{last:{inputTokens, outputTokens, ...}, total}}
        const usage = asRecord(params.tokenUsage);
        const last = asRecord(usage?.last);
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        if (turnId !== '' && last) {
          // 按 turnId 缓存：通知可能随流式多次到达，turn/completed 时统一产出一次，避免重复累计
          this.usageByTurn.set(turnId, {
            input: typeof last.inputTokens === 'number' ? last.inputTokens : 0,
            output: typeof last.outputTokens === 'number' ? last.outputTokens : 0,
          });
        }
        break;
      }
      case 'turn/completed': {
        // TurnCompletedNotification：{threadId, turn:{id, status, error?, items, ...}}
        const turn = asRecord(params.turn);
        const turnId = typeof turn?.id === 'string' ? turn.id : '';
        const usage = turnId !== '' ? this.usageByTurn.get(turnId) : undefined;
        if (usage) {
          this.usageByTurn.delete(turnId);
          push({ type: 'usage', input: usage.input, output: usage.output });
        }
        const error = asRecord(turn?.error);
        if (error && typeof error.message === 'string' && error.message !== '') {
          // turn 失败/中断：TurnError 随文案带出（fatal:false，同 error 通知——判定归映射引擎）
          push({ type: 'error', message: `codex turn 失败：${error.message}`, fatal: false });
        }
        // turn 结束：关 stdin 让 codex 自然退出（exit 事件 → done 由行分派产出）
        this.lastProc?.endStdin();
        break;
      }
      default:
        // thread/started / turn/started / warning / mcpServer/* 等其余通知：忽略（宽容原则）
        break;
    }
  }
}

/** 未知值的宽松对象收窄 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** 命令串首词（name 展示用）；空串回 '' */
function firstWord(command: string): string {
  const w = command.trim().split(/\s+/)[0] ?? '';
  return w;
}

/** 摘要对象：剔除 undefined 字段（避免 JSON.stringify 出 "key":undefined 噪声） */
function pickDefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
