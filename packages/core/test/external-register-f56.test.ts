/**
 * F-56 外部 Agent 手动注册单测（PASI-87，docs/design-f56-external-agent-registration.md §4/§5）：
 *  - 模板注册表：6 CLI 齐备，ACP 模板带 protocolArgs，dsh 为 reserved 预留档
 *  - upsert/remove：manual 条目写读、校验错误、白名单字段
 *  - 探测合并：manual 优先于缓存、probe 失败不移除（AC-56-5）、探测不覆盖手动字段
 *  - 适配器分派：codebuddy→AcpExternalAdapter（spec.args 含 --acp）、dsh→ReservedExternalAdapter
 *    （external_unsupported_protocol，AC-56-4）
 *
 * 零网络、零真实 CLI：probe 全部指向 node + fixture（POSIX /bin/sh 包装），HOME/PATH 隔离同 F-55 测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_AGENTS,
  detectExternalAgents,
  detectedToSpec,
  ensureExternalAdapters,
  externalEnvPathName,
  ManualRegisterError,
  readExternalAgentsCache,
  removeManualEntry,
  upsertManualEntry,
  writeExternalAgentsCache,
} from '../src/external/detect.js';
import { resolveExternalAdapter } from '../src/external/registry.js';
import { AcpExternalAdapter } from '../src/external/acp.js';
import { ReservedExternalAdapter } from '../src/external/reserved.js';
import type { ExternalAgentCacheEntry } from '../src/external/detect.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NODE = process.execPath;
const IS_POSIX = process.platform !== 'win32';
const itPosix = IS_POSIX ? it : it.skip;

let tmpRoot: string;
let home: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

/** POSIX 包装脚本：把 version-cli.mjs 包成独立可执行（探测命令必须是单个可执行路径） */
function writeWrapper(name: string, version: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, 'version-cli.mjs')}" "${version}"\n`, { mode: 0o755 });
  return p;
}

function cacheFile(): string {
  return path.join(home, '.delta', 'external.json');
}

/** 手动注册条目（codebuddy 形状） */
function manualEntry(command: string, overrides: Partial<ExternalAgentCacheEntry> = {}): ExternalAgentCacheEntry {
  return {
    id: 'cli:codebuddy',
    kind: 'acp',
    command,
    version: '2.171.0',
    tier: 'A',
    enabled: true,
    lastProbeAt: '2026-11-05T00:00:00.000Z',
    manual: true,
    displayName: 'CodeBuddy 自建',
    description: '本地构建的 codebuddy',
    ...overrides,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-f56-'));
  home = path.join(tmpRoot, 'home');
  fs.mkdirSync(home, { recursive: true });
  for (const def of KNOWN_AGENTS) delete process.env[externalEnvPathName(def.id)];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('模板注册表（F-56：6 CLI 齐备）', () => {
  it('KNOWN_AGENTS 含 6 个模板，id/协议/tier 符合矩阵', () => {
    const ids = KNOWN_AGENTS.map((d) => d.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'cli:claude-code',
        'cli:codex',
        'cli:codebuddy',
        'cli:cursor-agent',
        'cli:opencode',
        'cli:dsh',
      ]),
    );
    const byId = (id: string) => KNOWN_AGENTS.find((d) => d.id === id)!;
    expect(byId('cli:codebuddy').kind).toBe('acp');
    expect(byId('cli:codebuddy').protocolArgs).toEqual(['--acp']);
    expect(byId('cli:cursor-agent').kind).toBe('acp');
    expect(byId('cli:cursor-agent').protocolArgs).toEqual(['acp']);
    expect(byId('cli:opencode').kind).toBe('acp');
    expect(byId('cli:opencode').protocolArgs).toEqual(['acp']);
    expect(byId('cli:dsh').kind).toBe('reserved');
    expect(byId('cli:dsh').tier).toBe('D');
    // 每个模板都有向导展示字段
    for (const d of KNOWN_AGENTS) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it('detectedToSpec 透传 protocolArgs 到 spec.args', () => {
    const def = KNOWN_AGENTS.find((d) => d.id === 'cli:codebuddy')!;
    const spec = detectedToSpec({ def, command: '/usr/local/bin/codebuddy', version: '2.171.0', source: 'manual' });
    expect(spec.args).toEqual(['--acp']);
  });
});

describe('upsertManualEntry / removeManualEntry', () => {
  it('注册 → 写入 manual 条目（manual/displayName/command/description，AC-56-1）', () => {
    const entry = upsertManualEntry(
      { templateId: 'cli:codebuddy', command: '/opt/cb/bin/codebuddy', displayName: 'CB', description: '自建' },
      home,
    );
    expect(entry.manual).toBe(true);
    expect(entry.id).toBe('cli:codebuddy');
    expect(entry.kind).toBe('acp');
    expect(entry.tier).toBe('A');
    expect(entry.command).toBe('/opt/cb/bin/codebuddy');
    expect(entry.displayName).toBe('CB');
    expect(entry.description).toBe('自建');
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as { agents: ExternalAgentCacheEntry[] };
    expect(raw.agents).toHaveLength(1);
    expect(raw.agents[0]!.manual).toBe(true);
  });

  it('command 缺省 = 模板 executable；displayName 缺省 = 模板 label', () => {
    const entry = upsertManualEntry({ templateId: 'cli:opencode' }, home);
    expect(entry.command).toBe('opencode');
    expect(entry.displayName).toBe('OpenCode');
  });

  it('未知模板 / 空 command / 超长字段 → ManualRegisterError 明确错误码', () => {
    expect(() => upsertManualEntry({ templateId: 'cli:nope' }, home)).toThrow(ManualRegisterError);
    expect(() => upsertManualEntry({ templateId: 'cli:codebuddy', command: '  ' }, home)).toThrow(ManualRegisterError);
    expect(() => upsertManualEntry({ templateId: 'cli:codebuddy', displayName: 'x'.repeat(101) }, home)).toThrow(
      ManualRegisterError,
    );
  });

  it('upsert 同模板覆盖（v1 一个模板一个手动条目），version 沿用上次手动条目', () => {
    upsertManualEntry({ templateId: 'cli:codebuddy', command: '/a/codebuddy' }, home);
    const second = upsertManualEntry({ templateId: 'cli:codebuddy', command: '/b/codebuddy' }, home);
    expect(second.command).toBe('/b/codebuddy');
    expect(readExternalAgentsCache(home)).toHaveLength(1);
    expect(readExternalAgentsCache(home)[0]!.version).toBe('');
  });

  it('removeManualEntry 只删 manual 条目；探测缓存条目与非存在 id 返回 false', () => {
    upsertManualEntry({ templateId: 'cli:codebuddy' }, home);
    expect(removeManualEntry('cli:codebuddy', home)).toBe(true);
    expect(readExternalAgentsCache(home)).toHaveLength(0);
    expect(removeManualEntry('cli:codebuddy', home)).toBe(false);
    writeExternalAgentsCache([manualEntry('/x', { manual: undefined })], home);
    expect(removeManualEntry('cli:codebuddy', home)).toBe(false);
  });

  it('白名单：token/key 等额外字段读入即丢弃，F-56 三字段保留（AC-55-9）', () => {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({
        agents: [
          { ...manualEntry('/x'), token: 'SECRET', apiKey: 'SECRET2' },
        ],
      }),
    );
    const agents = readExternalAgentsCache(home);
    expect(agents[0]!.manual).toBe(true);
    expect(agents[0]!.displayName).toBe('CodeBuddy 自建');
    expect(JSON.stringify(agents[0])).not.toContain('SECRET');
  });
});

describe('探测合并（AC-56-5：手动优先、不移除、不覆盖手动字段）', () => {
  it('manual 条目 probe 失败 → 保留并以缓存 version 呈现（source=manual）', async () => {
    writeExternalAgentsCache([manualEntry('/nonexistent/codebuddy')], home);
    const detected = await detectExternalAgents({ homeDir: home, probePathEnv: '' });
    const hit = detected.find((d) => d.def.id === 'cli:codebuddy')!;
    expect(hit).toBeDefined();
    expect(hit.source).toBe('manual');
    expect(hit.version).toBe('2.171.0'); // 过期版本串，非 probe 产物
    // external.json 仍保留 manual 条目
    const cached = readExternalAgentsCache(home).find((e) => e.id === 'cli:codebuddy')!;
    expect(cached.manual).toBe(true);
  });

  itPosix('manual 条目 probe 成功 → version 刷新且 manual/displayName 保留', async () => {
    const wrapper = writeWrapper('cb', '2.999.0-test');
    writeExternalAgentsCache([manualEntry(wrapper)], home);
    const detected = await detectExternalAgents({ homeDir: home, probePathEnv: '' });
    const hit = detected.find((d) => d.def.id === 'cli:codebuddy')!;
    expect(hit.version).toBe('2.999.0-test');
    expect(hit.manual).toBe(true);
    expect(hit.displayName).toBe('CodeBuddy 自建');
    const cached = readExternalAgentsCache(home).find((e) => e.id === 'cli:codebuddy')!;
    expect(cached.manual).toBe(true);
    expect(cached.displayName).toBe('CodeBuddy 自建');
    expect(cached.command).toBe(wrapper);
  });

  itPosix('manual 条目优先于探测缓存条目（同 id，manual 命中的命令胜出）', async () => {
    const wrapperA = writeWrapper('cb-a', '1.0.0-manual');
    const wrapperB = writeWrapper('cb-b', '2.0.0-cache');
    writeExternalAgentsCache([
      manualEntry(wrapperA, { version: '1.0.0-manual' }),
      manualEntry(wrapperB, { manual: undefined, version: '2.0.0-cache' }),
    ], home);
    const detected = await detectExternalAgents({ homeDir: home, probePathEnv: '' });
    const hit = detected.find((d) => d.def.id === 'cli:codebuddy')!;
    expect(hit.command).toBe(wrapperA);
    expect(hit.source).toBe('manual');
  });

  itPosix('非 manual 缓存条目 probe 失效 → 维持 F-55 语义：降级 PATH（空 PATH 则移除）', async () => {
    writeExternalAgentsCache([manualEntry('/nonexistent', { manual: undefined })], home);
    const detected = await detectExternalAgents({ homeDir: home, probePathEnv: '' });
    expect(detected.find((d) => d.def.id === 'cli:codebuddy')).toBeUndefined();
    expect(readExternalAgentsCache(home).find((e) => e.id === 'cli:codebuddy')).toBeUndefined();
  });
});

describe('适配器分派（F-56）', () => {
  itPosix('codebuddy 手动条目 → AcpExternalAdapter 工厂，spec.args 含 --acp', async () => {
    const wrapper = writeWrapper('cb2', '2.171.0');
    writeExternalAgentsCache([manualEntry(wrapper)], home);
    const detected = await ensureExternalAdapters({ homeDir: home, probePathEnv: '' });
    expect(detected.map((d) => d.def.id)).toContain('cli:codebuddy');
    const factory = resolveExternalAdapter('cli:codebuddy');
    expect(factory).toBeDefined();
    const adapter = factory!();
    expect(adapter).toBeInstanceOf(AcpExternalAdapter);
    expect(adapter.spec.args).toEqual(['--acp']);
    expect(adapter.spec.kind).toBe('acp');
  });

  itPosix('dsh 条目 → ReservedExternalAdapter，run 报 external_unsupported_protocol（AC-56-4）', async () => {
    const wrapper = writeWrapper('dsh', '0.2.1-rc.3');
    writeExternalAgentsCache(
      [manualEntry(wrapper, { id: 'cli:dsh', kind: 'reserved', tier: 'D', displayName: 'DSH 预留' })],
      home,
    );
    const detected = await ensureExternalAdapters({ homeDir: home, probePathEnv: '' });
    expect(detected.map((d) => d.def.id)).toContain('cli:dsh');
    const factory = resolveExternalAdapter('cli:dsh');
    expect(factory).toBeDefined();
    const adapter = factory!();
    expect(adapter).toBeInstanceOf(ReservedExternalAdapter);
    const events = [];
    for await (const ev of adapter.run({
      prompt: 'hi',
      cwd: tmpRoot,
      permissionMode: 'default',
      signal: new AbortController().signal,
    })) {
      events.push(ev);
    }
    const fatal = events.find((e) => e.type === 'error') as { fatal: boolean; message: string };
    expect(fatal.fatal).toBe(true);
    expect(fatal.message).toContain('external_unsupported_protocol');
    expect(events.at(-1)!.type).toBe('done');
  });
});
