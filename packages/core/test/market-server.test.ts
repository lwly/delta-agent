/** F-52 市场端点测试（/api/market*） */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import { writeMarketSources } from '../src/market/registry.js';
import type { SessionHubDeps } from '../src/server/hub.js';

let tmp = '';
let projectDir = '';
let service: SessionService;
let server: ReturnType<typeof createWebServer>;
let base = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-market-srv-'));
  projectDir = path.join(tmp, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'README.md'), '# demo');
  service = new SessionService(path.join(tmp, 'db.sqlite'));
  const deps: SessionHubDeps = {
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => {
      throw new Error('not used');
    },
  };
  const hub = new SessionHub(deps);
  server = createWebServer({ service, hub, port: 0, skillsHomeDir: tmp, configHomeDir: tmp });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

// ── 快照 / 来源配置 ─────────────────────────────────────────────────────────

describe('GET /api/market + sources', () => {
  it('返回内置清单（skill + mcp）与空订阅源', async () => {
    const { status, json } = await api('GET', '/api/market');
    expect(status).toBe(200);
    const items = json.items as Array<{ kind: string; name: string; source: string }>;
    expect(items.some((i) => i.kind === 'skill' && i.name === 'code-review' && i.source === 'builtin')).toBe(true);
    expect(items.some((i) => i.kind === 'mcp' && i.name === 'everything')).toBe(true);
    expect(json.sources).toEqual([]);
  });

  it('sources PUT/GET 往返；非法 kind 拒绝', async () => {
    const bad = await api('PUT', '/api/market/sources', { sources: [{ name: 'x', url: 'https://x/r.json', kind: 'zip' }] });
    expect(bad.status).toBe(400);
    const put = await api('PUT', '/api/market/sources', { sources: [{ name: 'team', url: 'https://x/r.json', kind: 'skills' }] });
    expect(put.status).toBe(200);
    const get = await api('GET', '/api/market/sources');
    expect(get.status).toBe(200);
    expect(get.json.sources).toEqual([{ name: 'team', url: 'https://x/r.json', kind: 'skills' }]);
  });
});

// ── Skill 安装（含 scripts 409 流程）────────────────────────────────────────

const REGISTRY_JSON = {
  skills: [
    { name: 'deploy-check', description: '部署检查', body: '# 步骤', triggers: ['deploy'],
      scripts: [{ name: 'check.sh', content: '#!/bin/sh\necho ok' }] },
    { name: 'plain-skill', description: '无脚本技能', body: '# 直接装' },
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

describe('POST /api/market/install（skill）', () => {
  let registry: { server: http.Server; url: string };
  beforeEach(async () => {
    registry = await startRegistryServer();
    await writeMarketSources(tmp, [{ name: 'community', url: registry.url, kind: 'skills' }]);
  });
  afterEach(() => {
    registry.server.close();
  });

  it('内置无脚本条目直接安装落盘', async () => {
    const { status, json } = await api('POST', '/api/market/install', {
      kind: 'skill', source: 'builtin', name: 'code-review', scope: 'user',
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const file = await fs.readFile(path.join(tmp, '.delta', 'skills', 'code-review', 'SKILL.md'), 'utf8');
    expect(file).toContain('description:');
  });

  it('含 scripts 条目 → 409 + 脚本清单；confirmScripts 后落盘', async () => {
    const r1 = await api('POST', '/api/market/install', {
      kind: 'skill', source: 'community', name: 'deploy-check', scope: 'user',
    });
    expect(r1.status).toBe(409);
    const scripts = r1.json.scripts as Array<{ name: string; content: string }>;
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.name).toBe('check.sh');

    const r2 = await api('POST', '/api/market/install', {
      kind: 'skill', source: 'community', name: 'deploy-check', scope: 'user', confirmScripts: true,
    });
    expect(r2.status).toBe(200);
    expect(r2.json.scriptsWritten).toEqual(['check.sh']);
    const onDisk = await fs.readFile(path.join(tmp, '.delta', 'skills', 'deploy-check', 'scripts', 'check.sh'), 'utf8');
    expect(onDisk).toContain('echo ok');
  });

  it('远程条目预览带 untrusted 包裹', async () => {
    const { status, json } = await api('GET', '/api/market/item?kind=skill&source=community&name=plain-skill');
    expect(status).toBe(200);
    const preview = json.preview as { description: string; body: string };
    expect(preview.description).toContain('<untrusted_content source="market:community/plain-skill">');
    expect(preview.body).toContain('</untrusted_content>');
  });

  it('卸载：用户级可删、内置拒绝 403', async () => {
    await api('POST', '/api/market/install', { kind: 'skill', source: 'builtin', name: 'code-review', scope: 'user' });
    const del = await api('DELETE', '/api/market/item?kind=skill&name=code-review&scope=user');
    expect(del.status).toBe(200);
    const forbidden = await api('DELETE', '/api/market/item?kind=skill&name=git-flow&scope=user&source=builtin');
    expect(forbidden.status).toBe(403);
  });
});

// ── MCP 安装（连通测试门禁）─────────────────────────────────────────────────

/** 复用 mcp-f48 模式：假 streamable HTTP MCP 服务 */
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

describe('POST /api/market/install（mcp）', () => {
  it('条目不存在 → 404', async () => {
    const { status } = await api('POST', '/api/market/install', {
      kind: 'mcp', source: 'builtin', name: 'everything-x', scope: 'global',
    });
    expect(status).toBe(404);
  });

  it('连通失败（draft 指向不可达端口）→ 502 不落盘', async () => {
    const regServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        mcpServers: [{ name: 'dead-mcp', description: '不可达', draft: { url: 'http://127.0.0.1:9/mcp' } }],
      }));
    });
    await new Promise<void>((r) => regServer.listen(0, '127.0.0.1', r));
    const { port } = regServer.address() as AddressInfo;
    await writeMarketSources(tmp, [{ name: 'mcp-src', url: `http://127.0.0.1:${port}/registry.json`, kind: 'mcp' }]);
    try {
      const r = await api('POST', '/api/market/install', { kind: 'mcp', source: 'mcp-src', name: 'dead-mcp', scope: 'global' });
      expect(r.status).toBe(502);
      expect(String(r.json.error)).toContain('下一步');
      await expect(fs.access(path.join(tmp, '.delta', 'mcp.json'))).rejects.toThrow();
    } finally {
      regServer.close();
    }
  });

  it('连通成功 → 200 写入 mcp.json（headers 加密）', async () => {
    const fake = await startFakeMcpHttp();
    try {
      // 通过订阅源暴露一个指向假服务的 MCP 条目
      const regServer = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          mcpServers: [{ name: 'local-mcp', description: '本地假服务', draft: { url: fake.url, headers: { Authorization: 'tok-1' } } }],
        }));
      });
      await new Promise<void>((r) => regServer.listen(0, '127.0.0.1', r));
      const { port } = regServer.address() as AddressInfo;
      await writeMarketSources(tmp, [{ name: 'mcp-src', url: `http://127.0.0.1:${port}/registry.json`, kind: 'mcp' }]);

      const { status, json } = await api('POST', '/api/market/install', {
        kind: 'mcp', source: 'mcp-src', name: 'local-mcp', scope: 'global',
      });
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.toolCount).toBe(1);
      const raw = JSON.parse(await fs.readFile(path.join(tmp, '.delta', 'mcp.json'), 'utf8')) as {
        mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
      };
      expect(raw.mcpServers['local-mcp']!.url).toBe(fake.url);
      expect(raw.mcpServers['local-mcp']!.headers!.Authorization).toMatch(/^enc:v1:/);

      // 卸载：从 mcp.json 移除
      const del = await api('DELETE', '/api/market/item?kind=mcp&name=local-mcp&scope=user');
      expect(del.status).toBe(200);
      const after = JSON.parse(await fs.readFile(path.join(tmp, '.delta', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
      expect(after.mcpServers).toEqual({});
      regServer.close();
    } finally {
      fake.server.close();
    }
  });
});
