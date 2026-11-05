// F-55 外部 CLI Agent 探测与配置（docs/design-f55-external-cli-agents.md §10 + §9 Windows shim）
//
// 职责分界（本文件只做探测与持久化，不做协议适配）：
//   - detect：KNOWN_AGENTS 定义 + probeAgent（--version 探测，3s 超时静默跳过）
//     + 三级优先级解析（env 显式路径 > external.json 缓存 > PATH 探测）
//     + external.json 白名单读写（AC-55-9：固定 schema，token/key/secret 进不了文件）
//     + checkLoginState（登录态存在性，只 existsSync 不解析内容）
//   - 协议接缝：detectedToSpec（DetectedAgent → ExternalAgentSpec 纯函数）与
//     registerDetected（工厂注入式注册）在此导出；ensureExternalAdapters() 是
//     「detect + StreamJsonExternalAdapter 工厂 + registry 注册」的组合入口（Task 11）。
//   - 不自动下载/安装任何 CLI（设计稿 §10），探测失败一律静默跳过（warn 例外见 resolveCommand）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { userConfigDir } from '../paths.js';
import { spawnExternal } from './spawn.js';
import { registerExternalAdapterFactory } from './registry.js';
import { StreamJsonExternalAdapter } from './stream-json.js';
import { CodexExternalAdapter } from './codex.js';
import { AcpExternalAdapter } from './acp.js';
import { ReservedExternalAdapter } from './reserved.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalTier } from './types.js';

/** 探测超时（设计稿 §10：`command --version` 超时 3s，失败静默跳过） */
export const PROBE_TIMEOUT_MS = 3000;

/** external.json 文件名（位于 userConfigDir()，即 ~/.delta/external.json） */
const EXTERNAL_CACHE_FILE = 'external.json';

/**
 * 已知外部 agent 定义。
 * 元素类型 = ExternalAgentSpec 去掉 command/version/args（探测期未知）+ 探测专用字段。
 */
export type KnownAgentDef = Omit<ExternalAgentSpec, 'command' | 'version' | 'args'> & {
  /** PATH 探测的可执行名（Windows 依次尝试 .cmd/.bat/.ps1 后缀） */
  executable: string;
  /** 版本探测参数（§10：`command --version`） */
  probeArgs: string[];
  /** 登录态存在性检查文件（相对 HOME；只判断存在，不解析内容，§10） */
  loginStateFiles: string[];
  // ── F-56 手动注册向导字段 ──
  /** 模板展示名（Web 向导卡片 / 手动条目 displayName 缺省值） */
  label: string;
  /** 模板一句话描述（Web 向导卡片） */
  description: string;
  /** 协议入口参数（adapter 组装启动行时前置：cursor/opencode ['acp']、codebuddy ['--acp']；探测层不做协议知识） */
  protocolArgs?: string[];
  /**
   * F-56 指定模型的 flag 形态与放置位置（模型 flag 因 CLI 而异，且 opencode 的 -m 必须在
   * acp 子命令之前）——before = protocolArgs 之前，after = 之后。stream-json/app-server-jsonl
   * 模板不设（模型 flag 是协议知识，由适配器按 spec.model 自行组装）。
   */
  modelArgs?: (model: string) => { before?: string[]; after?: string[] };
  /** F-56：候选模型清单（向导「模型」下拉建议；来源 = CLI --help / 官方文档，允许自由输入不设限） */
  models?: string[];
  /**
   * F-56 自动获取模型：CLI 模型清单探测（列举命令 + 输出解析器）。探测失败静默回落静态
   * models 清单——不阻塞注册，解析是建议不是校验。仅对「CLI 自带列举命令/可解析输出」的
   * 模板提供；claude/codex 无列举命令且 API 拉取会违反凭证红线（§10），不设。
   */
  modelsProbe?: {
    /** 模型列举命令参数（如 opencode ['models']、codebuddy ['--help']） */
    args: string[];
    /** stdout → 模型 ID 数组（宽松解析，空数组 = 视为失败） */
    parse: (stdout: string) => string[];
    /** 探测超时（缺省 MODELS_PROBE_TIMEOUT_MS） */
    timeoutMs?: number;
  };
};

/**
 * 已知外部 agent 清单（P2 起 claude-code，P3 起 codex）。
 * 元素类型 = ExternalAgentSpec 去掉 command/version/args（探测期未知）+ 探测专用字段。
 */
export const KNOWN_AGENTS: KnownAgentDef[] = [
  {
    id: 'cli:claude-code',
    kind: 'stream-json-jsonl',
    tier: 'B',
    executable: 'claude',
    label: 'Claude Code',
    description: 'Anthropic 官方 CLI，stream-json 双向协议（Tier B）',
    probeArgs: ['--version'],
    models: ['opus', 'sonnet', 'haiku', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    loginStateFiles: ['.claude.json'],
    permissionArgs: {
      plan: ['--permission-mode', 'plan'],
      default: [],
      yolo: ['--dangerously-skip-permissions'],
    },
    resumeArgs: (sessionId) => ['--resume', sessionId],
    mcpArgs: (configPath) => ['--mcp-config', configPath],
  },
  {
    // Codex app-server v2（JSON-RPC over stdio）。'app-server' 子命令由 CodexExternalAdapter
    // 按协议静态携带（协议知识不进探测层，与 stream-json 自行组装 '-p' 同原则），故此处无 args。
    id: 'cli:codex',
    kind: 'app-server-jsonl',
    tier: 'C',
    executable: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex CLI，app-server v2 JSON-RPC 协议（Tier C）',
    probeArgs: ['--version'],
    models: ['gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5-codex', 'gpt-5.1', 'o4-mini'],
    // 弱判定：'.codex/auth.json' 是正式登录态文件；'.codex' 目录存在只说明「曾初始化过」
    // （auth.json 可能不存在但目录在）。任一存在即视为已登录，不解析内容（§10 只判存在性）。
    loginStateFiles: ['.codex/auth.json', '.codex'],
    permissionArgs: {
      // Codex 无只读 plan 模式（schema/flags 实测均无）→ 空数组，映射引擎 external_no_plan_mode
      // 门禁拒绝 plan 档启动（设计稿 §5.1 能力降级显式告知）。
      plan: [],
      // default 档不追加 flags：上游审批请求走 adapter 桥接确认流（codex.ts handleServerRequest）
      default: [],
      // codex --help 实测存在（0.162.0-alpha.17.2）：跳过全部确认并无沙箱执行
      yolo: ['--dangerously-bypass-approvals-and-sandbox'],
    },
    // resume 走协议 thread/resume（threadId），不经 CLI flags——resumeArgs 不设
    // MCP 透传：P3 不做（schema 有 config/mcpServer 等方法，P4+ 再议）——mcpArgs 不设
  },
  // ── F-56 新增 4 个模板（PASI-87；协议矩阵经 2026-11-05 本机实测 + 官方文档核实）──
  {
    // CodeBuddy Code：`--acp` 以 ndJsonStream 在 stdio 上跑 ACP（--help 实测），Tier A 复用 ACP 适配器
    id: 'cli:codebuddy',
    kind: 'acp',
    tier: 'A',
    executable: 'codebuddy',
    label: 'CodeBuddy Code',
    description: '腾讯 CodeBuddy CLI，--acp stdio ACP 协议（Tier A）',
    protocolArgs: ['--acp'],
    modelArgs: (m) => ({ after: ['--model', m] }),
    models: [
      'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'deepseek-v4-pro', 'deepseek-v4.1-flash',
      'kimi-k3.1-pro', 'kimi-k3-1', 'kimi-k2.8-preview', 'minimax-m3.1-flash', 'minimax-m2.7',
      'hy4free', 'hy4std', 'hy3', 'hy3-x', 'space-bunny', 'step-5-preview', 'mimo-v2.6-pro',
    ],
    // --help 实测：模型清单在「Currently supported: (a, b, …)」一行里，正则可稳定提取
    modelsProbe: {
      args: ['--help'],
      parse: (stdout) => {
        const m = stdout.match(/Currently supported:\s*\(([^)]+)\)/);
        return m ? m[1]!.split(/[\s,]+/).filter((t) => t !== '') : [];
      },
    },
    probeArgs: ['--version'],
    loginStateFiles: ['.codebuddy'],
    permissionArgs: {
      // --permission-mode plan 实测存在（--help）
      plan: ['--permission-mode', 'plan'],
      default: [],
      yolo: ['--dangerously-skip-permissions'],
    },
  },
  {
    // cursor-agent：`cursor-agent acp` 子命令（官方文档 cursor.com/docs/cli/acp，JSON-RPC 2.0 over stdio）
    id: 'cli:cursor-agent',
    kind: 'acp',
    tier: 'A',
    executable: 'cursor-agent',
    label: 'Cursor CLI',
    description: 'Cursor Agent CLI，acp 子命令 stdio ACP 协议（Tier A）',
    protocolArgs: ['acp'],
    modelArgs: (m) => ({ after: ['--model', m] }),
    models: ['composer-1', 'claude-sonnet-4-5', 'claude-opus-4-1', 'gpt-5', 'gemini-2.5-pro'],
    // 官方 changelog 实证：`agent models` / `--list-models` 列出全部可用模型（输出为表格，
    // 解析取首个「形似模型 ID」的 token；本机二进制损坏待实测，解析器从宽）
    modelsProbe: {
      args: ['models'],
      parse: (stdout) => parseModelTokens(stdout, /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i),
    },
    probeArgs: ['--version'],
    loginStateFiles: ['.cursor'],
    // agent/plan/ask 三模式由 ACP 会话内协商（无启动 flags），permissionArgs 留空
    permissionArgs: { plan: [], default: [], yolo: [] },
  },
  {
    // opencode：`opencode acp` 子命令（官方文档 opencode.ai/docs/acp，JSON-RPC over stdio 协议 v1）
    id: 'cli:opencode',
    kind: 'acp',
    tier: 'A',
    executable: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode CLI，acp 子命令 stdio ACP 协议（Tier A）',
    protocolArgs: ['acp'],
    modelArgs: (m) => ({ before: ['-m', m] }),
    models: ['anthropic/claude-sonnet-4', 'openai/gpt-5', 'google/gemini-2.5-pro', 'opencode/gpt-5'],
    // 官方 docs/models 实证：`opencode models` 列出全部模型（provider/model 格式，取含 '/' 的首 token）
    modelsProbe: {
      args: ['models'],
      parse: (stdout) => parseModelTokens(stdout, /^[a-z0-9][a-z0-9._-]*\/([a-z0-9][a-z0-9._-]*)$/i),
    },
    probeArgs: ['--version'],
    loginStateFiles: ['.local/share/opencode/auth.json', '.local/share/opencode', '.config/opencode'],
    permissionArgs: { plan: [], default: [], yolo: [] },
  },
  {
    // dsh（DeepSeek Harness）：cordis 插件栈启动器，无标准 ACP/stream-json 入口——Tier D 预留档，
    // 可注册/可探测，启动时 ReservedExternalAdapter 报 external_unsupported_protocol（AC-56-4）
    id: 'cli:dsh',
    kind: 'reserved',
    tier: 'D',
    executable: 'dsh',
    label: 'DSH',
    description: 'DeepSeek Harness（cordis 插件栈）——注册与探测可用，协议适配预留（Tier D）',
    probeArgs: ['--version'],
    loginStateFiles: ['.dsh'],
    permissionArgs: { plan: [], default: [], yolo: [] },
  },
];

/** 优先级来源（探测命中顺序，供 doctor/UI 展示与测试断言）；'manual' = F-56 手动注册条目 */
export type DetectSource = 'env' | 'manual' | 'cache' | 'path';

/** detectExternalAgents 的单条产出 */
export interface DetectedAgent {
  def: KnownAgentDef;
  /** 探测到的可执行路径（env/缓存路径原样；PATH 命中为绝对路径候选） */
  command: string;
  /** probe 输出的版本串（首个非空 stdout 行）；手动条目 probe 失败时为缓存中的过期版本串 */
  version: string;
  source: DetectSource;
  /** F-56：手动注册条目附加信息（manual 命中时带出，供 UI 展示） */
  manual?: boolean;
  displayName?: string;
  description?: string;
  /** F-56：指定模型（手动条目携带；detectedToSpec 据此组装模型 flag） */
  model?: string;
}

export interface DetectOptions {
  /** 注入 HOME（测试隔离 ~/.delta 用）；缺省用真实 HOME */
  homeDir?: string;
  /** 探测超时毫秒数（缺省 PROBE_TIMEOUT_MS） */
  probeTimeoutMs?: number;
  /** 注入 PATH 探测用的 PATH 环境串（测试隔离 process.env.PATH 用）；缺省读 process.env.PATH */
  probePathEnv?: string;
}

/** external.json 中单个 agent 条目（固定 schema；F-56 扩展手动注册字段，仍为白名单制，AC-55-9） */
export interface ExternalAgentCacheEntry {
  id: string;
  kind: string;
  command: string;
  version: string;
  tier: ExternalTier;
  enabled: boolean;
  lastProbeAt: string;
  /** F-56：手动注册条目（探测不覆盖、探测失败不移除，AC-56-5） */
  manual?: boolean;
  /** F-56：手动注册的展示名（模型选择器/面板优先展示） */
  displayName?: string;
  /** F-56：手动注册的一句话描述（向导第 2 步「描述」字段） */
  description?: string;
  /** F-56：指定模型（探测缓存条目也可携带；探测写回沿用既有值） */
  model?: string;
}

/** 外部 agent 显式路径环境变量名：id `cli:claude-code` → `DELTA_EXTERNAL_CLAUDE_CODE_PATH` */
export function externalEnvPathName(id: string): string {
  const bare = id.replace(/^[a-z]+:/i, '');
  return `DELTA_EXTERNAL_${bare.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`;
}

function warn(message: string): void {
  console.warn(`[delta] ${message}`);
}

/**
 * 版本探测：跑 `command + probeArgs`，整体超时（Promise.race + abort → proc.cancel 杀进程）。
 * 首个非空 stdout 行作为 version；非零退出 / 超时 / 无输出 → null（静默，不抛错）。
 * cwd 用 os.tmpdir()（探测不属于任何项目，不落 projectRoot）；envWhitelist 空（基础白名单已含 PATH/HOME）。
 */
export async function probeAgent(
  def: KnownAgentDef,
  command: string,
  opts: { probeTimeoutMs?: number } = {},
): Promise<string | null> {
  const ac = new AbortController();
  const proc = spawnExternal({
    command,
    args: def.probeArgs,
    cwd: os.tmpdir(),
    envWhitelist: [],
    signal: ac.signal,
  });
  const timeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const collected = (async (): Promise<{ version: string | null; exitCode: number | null }> => {
      let version: string | null = null;
      let exitCode: number | null = null;
      for await (const ev of proc.events) {
        if (ev.type === 'line' && version === null && ev.text.trim() !== '') version = ev.text.trim();
        else if (ev.type === 'exit') exitCode = ev.code;
      }
      return { version, exitCode };
    })();
    const result = await Promise.race([collected, timeoutPromise]);
    if (result === null) return null; // 超时
    if (result.exitCode !== 0 || result.version === null) return null;
    return result.version;
  } finally {
    clearTimeout(timer);
    ac.abort(); // 幂等触发杀进程：超时路径收尾子进程，正常退出路径无副作用
    await proc.cancel();
  }
}

/** PATH 候选解析：POSIX 只试裸名；Windows 依次 .cmd/.bat/.ps1/裸名（§9 shim 约定），只收 existsSync 命中的 */
function tryPaths(def: KnownAgentDef, pathEnv?: string): string[] {
  const searchPath = pathEnv ?? process.env.PATH ?? '';
  if (searchPath.trim() === '') return [];
  const isWin = process.platform === 'win32';
  const suffixes = isWin ? ['.cmd', '.bat', '.ps1', ''] : [''];
  const candidates: string[] = [];
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir === '') continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, def.executable + suffix);
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * 四级优先级解析（§10 + F-56）：env 显式路径 > 手动注册条目（manual=true）> external.json
 * 探测缓存（enabled=true）> PATH 探测。
 * 命中仍要 probe 拿 version：
 *   - env 显式路径 probe 失败 → warn 并放弃该 agent（用户显式指定即明确意图，不降级 PATH）；
 *   - 手动条目 probe 失败 → warn 并以缓存 version 产出 DetectedAgent（手动注册 = 明确意图：
 *     AC-56-5 探测不覆盖/不移除手动条目；version 可能过期，注册时未探测成功即为空串）；
 *   - 探测缓存条目 probe 失败 → warn 并降级尝试 PATH（缓存只是上次探测的快照，非显式意图）。
 */
async function resolveCommand(
  def: KnownAgentDef,
  o: { cached: ExternalAgentCacheEntry[]; probeTimeoutMs?: number; probePathEnv?: string },
): Promise<DetectedAgent | null> {
  // 1) 显式环境变量
  const envName = externalEnvPathName(def.id);
  const envPath = process.env[envName];
  if (envPath) {
    const version = await probeAgent(def, envPath, { probeTimeoutMs: o.probeTimeoutMs });
    if (version !== null) return { def, command: envPath, version, source: 'env' };
    warn(
      `外部 agent ${def.id}：${envName} 指定的 ${envPath} 探测失败（--version 无输出或非零退出），跳过该 agent（显式指定不降级 PATH）`,
    );
    return null;
  }

  // 2) 手动注册条目（F-56）：显式意图，probe 失败不移除、不降级，以缓存 version 呈现
  const manualEntry = o.cached.find((e) => e.id === def.id && e.manual === true);
  if (manualEntry?.command) {
    const version = await probeAgent(def, manualEntry.command, { probeTimeoutMs: o.probeTimeoutMs });
    const extras = {
      manual: true,
      displayName: manualEntry.displayName,
      description: manualEntry.description,
      model: manualEntry.model,
    };
    if (version !== null) return { def, command: manualEntry.command, version, source: 'manual', ...extras };
    warn(
      `外部 agent ${def.id}：手动注册条目探测失败（command=${manualEntry.command}），保留条目并沿用上次版本串「${manualEntry.version}」`,
    );
    return { def, command: manualEntry.command, version: manualEntry.version, source: 'manual', ...extras };
  }

  // 3) external.json 探测缓存
  const cachedEntry = o.cached.find((e) => e.id === def.id && e.enabled);
  if (cachedEntry?.command) {
    const version = await probeAgent(def, cachedEntry.command, { probeTimeoutMs: o.probeTimeoutMs });
    if (version !== null) return { def, command: cachedEntry.command, version, source: 'cache' };
    warn(`外部 agent ${def.id}：external.json 缓存条目失效（command=${cachedEntry.command}），降级尝试 PATH 探测`);
  }

  // 4) PATH 探测（静默：探测失败是常态，不 warn）
  for (const candidate of tryPaths(def, o.probePathEnv)) {
    const version = await probeAgent(def, candidate, { probeTimeoutMs: o.probeTimeoutMs });
    if (version !== null) return { def, command: candidate, version, source: 'path' };
  }
  return null;
}

function whitelistEntry(raw: unknown): ExternalAgentCacheEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string' || typeof rec.command !== 'string') return null;
  // F-56 三字段条件展开：无手动信息的条目回读形状与 F-55 完全一致（键不增），旧缓存文件零迁移
  return {
    id: rec.id,
    kind: typeof rec.kind === 'string' ? rec.kind : 'stream-json-jsonl',
    command: rec.command,
    version: typeof rec.version === 'string' ? rec.version : '',
    tier: (typeof rec.tier === 'string' ? rec.tier : 'B') as ExternalTier,
    enabled: rec.enabled === true,
    lastProbeAt: typeof rec.lastProbeAt === 'string' ? rec.lastProbeAt : '',
    ...(rec.manual === true ? { manual: true } : {}),
    ...(typeof rec.displayName === 'string' && rec.displayName !== '' ? { displayName: rec.displayName } : {}),
    ...(typeof rec.description === 'string' && rec.description !== '' ? { description: rec.description } : {}),
    ...(typeof rec.model === 'string' && rec.model !== '' ? { model: rec.model } : {}),
  };
}

function externalCachePath(homeDir?: string): string {
  return path.join(userConfigDir(homeDir), EXTERNAL_CACHE_FILE);
}

/**
 * 读 external.json：文件不存在 → 空；JSON 损坏 → warn 并当作空（下次探测后重建）。
 * 读取同样按白名单挑字段，不信任文件里的额外键。
 */
export function readExternalAgentsCache(homeDir?: string): ExternalAgentCacheEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(externalCachePath(homeDir), 'utf8');
  } catch {
    return []; // 不存在 → 空（首次使用）
  }
  try {
    const parsed = JSON.parse(raw) as { agents?: unknown };
    if (!Array.isArray(parsed.agents)) return [];
    return parsed.agents
      .map(whitelistEntry)
      .filter((e): e is ExternalAgentCacheEntry => e !== null);
  } catch {
    warn(`external.json 解析失败（${externalCachePath(homeDir)}），按空处理，将在下次探测后重建`);
    return [];
  }
}

/**
 * 写 external.json（§10：非密钥文件，无加密）。写入前白名单挑字段（AC-55-9 红线），
 * 固定 schema `{ agents: [...] }`，不接受任何额外字段。
 */
export function writeExternalAgentsCache(agents: ExternalAgentCacheEntry[], homeDir?: string): void {
  const file = externalCachePath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const safe = agents
    .map(whitelistEntry)
    .filter((e): e is ExternalAgentCacheEntry => e !== null);
  fs.writeFileSync(file, `${JSON.stringify({ agents: safe }, null, 2)}\n`);
}

/**
 * 登录态存在性检查（§10）：loginStateFiles 相对 HOME 逐个 existsSync，任一存在即 true。
 * 只判断存在，不解析内容、不复制、不上报。
 */
export function checkLoginState(def: KnownAgentDef, homeDir: string = os.homedir()): boolean {
  return def.loginStateFiles.some((f) => fs.existsSync(path.join(homeDir, f)));
}

// ── F-56 手动注册（PASI-87）：模板查表 + upsert/remove ──────────────────────────

/** 手动注册输入（Web 向导第 2 步 / CLI agents add 的载荷） */
export interface ManualRegisterInput {
  /** 模板 id（必须在 KNOWN_AGENTS 中，决定 kind/tier/permissionArgs 等协议元数据） */
  templateId: string;
  /** 可执行命令（绝对路径或 PATH 裸名；缺省 = 模板 executable） */
  command?: string;
  /** 展示名（缺省 = 模板 label） */
  displayName?: string;
  /** 一句话描述（可选） */
  description?: string;
  /** 指定模型（可选；如 claude 的 sonnet / opencode 的 provider/model） */
  model?: string;
}

/** 手动注册校验失败错误码（http 层映射 400，UI 直接展示） */
export class ManualRegisterError extends Error {
  constructor(
    public readonly code: 'unknown_template' | 'empty_command' | 'too_long',
    message: string,
  ) {
    super(message);
  }
}

const DISPLAY_NAME_MAX = 100;
const DESCRIPTION_MAX = 500;
const MODEL_MAX = 100;

/** 模型清单探测超时（列举命令可能要拉 provider 注册表，比 --version 宽） */
export const MODELS_PROBE_TIMEOUT_MS = 8000;

/**
 * 宽松模型 token 解析：逐行取首个匹配 tokenFilter 的空白分隔 token，去重保序。
 * 表格/装饰线/表头行自然被 filter 挡掉；解析是建议不是校验，宁缺勿滥（空 = 失败回落静态清单）。
 */
export function parseModelTokens(stdout: string, tokenFilter: RegExp): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    for (const token of line.trim().split(/\s+/)) {
      if (token !== '' && tokenFilter.test(token) && !out.includes(token)) out.push(token);
    }
  }
  return out;
}

/** 模板清单：id → KnownAgentDef（手动注册/CLI/HTTP 共用） */
export function findKnownAgent(id: string): KnownAgentDef | undefined {
  return KNOWN_AGENTS.find((d) => d.id === id);
}

/**
 * F-56 自动获取模型：跑 def.modelsProbe 列举命令，解析 stdout 得模型 ID 数组。
 * 超时/非零退出/解析为空 → null（静默，调用方回落静态 models 清单）。
 * cwd 用 os.tmpdir()；envWhitelist 空（基础白名单已含 PATH/HOME）。
 */
export async function probeAgentModels(
  def: KnownAgentDef,
  command: string,
  opts: { probeTimeoutMs?: number } = {},
): Promise<string[] | null> {
  const probe = def.modelsProbe;
  if (!probe) return null;
  const ac = new AbortController();
  const proc = spawnExternal({
    command,
    args: probe.args,
    cwd: os.tmpdir(),
    envWhitelist: [],
    signal: ac.signal,
  });
  const timeoutMs = opts.probeTimeoutMs ?? MODELS_PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const collected = (async (): Promise<{ stdout: string; exitCode: number | null }> => {
      let stdout = '';
      let exitCode: number | null = null;
      for await (const ev of proc.events) {
        if (ev.type === 'line') stdout += `${ev.text}\n`;
        else if (ev.type === 'exit') exitCode = ev.code;
      }
      return { stdout, exitCode };
    })();
    const result = await Promise.race([collected, timeoutPromise]);
    if (result === null) return null; // 超时
    if (result.exitCode !== 0) return null;
    const models = probe.parse(result.stdout);
    return models.length > 0 ? models : null;
  } finally {
    clearTimeout(timer);
    ac.abort(); // 幂等收尾子进程（同 probeAgent）
    await proc.cancel();
  }
}

/**
 * 自动获取 + 静态清单合并（去重保序，动态优先）。探测失败 / 无 modelsProbe → 静态清单。
 * 返回 source 供 UI 提示（'probed' = 动态探测命中，'static' = 回落静态清单）。
 */
export async function resolveAgentModels(
  def: KnownAgentDef,
  command: string,
  opts: { probeTimeoutMs?: number } = {},
): Promise<{ models: string[]; source: 'probed' | 'static' }> {
  const dynamic = await probeAgentModels(def, command, opts);
  const merged: string[] = [];
  for (const m of [...(dynamic ?? []), ...(def.models ?? [])]) {
    if (!merged.includes(m)) merged.push(m);
  }
  return { models: merged, source: dynamic !== null ? 'probed' : 'static' };
}

/**
 * 手动注册 / 更新一个外部 agent 条目（upsert：同模板 id 覆盖，v1 一个模板一个手动条目）。
 * 写 external.json（manual=true 条目探测不覆盖不移除，AC-56-5）；不做版本探测——
 * version 置空串，下次 detect 探测成功后回填。
 */
export function upsertManualEntry(input: ManualRegisterInput, homeDir?: string): ExternalAgentCacheEntry {
  const def = findKnownAgent(input.templateId);
  if (!def) throw new ManualRegisterError('unknown_template', `未知模板 id：${input.templateId}`);
  const command = (input.command ?? def.executable).trim();
  if (command === '') throw new ManualRegisterError('empty_command', 'command 不能为空');
  const displayName = (input.displayName ?? def.label).trim();
  const description = (input.description ?? '').trim();
  if (displayName.length > DISPLAY_NAME_MAX || description.length > DESCRIPTION_MAX) {
    throw new ManualRegisterError(
      'too_long',
      `displayName ≤ ${DISPLAY_NAME_MAX} 字、description ≤ ${DESCRIPTION_MAX} 字`,
    );
  }
  const model = (input.model ?? '').trim();
  if (model.length > MODEL_MAX) {
    throw new ManualRegisterError('too_long', `model ≤ ${MODEL_MAX} 字`);
  }
  const agents = readExternalAgentsCache(homeDir);
  const idx = agents.findIndex((e) => e.id === def.id);
  const entry: ExternalAgentCacheEntry = {
    id: def.id,
    kind: def.kind,
    command,
    version: idx >= 0 ? (agents[idx].manual === true ? agents[idx].version : '') : '',
    tier: def.tier,
    enabled: true,
    lastProbeAt: idx >= 0 && agents[idx].manual === true ? agents[idx].lastProbeAt : '',
    ...buildManualFields({ displayName, description, model }),
  };
  if (idx >= 0) agents[idx] = entry;
  else agents.push(entry);
  writeExternalAgentsCache(agents, homeDir);
  return entry;
}

/** 手动条目构建（upsert 与 detect 写回共用：model 空串 = 清除，条件展开保持旧条目键形状） */
function buildManualFields(input: { displayName?: string; description?: string; model?: string }): {
  manual: true;
  displayName?: string;
  description?: string;
  model?: string;
} {
  return {
    manual: true,
    ...(input.displayName && input.displayName !== '' ? { displayName: input.displayName } : {}),
    ...(input.description && input.description !== '' ? { description: input.description } : {}),
    ...(input.model && input.model !== '' ? { model: input.model } : {}),
  };
}

/** 移除手动注册条目（仅 manual=true 可移除；探测缓存条目由探测自维护）；不存在返回 false */
export function removeManualEntry(id: string, homeDir?: string): boolean {
  const agents = readExternalAgentsCache(homeDir);
  const idx = agents.findIndex((e) => e.id === id && e.manual === true);
  if (idx < 0) return false;
  agents.splice(idx, 1);
  writeExternalAgentsCache(agents, homeDir);
  return true;
}

/** DetectedAgent → ExternalAgentSpec（纯函数，Task 10 的 stream-json 适配器消费） */
export function detectedToSpec(detected: DetectedAgent): ExternalAgentSpec {
  const model = detected.model;
  const modelFrag = model !== undefined && detected.def.modelArgs ? detected.def.modelArgs(model) : undefined;
  return {
    id: detected.def.id,
    kind: detected.def.kind,
    command: detected.command,
    // args 是运行期基参数：stream-json 适配器（Task 10）按协议自行组装 -p/--output-format 等，
    // detect 阶段不预填，避免协议知识泄漏进探测层；F-56：protocolArgs（acp 子命令/flag 等
    // 模板级协议入口）是用户注册时可见的固定形态，随 def 透传；
    // F-56 指定模型：ACP 系模板经 modelArgs 折叠进 args（opencode 的 -m 须在 acp 之前），
    // stream-json/app-server-jsonl 模板不设 modelArgs——模型 flag 由适配器按 spec.model 组装
    args: [
      ...(modelFrag?.before ?? []),
      ...(detected.def.protocolArgs ?? []),
      ...(modelFrag?.after ?? []),
    ],
    tier: detected.def.tier,
    version: detected.version,
    model,
    permissionArgs: detected.def.permissionArgs,
    resumeArgs: detected.def.resumeArgs,
    mcpArgs: detected.def.mcpArgs,
  };
}

/** 工厂注入式注册：ensureExternalAdapters() 以 StreamJsonExternalAdapter 工厂调用；也可单独使用 */
export function registerDetected(
  detected: DetectedAgent,
  factory: (spec: ExternalAgentSpec) => ExternalAgentAdapter,
): void {
  // P4 工厂语义：注册只存工厂不实例化——每次 run 执行工厂得到独立 adapter 实例
  // （并发会话实例状态隔离）；factory 闭包捕获本次探测的 spec。
  const spec = detectedToSpec(detected);
  registerExternalAdapterFactory(spec.id, () => factory(spec));
}

/**
 * 组合入口（Task 11）：detectExternalAgents 探测 → 每个命中以 StreamJsonExternalAdapter 工厂
 * 经 registerDetected 注册进 registry。
 *  - 幂等：同 id 重复注册覆盖（registry 语义，版本/路径变化后的重探测即重注册），无其他副作用
 *    （探测本身按 §10 落 external.json 缓存）。
 *  - 空命中静默：探测失败不抛错（detect 内部已静默），返回空数组；调用方（headless 入口）无需
 *    特殊处理——adapter 未注册时映射引擎会发 external_agent_not_found fatal error，走正常事件流。
 *  - 返回 DetectedAgent[]（注册副作用之外额外供 CLI 展示消费：models list / doctor 需要
 *    loginStateFiles 与三档 permissionArgs 等 KnownAgentDef 信息，ExternalAgentSpec 上没有）。
 */
export async function ensureExternalAdapters(opts: DetectOptions = {}): Promise<DetectedAgent[]> {
  const detected = await detectExternalAgents(opts);
  const registered: DetectedAgent[] = [];
  for (const d of detected) {
    // 按 kind 选适配器工厂（协议知识归 adapter，探测层只分派）
    // F-56：ACP（Tier A）工厂落地（acp.ts P4 已实现）；'reserved'（Tier D）走 stub 适配器，
    // 运行期报 external_unsupported_protocol，正常事件流呈现（AC-56-4）
    registerDetected(d, (spec) => {
      if (spec.kind === 'app-server-jsonl') return new CodexExternalAdapter(spec);
      if (spec.kind === 'acp') return new AcpExternalAdapter(spec);
      if (spec.kind === 'reserved') return new ReservedExternalAdapter(spec);
      return new StreamJsonExternalAdapter(spec);
    });
    registered.push(d);
  }
  return registered;
}

/**
 * 探测主入口：对每个 KNOWN_AGENT 走 resolveCommand 三级优先级。
 * 命中 → 产出 DetectedAgent 并更新 external.json（lastProbeAt=now）；
 * 失败 → 从 external.json 移除该条目（取移除的简单方案：条目由 detect 全量维护，enabled 语义留给上层 UI 演进）并静默跳过。
 */
export async function detectExternalAgents(opts: DetectOptions = {}): Promise<DetectedAgent[]> {
  const cached = readExternalAgentsCache(opts.homeDir);
  const working = [...cached];
  const detected: DetectedAgent[] = [];

  for (const def of KNOWN_AGENTS) {
    const hit = await resolveCommand(def, {
      cached: working,
      probeTimeoutMs: opts.probeTimeoutMs,
      probePathEnv: opts.probePathEnv,
    });
    const idx = working.findIndex((e) => e.id === def.id);
    if (hit !== null) {
      detected.push(hit);
      // F-56：手动注册字段只增不抹——探测命中刷新 command/version/lastProbeAt，
      // manual/displayName/description/model 一律沿用既有条目（AC-56-5：探测不覆盖手动条目）
      const prev = idx >= 0 ? working[idx] : undefined;
      const entry: ExternalAgentCacheEntry = {
        id: def.id,
        kind: def.kind,
        command: hit.command,
        version: hit.version,
        tier: def.tier,
        enabled: true,
        lastProbeAt: new Date().toISOString(),
        ...(prev?.manual === true ? { manual: true } : {}),
        ...(prev?.displayName ? { displayName: prev.displayName } : {}),
        ...(prev?.description ? { description: prev.description } : {}),
        ...(prev?.model ? { model: prev.model } : {}),
      };
      if (idx >= 0) working[idx] = entry;
      else working.push(entry);
    } else if (idx >= 0) {
      // 探测失败：移除缓存条目 + 静默跳过（手动条目在 resolveCommand 第 2 级必然命中，不会走到这里）
      working.splice(idx, 1);
    }
  }

  writeExternalAgentsCache(working, opts.homeDir);
  return detected;
}
