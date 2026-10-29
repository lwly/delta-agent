/**
 * `delta mcp` 子命令组（F-48）：
 *  - list                列出全局/项目两级已配置的 MCP 服务器（header 值一律掩码不回显）
 *  - add <name>          添加服务器：--transport stdio（默认，--command）| http（--url + --header K=V）
 *  - remove <name>       移除服务器
 *  - resources <server>  列出服务器暴露的 resources（仅清单，不取内容、不自动轮询）
 *  - resource-read <server> <uri>   显式读取一个 resource（内容 untrusted 包裹，等价 @ 引用语义）
 *  - prompts <server>    列出服务器暴露的 prompt 模板
 *  - prompt-show <server> <name> [--arg k=v]  取模板并装配为消息文本
 *
 * header 鉴权值经 encryptMcpHeaders 加密落盘（enc:v1:，keychain 机器派生密钥），明文不落盘。
 */
import {
  McpManager,
  loadMcpConfig,
  readMcpConfigFile,
  saveMcpConfig,
  encryptMcpHeaders,
  maskMcpHeaderValue,
  type McpServerConfig,
} from '@delta/core';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

/** 解析 KEY=VALUE 形式的重复 flag（env / header / prompt 参数）。 */
function parseKvList(values: string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values ?? []) {
    const eq = v.indexOf('=');
    if (eq <= 0) throw new Error(`${what} 格式错误：「${v}」（应为 KEY=VALUE）`);
    out[v.slice(0, eq).trim()] = v.slice(eq + 1);
  }
  return out;
}

function scopeOpts(opts: { project?: boolean }): { scope: 'global' | 'project'; projectRoot?: string } {
  return opts.project ? { scope: 'project', projectRoot: process.cwd() } : { scope: 'global' };
}

function configLabel(cfg: McpServerConfig): string {
  if (cfg.url) {
    const headerKeys = Object.keys(cfg.headers ?? {}).map((k) => `${k}=${maskMcpHeaderValue('')}`);
    return `http  ${cfg.url}${headerKeys.length ? `   headers: ${headerKeys.join(', ')}` : ''}`;
  }
  return `stdio  ${[cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ')}`;
}

// ── list ─────────────────────────────────────────────────────────────────────

export function mcpListCommand(): void {
  const merged = loadMcpConfig(process.cwd());
  const names = Object.keys(merged);
  if (!names.length) {
    console.log('（无 MCP 服务器配置。添加：`delta mcp add <name> --command "npx -y <server>"` 或 `delta mcp add <name> --transport http --url <endpoint>`）');
    return;
  }
  for (const name of names) {
    const cfg = merged[name]!;
    console.log(`${name}  ${configLabel(cfg)}${cfg.timeoutMs ? `   timeoutMs=${cfg.timeoutMs}` : ''}`);
  }
  console.log(`\n共 ${names.length} 个（全局与项目级合并视图，项目级同名覆盖全局；配置文件 ~/.delta/mcp.json 与 <项目>/.delta/mcp.json）`);
}

// ── add / remove ─────────────────────────────────────────────────────────────

export interface McpAddOptions {
  transport?: string;
  command?: string;
  url?: string;
  env?: string[];
  header?: string[];
  timeoutMs?: string;
  project?: boolean;
}

export function mcpAddCommand(name: string, opts: McpAddOptions): void {
  try {
    if (!NAME_RE.test(name)) {
      throw new Error(`名称「${name}」不合法：字母数字与 - _，字母数字开头，长度 2–64`);
    }
    const transport = opts.transport ?? 'stdio';
    let cfg: McpServerConfig;
    if (transport === 'stdio') {
      if (opts.url) throw new Error('stdio 传输不接受 --url；请用 --command 或改用 --transport http');
      const cmd = (opts.command ?? '').trim();
      if (!cmd) throw new Error('stdio 传输需要 --command "可执行文件 参数..."（或改用 --transport http --url <endpoint>）');
      const tokens = cmd.split(/\s+/);
      cfg = { command: tokens[0]!, args: tokens.slice(1) };
      const env = parseKvList(opts.env, 'env');
      if (Object.keys(env).length) cfg.env = env;
    } else if (transport === 'http') {
      if (!opts.url?.trim()) throw new Error('http 传输需要 --url <endpoint>（streamable HTTP）');
      if (opts.command) throw new Error('http 传输不接受 --command');
      const headers = parseKvList(opts.header, 'header');
      cfg = { url: opts.url.trim(), headers: encryptMcpHeaders(Object.keys(headers).length ? headers : undefined) };
    } else {
      throw new Error(`未知 transport「${transport}」：支持 stdio | http`);
    }
    if (opts.timeoutMs) {
      const n = Number(opts.timeoutMs);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout-ms 必须是正数（毫秒）');
      cfg.timeoutMs = Math.round(n);
    }
    const scope = scopeOpts(opts);
    const servers = readMcpConfigFile(scope);
    servers[name] = cfg;
    const file = saveMcpConfig(servers, scope);
    console.log(`✔ 已写入 ${file}`);
    console.log(`  ${name}  ${configLabel(cfg)}`);
    if (cfg.headers) console.log('  header 值已加密存储（enc:v1:），展示时仅显示掩码');
    console.log('  新配置在新会话生效。');
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export function mcpRemoveCommand(name: string, opts: { project?: boolean }): void {
  try {
    const scope = scopeOpts(opts);
    const servers = readMcpConfigFile(scope);
    if (!servers[name]) {
      console.error(`✘ 目标作用域（${scope.scope}）的 mcp.json 中未找到「${name}」（列表见 delta mcp list 的合并视图）`);
      process.exitCode = 1;
      return;
    }
    delete servers[name];
    const written = saveMcpConfig(servers, scope);
    console.log(`✔ 已从 ${written} 移除「${name}」。新会话生效。`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// ── resources / prompts（显式读取，不自动轮询）──────────────────────────────

/** 连接 → 执行 → 断开 的公共壳。 */
async function withServer<T>(name: string, fn: (mgr: McpManager) => Promise<T>): Promise<T> {
  const cfg = loadMcpConfig(process.cwd())[name];
  if (!cfg) throw new Error(`未找到 MCP 服务器「${name}」，先在 mcp.json 或 delta mcp add 中配置`);
  const mgr = new McpManager();
  try {
    await mgr.connect(name, cfg);
    return await fn(mgr);
  } finally {
    await mgr.disconnectAll();
  }
}

export function mcpResourcesCommand(server: string): void {
  withServer(server, async (mgr) => {
    const list = await mgr.listResources(server);
    if (!list.length) {
      console.log(`（服务器「${server}」未暴露 resources）`);
      return;
    }
    for (const r of list) {
      console.log(`${r.uri}  ${r.name}${r.mimeType ? `  [${r.mimeType}]` : ''}${r.description ? `  — ${r.description}` : ''}`);
    }
    console.log(`\n共 ${list.length} 项。显式读取：delta mcp resource-read ${server} <uri>（内容经 untrusted 包裹注入，等价 @ 引用；不自动轮询）`);
  }).catch((e: unknown) => {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  });
}

export function mcpResourceReadCommand(server: string, uri: string): void {
  withServer(server, async (mgr) => {
    const res = await mgr.readResource(server, uri);
    if (!res.ok) {
      console.error(`✘ ${res.content}`);
      process.exitCode = 1;
      return;
    }
    console.log(res.content);
  }).catch((e: unknown) => {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  });
}

export function mcpPromptsCommand(server: string): void {
  withServer(server, async (mgr) => {
    const list = await mgr.listPrompts(server);
    if (!list.length) {
      console.log(`（服务器「${server}」未暴露 prompts）`);
      return;
    }
    for (const p of list) {
      const args = (p.arguments ?? []).map((a) => `${a.name}${a.required ? '' : '?'}${a.description ? `=${a.description}` : ''}`);
      console.log(`${p.name}${p.description ? `  — ${p.description}` : ''}${args.length ? `\n    参数: ${args.join(', ')}` : ''}`);
    }
    console.log(`\n共 ${list.length} 项。装配查看：delta mcp prompt-show ${server} <name> [--arg key=value]`);
  }).catch((e: unknown) => {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  });
}

export function mcpPromptShowCommand(server: string, name: string, opts: { arg?: string[] }): void {
  withServer(server, async (mgr) => {
    const args = parseKvList(opts.arg, 'arg');
    const res = await mgr.getPrompt(server, name, args);
    if (!res.ok) {
      console.error(`✘ ${res.content}`);
      process.exitCode = 1;
      return;
    }
    console.log(res.content);
  }).catch((e: unknown) => {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
