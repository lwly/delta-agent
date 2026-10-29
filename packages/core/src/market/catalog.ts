/**
 * F-52 市场内置清单（builtin catalog）
 *
 * Skills：复用 Skill Hub 的 seed 目录（skill-hub-catalog.ts，随包发布、始终可用）；
 * MCP Servers：内置少量官方演示条目（配置草案，安装前必须通过连通性测试）。
 *
 * 内置条目 source 标识统一为 'builtin'，与订阅源条目在快照合并时去重（内置优先）。
 */
import type { McpServerConfig } from '../mcp/client.js';
import type { HubEntry } from '../server/skill-hub-catalog.js';
import { SEED_SKILLS } from '../server/skill-hub-catalog.js';

export type { HubEntry };

/** MCP 市场条目：draft 为 mcp.json 写入前的配置草案（headers 为明文模板，写入时加密） */
export interface McpMarketEntry {
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  draft: McpServerConfig;
}

/** 市场条目统一判别联合：kind = 'skill' | 'mcp' */
export type MarketEntry =
  | (HubEntry & { kind: 'skill'; scripts?: MarketScript[] })
  | (McpMarketEntry & { kind: 'mcp' });

/** Skill 条目内联脚本（安装时需强制确认后落盘 <skillDir>/scripts/<name>） */
export interface MarketScript {
  name: string;
  content: string;
}

/** 内置 MCP 市场条目（source='builtin'）。连通性测试 = connect + listTools。 */
export const BUILTIN_MCP_ENTRIES: McpMarketEntry[] = [
  {
    name: 'everything',
    description: 'MCP 官方演示服务（@modelcontextprotocol/server-everything）：echo/add 等示例工具，用于验证 MCP 链路',
    category: '演示',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    draft: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
  },
];

/** 内置 Skill 条目（kind 已标注；SEED_SKILLS 均不含 scripts） */
export function builtinSkillEntries(): MarketEntry[] {
  return SEED_SKILLS.map((e) => ({ ...e, kind: 'skill' as const }));
}

/** 内置 MCP 条目（kind 已标注） */
export function builtinMcpEntries(): MarketEntry[] {
  return BUILTIN_MCP_ENTRIES.map((e) => ({ ...e, kind: 'mcp' as const }));
}

export function findBuiltinMarketEntry(kind: 'skill' | 'mcp', name: string): MarketEntry | null {
  const pool = kind === 'skill' ? builtinSkillEntries() : builtinMcpEntries();
  return pool.find((e) => e.name === name) ?? null;
}
