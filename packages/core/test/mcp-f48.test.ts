import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpManager, loadMcpConfig, encryptMcpHeaders, decryptMcpHeaders } from '../src/mcp/client.js';
import type { McpServerConfig } from '../src/mcp/client.js';
import { validateMcpServers } from '../src/server/config-store.js';
import { encryptKey } from '../src/llm/keychain.js';
// F-48：resources/prompts 走真实 SDK 配对（InMemory），streamable HTTP 走本地假 JSON-RPC 服务。
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let tmpRoot = '';
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-mcp48-'));
});

// ── header 鉴权加解密（AC-48-1：header Key 加密存储不回显）──────────────────

describe('MCP header encryption (F-48)', () => {
  it('encryptMcpHeaders encrypts plaintext, keeps ciphertext as-is', () => {
    const stored = encryptKey('super-secret');
    const out = encryptMcpHeaders({ Authorization: 'plain-token', X: stored })!;
    expect(out['Authorization']).toMatch(/^enc:v1:/);
    expect(out['Authorization']).not.toContain('plain-token');
    expect(out['X']).toBe(stored);
  });

  it('decryptMcpHeaders round-trips ciphertext and tolerates plaintext', () => {
    const enc = encryptMcpHeaders({ Authorization: 'round-trip' })!;
    expect(decryptMcpHeaders(enc)).toEqual({ Authorization: 'round-trip' });
    expect(decryptMcpHeaders({ A: 'plain' })).toEqual({ A: 'plain' });
    expect(decryptMcpHeaders(undefined)).toBeUndefined();
  });

  it('decryptMcpHeaders throws a guidance error on foreign ciphertext', () => {
    // 有效 enc:v1: 前缀但内容是随机串 → keychain 解密失败
    expect(() => decryptMcpHeaders({ Authorization: 'enc:v1:AAAA:BBBB:CCCC:DDDD' })).toThrow(/重新配置/);
  });
});

// ── resources / prompts（AC-48-2 / AC-48-3，InMemory 真实 SDK 配对）──────────

async function attachSdkServer(mgr: McpManager, name: string): Promise<void> {
  const server = new SdkMcpServer({ name: 'fake', version: '1.0.0' });
  server.registerTool('ping', { description: 'ping 工具', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  server.registerResource('greeting', 'memo://greet', { name: 'greeting' }, async () => ({
    contents: [{ uri: 'memo://greet', mimeType: 'text/plain', text: 'hello from resource' }],
  }));
  server.registerPrompt('greet', { description: '问候模板' }, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Hello, delta' } }],
  }));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await mgr.connectWithTransport(name, { command: 'noop' }, clientT);
}

describe('MCP resources/prompts (F-48, InMemory pairing)', () => {
  it('lists and reads resources with untrusted wrapping, no auto-poll', async () => {
    const mgr = new McpManager();
    await attachSdkServer(mgr, 'memo');
    const list = await mgr.listResources('memo');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ uri: 'memo://greet', name: 'greeting' });

    const res = await mgr.readResource('memo', 'memo://greet');
    expect(res.ok).toBe(true);
    expect(res.content).toContain('hello from resource');
    // F-44/AC-48-2：资源内容为外部内容 → untrusted 包裹
    expect(res.content).toContain('<untrusted_content source="mcp:memo/resource:memo://greet">');
    await mgr.disconnectAll();
  });

  it('lists prompts and assembles template messages (untrusted)', async () => {
    const mgr = new McpManager();
    await attachSdkServer(mgr, 'memo');
    const list = await mgr.listPrompts('memo');
    expect(list.map((p) => p.name)).toContain('greet');

    const res = await mgr.getPrompt('memo', 'greet');
    expect(res.ok).toBe(true);
    expect(res.content).toContain('Hello, delta');
    expect(res.content).toContain('[user]');
    expect(res.content).toContain('<untrusted_content source="mcp:memo/prompt:greet">');
    await mgr.disconnectAll();
  });

  it('bridged tool descriptions carry untrusted markers (AC-48-4)', async () => {
    const mgr = new McpManager();
    await attachSdkServer(mgr, 'memo');
    const tools = await mgr.listTools('memo');
    const tool = mgr.toAgentTool('memo', tools[0]!);
    expect(tool.description).toContain('<untrusted_content source="mcp:memo/tool/ping">');
    await mgr.disconnectAll();
  });
});

// ── streamable HTTP transport（AC-48-1，本地假 JSON-RPC 端点）────────────────

interface FakeCapture {
  authorization?: string;
}

/** 起一个只讲 JSON-RPC（application/json 单响应）的假 streamable HTTP 服务。 */
function startFakeMcpHttp(capture: FakeCapture): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      capture.authorization = req.headers.authorization;
      if (!body) { // 会话关闭等无请求体调用（如 DELETE）
        res.writeHead(200);
        res.end();
        return;
      }
      const msg = JSON.parse(body) as { id?: number | string; method: string; params?: Record<string, unknown> };
      const reply = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') {
        reply({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'fake-http', version: '1.0.0' },
        });
      } else if (msg.method.startsWith('notifications/')) {
        res.writeHead(202);
        res.end();
      } else if (msg.method === 'tools/list') {
        reply({ tools: [{ name: 'ping', description: 'pings', inputSchema: { type: 'object', properties: {} } }] });
      } else if (msg.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: 'pong over http' }] });
      } else if (msg.method === 'resources/list') {
        reply({ resources: [{ uri: 'memo://greet', name: 'greeting' }] });
      } else if (msg.method === 'resources/read') {
        reply({ contents: [{ uri: msg.params?.uri, mimeType: 'text/plain', text: 'resource over http' }] });
      } else if (msg.method === 'prompts/list') {
        reply({ prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }] });
      } else if (msg.method === 'prompts/get') {
        const who = (msg.params?.arguments as Record<string, string> | undefined)?.who ?? '?';
        reply({ messages: [{ role: 'user', content: { type: 'text', text: `Hello, ${who}` } }] });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('MCP streamable HTTP transport (F-48)', () => {
  it('handshakes, lists/calls tools, reads resources and prompts with decrypted headers', async () => {
    const capture: FakeCapture = {};
    const server = await startFakeMcpHttp(capture);
    const { port } = server.address() as AddressInfo;
    const mgr = new McpManager();
    try {
      const cfg: McpServerConfig = {
        url: `http://127.0.0.1:${port}/mcp`,
        headers: encryptMcpHeaders({ Authorization: 'Bearer http-token' }),
      };
      await mgr.connect('remote', cfg);
      expect(mgr.servers).toContain('remote');

      // 握手后请求头携带解密后的鉴权值（密文只在落盘时存在）
      const tools = await mgr.listTools('remote');
      expect(tools.map((t) => t.name)).toEqual(['ping']);
      expect(capture.authorization).toBe('Bearer http-token');

      const called = await mgr.callTool('remote', 'ping', {});
      expect(called.ok).toBe(true);
      expect(called.content).toContain('pong over http');
      expect(called.content).toContain('<untrusted_content source="mcp:remote/ping">');

      const list = await mgr.listResources('remote');
      expect(list[0]?.uri).toBe('memo://greet');
      const read = await mgr.readResource('remote', 'memo://greet');
      expect(read.content).toContain('resource over http');

      const prompts = await mgr.listPrompts('remote');
      expect(prompts[0]?.name).toBe('greet');
      const prompt = await mgr.getPrompt('remote', 'greet');
      expect(prompt.content).toContain('Hello, ?');
    } finally {
      await mgr.disconnectAll().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('connect failure surfaces a clear error (异常降级)', async () => {
    const mgr = new McpManager();
    // 无监听端口 → connect 直接失败且错误可读
    await expect(mgr.connect('dead', { url: 'http://127.0.0.1:1/mcp' })).rejects.toThrow();
    expect(mgr.servers).not.toContain('dead');
  });
});

// ── 配置校验（AC-48-5 写入口径）─────────────────────────────────────────────

describe('validateMcpServers (F-48 http entries)', () => {
  it('accepts url-only entries and encrypts plaintext headers', () => {
    const out = validateMcpServers({ remote: { url: 'https://example.com/mcp', headers: { Authorization: 'plain' } } });
    expect(out['remote']?.url).toBe('https://example.com/mcp');
    expect(out['remote']?.headers?.Authorization).toMatch(/^enc:v1:/);
  });

  it('rejects entries with both or neither of command/url', () => {
    expect(() => validateMcpServers({ srv: { command: 'x', url: 'https://a' } })).toThrow('二选一');
    expect(() => validateMcpServers({ srv: {} })).toThrow('二选一');
  });

  it('rejects headers on stdio entries', () => {
    expect(() => validateMcpServers({ srv: { command: 'x', headers: { A: 'b' } } })).toThrow('headers');
  });
});
