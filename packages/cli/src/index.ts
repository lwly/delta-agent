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
  ModelRouter,
  SessionHub,
  createWebServer,
  createSkillRuntime,
  formatSearchHits,
  HookManager,
  loadHookFiles,
  MIGRATIONS,
  LATEST_SCHEMA_VERSION,
} from '@y-zero/core';
import { App } from './ui/app.js';
import { assemblePrompt } from './prompt.js';
import { runHeadlessCommand, type RunOptions } from './headless-run.js';
import { usageCommand, type UsageCommandOptions } from './usage.js';
import {
  sandboxStatusCommand,
  sandboxEnableCommand,
  sandboxDisableCommand,
  sandboxPullCommand,
  sandboxGcCommand,
} from './sandbox.js';
import { evalsListCommand, evalsRunCommand, type EvalsOptions } from './evals.js';
import {
  notifyDisableCommand,
  notifyEnableCommand,
  notifyStatusCommand,
  notifyTestCommand,
} from './notify.js';
import {
  onboardingStatusCommand,
  onboardingRunCommand,
  onboardingConfirmCommand,
  onboardingSkipCommand,
} from './onboarding.js';
import { createDesktopNotifier, autoOnboardProject } from '@y-zero/core';
import {
  normalizeGitPolicy,
  normalizeMode,
  parseAllowTools,
  resolvePermissionMode,
} from './shared.js';

interface CliOpts {
  resume?: string;
  model?: string;
  provider?: string;
  yolo?: boolean;
  permission?: string;
  allow?: string;
  git?: string;
  debugPrompt?: boolean;
  maxTurns: string;
  db?: string;
  mode?: string;
}

const program = new Command();

// F-28 evals 等子命令与根命令重复声明了 --model/--provider/--db：开启位置选项语义，
// 使子命令位置参数之后的选项由子命令解析（否则父命令声明遮蔽子命令同名选项，值丢失）。
program.enablePositionalOptions();

program
  .name('yzero')
  .description('y-zero-agent —— AI 编程命令行工具（M2：4 家 Provider + MCP 扩展 + 并行工具）')
  .version('0.1.0')
  .option('-r, --resume [sessionId]', '恢复指定会话（缺省恢复项目最近会话）')
  .option('-m, --model <model>', '指定模型名（默认读 YZERO_MODEL，再退回各厂商默认）')
  .option('-p, --provider <name>', '模型厂商：anthropic | deepseek | qwen | openai（默认读 YZERO_PROVIDER，再按已配置 Key 自动探测）')
  .option('--yolo', 'YOLO 第二重开关（须与 --permission yolo 同时使用；单独使用会降级为 default 并告警）')
  .option('--permission <mode>', 'F-23 权限模式：plan（只读）| default（写需确认）| yolo（全放行，需 --yolo 双重开启）', 'default')
  .option('--allow <tools>', '工具级 allowlist（逗号分隔，default 模式下命中跳过确认，如 write_file,edit_file）')
  .option('--git <mode>', 'F-24 git 策略：off | suggest（启动建议分支，默认）| auto（任务结束自动提交本会话变更）', 'suggest')
  .option('--debug-prompt', '启动时打印系统提示词与上下文统计')
  .option('--max-turns <n>', '单任务最大轮次', '50')
  .option('--mode <mode>', '执行模式：react | plan | multi（M5，默认 react）')
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

// ── F-32 模型路由：yzero models routing 子命令组 ─────────────────────────

models
  .command('routing')
  .description('查看模型路由配置（F-32：分类/提炼/摘要类辅助调用按规则走小模型）')
  .action(() => {
    const cfg = new ProviderManager().getRouting();
    if (!cfg) {
      console.log('（未配置）可用命令：routing set <kind> <model> [--provider <id>] / routing on / routing off');
      return;
    }
    console.log(`状态：${cfg.enabled ? '已启用' : '已停用'}`);
    const kinds = Object.keys(cfg.rules);
    if (kinds.length === 0) {
      console.log('规则：（空）');
      return;
    }
    for (const kind of kinds) {
      const rule = cfg.rules[kind]!;
      console.log(`  ${kind.padEnd(12)} → ${rule.model}${rule.provider ? ` @ ${rule.provider}` : '（主 Provider）'}`);
    }
  });

models
  .command('routing-set')
  .description('设置一条路由规则（kind 如 distill/classify/summarize，也可自定义）')
  .argument('<kind>', '任务类型')
  .argument('<model>', '目标模型 id')
  .option('--provider <id>', '目标 Provider（缺省跟随会话主 Provider）')
  .action((kind: string, model: string, opts: { provider?: string }) => {
    try {
      const mgr = new ProviderManager();
      const cfg = mgr.getRouting() ?? { enabled: true, rules: {} };
      cfg.rules[kind] = { model, provider: opts.provider };
      cfg.enabled = true; // 配置规则即启用（可用 routing-set-off 关闭）
      mgr.setRouting(cfg);
      console.log(`✔ 路由规则已保存：${kind} → ${model}${opts.provider ? ` @ ${opts.provider}` : ''}（路由已启用）`);
    } catch (e) {
      console.error(`✘ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

models
  .command('routing-remove')
  .description('删除一条路由规则（该类任务回退主模型）')
  .argument('<kind>', '任务类型')
  .action((kind: string) => {
    const mgr = new ProviderManager();
    const cfg = mgr.getRouting();
    if (!cfg || !cfg.rules[kind]) {
      console.error(`✘ 未找到路由规则：${kind}`);
      process.exitCode = 1;
      return;
    }
    delete cfg.rules[kind];
    mgr.setRouting(cfg);
    console.log(`✔ 已删除路由规则 ${kind}`);
  });

models
  .command('routing-on')
  .description('启用模型路由')
  .action(() => {
    try {
      const mgr = new ProviderManager();
      const cfg = mgr.getRouting();
      if (!cfg || Object.keys(cfg.rules).length === 0) {
        console.error('✘ 尚无路由规则，先 routing-set <kind> <model>');
        process.exitCode = 1;
        return;
      }
      mgr.setRouting({ ...cfg, enabled: true });
      console.log('✔ 模型路由已启用');
    } catch (e) {
      console.error(`✘ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

models
  .command('routing-off')
  .description('停用模型路由（全部调用回退会话主模型）')
  .action(() => {
    const mgr = new ProviderManager();
    const cfg = mgr.getRouting();
    if (!cfg) {
      console.log('（本就未配置路由）');
      return;
    }
    mgr.setRouting({ ...cfg, enabled: false });
    console.log('✔ 模型路由已停用');
  });

// ── yzero memory：L2 动态记忆管理（memory-design §8）────────────────────

const memory = program.command('memory').description('管理 L2 长期动态记忆（memories 表）');

memory
  .command('list')
  .description('列出记忆条目（默认全局 + 全部 scope 汇总）')
  .option('--scope <scope>', '按 scope 过滤（global / project:<id> / session:<id>）')
  .option('--kind <kind>', '按类型过滤（preference/fact/decision/pitfall/workflow）')
  .option('--pending', '只看待确认队列')
  .option('--database <path>', 'SQLite 数据库路径（默认 ~/.y-zero/agent.db）')
  .action((opts: { scope?: string; kind?: string; pending?: boolean; database?: string }) => {
    const service = new SessionService(opts.database);
    const items = opts.pending
      ? service.memory.listPending()
      : service.memory.list({ scope: opts.scope, kind: opts.kind });
    if (items.length === 0) {
      console.log('（暂无记忆条目）');
      return;
    }
    for (const m of items) {
      const flag = m.status === 'pending' ? ' [待确认]' : m.superseded_by ? ' [已被新版本取代]' : '';
      console.log(
        `${m.id.slice(0, 8)}  ${m.scope.padEnd(20)} ${m.kind.padEnd(11)} imp=${m.importance.toFixed(2)} conf=${m.confidence.toFixed(2)} 召回=${m.access_count}${flag}\n            ${m.content}`,
      );
    }
    const scope = opts.scope ?? 'global';
    const u = service.memory.usage(scope);
    console.error(`\n共 ${items.length} 条${opts.scope ? `；${scope} 用量 ${u.count}/512 条 ≈ ${u.tokens} tokens` : ''}`);
    service.close();
  });

memory
  .command('export')
  .description('导出记忆为 JSON（可迁移/备份）')
  .option('--scope <scope>', '按 scope 过滤')
  .option('--out <file>', '输出文件（缺省打印到 stdout）')
  .option('--database <path>', 'SQLite 数据库路径')
  .action((opts: { scope?: string; out?: string; database?: string }) => {
    const service = new SessionService(opts.database);
    const json = JSON.stringify(service.memory.export(opts.scope), null, 2);
    if (opts.out) {
      fs.writeFileSync(opts.out, json, 'utf8');
      console.log(`✔ 已导出到 ${opts.out}`);
    } else {
      console.log(json);
    }
    service.close();
  });

memory
  .command('rm')
  .description('停用（软删）或彻底删除一条记忆')
  .argument('<id>')
  .option('--hard', '物理删除（缺省软删进回收站）')
  .option('--database <path>', 'SQLite 数据库路径')
  .action((id: string, opts: { hard?: boolean; database?: string }) => {
    const service = new SessionService(opts.database);
    console.log(service.memory.remove(id, opts.hard) ? '✔ 已删除' : '✘ 未找到该记忆');
    service.close();
  });

// ── yzero usage：F-31 成本与用量报告 ────────────────────────────────────

program
  .command('usage')
  .description('查看费用与 token 用量报告（按项目 / 模型 / 会话聚合；--json 与 /api/usage/summary 同构）')
  .option('--range <range>', '时间范围：today | 7d | 30d | all（默认 all，非法值归一化为 all）', 'all')
  .option('--project <id|name>', '按项目过滤（支持项目 id 或名称）')
  .option('--json', 'stdout 输出结构化 JSON（与 GET /api/usage/summary 同构，可直接供 jq 消费）', false)
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.y-zero/agent.db）')
  .action(async (opts: UsageCommandOptions) => {
    await usageCommand(opts);
  });

// ── yzero migrate：F-35 Schema 版本迁移 ─────────────────────────────────

program
  .command('migrate')
  .description('查看/执行数据库 Schema 迁移（打开数据库时自动执行；此命令用于核对版本与迁移历史）')
  .option('--database <path>', 'SQLite 数据库路径（默认 ~/.y-zero/agent.db）')
  .action((opts: { database?: string }) => {
    const service = new SessionService(opts.database); // 构造即自动迁移
    const v = service.store.schemaVersion;
    console.log(`当前 schema 版本：v${v}（最新 v${LATEST_SCHEMA_VERSION}）`);
    console.log('迁移历史定义：');
    for (const m of MIGRATIONS) {
      const state = m.version <= v ? '✔ 已应用' : '○ 待应用';
      console.log(`  v${m.version}  ${state}  ${m.name}`);
    }
    service.close();
  });

// ── yzero search：F-17 全文/语义搜索历史对话 ────────────────────────────

program
  .command('search')
  .description('搜索历史对话（全文 FTS5 + 语义 embedding 混合；无 embedding 配置时自动降级全文）')
  .argument('<query>', '检索词（中英文均可）')
  .option('--mode <mode>', 'auto（混合，默认）| fulltext | semantic', 'auto')
  .option('--limit <n>', '返回条数（默认 10）', '10')
  .option('--database <path>', 'SQLite 数据库路径（默认 ~/.y-zero/agent.db）')
  .action(async (query: string, opts: { mode: string; limit: string; database?: string }) => {
    const service = new SessionService(opts.database);
    try {
      const mode = opts.mode === 'fulltext' || opts.mode === 'semantic' ? opts.mode : 'auto';
      if (mode !== 'fulltext' && !service.search.semanticAvailable) {
        console.error('ℹ 语义检索不可用（未配置 embedding 或 Key 无效），降级为全文检索');
      }
      const hits = await service.searchMessages(query, { mode, limit: Number(opts.limit) || 10 });
      console.log(formatSearchHits(hits, query));
    } catch (e) {
      console.error(`✘ 检索失败：${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      service.close();
    }
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
    const project = service.ensureProject(projectRoot); // 注册当前目录为项目
    // F-34 项目 onboarding：新注册项目后台自动扫描生成静态记忆草案（fire-and-forget，失败不影响服务）
    if (project.created) {
      void (async () => {
        try {
          const onboardingProvider = await resolveProviderFromEnv(undefined);
          const r = await autoOnboardProject({
            projectRoot,
            provider: onboardingProvider,
            model: process.env.YZERO_MODEL || 'claude-sonnet-4-5-20250929',
          });
          if (r && !r.skipped) {
            console.log(`✔ onboarding 草案已生成：${r.agentMdDraftPath}（用 \`yzero onboarding confirm\` 采纳）`);
          }
        } catch {
          console.error('⚠ onboarding 扫描失败（可稍后手动运行 `yzero onboarding run`）');
        }
      })();
    }
    const skills = await createSkillRuntime(projectRoot);
    // F-27 Hook 系统：加载用户级 + 项目级 hooks.json（工具钩子 + 生命周期）
    const hooks = HookManager.load(projectRoot, undefined, (o) => {
      if (!o.ok) console.error(`⚠ hook ${o.hook.event}(${o.hook.command}) 异常：${o.reason ?? o.stderr.trim().slice(0, 200)}`);
    });

    const hub = new SessionHub({
      service,
      registry,
      resolveProvider: () => resolveProviderFromEnv(undefined), // env → 存储配置，设置页修改后即时生效
      // F-32 模型路由：路由规则每次运行即时读取（settings 修改后生效）；目标 provider 走同一解析链
      modelRouter: new ModelRouter(),
      resolveProviderById: (id) => resolveProviderFromEnv(id),
      skills,
      hooks,
      // F-33 桌面通知：任务结束 / 确认卡出现时系统级通知（旁路 fire-and-forget）
      notify: createDesktopNotifier({ projectRoot }),
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
      mode: normalizeMode(opts.mode),
    });
  } else if (opts.model) {
    session = { ...session, model: opts.model };
  }

  // M5: 启动时孤儿任务恢复（running 且租约过期 → queued，retries+1）
  const recovered = service.recoverTasks(session.id);
  if (recovered > 0) console.error(`♻ 已恢复 ${recovered} 个中断任务（重新排队）`);

  // F-34 项目 onboarding：新注册项目后台自动扫描生成静态记忆草案
  // （fire-and-forget 不阻塞 TUI 启动；完成情况看 `.y-zero/onboarding.json` 或 `yzero onboarding status`）
  if (project.created) {
    console.error('✨ 新项目已注册：onboarding 扫描已在后台启动（完成后用 `yzero onboarding confirm` 采纳）');
    void autoOnboardProject({
      projectRoot: cwd,
      provider,
      model: session.model || 'claude-sonnet-4-5-20250929',
    }).catch(() => undefined); // 失败静默：状态留在 pending，下次启动重试
  };

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
    // F-27 Hook 系统：工具挂钩 + SessionStart/Stop/SessionEnd 生命周期
    hooks: HookManager.load(cwd, undefined, (o) => {
      if (!o.ok) console.error(`⚠ hook ${o.hook.event}(${o.hook.command}) 异常：${o.reason ?? o.stderr.trim().slice(0, 200)}`);
    }),
    // F-33 桌面通知：任务结束 / 确认卡出现时系统级通知（旁路 fire-and-forget）
    notify: createDesktopNotifier({ projectRoot: cwd }),
    yolo: Boolean(opts.yolo),
    permissionMode: resolvePermissionMode(Boolean(opts.yolo), opts.permission),
    allowTools: parseAllowTools(opts.allow),
    gitPolicy: normalizeGitPolicy(opts.git),
    debugPrompt: Boolean(opts.debugPrompt),
    maxTurns: Number(opts.maxTurns) || 50,
    engineMode: normalizeMode(opts.mode),
  });

  const { waitUntilExit } = render(app, { exitOnCtrlC: true });
  try {
    await waitUntilExit();
  } finally {
    await mcp.disconnectAll();
  }
}

// ── yzero hooks：F-27 生命周期钩子配置查看 ──────────────────────────────

program
  .command('hooks')
  .description('查看已加载的 Hook 配置（~/.y-zero/hooks.json + .y-zero/hooks.json；事件与退出码语义见 PRD F-27）')
  .action(() => {
    const files = loadHookFiles(process.cwd());
    const render = (list: typeof files.user, label: string) => {
      console.log(`${label}（${list.length} 条）`);
      for (const h of list) {
        const matcher = h.tool ? ` tool=${h.tool}` : '';
        console.log(`  ${h.event.padEnd(12)} ${h.command}${matcher}${h.timeout_ms ? ` timeout=${h.timeout_ms}ms` : ''}`);
      }
    };
    render(files.user, '用户级 ~/.y-zero/hooks.json');
    render(files.project, '项目级 .y-zero/hooks.json');
    for (const e of files.errors) console.error(`✘ ${e}`);
    if (files.hooks.length === 0 && files.errors.length === 0) {
      console.log('（未配置任何钩子）示例：.y-zero/hooks.json → {"hooks":[{"event":"PreToolUse","tool":"write_file","command":"npx lint --fix"}]}');
    }
  });

// ── yzero evals：F-28 评测体系 ───────────────────────────────────────────

program
  .command('evals')
  .description('F-28 Evals 评测体系：本地任务基准集 + 多 Provider 横向对比 + 回归基线保护')
  .argument('[sub]', 'list | run | baseline（缺省 run）')
  .addHelpText(
    'after',
    `
子命令：
  yzero evals list                                查看内置/项目基准集
  yzero evals run [options]                       运行基准集（--provider a,b,c 横向对比）
  yzero evals baseline --save [options]           保存当前结果为回归基线（.y-zero/evals/baseline.json）
  yzero evals baseline --check [options]          重跑并对比基线，回归即退出码 1

自定义套件：.y-zero/evals/suite.json（{"name","cases":[{id,title,task,checks}]}），--suite 指定任意路径。`,
  )
  .option('--suite <path>', '基准集 JSON 路径（缺省用内置 builtin-core）')
  .option('--provider <ids>', 'Provider（逗号分隔可多个，横评对比；缺省自动探测）')
  .option('-m, --model <model>', '指定模型名')
  .option('--tag <tag>', '只跑指定标签的用例')
  .option('--only <ids>', '只跑指定用例 id（逗号分隔）')
  .option('--json', 'stdout 输出结构化 JSON（SuiteRun 数组）', false)
  .option('--output <file>', 'Markdown 报告落文件')
  .option('--save', 'baseline 模式：保存为基线', false)
  .option('--check', 'baseline 模式：对比基线（回归 → 退出码 1）', false)
  .option('--max-turns <n>', '单用例最大轮次', '30')
  .option('--max-cost <usd>', '单用例费用预算（USD，默认 0.7）')
  .option('--permission <mode>', 'F-23 权限模式：plan | default | yolo（写类用例需放行）', 'default')
  .option('--yolo', 'YOLO 第二重开关（与 --permission yolo 同时使用）')
  .option('--allow <tools>', '工具级 allowlist（逗号分隔）')
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.y-zero/agent.db）')
  .action(async (sub: string | undefined, opts: EvalsOptions) => {
    if (sub && !['list', 'run', 'baseline'].includes(sub)) {
      console.error('✘ 未知子命令，可用：list / run / baseline');
      process.exitCode = 1;
      return;
    }
    if (sub === 'list') await evalsListCommand(opts);
    else await evalsRunCommand(opts);
  });

// ── yzero sandbox：F-30 沙箱运维（status / enable / disable / pull / gc）──

const sandbox = program.command('sandbox').description('F-30 沙箱运维：查看状态、启用/关闭（seatbelt 为主后端，Docker 为可选）');

sandbox
  .command('status')
  .description('查看生效模式、后端探测结论与配置警告（不执行任何命令）')
  .option('--refresh', '强制重新探测（绕过 30s 缓存）', false)
  .action((opts: { refresh?: boolean }) => sandboxStatusCommand(opts));

sandbox
  .command('enable')
  .description('全局启用沙箱（写 ~/.y-zero/sandbox.json 的 mode；默认 seatbelt，其它字段保留）')
  .option('--mode <mode>', '隔离后端：seatbelt（macOS 自带，默认）| docker（容器）', 'seatbelt')
  .action((opts: { mode: string }) => sandboxEnableCommand(opts));

sandbox
  .command('disable')
  .description('全局关闭沙箱（mode=local，其它字段保留）')
  .action(() => sandboxDisableCommand());

sandbox
  .command('pull')
  .description('预拉取 docker 镜像（仅 docker 后端需要；seatbelt 无镜像概念）')
  .option('-i, --image <image>', '镜像名（缺省用生效配置的 sandbox.image）')
  .action((opts: { image?: string }) => sandboxPullCommand(opts));

sandbox
  .command('gc')
  .description('清理 yzero 残留容器（上次运行未正常退出时的兜底）')
  .action(() => sandboxGcCommand());

// ── yzero notify：F-33 桌面通知（status / enable / disable / test）────────

const notify = program.command('notify').description('F-33 桌面通知：长任务结束 / 需人工确认时系统级通知（macOS 通知中心 / Windows 通知）');

notify
  .command('status')
  .description('查看生效配置、配置来源与平台通知后端（不发送通知）')
  .action(() => notifyStatusCommand());

notify
  .command('enable')
  .description('全局启用桌面通知（写 ~/.y-zero/notify.json 的 enabled=true，其它字段保留）')
  .action(() => notifyEnableCommand());

notify
  .command('disable')
  .description('全局关闭桌面通知（enabled=false，其它字段保留）')
  .action(() => notifyDisableCommand());

notify
  .command('test')
  .description('发送一条样例通知（人工验证端到端链路）')
  .action(() => {
    void notifyTestCommand();
  });

// ── yzero onboarding：F-34 项目 onboarding（status / run / confirm / skip）────

const onboarding = program
  .command('onboarding')
  .description('F-34 项目 onboarding：新项目首次启动自动扫描，生成项目摘要与初始静态记忆草案，引导确认');

onboarding
  .command('status')
  .description('查看 onboarding 状态、草案与目标文件情况')
  .action(() => onboardingStatusCommand());

onboarding
  .command('run')
  .description('扫描项目并生成静态记忆草案（需要已配置模型 provider）')
  .option('--force', '忽略已有状态强制重新生成（覆盖草案）', false)
  .action((opts: { force?: boolean }) => {
    void onboardingRunCommand(opts);
  });

onboarding
  .command('confirm')
  .description('采纳草案（改名到位为 .y-zero/agent.md 与 MEMORY.md；目标已存在时不覆盖）')
  .action(() => onboardingConfirmCommand());

onboarding
  .command('skip')
  .description('跳过 onboarding（新项目首次注册不再自动扫描）')
  .action(() => onboardingSkipCommand());

// ── yzero run：F-29 Headless / SDK 非交互运行 ───────────────────────────

/** F-25：--image 可重复参数收集。 */
function collectImages(val: string, prev: string[] = []): string[] {
  return [...prev, val];
}

program
  .command('run')
  .description('非交互运行一次任务（F-29 Headless/SDK）：供 CI 流水线与脚本集成。退出码：0 成功 / 1 配置错误 / 2 引擎错误 / 3 达最大轮次 / 4 预算耗尽 / 5 中断')
  .argument('[task...]', '任务描述（也可用 -p 传入）')
  .option('-p, --prompt <text>', '任务描述（与位置参数等价，便于引用传参）')
  .option('--json', '结构化输出：最终在 stdout 打印单个 JSON 报告（结果/用量/工具调用/退出码）', false)
  .option('--output <file>', '把最终结果（--json 时为 JSON 报告）写入文件')
  .option('-r, --resume [sessionId]', '追加到既有会话（缺省恢复项目最近会话）')
  .option('-m, --model <model>', '指定模型名（默认读 YZERO_MODEL，再退回各厂商默认）')
  .option('--provider <name>', '模型厂商：anthropic | deepseek | qwen | openai')
  .option('--yolo', 'YOLO 第二重开关（须与 --permission yolo 同时使用）')
  .option('--permission <mode>', 'F-23 权限模式：plan | default | yolo（headless 下需确认操作会被自动拒绝，写任务请用 --allow / yolo）', 'default')
  .option('--allow <tools>', '工具级 allowlist（逗号分隔，default 模式下命中跳过确认）')
  .option('--git <mode>', 'F-24 git 策略：off | suggest | auto（auto = 成功结束后自动提交本会话变更）', 'suggest')
  .option('--max-turns <n>', '单任务最大轮次', '50')
  .option('--max-cost <usd>', '本次任务费用预算（USD，默认 0.7）')
  .option('--mode <mode>', '执行模式：react | plan | multi（默认 react）')
  .option('--image <path>', 'F-25 多模态：附加图片（可重复，最多 5 张；png/jpeg/gif/webp，单张 ≤4MB）', collectImages)
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.y-zero/agent.db）')
  .action(async (task: string[] | undefined, opts: RunOptions) => {
    opts.task = task?.length ? task.join(' ') : undefined;
    await runHeadlessCommand(opts);
  });

// ── 裸任务路由：`yzero "任务" --json` 等价于 `yzero run "任务" --json` ──
// 首个非选项参数且不是已知子命令时，重写为 run 子命令。
const KNOWN_SUBCOMMANDS = new Set(['run', 'models', 'memory', 'migrate', 'search', 'serve', 'hooks', 'evals', 'usage', 'sandbox', 'notify', 'onboarding', 'help']);
const argv = process.argv.slice(2);
if (argv.length > 0 && !argv[0]!.startsWith('-') && !KNOWN_SUBCOMMANDS.has(argv[0]!)) {
  process.argv.splice(2, 0, 'run');
}

program.parseAsync(process.argv).catch((e) => {
  console.error(`✘ ${(e as Error).message}`);
  process.exit(1);
});

// keep path import used (win compat helpers may grow here)
void path;
