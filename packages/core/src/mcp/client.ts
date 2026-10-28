import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
import { FILES, projectConfigDir, userConfigDir } from '../paths.js';

/** M2 scope: stdio transport. `url` is reserved for the SSE transport (M4 web). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** reserved; not used in M2 */
  url?: string;
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
    if (config.url) {
      throw new Error(`mcp server ${name}: SSE transport 未在 M2 支持，请使用 stdio (command)`);
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...config.env } as Record<string, string>,
    });
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

  /** Convert one MCP tool descriptor into an AgentTool (danger:'confirm' 默认）。 */
  toAgentTool(server: string, def: ToolDefinition): AgentTool {
    const fullName = `mcp__${server}__${def.name}`;
    return {
      name: fullName,
      description: `[MCP:${server}] ${def.description || def.name}`,
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
 * `{ "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }`
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
        if (!cfg?.command) continue; // 必须显式声明命令；schema 校验交给 registry
        merged[name] = cfg;
      }
    } catch (e) {
      throw new Error(`mcp 配置解析失败 ${file}: ${(e as Error).message}`);
    }
  }
  return merged;
}
