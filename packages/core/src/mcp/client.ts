import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  ToolDefinition,
  ToolResult,
} from '@delta/shared';
import type { AgentTool, ToolContext } from '../tools/types.js';
import { ok, fail } from '../tools/types.js';
import { wrapUntrusted } from '../context/untrusted.js';
import { decryptKey, encryptKey } from '../llm/keychain.js';
import { FILES, projectConfigDir, userConfigDir } from '../paths.js';

/**
 * MCP 服务器配置。二选一：
 * - stdio：`command`（+ args/env）
 * - streamable HTTP（F-48）：`url`（+ headers）
 * `headers` 的值可为 `enc:v1:` 密文（keychain 口径，CLI/Web 写入时加密）；
 * 连接时解密，展示时掩码，明文不落盘不回显。
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** streamable HTTP 端点（F-48 起启用；此前为保留字段） */
  url?: string;
  /** HTTP 请求头（如 Authorization / X-Api-Key）；值可为 enc:v1: 密文 */
  headers?: Record<string, string>;
  /** per-call timeout in ms (default 60s, 技术方案 §10 熔断) */
  timeoutMs?: number;
}

interface McpConnection {
  client: Client;
  config: McpServerConfig;
}

const MCP_CALL_TIMEOUT_MS = 60_000;

/**
 * MCP client manager (技术方案 §4.3).
 * Spawns stdio MCP servers, bridges their tools into the ToolRegistry as
 * `mcp__<server>__<tool>` prefixed AgentTools. Schema validation and the
 * confirmation flow reuse the registry pipeline.
 */
export class McpManager {
  private connections = new Map<string, McpConnection>();

  /** Servers currently connected (config name -> connection). */
  get servers(): string[] {
    return [...this.connections.keys()];
  }

  async connect(name: string, config: McpServerConfig): Promise<void> {
    if (this.connections.has(name)) return; // idempotent
    if (!config.command && !config.url) {
      throw new Error(`mcp server ${name}: 配置缺少 command（stdio）或 url（streamable HTTP）`);
    }
    const transport = config.url
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: decryptMcpHeaders(config.headers) },
        })
      : new StdioClientTransport({
          command: config.command!,
          args: config.args ?? [],
          env: { ...process.env, ...config.env } as Record<string, string>,
        });
    const client = new Client({ name: 'delta-agent', version: '0.1.0' });
    await client.connect(transport);
    this.connections.set(name, { client, config });
  }

  /** 供测试/内嵌场景注入已配对的 transport（如 InMemory）。 */
  async connectWithTransport(name: string, config: McpServerConfig, transport: Parameters<Client['connect']>[0]): Promise<void> {
    if (this.connections.has(name)) return; // idempotent
    const client = new Client({ name: 'delta-agent', version: '0.1.0' });
    await client.connect(transport);
    this.connections.set(name, { client, config });
  }

  async disconnectAll(): Promise<void> {
    for (const [name, conn] of this.connections) {
      try {
        await conn.client.close();
      } catch {
        // best-effort shutdown of a dying child process
      }
      this.connections.delete(name);
    }
  }

  /** Raw tool descriptors exposed by a server. */
  async listTools(server: string): Promise<ToolDefinition[]> {
    const conn = this.mustGet(server);
    const res = await conn.client.listTools();
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    }));
  }

  /** Bridge every tool of a server into the registry with a collision-safe prefix. */
  async registerInto(server: string, registry: {
    register(tool: AgentTool): void;
  }): Promise<number> {
    const tools = await this.listTools(server);
    for (const t of tools) {
      registry.register(this.toAgentTool(server, t));
    }
    return tools.length;
  }

  /** Convert one MCP tool descriptor into an AgentTool（danger:'confirm' 默认）。
   *  F-44/AC-48-4：工具描述是服务器提供的外部内容，入上下文前按 untrusted 口径包裹。 */
  toAgentTool(server: string, def: ToolDefinition): AgentTool {
    const fullName = `mcp__${server}__${def.name}`;
    return {
      name: fullName,
      description: `[MCP:${server}] ${wrapUntrusted(def.description || def.name, `mcp:${server}/tool/${def.name}`)}`,
      schema: def.parameters,
      danger: 'confirm',
      execute: (args, ctx) => this.callTool(server, def.name, args, ctx),
    };
  }

  /** Execute an MCP tool with timeout + signal propagation. */
  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    ctx?: Pick<ToolContext, 'signal'>,
  ): Promise<ToolResult> {
    const conn = this.mustGet(server);
    const timeout = conn.config.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
    try {
      const res = (await conn.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { timeout, signal: ctx?.signal },
      )) as { content?: unknown[]; isError?: boolean };

      const text = contentToText(res.content);
      // F-44：MCP 结果为外部内容（成功载荷与服务端错误文本 alike），统一 untrusted 包裹
      if (res.isError) return fail(wrapUntrusted(text || `mcp tool ${tool} reported an error`, `mcp:${server}/${tool}`), 'mcp_tool_error');
      return ok(wrapUntrusted(text || '（空结果）', `mcp:${server}/${tool}`));
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // 超时熔断：不重试，直接把失败回喂给模型（技术方案 §10）
      const error = /timed? ?out/i.test(msg) ? 'mcp_timeout' : 'mcp_error';
      return fail(`mcp tool ${server}/${tool} failed: ${msg}`, error);
    }
  }

  // ── F-48：resources / prompts ────────────────────────────────────────────
  // 显式读取，不自动轮询；内容一律 untrusted 包裹（与工具结果同口径）。

  /** List resources exposed by a server（仅清单，不取内容）。 */
  async listResources(server: string): Promise<Array<{ uri: string; name: string; description?: string; mimeType?: string }>> {
    const conn = this.mustGet(server);
    const res = await conn.client.listResources();
    return (res.resources ?? []).map((r) => ({
      uri: r.uri,
      name: r.name ?? r.uri,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  /** Read one resource；内容按 F-44 untrusted 口径包裹。 */
  async readResource(server: string, uri: string): Promise<ToolResult> {
    const conn = this.mustGet(server);
    try {
      const res = await conn.client.readResource({ uri });
      const parts = (res.contents ?? []).map((c) => {
        const text = 'text' in c && typeof c.text === 'string' ? c.text : `[blob: ${c.mimeType ?? 'unknown'}，${(c as { blob?: string }).blob?.length ?? 0} bytes]`;
        return `[[${c.uri}]]\n${text}`;
      });
      return ok(wrapUntrusted(parts.join('\n\n') || '（空资源）', `mcp:${server}/resource:${uri}`));
    } catch (e) {
      return fail(`mcp resource ${server}/${uri} failed: ${(e as Error).message ?? String(e)}`, 'mcp_error');
    }
  }

  /** List prompt templates exposed by a server。 */
  async listPrompts(server: string): Promise<Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>> {
    const conn = this.mustGet(server);
    const res = await conn.client.listPrompts();
    return (res.prompts ?? []).map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments?.map((a) => ({ name: a.name, description: a.description, required: a.required })),
    }));
  }

  /** Get a prompt template（可带参数），装配为可注入的消息模板文本（untrusted 包裹）。 */
  async getPrompt(server: string, name: string, args: Record<string, string> = {}): Promise<ToolResult> {
    const conn = this.mustGet(server);
    try {
      const res = await conn.client.getPrompt({ name, arguments: args });
      const msgs = (res.messages ?? []).map((m) => {
        const text = m.content.type === 'text' ? m.content.text : `[${m.content.type} 内容]`;
        return `[${m.role}]\n${text}`;
      });
      return ok(wrapUntrusted(msgs.join('\n\n') || '（空模板）', `mcp:${server}/prompt:${name}`));
    } catch (e) {
      return fail(`mcp prompt ${server}/${name} failed: ${(e as Error).message ?? String(e)}`, 'mcp_error');
    }
  }

  private mustGet(server: string): McpConnection {
    const conn = this.connections.get(server);
    if (!conn) throw new Error(`mcp server not connected: ${server}`);
    return conn;
  }
}

/** Convert MCP content blocks into a single text observation. */
function contentToText(content: unknown[] | undefined): string {
  if (!content?.length) return '';
  return content
    .map((block) => {
      const b = block as { type: string; text?: string; uri?: string; name?: string };
      switch (b.type) {
        case 'text':
          return b.text ?? '';
        case 'image':
          return '[图片结果：已省略，当前为文本会话]';
        case 'resource':
          return `[resource] ${b.uri ?? ''}`;
        case 'resource_link':
          return `[link] ${b.uri ?? ''} ${b.name ?? ''}`.trim();
        default:
          return JSON.stringify(block);
      }
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Load MCP config: global `~/.delta/mcp.json` merged with project-level
 * `.delta/mcp.json` (project wins on name conflict). Shape:
 * `{ "mcpServers": { "<name>": { "command": "...", ... } | { "url": "...", "headers": {...} } } }`
 */
export function loadMcpConfig(projectRoot?: string): Record<string, McpServerConfig> {
  const files: string[] = [
    path.join(userConfigDir(), FILES.mcp),
  ];
  if (projectRoot) files.push(path.join(projectConfigDir(projectRoot), FILES.mcp));

  const merged: Record<string, McpServerConfig> = {};
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // missing config is normal
    }
    try {
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
      for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
        if (!cfg?.command && !cfg?.url) continue; // 必须声明 command（stdio）或 url（http）；schema 校验交给 registry
        merged[name] = cfg;
      }
    } catch (e) {
      throw new Error(`mcp 配置解析失败 ${file}: ${(e as Error).message}`);
    }
  }
  return merged;
}

/** 读取单个作用域的 mcp.json（不做合并；供 delta mcp add/remove 精确读写目标文件）。homeDir 可注入隔离。 */
export function readMcpConfigFile(opts: { scope: 'global' | 'project'; projectRoot?: string; homeDir?: string }): Record<string, McpServerConfig> {
  const file = opts.scope === 'global'
    ? path.join(userConfigDir(opts.homeDir), FILES.mcp)
    : (() => {
        if (!opts.projectRoot) throw new Error('项目级 MCP 配置需要项目根目录');
        return path.join(projectConfigDir(opts.projectRoot), FILES.mcp);
      })();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // missing config is normal
  }
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
    if (!cfg?.command && !cfg?.url) continue;
    out[name] = cfg;
  }
  return out;
}

/** 写入某作用域的 mcp.json（覆盖该文件）。scope=project 时需提供 projectRoot。homeDir 可注入隔离。 */
export function saveMcpConfig(
  servers: Record<string, McpServerConfig>,
  opts: { scope: 'global' | 'project'; projectRoot?: string; homeDir?: string },
): string {
  const file = opts.scope === 'global'
    ? path.join(userConfigDir(opts.homeDir), FILES.mcp)
    : (() => {
        if (!opts.projectRoot) throw new Error('项目级 MCP 配置需要项目根目录');
        return path.join(projectConfigDir(opts.projectRoot), FILES.mcp);
      })();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf8');
  return file;
}

// ── F-48：header 鉴权加解密（复用 keychain 机器派生密钥，enc:v1: 前缀） ──────

const ENC_V1_PREFIX = 'enc:v1:';

/**
 * 连接前解密 headers：`enc:v1:` 密文走 keychain 解密（无法解密时抛错并给「下一步」指引），
 * 明文原样通过（容忍手工编辑的配置）。
 */
export function decryptMcpHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v.startsWith(ENC_V1_PREFIX)) {
      const plain = decryptKey(v);
      if (!plain) {
        throw new Error(`mcp header「${k}」解密失败：密文可能来自其他机器，请用 delta mcp add 重新配置该 header`);
      }
      out[k] = plain;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 写盘前加密 headers：明文值加密为 enc:v1: 密文（已是密文的保持不变）。
 * CLI/Web 写入路径统一收口于此，保证明文不落盘。
 */
export function encryptMcpHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = v.startsWith(ENC_V1_PREFIX) ? v : encryptKey(v);
  }
  return out;
}

/** header 值展示掩码：密文与明文一律不回显。 */
export function maskMcpHeaderValue(value: string): string {
  return '********';
}
