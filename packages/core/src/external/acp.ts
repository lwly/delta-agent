// F-55 Tier A 外部适配器：ACP（Agent Client Protocol，JSON-RPC 2.0 over stdio，换行分隔 JSON）。
//
// 职责切分（务必遵守）：
//   - 本文件只懂 ACP 协议（JSON-RPC 线上消息 → ExternalEvent）
//   - ExternalEvent → AgentEvent 的映射归 engine/external.ts（改映射不必动协议层）
//   - 进程生命周期底座归 spawn.ts（本文件不直接碰 child_process）
//
// 协议纪律（设计稿 §2）：字段名以 ACP 当前 spec 实现为基准；运行时对未知字段宽容——
// 未知 sessionUpdate 类型、未知通知方法、未知回包字段一律忽略/透传，不做猜测性多分支，
// 不为兼容旧版本版本号报错（initialize 的 protocolVersion 差异仅记录不校验）。
import { spawnExternal, type SpawnedProcess } from './spawn.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from './types.js';

/**
 * env 白名单：只放行用户自己环境里已有的 provider 自身变量（订阅登录态 CLI 自行管理，
 * delta 不注入任何密钥——白名单里没有的变量不会透传给子进程）。
 */
const ACP_ENV_WHITELIST = [
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

/** decision → 期望的 option kind（找不到对应 kind 时取第一个 option 兜底） */
const DECISION_TO_KIND: Record<'allow' | 'allow_session' | 'reject', string> = {
  allow: 'allow_once',
  allow_session: 'allow_always',
  reject: 'reject_once',
};

/** ACP 线上消息的宽松形状（字段名以 spec 为准；这里只声明用到的部分，未知字段宽容） */
interface AcpIncomingMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** session/update 里 permission option 的宽松形状 */
interface AcpPermissionOption {
  optionId?: string;
  kind?: string;
}

/**
 * JSON-RPC error 回包的异常载体：code/data 挂在 Error 上——上层据此区分「认证失败」
 * （code -32000 或 data.category==='auth'，codebuddy 实测）与普通协议错。
 */
export class AcpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRpcError';
  }

  /** 认证类错误判定：code -32000 或 data.category === 'auth'（二者其一即认） */
  get isAuthError(): boolean {
    if (this.code === -32000) return true;
    const category = (this.data as Record<string, unknown> | undefined)?.category;
    return category === 'auth';
  }
}

/** initialize 回包 authMethods 的宽松解析：只收 {id, name} 形状项（宽容，缺失字段不给 id） */
function parseAuthMethods(raw: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id === '') continue;
    out.push({ id: rec.id, name: typeof rec.name === 'string' ? rec.name : rec.id });
  }
  return out;
}

/**
 * authenticate 后等待登录链接的保底提示时限：超时仍未收到 auth_url 且未完成认证，
 * 补一条终端登录指引（不让用户对着「正在发起认证…」无限干等）。
 */
const AUTH_URL_HINT_DELAY_MS = 30_000;

export class AcpExternalAdapter implements ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec;

  constructor(spec: ExternalAgentSpec) {
    this.spec = spec;
  }

  /** 最近一次 run() 的进程句柄（stderrTail 供映射引擎收尾带出 stderr 摘要） */
  private lastProc: SpawnedProcess | null = null;
  /** 我方发出的 JSON-RPC 请求等待表：key = String(id)，value = 回包 resolve/reject */
  private pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  /** agent→client 的 request_permission 等待表：key = permissionId（JSON-RPC 请求 id 字符串化） */
  private pendingPermissions = new Map<
    string,
    { rpcId: number | string; options: AcpPermissionOption[] }
  >();
  private nextId = 1;
  private sessionId: string | null = null;
  private exitSeen = false;
  /** 本轮 turn 是否已宣告结束（prompt 回包到达 / 驱动失败收尾）；防 dispatch 重复发 done */
  private turnDone = false;
  /** initialize 回包声明的认证方式清单（session/new 报认证错时挑第一个发起 authenticate） */
  private authMethods: Array<{ id: string; name: string }> = [];
  /** 本次认证是否已收到过登录链接通知（30s 保底提示的判定依据） */
  private authUrlSeen = false;

  stderrTail(): string[] {
    return this.lastProc?.stderrTail() ?? [];
  }

  /** 主动取消当前 run() 的子进程（AC-55-5 dispose 全杀；spawnExternal.cancel 幂等，onAbort 协议取消钩子同路径） */
  async cancel(): Promise<void> {
    await this.lastProc?.cancel();
  }

  /**
   * 权限应答：把 delta 确认流的决定映射回 ACP option（allow→allow_once / allow_session→
   * allow_always / reject→reject_once；找不到对应 kind 取第一个 option 兜底）。
   * permissionId 已不在等待表（已答复 / 超时 / 会话已结束）→ 静默忽略，不崩。
   */
  respondPermission(permissionId: string, decision: 'allow' | 'allow_session' | 'reject'): void {
    const entry = this.pendingPermissions.get(permissionId);
    if (!entry) return;
    this.pendingPermissions.delete(permissionId);
    const wanted = DECISION_TO_KIND[decision];
    const option = entry.options.find((o) => o.kind === wanted) ?? entry.options[0];
    if (!option?.optionId) return; // 无可用 option：无法应答，静默放弃
    this.respond(entry.rpcId, { outcome: { outcome: 'selected', optionId: option.optionId } });
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
    this.sessionId = null;
    this.exitSeen = false;
    this.turnDone = false;
    this.authMethods = [];
    this.authUrlSeen = false;

    const proc = spawnExternal({
      command: this.spec.command,
      // 权限档位 → 追加 flags（缺失档位按空数组）
      args: [...this.spec.args, ...(this.spec.permissionArgs[req.permissionMode] ?? [])],
      cwd: req.cwd,
      envWhitelist: [...ACP_ENV_WHITELIST],
      signal: req.signal,
      onAbort: () => {
        // abort → 先发协议取消（session 已建立才有意义）；宽限期后 spawnExternal 杀进程组
        if (this.sessionId !== null) {
          this.notify('session/cancel', { sessionId: this.sessionId });
        }
      },
      // 测试支撑（对齐 ScriptedExternalAdapter 的 DELTA_FAKE_CLI 先例）：FAKE_ACP_SCRIPT
      // 指向 fixture 场景 JSON 时镜像注入子进程 env；生产不设置该变量，零影响。
      extraEnv: process.env.FAKE_ACP_SCRIPT ? { FAKE_ACP_SCRIPT: process.env.FAKE_ACP_SCRIPT } : undefined,
    });
    this.lastProc = proc;

    // ---- 出站事件汇聚队列：行分派与协议驱动并发跑，经此串行产出给消费方 ----
    const outQueue: ExternalEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (ev: ExternalEvent): void => {
      outQueue.push(ev);
      const w = wake;
      wake = null;
      w?.();
    };

    // abort 时拒绝所有挂起请求，避免协议驱动在 prompt 回包上悬挂
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
          // turn 已宣告结束时不再重复发 done（常驻 agent 是被 cancel 收杀的，退出码无意义）
          if (!this.turnDone) push({ type: 'done', exitCode: ev.code ?? -1 });
          return;
        }
        // stderr_line：已进环形缓冲（stderrTail 透传），不上抛
      }
    };
    let dispatchSettled = false;
    const dispatchPromise = dispatch()
      .catch((err: Error) => {
        if (!this.exitSeen) push({ type: 'error', message: `ACP 行分派异常：${err.message}`, fatal: false });
      })
      .finally(() => {
        dispatchSettled = true;
        wake?.();
        wake = null;
      });

    // ---- 协议驱动：initialize → session/new → session/prompt；靠 pending 表等回包 ----
    const driver = async (): Promise<void> => {
      try {
        // 握手第一步必须在读 stdout 首行前发出（spawn stdin 即写，管道缓冲保证顺序）
        // 接住回包：authMethods 供 session/new 认证失败时自动发起 authenticate
        const initResult = await this.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
        this.authMethods = parseAuthMethods(initResult?.authMethods);
        // 版本协商宽容：agent 回包的 protocolVersion 与我方（1）不同也不报错，仅依赖语义不锁拼写
        const newResult = await this.requestSessionNew(req.cwd, push);
        const sessionId = newResult?.sessionId;
        if (typeof sessionId !== 'string') throw new Error('session/new 回包缺少 sessionId');
        this.sessionId = sessionId;
        push({ type: 'external_session', id: sessionId });
        // prompt 回包到达 = 本轮 turn 结束（ACP 语义，stopReason 随回包返回）。
        // cursor-agent / opencode 等 ACP agent 是常驻 JSON-RPC 服务，答完不会退出进程
        //（旧实现等 exit 才发 done → UI 永远停在「运行中」，cursor-agent 实测回归）。
        // 故回包即发 done 结束本轮；常驻进程由消费方 break → run() finally 的 cancel()
        // 收杀（onAbort 先发 session/cancel 通知，宽限期后杀进程组，幂等）。
        await this.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: req.prompt }],
        });
        this.turnDone = true;
        proc.endStdin(); // 一次性 CLI（答完自退）借此外正常收敛；常驻 agent 不受影响
        push({ type: 'done', exitCode: 0 });
      } catch (err) {
        if (req.signal.aborted) return; // abort 路径：done 由行分派产出，abort 语义归映射引擎
        if (this.exitSeen) return; // 进程已退出：done 已带退出码，不再补 error
        push({
          type: 'error',
          message: `ACP 会话失败：${err instanceof AcpRpcError ? `（code ${err.code}）${err.message}` : err instanceof Error ? err.message : String(err)}`,
          fatal: true,
        });
        // 失败同样立即收尾：常驻 agent 收到协议错误后未必自退，不能等 exit（同上回归）
        this.turnDone = true;
        proc.endStdin();
        push({ type: 'done', exitCode: 1 });
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

  /**
   * session/new：认证类错误（-32000 / data.category==='auth'）且 agent 声明了认证方式时，
   * 自动对第一个 authMethod 发 authenticate（agent 会推登录链接通知），回包（= 登录完成）
   * 后重试一次 session/new；仍失败按普通协议错上抛。agent 未声明认证方式则原样上抛。
   */
  private async requestSessionNew(cwd: string, push: (ev: ExternalEvent) => void): Promise<Record<string, unknown>> {
    try {
      return await this.request('session/new', {
        cwd,
        mcpServers: [], // TODO(P2): MCP 透传（spec.mcpArgs 写临时 mcp.json 后经 args 传入）
      });
    } catch (err) {
      if (!(err instanceof AcpRpcError) || !err.isAuthError || this.authMethods.length === 0) throw err;
      const method = this.authMethods[0]!;
      push({ type: 'auth_required', methods: this.authMethods });
      // authenticate 回包即登录完成（agent 在此期间经 authUrl 类通知推送浏览器链接）
      const authPromise = this.request('authenticate', { methodId: method.id });
      // 保底提示（两阶段，30s）：认证没完成就该给用户说法——
      //   已收到登录链接 → 提示「可能浏览器端没走完 / CLI 无权限写凭据目录」（实测 EPERM 场景）；
      //   没收到链接   → 提示终端登录指引（agent 侧卡住或网络问题）。
      // 旧实现用 !this.authUrlSeen 屏蔽：链接 2.7s 就到、认证却一直没完成时，兜底永远不响，
      // 用户对着「正在发起认证…」无限干等（2026-11 实测踩过）。
      let settled = false;
      void authPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const hintTimer = setTimeout(() => {
        if (settled) return;
        push({
          type: 'error',
          fatal: false,
          message: this.authUrlSeen
            ? 'external_auth_required: 登录链接已发出但认证未完成——可能浏览器端未走完，或 CLI 无权限写入凭据目录'
            : 'external_auth_required: 30s 内未收到登录链接，可在终端运行 codebuddy 完成登录（/login）后重试',
        });
      }, AUTH_URL_HINT_DELAY_MS);
      try {
        await authPromise;
      } catch (authErr) {
        // authenticate 失败原因必须透出（CLI 侧 EPERM 等在 stderr 里，吞掉用户只能干等）
        const tail = this.stderrTail().slice(-3).join(' ').trim();
        push({
          type: 'error',
          fatal: false,
          message: `external_auth_failed: ${authErr instanceof Error ? authErr.message : String(authErr)}${tail ? ` | CLI: ${tail}` : ''}`,
        });
        throw authErr;
      } finally {
        clearTimeout(hintTimer);
      }
      return await this.request('session/new', { cwd, mcpServers: [] });
    }
  }

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

  /** 对 agent→client 的请求回 result（如 request_permission 的应答） */
  private respond(id: number | string, result: unknown): void {
    this.lastProc?.writeLine(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  /** 对 agent→client 的请求回错误（本任务只开放权限协商，文件系统能力后续按需开放） */
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
    let msg: AcpIncomingMessage;
    try {
      msg = JSON.parse(text) as AcpIncomingMessage;
    } catch {
      // 非法 JSON 行不致命：透出原始行，会话继续（宽容原则；超长截断由 spawn.ts 处理）
      push({ type: 'error', message: `ACP 输出行不是合法 JSON：${text}`, fatal: false });
      return;
    }
    if (typeof msg !== 'object' || msg === null) {
      push({ type: 'error', message: `ACP 输出行不是合法 JSON：${text}`, fatal: false });
      return;
    }

    // 1) response（我方请求的回包，无 method 字段）
    if (msg.method === undefined && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(String(msg.id));
      if (!entry) return; // 未知 id 的回包：忽略（宽容）
      this.pending.delete(String(msg.id));
      if (msg.error !== undefined) {
        entry.reject(new AcpRpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    // 2) request（agent→client，必须回包）
    if (msg.method !== undefined && msg.id !== undefined) {
      if (msg.method === 'session/request_permission') {
        this.handlePermissionRequest(msg, push);
      } else {
        // 其他 agent→client 请求（fs/read_text_file 等）：一律 method-not-found
        this.respondError(msg.id, msg.method);
      }
      return;
    }

    // 3) notification
    if (msg.method === 'session/update') {
      this.mapSessionUpdate(msg.params ?? {}, push);
    } else if (typeof msg.method === 'string' && msg.method.includes('authUrl')) {
      // 认证登录链接通知（宽容匹配：方法名含 authUrl；codebuddy 实测 method:
      // _codebuddy.ai/authUrl，params 字段名是 authUrl——2026-11 反编译确认，
      // params.url 留作兜底）——转 auth_url 对外事件，由映射引擎/Web 弹「点击登录」
      const p = (msg.params ?? {}) as Record<string, unknown>;
      const url = typeof p.authUrl === 'string' && p.authUrl !== '' ? p.authUrl : p.url;
      if (typeof url === 'string' && url !== '') {
        this.authUrlSeen = true;
        push({ type: 'auth_url', url });
      }
    }
    // 其他通知方法：忽略（宽容原则）
  }

  /** session/request_permission → ExternalEvent permission_request（id = JSON-RPC 请求 id 字符串化） */
  private handlePermissionRequest(msg: AcpIncomingMessage, push: (ev: ExternalEvent) => void): void {
    const params = msg.params ?? {};
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const options = Array.isArray(params.options) ? (params.options as AcpPermissionOption[]) : [];
    // permissionId 用 JSON-RPC 请求 id 字符串化：respondPermission 回包时按它回查 option 集合
    const permissionId = String(msg.id);
    this.pendingPermissions.set(permissionId, { rpcId: msg.id!, options });
    push({
      type: 'permission_request',
      id: permissionId,
      tool:
        (typeof toolCall.title === 'string' && toolCall.title) ||
        (typeof toolCall.kind === 'string' && toolCall.kind) ||
        'tool',
      argsJson:
        toolCall.rawInput !== undefined && toolCall.rawInput !== null
          ? JSON.stringify(toolCall.rawInput)
          : '',
      options: options.map((o) => o.optionId ?? ''),
      // ACP toolCall.kind 原样带出（read/edit/…），供映射引擎做 plan 档只读判定；缺失不填
      ...(typeof toolCall.kind === 'string' && toolCall.kind ? { toolKind: toolCall.kind } : {}),
    });
  }

  /** session/update 通知 → ExternalEvent（未知 sessionUpdate 值忽略——宽容原则） */
  private mapSessionUpdate(params: Record<string, unknown>, push: (ev: ExternalEvent) => void): void {
    const update = (params.update ?? {}) as Record<string, unknown>;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        push({ type: 'text', text: contentBlockToText(update.content) });
        break;
      case 'agent_thought_chunk':
        push({ type: 'thinking', text: contentBlockToText(update.content) });
        break;
      case 'tool_call':
        push({
          type: 'tool_use',
          id: typeof update.toolCallId === 'string' ? update.toolCallId : '',
          name:
            (typeof update.title === 'string' && update.title) ||
            (typeof update.kind === 'string' && update.kind) ||
            'tool',
          argsJson: update.rawInput !== undefined && update.rawInput !== null ? JSON.stringify(update.rawInput) : '',
        });
        break;
      case 'tool_call_update': {
        // 仅 completed/failed 产出 tool_result；in_progress/pending 等中间态忽略
        if (update.status === 'completed' || update.status === 'failed') {
          push({
            type: 'tool_result',
            id: typeof update.toolCallId === 'string' ? update.toolCallId : '',
            ok: update.status === 'completed',
            content: outputToText(update.output),
          });
        }
        break;
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? (update.entries as Record<string, unknown>[]) : [];
        push({
          type: 'plan',
          steps: entries.map((e) => ({
            title: typeof e.content === 'string' ? e.content : '',
            status: typeof e.status === 'string' ? e.status : 'pending',
          })),
        });
        break;
      }
      default:
        // 未知 sessionUpdate 值：忽略（ACP spec 演进中，不为未知类型崩溃）
        break;
    }
  }
}

/** content 块 → 文本：{type:'text',text} 取 text，其他类型序列化占位（宽容） */
function contentBlockToText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'object' && (content as Record<string, unknown>).type === 'text') {
    const text = (content as Record<string, unknown>).text;
    return typeof text === 'string' ? text : '';
  }
  return JSON.stringify(content);
}

/** tool_call_update 的 output → 文本：content 块数组逐个取 text / 序列化占位，其余形状宽容序列化 */
function outputToText(output: unknown): string {
  if (output === null || output === undefined) return '';
  const content = (output as Record<string, unknown>).content;
  if (Array.isArray(content)) {
    return content
      .map((block) => contentBlockToText(block))
      .filter((s) => s !== '')
      .join('\n');
  }
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
}
