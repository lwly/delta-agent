/** F-52 市场核心逻辑测试：registry 配置 / 清单拉取合并 / Skill scripts 闸门 / MCP 连通测试与安装 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  fetchMarketSourceEntries,
  installMarketMcp,
  installMarketSkill,
  listMarketSnapshot,
  removeMarketItem,
  testMcpConnectivity,
  validateScriptName,
  wrapMarketPreview,
} from '../src/market/install.js';
import { findBuiltinMarketEntry } from '../src/market/catalog.js';
import { readMarketSources, userRegistryConfigPath, validateMarketSources, writeMarketSources } from '../src/market/registry.js';
import { encryptMcpHeaders } from '../src/mcp/client.js';

let tmp = '';
let projectDir = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-market-'));
  projectDir = path.join(tmp, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// ── registry 配置（~/.delta/registry.json）──────────────────────────────────

describe('validateMarketSources', () => {
  it('通过合法条目并补齐字段', () => {
    const out = validateMarketSources([{ name: ' team ', url: 'https://x.dev/r.json ', kind: 'skills' }]);
    expect(out).toEqual([{ name: 'team', url: 'https://x.dev/r.json', kind: 'skills' }]);
  });
  it('拒绝非数组 / 空 name / 非法 URL / 非法 kind / 重名', () => {
    expect(() => validateMarketSources({})).toThrow(/数组/);
    expect(() => validateMarketSources([{ name: '', url: 'https://x', kind: 'skills' }])).toThrow(/name/);
    expect(() => validateMarketSources([{ name: 'a', url: 'ftp://x', kind: 'skills' }])).toThrow(/URL/);
    expect(() => validateMarketSources([{ name: 'a', url: 'https://x', kind: 'zip' }])).toThrow(/kind/);
    expect(() =>
      validateMarketSources([
        { name: 'a', url: 'https://x', kind: 'skills' },
        { name: 'a', url: 'https://y', kind: 'mcp' },
      ]),
    ).toThrow(/重复/);
  });
});

describe('readMarketSources 旧配置兼容回退', () => {
  it('registry.json 存在时优先', async () => {
    await writeMarketSources(tmp, [{ name: 'main', url: 'https://x/main.json', kind: 'mcp' }]);
    const r = await readMarketSources(tmp);
    expect(r.sources).toEqual([{ name: 'main', url: 'https://x/main.json', kind: 'mcp' }]);
    expect(r.legacy).toBeFalsy();
  });

  it('registry.json 不存在时回退 skill-hub.json 的 sources（视为 skills 源）', async () => {
    const hubFile = path.join(tmp, '.delta', 'skill-hub.json');
    await fs.mkdir(path.dirname(hubFile), { recursive: true });
    await fs.writeFile(hubFile, JSON.stringify({ sources: [{ name: 'legacy', url: 'https://x/legacy.json' }] }), 'utf8');
    const r = await readMarketSources(tmp);
    expect(r.legacy).toBe(true);
    expect(r.sources).toEqual([{ name: 'legacy', url: 'https://x/legacy.json', kind: 'skills' }]);
  });

  it('坏 JSON 降级为空列表 + error 提示', async () => {
    const file = userRegistryConfigPath(tmp);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{broken', 'utf8');
    const r = await readMarketSources(tmp);
    expect(r.sources).toEqual([]);
    expect(r.error).toContain('registry.json 解析失败');
  });
});

// ── 远程清单拉取与快照合并 ──────────────────────────────────────────────────

const REGISTRY_JSON = {
  skills: [
    { name: 'deploy-check', description: '部署检查', body: '# 步骤', triggers: ['deploy'],
      scripts: [{ name: 'check.sh', content: '#!/bin/sh\necho ok' }] },
    // 与内置同名：验证 builtin 优先去重
    { name: 'code-review', description: '社区版代码审查（应被内置去重）', body: 'x' },
    { name: 'bad entry!', description: '非法名称' },
    { description: '缺 name' },
  ],
  mcpServers: [
    { name: 'remote-mcp', description: '远端 MCP', draft: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'tok' } } },
  ],
};

function startRegistryServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(REGISTRY_JSON));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/registry.json` });
    });
  });
}

describe('fetchMarketSourceEntries / listMarketSnapshot', () => {
  it('拉取并规范化条目：非法条目记错误不炸整源', async () => {
    const { server, url } = await startRegistryServer();
    try {
      const r = await fetchMarketSourceEntries({ name: 'community', url, kind: 'skills' });
      expect(r.status).toBe('ok');
      expect(r.entries.map((e) => e.name).sort()).toEqual(['code-review', 'deploy-check', 'remote-mcp']);
      const skill = r.entries.find((e) => e.name === 'deploy-check')!;
      expect(skill.kind).toBe('skill');
      expect(skill.kind === 'skill' && skill.scripts?.[0]?.name).toBe('check.sh');
      expect(r.entryErrors.length).toBe(2); // 非法名称 + 缺 name
    } finally {
      server.close();
    }
  });

  it('快照合并：内置优先去重 + 已装检测 + 离线源降级', async () => {
    const { server, url } = await startRegistryServer();
    try {
      await writeMarketSources(tmp, [
        { name: 'community', url, kind: 'skills' },
        { name: 'offline', url: 'http://127.0.0.1:9/unreachable.json', kind: 'mcp' },
      ]);
      // 预装：用户级放一个与内置同名 skill（code-review）与 registry 同名 skill（deploy-check）
      const r = await installMarketSkill(
        { kind: 'skill', name: 'deploy-check', description: 'd', category: 'c', version: '1', author: 'a',
          triggers: [], toolsAllowlist: [], body: 'b' },
        { layers: { homeDir: tmp }, scope: 'user', confirmScripts: true },
      );
      expect(r.status).toBe('installed');

      const snap = await listMarketSnapshot({ homeDir: tmp, projectRoot: projectDir });
      const kinds = snap.items.map((i) => `${i.entry.kind}:${i.entry.name}`);
      // 内置条目在列
      expect(kinds).toContain('skill:code-review');
      expect(kinds).toContain('mcp:everything');
      // 内置优先去重：code-review 只出现一次且 source=builtin；deploy-check 来自订阅源且已装
      const review = snap.items.filter((i) => i.entry.name === 'code-review');
      expect(review).toHaveLength(1);
      expect(review[0]!.source).toBe('builtin');
      const deploy = snap.items.filter((i) => i.entry.name === 'deploy-check');
      expect(deploy).toHaveLength(1);
      expect(deploy[0]!.source).toBe('community');
      expect(deploy[0]!.installedIn.user).toBe(true);
      // 离线源降级：状态 error，其余条目照常
      const offline = snap.sources.find((s) => s.name === 'offline')!;
      expect(offline.status).toBe('error');
      expect(snap.items.length).toBeGreaterThanOrEqual(12);
    } finally {
      server.close();
    }
  });
});

// ── Skill 安装（scripts 闸门）───────────────────────────────────────────────

const scriptedSkill = {
  kind: 'skill' as const,
  name: 'deploy-check',
  description: '部署检查',
  category: '运维',
  version: '1.0.0',
  author: 'tester',
  triggers: ['deploy'],
  toolsAllowlist: ['run_command'],
  body: '# 部署检查',
  scripts: [{ name: 'check.sh', content: '#!/bin/sh\necho ok' }],
};

describe('installMarketSkill scripts 闸门', () => {
  it('含 scripts 未确认 → scripts_required；确认后落盘 SKILL.md + scripts/', async () => {
    const r1 = await installMarketSkill(scriptedSkill, { layers: { homeDir: tmp }, scope: 'user' });
    expect(r1.status).toBe('scripts_required');
    expect(r1.scripts).toHaveLength(1);
    expect(await fs.access(path.join(tmp, '.delta', 'skills', 'deploy-check')).then(() => true, () => false)).toBe(false);

    const r2 = await installMarketSkill(scriptedSkill, { layers: { homeDir: tmp }, scope: 'user', confirmScripts: true });
    expect(r2.status).toBe('installed');
    expect(r2.scriptsWritten).toEqual(['check.sh']);
    const skillDir = path.join(tmp, '.delta', 'skills', 'deploy-check');
    expect(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('# 部署检查');
    expect(await fs.readFile(path.join(skillDir, 'scripts', 'check.sh'), 'utf8')).toContain('echo ok');
  });

  it('脚本名非法（路径越界）整包拒绝，不落任何文件', async () => {
    const evil = { ...scriptedSkill, scripts: [{ name: '../escape.sh', content: 'evil' }] };
    await expect(
      installMarketSkill(evil, { layers: { homeDir: tmp }, scope: 'user', confirmScripts: true }),
    ).rejects.toThrow(/脚本名/);
    expect(await fs.access(path.join(tmp, '.delta', 'skills', 'deploy-check')).then(() => true, () => false)).toBe(false);
  });

  it('同名已存在需 force（覆盖 = 先删后装）', async () => {
    await installMarketSkill(scriptedSkill, { layers: { homeDir: tmp }, scope: 'user', confirmScripts: true });
    await expect(
      installMarketSkill(scriptedSkill, { layers: { homeDir: tmp }, scope: 'user', confirmScripts: true }),
    ).rejects.toThrow(/已存在同名 Skill/);
    const r = await installMarketSkill(scriptedSkill, { layers: { homeDir: tmp }, scope: 'user', confirmScripts: true, force: true });
    expect(r.status).toBe('installed');
  });

  it('validateScriptName 拒绝路径分隔符与隐藏文件', () => {
    expect(validateScriptName('check.sh')).toBeNull();
    expect(validateScriptName('../x')).toContain('脚本名');
    expect(validateScriptName('a/b')).toContain('脚本名');
    expect(validateScriptName('.hidden')).toContain('脚本名');
  });
});

// ── MCP 连通性测试 + 安装 ───────────────────────────────────────────────────

/** 复用 mcp-f48 模式：起一个只讲 JSON-RPC 的假 streamable HTTP MCP 服务 */
function startFakeMcpHttp(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      if (!body) { res.writeHead(200); res.end(); return; }
      const msg = JSON.parse(body) as { id?: number | string; method: string };
      const reply = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') {
        reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } });
      } else if (msg.method.startsWith('notifications/')) {
        res.writeHead(202); res.end();
      } else if (msg.method === 'tools/list') {
        reply({ tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object', properties: {} } }] });
      } else { res.writeHead(404); res.end(); }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('testMcpConnectivity / installMarketMcp', () => {
  it('连通成功：ok + 工具数；写入 mcp.json 且 headers 加密落盘', async () => {
    const { server, url } = await startFakeMcpHttp();
    try {
      const probe = await testMcpConnectivity({ url, headers: { Authorization: 'plain-tok' } });
      expect(probe.ok).toBe(true);
      expect(probe.toolCount).toBe(1);

      const entry = {
        kind: 'mcp' as const, name: 'remote-mcp', description: 'd', category: 'c', version: '1', author: 'a',
        draft: { url, headers: { Authorization: 'plain-tok' } },
      };
      const r = await installMarketMcp(entry, { homeDir: tmp, scope: 'global' });
      expect(r.status).toBe('installed');
      expect(r.toolCount).toBe(1);
      const raw = await fs.readFile(path.join(tmp, '.delta', 'mcp.json'), 'utf8');
      const parsed = JSON.parse(raw) as { mcpServers: Record<string, { url: string; headers?: Record<string, string> }> };
      expect(parsed.mcpServers['remote-mcp']!.url).toBe(url);
      // AC-48 口径沿用：明文 header 不落盘
      expect(parsed.mcpServers['remote-mcp']!.headers!.Authorization).toMatch(/^enc:v1:/);
      expect(parsed.mcpServers['remote-mcp']!.headers!.Authorization).not.toContain('plain-tok');
      expect(encryptMcpHeaders({ Authorization: 'plain-tok' })!.Authorization).toMatch(/^enc:v1:/);
    } finally {
      server.close();
    }
  });

  it('连通失败：不写盘 + 指引「下一步」', async () => {
    const port = await freePort();
    const entry = {
      kind: 'mcp' as const, name: 'bad-mcp', description: 'd', category: 'c', version: '1', author: 'a',
      draft: { url: `http://127.0.0.1:${port}/mcp` },
    };
    const r = await installMarketMcp(entry, { homeDir: tmp, scope: 'global' });
    expect(r.status).toBe('connect_failed');
    expect(r.error).toContain('下一步');
    await expect(fs.access(path.join(tmp, '.delta', 'mcp.json'))).rejects.toThrow();
  });
});

// ── 卸载 / untrusted 预览 ───────────────────────────────────────────────────

describe('removeMarketItem / wrapMarketPreview', () => {
  it('卸载 skill 与 mcp；untrusted 预览包含包裹标记', async () => {
    const plain = { kind: 'skill' as const, name: 'deploy-check', description: 'd', category: 'c', version: '1',
      author: 'a', triggers: [], toolsAllowlist: [], body: 'b' };
    await installMarketSkill(plain, { layers: { homeDir: tmp }, scope: 'user' });
    const r1 = await removeMarketItem('skill', 'deploy-check', 'user', { homeDir: tmp });
    expect(r1.path).toContain('skills');

    await fs.mkdir(path.join(tmp, '.delta'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.delta', 'mcp.json'), JSON.stringify({ mcpServers: { foo: { command: 'x' } } }), 'utf8');
    const r2 = await removeMarketItem('mcp', 'foo', 'user', { homeDir: tmp });
    expect(r2.path).toContain('mcp.json');
    const after = JSON.parse(await fs.readFile(path.join(tmp, '.delta', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers).toEqual({});

    const preview = wrapMarketPreview(
      { kind: 'skill', name: 'deploy-check', description: '外部描述', body: '外部正文', category: '', version: '', author: '', triggers: [], toolsAllowlist: [] },
      'community',
    );
    expect(preview.description).toContain('<untrusted_content source="market:community/deploy-check">');
    expect(preview.body).toContain('</untrusted_content>');
  });

  it('内置清单含 everything MCP 条目（连通测试用演示草案）', () => {
    const e = findBuiltinMarketEntry('mcp', 'everything');
    expect(e?.kind).toBe('mcp');
    expect(e && e.kind === 'mcp' && e.draft.command).toBe('npx');
  });
});
