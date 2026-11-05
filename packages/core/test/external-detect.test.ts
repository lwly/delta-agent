/**
 * F-55 外部 agent 探测与 external.json 持久化单测（docs/design-f55-external-cli-agents.md §10 + AC-55-9）：
 *  - 零网络、零真实 CLI：probe 全部指向 node + fixture（POSIX 用 /bin/sh 包装脚本把版本串带给 version-cli.mjs）；
 *  - PATH 探测隔离：detectExternalAgents 的 probePathEnv 注入项指向临时目录，不依赖真机 PATH；
 *  - HOME 隔离：homeDir 注入临时目录，绝不触碰真实 ~/.delta；
 *  - Windows：/bin/sh 包装脚本不可用，相关用例平台守卫跳过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_AGENTS,
  checkLoginState,
  detectExternalAgents,
  detectedToSpec,
  ensureExternalAdapters,
  externalEnvPathName,
  readExternalAgentsCache,
  registerDetected,
  writeExternalAgentsCache,
} from '../src/external/detect.js';
import type { DetectedAgent, DetectOptions, ExternalAgentCacheEntry } from '../src/external/detect.js';
import { resolveExternalAdapter } from '../src/external/registry.js';
import { StreamJsonExternalAdapter } from '../src/external/stream-json.js';
import type { ExternalAgentAdapter } from '../src/external/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NODE = process.execPath;
const IS_POSIX = process.platform !== 'win32';
const itPosix = IS_POSIX ? it : it.skip;

const ENV_NAME = externalEnvPathName('cli:claude-code');
const DEF = KNOWN_AGENTS[0]!;
const VERSION_CLI = path.join(FIXTURES, 'version-cli.mjs');
const VERSION_FAIL = path.join(FIXTURES, 'version-fail.mjs');
const LONG_RUNNING = path.join(FIXTURES, 'long-running.mjs');

let tmpRoot: string;
let home: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

/** POSIX 包装脚本：把 version-cli.mjs 包成独立可执行（探测命令必须是单个可执行路径） */
function writeWrapper(name: string, target: string, version: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, `#!/bin/sh\nexec "${NODE}" "${target}" "${version}"\n`, { mode: 0o755 });
  return p;
}

function cacheFile(): string {
  return path.join(home, '.delta', 'external.json');
}

function makeEntry(command: string): ExternalAgentCacheEntry {
  return {
    id: 'cli:claude-code',
    kind: 'stream-json-jsonl',
    command,
    version: '0.0.0-cached',
    tier: 'B',
    enabled: true,
    lastProbeAt: '2026-11-05T00:00:00.000Z',
  };
}

async function detect(opts: Partial<DetectOptions> = {}): Promise<DetectedAgent[]> {
  // PATH 缺省隔离为空串（tryPaths 对空 PATH 直接返回空）：KNOWN_AGENTS 含 cli:codex 后，
  // 真机装了 codex/claude 的环境不能泄进探测结果；显式传 probePathEnv 的用例照常覆盖
  return detectExternalAgents({ homeDir: home, probePathEnv: '', ...opts });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-detect-'));
  home = path.join(tmpRoot, 'home');
  fs.mkdirSync(home, { recursive: true });
  delete process.env[ENV_NAME];
  delete process.env[externalEnvPathName("cli:codex")];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[ENV_NAME];
  delete process.env[externalEnvPathName("cli:codex")];
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('externalEnvPathName', () => {
  it('id 转换：去 cli: 前缀、大写、非字母数字 → _', () => {
    expect(externalEnvPathName('cli:claude-code')).toBe('DELTA_EXTERNAL_CLAUDE_CODE_PATH');
    expect(externalEnvPathName('cli:codex')).toBe('DELTA_EXTERNAL_CODEX_PATH');
  });
});

describe('detectExternalAgents（三级优先级）', () => {
  itPosix('env 显式路径优先级最高：命中 env command，version 来自脚本输出，external.json 落 entry', async () => {
    const cmd = writeWrapper('claude-env', VERSION_CLI, '2.1.168-fake');
    process.env[ENV_NAME] = cmd;
    // PATH 注入另一个同样可用的候选：env 命中时不得使用
    const pathDir = path.join(tmpRoot, 'pathdir');
    fs.mkdirSync(pathDir);
    writeWrapper(path.join('pathdir', 'claude'), VERSION_CLI, '9.9.9-path');

    const found = await detect({ probePathEnv: pathDir });
    expect(found).toHaveLength(1);
    expect(found[0]!.command).toBe(cmd);
    expect(found[0]!.version).toBe('2.1.168-fake');
    expect(found[0]!.source).toBe('env');

    const cache = readExternalAgentsCache(home);
    expect(cache).toHaveLength(1);
    expect(cache[0]).toMatchObject({
      id: 'cli:claude-code',
      command: cmd,
      version: '2.1.168-fake',
      tier: 'B',
      enabled: true,
    });
    expect(cache[0]!.lastProbeAt).not.toBe('');
  });

  itPosix('external.json 缓存命中：清 env 后用已存 entry 的 command', async () => {
    const cmd = writeWrapper('claude-cache', VERSION_CLI, '1.2.3-cache');
    writeExternalAgentsCache([makeEntry(cmd)], home);

    const found = await detect();
    expect(found).toHaveLength(1);
    expect(found[0]!.command).toBe(cmd);
    expect(found[0]!.source).toBe('cache');
  });

  itPosix('PATH 探测：清 env 与缓存，probePathEnv 注入 fixture 目录命中 claude 包装脚本', async () => {
    const pathDir = path.join(tmpRoot, 'pathdir');
    fs.mkdirSync(pathDir);
    const cmd = writeWrapper(path.join('pathdir', 'claude'), VERSION_CLI, '4.5.6-path');

    const found = await detect({ probePathEnv: pathDir });
    expect(found).toHaveLength(1);
    expect(found[0]!.command).toBe(cmd);
    expect(found[0]!.version).toBe('4.5.6-path');
    expect(found[0]!.source).toBe('path');
  });

  itPosix('探测失败静默：command 指向 version-fail fixture → 不含该 agent、不抛错、缓存无 entry', async () => {
    const cmd = writeWrapper('claude-fail', VERSION_FAIL, 'ignored');
    process.env[ENV_NAME] = cmd;

    const found = await detect();
    expect(found).toEqual([]);
    expect(readExternalAgentsCache(home)).toEqual([]);
  });

  itPosix('显式指定路径失败：warn 且不降级 PATH（PATH 注入里有好候选也不用）', async () => {
    const badCmd = writeWrapper('claude-bad', VERSION_FAIL, 'ignored');
    process.env[ENV_NAME] = badCmd;
    const pathDir = path.join(tmpRoot, 'pathdir');
    fs.mkdirSync(pathDir);
    writeWrapper(path.join('pathdir', 'claude'), VERSION_CLI, '7.7.7-path');

    const found = await detect({ probePathEnv: pathDir });
    expect(found).toEqual([]); // 显式意图失效 → 跳过 agent，不降级
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain(ENV_NAME);
    expect(readExternalAgentsCache(home)).toEqual([]);
  });

  itPosix('缓存条目失效：warn 并降级尝试 PATH（缓存非显式意图）', async () => {
    const badCmd = writeWrapper('claude-bad', VERSION_FAIL, 'ignored');
    writeExternalAgentsCache([makeEntry(badCmd)], home);
    const pathDir = path.join(tmpRoot, 'pathdir');
    fs.mkdirSync(pathDir);
    const goodCmd = writeWrapper(path.join('pathdir', 'claude'), VERSION_CLI, '8.8.8-path');

    const found = await detect({ probePathEnv: pathDir });
    expect(found).toHaveLength(1);
    expect(found[0]!.command).toBe(goodCmd);
    expect(found[0]!.source).toBe('path');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain('external.json');
  });

  itPosix('探测超时：长驻脚本 + 短超时 → 返回空且总耗时常小于默认 3s（子进程被收尾）', async () => {
    const cmd = writeWrapper('claude-hang', LONG_RUNNING, 'ignored');
    process.env[ENV_NAME] = cmd;

    const started = Date.now();
    const found = await detect({ probeTimeoutMs: 300 });
    const elapsed = Date.now() - started;
    expect(found).toEqual([]);
    expect(elapsed).toBeLessThan(3000); // 300ms 超时 + 杀进程宽限 ~300ms，远小于默认 3000ms（上限放宽防慢 CI flake）
    expect(readExternalAgentsCache(home)).toEqual([]);
  });
});

describe('external.json 读写（AC-55-9）', () => {
  it('写入后回读结构一致', () => {
    const entry = makeEntry('/usr/local/bin/claude');
    writeExternalAgentsCache([entry], home);
    expect(readExternalAgentsCache(home)).toEqual([entry]);
    const raw = fs.readFileSync(cacheFile(), 'utf8');
    expect(JSON.parse(raw)).toEqual({ agents: [entry] });
  });

  it('AC-55-9：写入固定 schema 白名单，外部注入的 token/key/secret 字段进不了文件', () => {
    const entry = makeEntry('/usr/local/bin/claude');
    // 模拟恶意/误用注入：额外字段必须被白名单丢弃
    writeExternalAgentsCache([{ ...entry, apiKey: 'sk-injected', secretToken: 'tok' } as unknown as ExternalAgentCacheEntry], home);
    const raw = fs.readFileSync(cacheFile(), 'utf8');
    expect(raw).not.toMatch(/token|key|secret/i);
    expect(raw).not.toContain('sk-injected');
    expect(readExternalAgentsCache(home)).toEqual([entry]);
  });

  it('损坏 JSON → warn 并按空处理；下次探测成功后重建为合法 JSON', async () => {
    fs.mkdirSync(path.join(home, '.delta'), { recursive: true });
    fs.writeFileSync(cacheFile(), '{oops not json');
    expect(readExternalAgentsCache(home)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const cmd = writeWrapper('claude-rebuild', VERSION_CLI, '2.0.0-rebuild');
    process.env[ENV_NAME] = cmd;
    const found = await detect();
    expect(found).toHaveLength(1); // 损坏缓存不阻塞探测
    const reparsed = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as { agents: unknown[] };
    expect(reparsed.agents).toHaveLength(1);
    expect(readExternalAgentsCache(home)[0]!.version).toBe('2.0.0-rebuild');
  });

  it('文件不存在 → 空，不抛错', () => {
    expect(readExternalAgentsCache(home)).toEqual([]);
  });
});

describe('checkLoginState（登录态存在性，§10）', () => {
  it('临时 HOME 有 .claude.json → true；无 → false', () => {
    expect(checkLoginState(DEF, home)).toBe(false);
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    expect(checkLoginState(DEF, home)).toBe(true);
  });
});

describe('checkLoginState（F-56 实测修正：cursor 登录态走配置字段，不看目录存在）', () => {
  const CURSOR = KNOWN_AGENTS.find((d) => d.id === 'cli:cursor-agent')!;
  const writeConfig = (body: string) => {
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cursor/cli-config.json'), body);
  };

  it('只有 ~/.cursor 目录（IDE 目录常驻）→ false，不再误报已登录', () => {
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    expect(checkLoginState(CURSOR, home)).toBe(false);
  });

  it('cli-config.json 含 authInfo.email → true', () => {
    writeConfig(JSON.stringify({ authInfo: { email: 'dev@example.com' } }));
    expect(checkLoginState(CURSOR, home)).toBe(true);
  });

  it('authInfo 被 logout 清空 / 配置文件损坏 → false（一律不抛错）', () => {
    writeConfig(JSON.stringify({ authInfo: {} }));
    expect(checkLoginState(CURSOR, home)).toBe(false);
    writeConfig('{ not json');
    expect(checkLoginState(CURSOR, home)).toBe(false);
  });

  it('CURSOR_API_KEY 非空 → true（走 Key 鉴权，无需落盘登录态）', () => {
    const prev = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'sk-test';
    try {
      expect(checkLoginState(CURSOR, home)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
    }
  });
});

describe('cursor 模型清单（F-56 实测：`cursor-agent models` 行格式解析）', () => {
  const CURSOR = KNOWN_AGENTS.find((d) => d.id === 'cli:cursor-agent')!;

  it('只取行首模型 id，显示名（Auto / Composer / Grok…）不被当成模型', () => {
    const stdout = [
      'Available models',
      '',
      'auto - Auto (default)',
      'composer-2.5 - Composer 2.5 (current)',
      'composer-2.5-fast - Composer 2.5 Fast',
      'grok-4.7-high - Grok 4.7  High',
      'grok-4.7-high - Grok 4.7  High', // 重复行去重
    ].join('\n');
    expect(CURSOR.modelsProbe!.parse(stdout)).toEqual([
      'auto',
      'composer-2.5',
      'composer-2.5-fast',
      'grok-4.7-high',
    ]);
  });

  it('静态回落的 models 不含早已下线的 composer-1（防回归）', () => {
    expect(CURSOR.models).not.toContain('composer-1');
    expect(CURSOR.models).toContain('composer-2.5');
  });
});

describe('detectedToSpec / registerDetected（协议接缝）', () => {
  it('detectedToSpec 产出完整 ExternalAgentSpec', () => {
    const detected: DetectedAgent = { def: DEF, command: '/usr/local/bin/claude', version: '2.1.168', source: 'path' };
    const spec = detectedToSpec(detected);
    expect(spec.id).toBe('cli:claude-code');
    expect(spec.kind).toBe('stream-json-jsonl');
    expect(spec.tier).toBe('B');
    expect(spec.command).toBe('/usr/local/bin/claude');
    expect(spec.version).toBe('2.1.168');
    expect(spec.permissionArgs.plan).toEqual(['--permission-mode', 'plan']);
    expect(spec.permissionArgs.default).toEqual([]);
    expect(spec.permissionArgs.yolo).toEqual(['--dangerously-skip-permissions']);
    expect(spec.resumeArgs?.('sess-1')).toEqual(['--resume', 'sess-1']);
    expect(spec.mcpArgs?.('/tmp/mcp.json')).toEqual(['--mcp-config', '/tmp/mcp.json']);
  });

  it('registerDetected 经工厂注册到 registry（P4 工厂语义：注册不实例化，每 run 独立实例）', () => {
    const detected: DetectedAgent = { def: DEF, command: '/usr/local/bin/claude', version: '2.1.168', source: 'env' };
    const stub = { spec: detectedToSpec(detected) } as unknown as ExternalAgentAdapter;
    const factory = vi.fn(() => stub);
    registerDetected(detected, factory);
    expect(factory).not.toHaveBeenCalled(); // 注册只存工厂，不实例化
    const make = resolveExternalAdapter('cli:claude-code');
    expect(make).toBeDefined();
    const first = make!();
    const second = make!();
    expect(factory).toHaveBeenCalledTimes(2); // 每次 run 执行工厂 → 独立实例（并发会话状态隔离）
    expect(first).toBe(stub);
    expect(second).toBe(stub);
  });
});

describe('ensureExternalAdapters（detect → StreamJson 工厂 → registry 组合入口，Task 11）', () => {
  itPosix('探测命中：返回 DetectedAgent[]，registry 注册 StreamJsonExternalAdapter 且 spec 正确', async () => {
    const cmd = writeWrapper('claude-ensure', VERSION_CLI, '2.1.168-ensure');
    process.env[ENV_NAME] = cmd;

    const found = await ensureExternalAdapters({ homeDir: home, probePathEnv: "" });
    expect(found).toHaveLength(1);
    expect(found[0]!.command).toBe(cmd);
    expect(found[0]!.version).toBe('2.1.168-ensure');
    expect(found[0]!.def.id).toBe('cli:claude-code');

    const adapter = resolveExternalAdapter('cli:claude-code')!(); // 工厂语义：执行工厂得到本 run 实例
    expect(adapter).toBeInstanceOf(StreamJsonExternalAdapter);
    expect(adapter!.spec.id).toBe('cli:claude-code');
    expect(adapter!.spec.command).toBe(cmd);
    expect(adapter!.spec.version).toBe('2.1.168-ensure');
    expect(adapter!.spec.tier).toBe('B');
  });

  itPosix('探测失败：静默返回空数组，不覆盖 registry 既有条目（幂等无副作用）', async () => {
    // registry 是进程级单例且无反注册：同文件先行用例（registerDetected/命中用例）已注册过
    // cli:claude-code —— 探测失败路径不得触碰既有条目，以「前后一致」断言
    const before = resolveExternalAdapter('cli:claude-code');
    const cmd = writeWrapper('claude-ensure-fail', VERSION_FAIL, 'ignored');
    process.env[ENV_NAME] = cmd;

    const found = await ensureExternalAdapters({ homeDir: home, probePathEnv: "" });
    expect(found).toEqual([]);
    expect(readExternalAgentsCache(home)).toEqual([]);
    expect(resolveExternalAdapter('cli:claude-code')).toBe(before);
  });

  itPosix('重复调用幂等：同 id 覆盖注册，registry 始终可解析且为 StreamJsonExternalAdapter', async () => {
    const cmd = writeWrapper('claude-ensure-twice', VERSION_CLI, '9.9.9-twice');
    process.env[ENV_NAME] = cmd;

    await ensureExternalAdapters({ homeDir: home, probePathEnv: "" });
    const first = resolveExternalAdapter('cli:claude-code')!();
    await ensureExternalAdapters({ homeDir: home, probePathEnv: "" });
    const second = resolveExternalAdapter('cli:claude-code')!();
    expect(first).toBeInstanceOf(StreamJsonExternalAdapter);
    expect(second).toBeInstanceOf(StreamJsonExternalAdapter);
    expect(second.spec.version).toBe('9.9.9-twice');
  });
});
