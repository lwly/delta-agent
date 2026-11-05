// F-55 外部 CLI Agent 适配层：类型契约（docs/design-f55-external-cli-agents.md §3）
//
// 职责切分（务必遵守）：
//   - adapter 只懂协议（ACP/JSONL → ExternalEvent）
//   - engine/external.ts 只懂映射（ExternalEvent → AgentEvent + 落库语义）
// 本文件只定义两边的公共类型，不包含任何协议解析 / spawn / 映射逻辑。

// F-56：Tier D 为「预留档」——模板可注册/可探测，但协议适配器未实现（启动时明确报错不静默）
export type ExternalTier = 'A' | 'B' | 'C' | 'D';

export interface ExternalAgentSpec {
  /** 稳定 id，同时也是会话 model 字段的值：cli:claude-code / cli:codex / acp:<cmd> */
  id: string;
  /** 'reserved'：F-56 预留档（如 dsh cordis 插件栈），无标准协议适配器——启动报 external_unsupported_protocol */
  kind: 'acp' | 'stream-json-jsonl' | 'app-server-jsonl' | 'reserved';
  /** 绝对路径（detect 阶段解析，避免 PATH 漂移） */
  command: string;
  args: string[];
  tier: ExternalTier;
  version: string;
  /** F-56：指定模型（external.json 手动条目/缓存携带；ACP 系折叠进 args，B/C 适配器自行组装 flag） */
  model?: string;
  /** 三档权限对应的追加 flags（plan 档必须为空数组或只读 flags） */
  permissionArgs: { plan: string[]; default: string[]; yolo: string[] };
  resumeArgs?: (sessionId: string) => string[];
  /** 可透传 delta 的 MCP 配置（写临时 mcp.json 后传路径） */
  mcpArgs?: (configPath: string) => string[];
}

/** 归一化后的外部事件 —— 与 delta 协议无关，便于单测 */
export type ExternalEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; argsJson: string }
  | { type: 'tool_result'; id: string; ok: boolean; content: string }
  | {
      type: 'permission_request';
      id: string;
      tool: string;
      argsJson: string;
      options: string[];
      /** ACP toolCall.kind（read/edit/delete/move/search/execute/think/fetch/other）；Tier B/C 或未知时缺省 undefined */
      toolKind?: string;
    }
  | { type: 'plan'; steps: Array<{ title: string; status: string }> }
  | { type: 'usage'; input: number; output: number }
  | { type: 'external_session'; id: string } // 用于 --resume
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'done'; exitCode: number };

export interface ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec;
  /** 最近一次 run() 的 stderr 环形缓冲快照（设计稿 §9：进程异常时随 error 事件带出前 20 行；可缺省） */
  stderrTail?(): string[];
  run(req: {
    prompt: string;
    cwd: string;
    permissionMode: 'plan' | 'default' | 'yolo';
    resumeSessionId?: string;
    mcpConfigPath?: string;
    signal: AbortSignal;
  }): AsyncIterable<ExternalEvent>;
  /**
   * Tier A 权限应答通道：把 delta 确认流的决定回传 CLI（acp kind 必实现，其他可缺省）。
   * decision 是映射后的三值 —— ConfirmDecision 的 edit 视作 reject（外部 agent 无法回填编辑参数）。
   */
  respondPermission?(permissionId: string, decision: 'allow' | 'allow_session' | 'reject'): void;
  /**
   * 主动取消当前 run() 的子进程（AC-55-5 serve dispose 全杀兜底；可缺省）。
   * 语义与 spawnExternal 的 cancel 一致（幂等，等待进程确认退出）；
   * engine/external.ts 经 ExternalRunHandle 调用，实现类取消自身 lastProc 即可。
   */
  cancel?(): Promise<void>;
}
