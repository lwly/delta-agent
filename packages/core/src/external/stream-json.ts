// F-55 Tier B 外部适配器：Claude Code stream-json（`claude -p --output-format stream-json` 的 stdout JSONL）。
//
// 职责切分（务必遵守）：
//   - 本文件只懂 claude stream-json 协议（stdout JSONL → ExternalEvent）
//   - ExternalEvent → AgentEvent 的映射归 engine/external.ts（改映射不必动协议层）
//   - 进程生命周期底座归 spawn.ts（本文件不直接碰 child_process）
// 本适配器是 P2 Tier B 唯一生产适配器；ScriptedExternalAdapter 仍是测试/e2e 用。
//
// 协议纪律：字段名以 claude 2.1.168 实测为基准；运行时对未知字段宽容——
// 未知顶层 type、未知 content 块类型一律忽略（上游事件类型持续演进，不为未知形状崩溃）。
// Tier B 无逐次权限回包通道（respondPermission 不实现，接口可选方法）；abort 无协议级取消，
// 直接由 spawnExternal 杀进程组收敛（onAbort 不需要）。
import { spawnExternal, type SpawnedProcess } from './spawn.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from './types.js';

/**
 * env 白名单：与 ACP（acp.ts ACP_ENV_WHITELIST）同口径的 provider 自身变量清单 + claude 自家
 * CLAUDE_CODE_* 前缀变量。不改 acp.ts（红线），故在此各自列出、注释互指。
 * 订阅登录态 CLI 自行管理，delta 不注入任何密钥——白名单（含 CLAUDE_CODE_* 前缀匹配）
 * 之外的变量一律不透传给子进程。前缀变量在 run() 时从 process.env 实际展开成精确名单
 * （spawnExternal 的 envWhitelist 只支持精确名），不存在的名字传了也无副作用。
 */
const PROVIDER_ENV_WHITELIST = [
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

/** claude 自家配置变量前缀（如 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 等） */
const CLAUDE_ENV_PREFIX = 'CLAUDE_CODE_';

/** stream-json 输出格式的固定参数片段（claude 2.1.168 实测：--print 下必须叠加 --verbose，否则报错退出） */
const STREAM_JSON_ARGS = ['--output-format', 'stream-json', '--verbose'] as const;

/** stream-json 线上消息的宽松形状（只声明用到的部分，未知字段宽容） */
interface StreamJsonMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { content?: unknown };
}

/** assistant/user message.content 里的块（宽松形状） */
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

export class StreamJsonExternalAdapter implements ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec;

  constructor(spec: ExternalAgentSpec) {
    this.spec = spec;
  }

  /** 最近一次 run() 的进程句柄（stderrTail 供映射引擎收尾带出 stderr 摘要） */
  private lastProc: SpawnedProcess | null = null;

  stderrTail(): string[] {
    return this.lastProc?.stderrTail() ?? [];
  }

  /** 主动取消当前 run() 的子进程（AC-55-5 dispose 全杀；spawnExternal.cancel 幂等） */
  async cancel(): Promise<void> {
    await this.lastProc?.cancel();
  }

  async *run(req: {
    prompt: string;
    cwd: string;
    permissionMode: 'plan' | 'default' | 'yolo';
    resumeSessionId?: string;
    mcpConfigPath?: string;
    signal: AbortSignal;
  }): AsyncGenerator<ExternalEvent> {
    // CLAUDE_CODE_* 前缀变量：run() 时从 process.env 展开成精确名单（见 PROVIDER_ENV_WHITELIST 注释）
    const claudeEnvKeys = Object.keys(process.env).filter((k) => k.startsWith(CLAUDE_ENV_PREFIX));

    const proc = spawnExternal({
      command: this.spec.command,
      // 非交互单 prompt（-p）+ stream-json 输出 + 权限档位 flags + 可选 MCP 透传 / 会话续跑
      args: [
        ...this.spec.args,
        '-p',
        req.prompt,
        ...STREAM_JSON_ARGS,
        ...(this.spec.permissionArgs[req.permissionMode] ?? []),
        // MCP 透传（设计稿 §6）：engine 生成临时配置文件后经 mcpArgs 展开传入
        ...(req.mcpConfigPath && this.spec.mcpArgs ? this.spec.mcpArgs(req.mcpConfigPath) : []),
        ...(req.resumeSessionId && this.spec.resumeArgs ? this.spec.resumeArgs(req.resumeSessionId) : []),
      ],
      cwd: req.cwd,
      envWhitelist: [...PROVIDER_ENV_WHITELIST, ...claudeEnvKeys],
      signal: req.signal,
      // 测试支撑（对齐 FAKE_ACP_SCRIPT / DELTA_FAKE_CLI 先例）：FAKE_CLAUDE_SCRIPT 指向 fixture
      // 场景 JSON 时镜像注入子进程 env；生产不设置该变量，零影响。
      extraEnv: process.env.FAKE_CLAUDE_SCRIPT
        ? { FAKE_CLAUDE_SCRIPT: process.env.FAKE_CLAUDE_SCRIPT }
        : undefined,
    });
    this.lastProc = proc;

    // prompt 走 argv，立即关 stdin：claude -p 会等 stdin 数据 3s 才继续（实测警告
    // "no stdin data received in 3s"），关闭后零等待；Tier B 不用 --input-format。
    proc.endStdin();

    try {
      for await (const ev of proc.events) {
        if (ev.type === 'line') {
          yield* this.mapLine(ev.text);
        } else if (ev.type === 'exit') {
          // 进程退出收敛为 done；非零退出的 fatal 判定归映射引擎（engine/external.ts）
          yield { type: 'done', exitCode: ev.code ?? -1 };
        }
        // stderr_line：已进环形缓冲（stderrTail 透传），不上抛
      }
    } finally {
      // 消费方提前 return（映射引擎收到 done 即 break）时确保子进程收敛；已退出时幂等
      await proc.cancel();
    }
  }

  /** 单行 stream-json → ExternalEvent（可产 0..n 条；parse 失败不致命，会话继续） */
  private *mapLine(text: string): Generator<ExternalEvent> {
    let msg: StreamJsonMessage;
    try {
      msg = JSON.parse(text) as StreamJsonMessage;
    } catch {
      // 非法 JSON 行不致命：透出原始行，会话继续（宽容原则；超长截断由 spawn.ts 处理）
      yield { type: 'error', message: `claude 输出行不是合法 JSON：${text}`, fatal: false };
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return; // 未知形状：忽略

    switch (msg.type) {
      case 'system': {
        // init（首行）：session_id 是后续 --resume 的令牌；非 init 子类型忽略
        if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
          yield { type: 'external_session', id: msg.session_id };
        }
        return;
      }
      case 'assistant': {
        // assistant message 的 content 块组：thinking / text / tool_use；未知块类型忽略
        for (const block of contentBlocks(msg)) {
          if (block.type === 'text' && typeof block.text === 'string') {
            yield { type: 'text', text: block.text };
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            yield { type: 'thinking', text: block.thinking };
          } else if (block.type === 'tool_use') {
            // input 是对象：JSON.stringify 归一（与 ACP rawInput 同语义；映射引擎不 parse 原样透传）
            yield {
              type: 'tool_use',
              id: typeof block.id === 'string' ? block.id : '',
              name: typeof block.name === 'string' ? block.name : 'tool',
              argsJson: block.input !== undefined && block.input !== null ? JSON.stringify(block.input) : '',
            };
          }
          // 其他块类型（server_tool_use 等）：忽略（宽容原则）
        }
        return;
      }
      case 'user': {
        // user message 携带 tool_result 块组（工具执行结果回传）
        for (const block of contentBlocks(msg)) {
          if (block.type === 'tool_result') {
            yield {
              type: 'tool_result',
              id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
              ok: block.is_error !== true,
              content: toolResultContentToText(block.content),
            };
          }
        }
        return;
      }
      case 'result': {
        // 收尾行：token 用量（§7 成本口径：total_cost_usd 一律忽略——订阅制不计量，不产生 costUsd）
        if (msg.usage) {
          yield { type: 'usage', input: msg.usage.input_tokens ?? 0, output: msg.usage.output_tokens ?? 0 };
        }
        if (msg.is_error === true) {
          // 结果级错误不致命：进程退出码由 done 携带，映射引擎据退出码与产出判定 fatal
          yield { type: 'error', message: `claude 结果标记为错误（subtype=${msg.subtype ?? 'unknown'}）`, fatal: false };
        }
        return;
      }
      default:
        // 未知顶层 type（stream_event 等上游演进中的类型）：忽略（宽容原则）
        return;
    }
  }
}

/** message.content → 块数组（缺省/非数组宽容回空） */
function contentBlocks(msg: StreamJsonMessage): ContentBlock[] {
  const content = msg.message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/**
 * tool_result.content → 文本：字符串原样；块数组取 text 块拼接（其他类型 JSON 序列化占位）；
 * 其余形状宽容序列化。与 ACP outputToText 同语义。
 */
function toolResultContentToText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as ContentBlock;
        if (b?.type === 'text' && typeof b.text === 'string') return b.text;
        return JSON.stringify(block);
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  return JSON.stringify(content);
}
