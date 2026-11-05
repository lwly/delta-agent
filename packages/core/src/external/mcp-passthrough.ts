// F-55 MCP 配置透传（docs/design-f55-external-cli-agents.md §6 + §15 重名冲突缓解）。
//
// 职责切分：
//   - 本文件只负责把 delta 的 MCP 配置合并视图落成外部 CLI 可消费的临时配置文件
//     （os.tmpdir()/delta-mcp-<sessionId>.json），并把别名前缀 / 字段映射 / 清理收敛在此；
//   - 合并语义直接复用 mcp/client.ts 的 loadMcpConfig（全局 ~/.delta/mcp.json + 项目级
//     .delta/mcp.json，项目级同名优先）——不重写合并逻辑；
//   - 进程退出即删（cleanup 由 engine/external.ts 的收尾区调用）。
//
// 重名冲突（§15）：透传时给每个 server 名加 `delta-` 前缀别名，避免与 CLI 自带 MCP 重名；
// 原名已带 delta- 前缀则 warn 一次并保持单层（防双层前缀 delta-delta-x）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadMcpConfig, decryptMcpHeaders, type McpServerConfig } from '../mcp/client.js';

/** delta 透传 MCP server 的别名前缀（§15 重名冲突缓解） */
const DELTA_MCP_PREFIX = 'delta-';

/** 临时配置文件名前缀：os.tmpdir()/delta-mcp-<sessionId>.json（设计稿 §6） */
const TMP_FILE_PREFIX = 'delta-mcp-';

/** Claude --mcp-config 顶层键（实测 claude 2.1.168） */
const CLAUDE_MCP_TOP_KEY = 'mcpServers';

/** 单条透传配置（Claude 格式：stdio 为 {command,args,env}；http 为 {type:'http',url,headers}） */
type ClaudeServerConfig = Record<string, unknown>;

export interface DeltaMcpFile {
  /** 临时配置文件绝对路径；空配置（无任何 MCP server）时为 null（adapter 不加 mcpArgs） */
  configPath: string | null;
  /** 删除临时文件（幂等：文件不存在不报错；configPath 为 null 时无操作） */
  cleanup(): void;
}

function warn(message: string): void {
  console.warn(`[delta] ${message}`);
}

/**
 * 生成 delta MCP 配置的透传临时文件。
 * 空配置不写文件（configPath: null）；有配置时逐条做「delta- 前缀别名 + Claude 字段映射」后落盘。
 */
export function buildDeltaMcpFile(opts: { projectRoot: string; sessionId: string; homeDir?: string }): DeltaMcpFile {
  // 复用既有合并语义：全局 ~/.delta/mcp.json + 项目级 .delta/mcp.json（项目级同名优先），
  // 无 command（stdio）也无 url（http）的条目已在 loadMcpConfig 内过滤
  const merged = loadMcpConfig(opts.projectRoot, opts.homeDir);
  const names = Object.keys(merged);
  if (names.length === 0) {
    return { configPath: null, cleanup: () => {} }; // 空配置：不写文件
  }

  const servers: Record<string, ClaudeServerConfig> = {};
  for (const [name, cfg] of Object.entries(merged)) {
    const alias = prefixAlias(name);
    const mapped = mapToClaudeConfig(name, cfg);
    if (mapped !== null) servers[alias] = mapped;
  }

  // sessionId 只用作文件名令牌：过滤掉文件系统不安全字符（不参与任何路径解析）
  const safeSessionId = opts.sessionId.replace(/[^a-zA-Z0-9._-]/g, '-') || 'session';
  const configPath = path.join(os.tmpdir(), `${TMP_FILE_PREFIX}${safeSessionId}.json`);
  fs.writeFileSync(configPath, `${JSON.stringify({ [CLAUDE_MCP_TOP_KEY]: servers }, null, 2)}\n`, 'utf8');

  return {
    configPath,
    cleanup: () => {
      try {
        fs.rmSync(configPath, { force: true }); // force：不存在时幂等无错
      } catch {
        // 清理失败不影响会话（tmpdir 由系统回收）；静默
      }
    },
  };
}

/** delta- 前缀别名：原名已带前缀则保持单层并 warn（防双层前缀，§15） */
function prefixAlias(name: string): string {
  if (name.startsWith(DELTA_MCP_PREFIX)) {
    warn(`MCP server「${name}」已带 ${DELTA_MCP_PREFIX} 前缀，透传别名保持单层（防双层前缀）`);
    return name;
  }
  return `${DELTA_MCP_PREFIX}${name}`;
}

/**
 * delta 的 McpServerConfig → Claude --mcp-config 文件条目：
 *   - stdio（command）：command/args/env 直传——两侧字段语义一致；
 *   - streamable HTTP（url）：映射为 {type:'http', url, headers}；headers 经 decryptMcpHeaders
 *     解密 enc:v1: 密文（Claude 无法走 delta 的 keychain，密文透传不可用；解密失败 warn 跳过该条）；
 *   - timeoutMs 是 delta 特有熔断参数，Claude 无对应字段，丢弃（不 warn——属调优项非能力缺失）。
 *
 * 密钥边界说明：MCP server 自身的 env / headers 是用户显式配置的第三方凭据，照常透传
 * （与 delta 不注入自身密钥到子进程 env 的 §9 红线无关）。
 */
function mapToClaudeConfig(name: string, cfg: McpServerConfig): ClaudeServerConfig | null {
  if (cfg.command) {
    return {
      command: cfg.command,
      ...(cfg.args !== undefined ? { args: cfg.args } : {}),
      ...(cfg.env !== undefined ? { env: cfg.env } : {}),
    };
  }
  if (cfg.url) {
    let headers: Record<string, string> | undefined;
    try {
      headers = decryptMcpHeaders(cfg.headers);
    } catch (e) {
      warn(`MCP server「${name}」headers 解密失败（${(e as Error).message}），跳过该条透传`);
      return null;
    }
    return {
      type: 'http',
      url: cfg.url,
      ...(headers !== undefined ? { headers } : {}),
    };
  }
  // loadMcpConfig 已过滤无 command/url 的条目，此处为防御性兜底
  warn(`MCP server「${name}」既无 command 也无 url，跳过透传`);
  return null;
}
