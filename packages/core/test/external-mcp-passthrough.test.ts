/**
 * F-55 MCP 配置透传单测（docs/design-f55-external-cli-agents.md §6 + §15 重名冲突）：
 *  - 临时 HOME / 临时项目隔离（loadMcpConfig 的 homeDir 注入参数）；
 *  - delta- 前缀别名（§15：避免与 CLI 自带 MCP 重名冲突）；
 *  - MCP server 自身的 env（如 ANTHROPIC_API_KEY）照常透传——用户显式配置，不属于 delta 密钥注入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDeltaMcpFile } from '../src/external/mcp-passthrough.js';

let tmp: string;
let homeDir: string;
let projectRoot: string;
let sessionId: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'yz-mcp-pass-'));
  homeDir = path.join(tmp, 'home');
  projectRoot = path.join(tmp, 'project');
  sessionId = 'sess-test-1';
  await mkdir(path.join(homeDir, '.delta'), { recursive: true });
  await mkdir(path.join(projectRoot, '.delta'), { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function writeGlobalMcp(servers: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(homeDir, '.delta', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
}
async function writeProjectMcp(servers: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(projectRoot, '.delta', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
}

function build(): ReturnType<typeof buildDeltaMcpFile> {
  return buildDeltaMcpFile({ projectRoot, sessionId, homeDir });
}

async function readOutput(configPath: string): Promise<{ mcpServers: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

describe('buildDeltaMcpFile（F-55 §6 MCP 透传）', () => {
  it('合并全局 + 项目级（项目级同名优先）→ 每个名字加 delta- 前缀；原配置文件无变更；cleanup 幂等', async () => {
    await writeGlobalMcp({ svc: { command: 'global-cmd' }, alpha: { command: 'alpha-cmd', args: ['--x'] } });
    await writeProjectMcp({ svc: { command: 'project-cmd', env: { FOO: 'bar' } } });
    const globalRaw = await readFile(path.join(homeDir, '.delta', 'mcp.json'), 'utf8');
    const projectRaw = await readFile(path.join(projectRoot, '.delta', 'mcp.json'), 'utf8');

    const { configPath, cleanup } = build();
    expect(configPath).not.toBeNull();
    const out = await readOutput(configPath!);
    expect(out.mcpServers['delta-svc']).toEqual({ command: 'project-cmd', env: { FOO: 'bar' } }); // 项目级优先
    expect(out.mcpServers['delta-alpha']).toEqual({ command: 'alpha-cmd', args: ['--x'] });
    // 输出文件只含 delta- 前缀别名，无原名
    expect(Object.keys(out.mcpServers).every((k) => k.startsWith('delta-'))).toBe(true);
    // 原配置文件无变更
    expect(await readFile(path.join(homeDir, '.delta', 'mcp.json'), 'utf8')).toBe(globalRaw);
    expect(await readFile(path.join(projectRoot, '.delta', 'mcp.json'), 'utf8')).toBe(projectRaw);
    // 文件名约定：os.tmpdir()/delta-mcp-<sessionId>.json
    expect(path.basename(configPath!)).toBe(`delta-mcp-${sessionId}.json`);

    cleanup();
    expect(existsSync(configPath!)).toBe(false);
    cleanup(); // 二次 cleanup 幂等，不报错
  });

  it('已带 delta- 前缀的 server 名：warn 一次，不叠加双层前缀', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeGlobalMcp({ 'delta-already': { command: 'c1' }, plain: { command: 'c2' } });

    const { configPath } = build();
    const out = await readOutput(configPath!);
    expect(out.mcpServers['delta-already']).toEqual({ command: 'c1' }); // 保持单层前缀
    expect(out.mcpServers['delta-plain']).toEqual({ command: 'c2' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('delta-already');
  });

  it('空配置（无任何 MCP server）→ configPath null，不写文件', async () => {
    const { configPath, cleanup } = build();
    expect(configPath).toBeNull();
    expect(() => cleanup()).not.toThrow();
  });

  it('MCP server 自身的 env 照常透传（用户显式配置，不属于 delta 密钥注入——§9 边界注释）', async () => {
    await writeGlobalMcp({
      anthropic: { command: 'npx', args: ['-y', 'srv'], env: { ANTHROPIC_API_KEY: 'sk-user-owned' } },
    });
    const { configPath } = build();
    const out = await readOutput(configPath!);
    expect(out.mcpServers['delta-anthropic']).toEqual({
      command: 'npx',
      args: ['-y', 'srv'],
      env: { ANTHROPIC_API_KEY: 'sk-user-owned' },
    });
  });

  it('url 型（streamable HTTP）配置 → Claude 格式 {type:"http", url}，headers 保留；delta 特有字段 timeoutMs 丢弃', async () => {
    await writeProjectMcp({
      http1: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' }, timeoutMs: 1234 },
    });
    const { configPath } = build();
    const out = await readOutput(configPath!);
    expect(out.mcpServers['delta-http1']).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    });
  });
});
