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
    probeArgs: ['--version'],
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
    probeArgs: ['--version'],
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
];

/** 优先级来源（探测命中顺序，供 doctor/UI 展示与测试断言） */
export type DetectSource = 'env' | 'cache' | 'path';

/** detectExternalAgents 的单条产出 */
export interface DetectedAgent {
  def: KnownAgentDef;
  /** 探测到的可执行路径（env/缓存路径原样；PATH 命中为绝对路径候选） */
  command: string;
  /** probe 输出的版本串（首个非空 stdout 行） */
  version: string;
  source: DetectSource;
}

export interface DetectOptions {
  /** 注入 HOME（测试隔离 ~/.delta 用）；缺省用真实 HOME */
  homeDir?: string;
  /** 探测超时毫秒数（缺省 PROBE_TIMEOUT_MS） */
  probeTimeoutMs?: number;
  /** 注入 PATH 探测用的 PATH 环境串（测试隔离 process.env.PATH 用）；缺省读 process.env.PATH */
  probePathEnv?: string;
}

/** external.json 中单个 agent 条目（固定 schema，AC-55-9 白名单字段） */
export interface ExternalAgentCacheEntry {
  id: string;
  kind: string;
  command: string;
  version: string;
  tier: ExternalTier;
  enabled: boolean;
  lastProbeAt: string;
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
 * 三级优先级解析（§10）：env 显式路径 > external.json 缓存（enabled=true）> PATH 探测。
 * 命中 1/2 仍要 probe 拿 version：
 *   - env 显式路径 probe 失败 → warn 并放弃该 agent（用户显式指定即明确意图，不降级 PATH）；
 *   - 缓存条目 probe 失败 → warn 并降级尝试 PATH（缓存只是上次探测的快照，非显式意图）。
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

  // 2) external.json 缓存
  const cachedEntry = o.cached.find((e) => e.id === def.id && e.enabled);
  if (cachedEntry?.command) {
    const version = await probeAgent(def, cachedEntry.command, { probeTimeoutMs: o.probeTimeoutMs });
    if (version !== null) return { def, command: cachedEntry.command, version, source: 'cache' };
    warn(`外部 agent ${def.id}：external.json 缓存条目失效（command=${cachedEntry.command}），降级尝试 PATH 探测`);
  }

  // 3) PATH 探测（静默：探测失败是常态，不 warn）
  for (const candidate of tryPaths(def, o.probePathEnv)) {
    const version = await probeAgent(def, candidate, { probeTimeoutMs: o.probeTimeoutMs });
    if (version !== null) return { def, command: candidate, version, source: 'path' };
  }
  return null;
}

/** AC-55-9 白名单：external.json 固定 schema 字段，任何外部注入的额外字段（token/key/secret）一律丢弃 */
const CACHE_FIELDS = ['id', 'kind', 'command', 'version', 'tier', 'enabled', 'lastProbeAt'] as const;

function whitelistEntry(raw: unknown): ExternalAgentCacheEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string' || typeof rec.command !== 'string') return null;
  return {
    id: rec.id,
    kind: typeof rec.kind === 'string' ? rec.kind : 'stream-json-jsonl',
    command: rec.command,
    version: typeof rec.version === 'string' ? rec.version : '',
    tier: (typeof rec.tier === 'string' ? rec.tier : 'B') as ExternalTier,
    enabled: rec.enabled === true,
    lastProbeAt: typeof rec.lastProbeAt === 'string' ? rec.lastProbeAt : '',
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

/** DetectedAgent → ExternalAgentSpec（纯函数，Task 10 的 stream-json 适配器消费） */
export function detectedToSpec(detected: DetectedAgent): ExternalAgentSpec {
  return {
    id: detected.def.id,
    kind: detected.def.kind,
    command: detected.command,
    // args 是运行期基参数：stream-json 适配器（Task 10）按协议自行组装 -p/--output-format 等，
    // detect 阶段不预填，避免协议知识泄漏进探测层
    args: [],
    tier: detected.def.tier,
    version: detected.version,
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
    // ACP（Tier A）detect 条目 P4 落地时补工厂：ACP 协议适配器尚未实现，静默落到
    // StreamJsonExternalAdapter 会在运行期协议错配——warn 跳过注册，不进返回清单。
    if (d.def.kind === 'acp') {
      warn(`外部 agent ${d.def.id} 为 ACP 协议，适配器工厂 P4 落地时补，暂跳过注册`);
      continue;
    }
    // 按 kind 选适配器工厂（协议知识归 adapter，探测层只分派）
    registerDetected(d, (spec) =>
      spec.kind === 'app-server-jsonl' ? new CodexExternalAdapter(spec) : new StreamJsonExternalAdapter(spec),
    );
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
      const entry: ExternalAgentCacheEntry = {
        id: def.id,
        kind: def.kind,
        command: hit.command,
        version: hit.version,
        tier: def.tier,
        enabled: true,
        lastProbeAt: new Date().toISOString(),
      };
      if (idx >= 0) working[idx] = entry;
      else working.push(entry);
    } else if (idx >= 0) {
      working.splice(idx, 1); // 探测失败：移除缓存条目 + 静默跳过
    }
  }

  writeExternalAgentsCache(working, opts.homeDir);
  return detected;
}
