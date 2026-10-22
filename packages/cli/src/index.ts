#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SessionService,
  resolveProviderFromEnv,
  estimateMessagesTokens,
  ToolRegistry,
  McpManager,
  loadMcpConfig,
  ProviderManager,
  SessionHub,
  createWebServer,
  createSkillRuntime,
} from '@y-zero/core';
import { App } from './ui/app.js';
import { assemblePrompt } from './prompt.js';

interface CliOpts {
  resume?: string;
  model?: string;
  provider?: string;
  yolo?: boolean;
  debugPrompt?: boolean;
  maxTurns: string;
  db?: string;
}

const program = new Command();

program
  .name('yzero')
  .description('y-zero-agent —— AI 编程命令行工具（M2：4 家 Provider + MCP 扩展 + 并行工具）')
  .version('0.1.0')
  .option('-r, --resume [sessionId]', '恢复指定会话（缺省恢复项目最近会话）')
  .option('-m, --model <model>', '指定模型名（默认读 YZERO_MODEL，再退回各厂商默认）')
  .option('-p, --provider <name>', '模型厂商：anthropic | deepseek | qwen | openai（默认读 YZERO_PROVIDER，再按已配置 Key 自动探测）')
  .option('--yolo', '跳过高危工具确认（危险）')
  .option('--debug-prompt', '启动时打印系统提示词与上下文统计')
  .option('--max-turns <n>', '单任务最大轮次', '50')
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.y-zero/agent.db）')
  .action(async (opts: CliOpts) => {
    await start(opts);
  });

// ── yzero models：Provider Key 本地管理（F-04a）──────────────────────────

const models = program.command('models').description('管理模型 Provider 配置（Key 加密存储于 ~/.y-zero/models.json）');

models
  .command('add')
  .description('新增/覆盖一个 Provider（id: anthropic | openai | deepseek | qwen 或任意 openai 兼容网关名）')
  .argument('<id>', 'provider id')
  .requiredOption('-k, --key <apiKey>', 'API Key（注意 shell history 泄漏风险，可用引号并事后清理）')
  .option('--base-url <url>', '自定义 API 端点（openai 兼容网关必填）')
  .option('-m, --model <model>', '默认模型名')
  .option('--default', '设为默认 Provider')
  .action((id: string, opts: { key: string; baseUrl?: string; model?: string; default?: boolean }) => {
    new ProviderManager().add({
      id,
      apiKey: opts.key,
      baseUrl: opts.baseUrl,
      model: opts.model,
      setDefault: opts.default,
    });
    console.log(`✔ 已保存 ${id}${opts.default ? '（默认）' : ''}，Key 已加密存储`);
  });

models
  .command('list')
  .description('列出已配置的 Provider（Key 脱敏显示）')
  .action(() => {
    const list = new ProviderManager().list();
    if (list.length === 0) {
      console.log('（空）先用 `yzero models add <id> -k <apiKey>` 添加');
      return;
    }
    for (const p of list) {
      const flags = [
        p.default ? '默认' : '',
        p.enabled ? '' : '已停用',
      ].filter(Boolean).join(' · ');
      console.log(
        `${p.default ? '*' : ' '} ${p.id.padEnd(12)} [${p.vendor}] ${p.keyMasked}` +
          `${p.model ? ` model=${p.model}` : ''}${p.baseUrl ? ` base=${p.baseUrl}` : ''}` +
          `${flags ? `  (${flags})` : ''}`,
      );
    }
  });

models
  .command('remove')
  .description('删除一个 Provider')
  .argument('<id>')
  .action((id: string) => {
    console.log(new ProviderManager().remove(id) ? `✔ 已删除 ${id}` : `✘ 未找到 ${id}`);
  });

models
  .command('default')
  .description('设置默认 Provider')
  .argument('<id>')
  .action((id: string) => {
    try {
      new ProviderManager().setDefault(id);
      console.log(`✔ 默认 Provider 已设为 ${id}`);
    } catch (e) {
      console.error(`✘ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

for (const [name, enabled] of [['enable', true], ['disable', false]] as const) {
  models
    .command(name)
    .description(`${enabled ? '启用' : '停用'}一个 Provider`)
    .argument('<id>')
    .action((id: string) => {
      try {
        new ProviderManager().setEnabled(id, enabled);
        console.log(`✔ ${id} 已${enabled ? '启用' : '停用'}`);
      } catch (e) {
        console.error(`✘ ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}

models
  .command('move')
  .description('调整探测顺序（env Key 均未配置时按此顺序尝试）')
  .argument('<id>')
  .argument('<dir>', 'up | down')
  .action((id: string, dir: 'up' | 'down') => {
    try {
      new ProviderManager().move(id, dir);
      console.log(`✔ ${id} 已${dir === 'up' ? '上移' : '下移'}`);
    } catch (e) {
      console.error(`✘ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

models
  .command('test')
  .description('连通性测试（发送最小 chat 请求）')
  .argument('[id]', '缺省测试默认 Provider')
  .action(async (id?: string) => {
    const mgr = new ProviderManager();
    const target = id ?? mgr.activeIds()[0];
    if (!target) {
      console.error('✘ 没有已启用的 Provider，先 `yzero models add`');
      process.exitCode = 1;
      return;
    }
    console.log(`… 测试 ${target} …`);
    const r = await mgr.test(target);
    console.log(`${r.ok ? '✔' : '✘'} ${target}：${r.detail}（${r.latencyMs}ms）`);
    if (!r.ok) process.exitCode = 1;
  });

// ── yzero serve：Web 控制台本地服务（M4）────────────────────────────────

program
  .command('serve')
  .description('启动 Web 控制台本地服务（纯本地：默认 127.0.0.1:7900，仅监听回环地址）')
  .option('--port <n>', '监听端口（默认 7900）', '7900')
  .option('--web-dist <dir>', 'Vue 构建产物目录（缺省用包内嵌 packages/web/dist）')
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.y-zero/agent.db）')
  .action(async (opts: { port: string; webDist?: string; db?: string }) => {
    const service = new SessionService(opts.db);
    const registry = new ToolRegistry();
    const mcp = new McpManager();
    const mcpConfig = loadMcpConfig(process.cwd());
    for (const [name, cfg] of Object.entries(mcpConfig)) {
      try {
        await mcp.connect(name, cfg);
        await mcp.registerInto(name, registry);
        console.error(`✔ MCP ${name}：已接入`);
      } catch (e) {
        console.error(`✘ MCP ${name} 连接失败（已跳过）：${(e as Error).message}`);
      }
    }

    const projectRoot = process.cwd();
    service.ensureProject(projectRoot); // 注册当前目录为项目
    const skills = await createSkillRuntime(projectRoot);

    const hub = new SessionHub({
      service,
      registry,
      resolveProvider: () => resolveProviderFromEnv(undefined), // env → 存储配置，设置页修改后即时生效
      skills,
    });

    const providers = new ProviderManager(); // 设置中心共用同一存储（~/.y-zero/models.json）
    // Vue 构建产物候选：--web-dist > 包内嵌 cli/dist/web（npm 安装形态）> 仓库 packages/web/dist（开发形态）
    const distDir = path.dirname(fileURLToPath(import.meta.url));
    const webDist = [
      opts.webDist,
      path.resolve(distDir, 'web'),
      path.resolve(distDir, '../../web/dist'),
    ].find((d) => d && fs.existsSync(path.join(d, 'index.html')));
    const port = Number(opts.port) || 7900;
    const server = createWebServer({
      service,
      hub,
      port,
      webDistDir: webDist,
      providers,
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`✔ yzero Web 控制台已启动：http://127.0.0.1:${port}`);
      console.log(webDist ? `静态资源：${webDist}` : '（未发现 Vue 构建产物，仅提供 /api；先构建 packages/web）');
      console.log('Ctrl+C 退出');
    });
    const shutdown = () => {
      server.close();
      void mcp.disconnectAll().finally(() => {
        service.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

async function start(opts: CliOpts): Promise<void> {
  // provider (M2: anthropic / deepseek / qwen / openai via env)
  let provider;
  try {
    provider = await resolveProviderFromEnv(opts.provider);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exit(1);
  }

  // MCP servers: ~/.y-zero/mcp.json + .y-zero/mcp.json（项目级优先）
  const registry = new ToolRegistry();
  const mcp = new McpManager();
  const mcpConfig = loadMcpConfig(process.cwd());
  for (const [name, cfg] of Object.entries(mcpConfig)) {
    try {
      await mcp.connect(name, cfg);
      const n = await mcp.registerInto(name, registry);
      console.error(`✔ MCP ${name}：已接入 ${n} 个工具`);
    } catch (e) {
      console.error(`✘ MCP ${name} 连接失败（已跳过）：${(e as Error).message}`);
    }
  }

  // session
  const service = new SessionService(opts.db);
  const cwd = process.cwd();
  const project = service.ensureProject(cwd);
  let session = opts.resume
    ? typeof opts.resume === 'string'
      ? service.getSession(opts.resume)
      : service.latestSession(project.id)
    : undefined;
  if (opts.resume && !session) {
    console.error('✘ 未找到指定会话');
    process.exit(1);
  }
  if (!session) {
    session = service.createSession(project.id, {
      title: `${project.name} · ${new Date().toLocaleString('zh-CN')}`,
      model: opts.model ?? process.env.YZERO_MODEL ?? 'claude-sonnet-4-5-20250929',
    });
  } else if (opts.model) {
    session = { ...session, model: opts.model };
  }

  // ── M3 提示词体系：7 层组装 + 三级覆盖 + Skill 三层加载/两阶段加载 ──
  const model = session.model || 'claude-sonnet-4-5-20250929';
  const promptAssembly = await assemblePrompt({
    projectRoot: cwd,
    model,
    contextWindow: 200_000,
    tools: registry.definitions(),
  });

  if (opts.debugPrompt) {
    const history = service.getHistory(session.id);
    console.error(promptAssembly.debugReport());
    console.error('[debug] history messages:', history.length, 'tokens ≈', estimateMessagesTokens(history));
  }

  const app = React.createElement(App, {
    service,
    session,
    provider,
    registry,
    systemPrompt: promptAssembly.parts.staticText,
    systemPromptParts: promptAssembly.parts,
    refreshDynamic: promptAssembly.refreshDynamic,
    skillsRuntime: promptAssembly.skills,
    yolo: Boolean(opts.yolo),
    debugPrompt: Boolean(opts.debugPrompt),
    maxTurns: Number(opts.maxTurns) || 50,
  });

  const { waitUntilExit } = render(app, { exitOnCtrlC: true });
  try {
    await waitUntilExit();
  } finally {
    await mcp.disconnectAll();
  }
}

program.parseAsync(process.argv).catch((e) => {
  console.error(`✘ ${(e as Error).message}`);
  process.exit(1);
});

// keep path import used (win compat helpers may grow here)
void path;
