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
  defaultModelFor,
  estimateMessagesTokens,
  ToolRegistry,
  McpManager,
  loadMcpConfig,
  ProviderManager,
  createServeRuntime,
  formatSearchHits,
  HookManager,
  loadHookFiles,
  MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  ExpertStore,
  readExpertsConfig,
  isTrusted,
  recordTrust,
  resolveToolAllow,
  restrictRegistry,
  toTeamRuntime,
  exportSession,
  type ExpertRecord,
} from '@delta/core';
import { App } from './ui/app.js';
import { assemblePrompt } from './prompt.js';
import {
  expertListCommand,
  expertShowCommand,
  expertImportCommand,
  expertExportCommand,
  expertNewCommand,
  expertTrustCommand,
  printTrustInfo,
  askConfirm,
} from './expert.js';
import { runHeadlessCommand, type RunOptions } from './headless-run.js';
import { usageCommand, type UsageCommandOptions } from './usage.js';
import {
  sandboxStatusCommand,
  sandboxEnableCommand,
  sandboxDisableCommand,
  sandboxPullCommand,
  sandboxGcCommand,
} from './sandbox.js';
import {
  mcpListCommand,
  mcpAddCommand,
  mcpRemoveCommand,
  mcpResourcesCommand,
  mcpResourceReadCommand,
  mcpPromptsCommand,
  mcpPromptShowCommand,
} from './mcp.js';
import { evalsListCommand, evalsRunCommand, type EvalsOptions } from './evals.js';
import {
  notifyDisableCommand,
  notifyEnableCommand,
  notifyStatusCommand,
  notifyTestCommand,
} from './notify.js';
import {
  skillHubGetCommand,
  skillHubResetCommand,
  skillHubSetCommand,
  skillInstallCommand,
  skillListCommand,
  skillSearchCommand,
} from './skill.js';
import {
  onboardingStatusCommand,
  onboardingRunCommand,
  onboardingConfirmCommand,
  onboardingSkipCommand,
} from './onboarding.js';
import {
  cronListCommand,
  cronAddCommand,
  cronRemoveCommand,
  cronToggleCommand,
  cronRunCommand,
  cronDaemonCommand,
} from './cron.js';
import {
  worktreeListCommand,
  worktreeRemoveCommand,
  worktreePruneCommand,
} from './worktree.js';
import { createSpawnExecutor } from './cron-executor.js';
import { createDesktopNotifier, autoOnboardProject } from '@delta/core';
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
  expert?: string;
  yes?: boolean;
}

const program = new Command();

// F-28 evals 等子命令与根命令重复声明了 --model/--provider/--db：开启位置选项语义，
// 使子命令位置参数之后的选项由子命令解析（否则父命令声明遮蔽子命令同名选项，值丢失）。
program.enablePositionalOptions();

program
  .name('delta')
  .description('delta-agent —— AI 编程命令行工具（M2：4 家 Provider + MCP 扩展 + 并行工具）')
  .version('0.1.0')
  .option('-r, --resume [sessionId]', '恢复指定会话（缺省恢复项目最近会话）')
  .option('-m, --model <model>', '指定模型名（默认读 DELTA_MODEL，再退回各厂商默认）')
  .option('-p, --provider <name>', '模型厂商：anthropic | deepseek | qwen | openai（默认读 DELTA_PROVIDER，再按已配置 Key 自动探测）')
  .option('--yolo', 'YOLO 第二重开关（须与 --permission yolo 同时使用；单独使用会降级为 default 并告警）')
  .option('--permission <mode>', 'F-23 权限模式：plan（只读）| default（写需确认）| yolo（全放行，需 --yolo 双重开启）', 'default')
  .option('--allow <tools>', '工具级 allowlist（逗号分隔，default 模式下命中跳过确认，如 write_file,edit_file）')
  .option('--git <mode>', 'F-24 git 策略：off | suggest（启动建议分支，默认）| auto（任务结束自动提交本会话变更）', 'suggest')
  .option('--debug-prompt', '启动时打印系统提示词与上下文统计')
  .option('--max-turns <n>', '单任务最大轮次', '50')
  .option('--mode <mode>', '执行模式：react | plan | multi（M5，默认 react）')
  .option('--expert <name>', 'F-39 召唤专家（会话级绑定；专家库 = 内置 < ~/.delta/experts < .delta/experts）')
  .option('--yes', 'F-39 跳过首次召唤信任确认（脚本/CI；非交互环境未传则失败退出）')
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.delta/agent.db）')
  .action(async (opts: CliOpts) => {
    await start(opts);
  });

// ── delta expert：F-39 专家库查看（P0：list/show；导入导出/创建归 P1 T15）──

const expert = program.command('expert').description('F-39 专家库：三层发现 + 会话级召唤');
expert
  .command('list')
  .description('列出全部专家（--verbose 显示被覆盖项与解析错误）')
  .option('--verbose', '显示被覆盖项与 errors')
  .action((opts: { verbose?: boolean }) => expertListCommand({ projectRoot: process.cwd(), homeDir: process.env.HOME, verbose: opts.verbose }));
expert
  .command('show')
  .description('查看专家详情（成员 / 工具 / 技能 / 提示词摘要）')
  .argument('<name>', '专家包名')
  .action((name: string) => expertShowCommand(name, { projectRoot: process.cwd(), homeDir: process.env.HOME }));
expert
  .command('import')
  .description('导入专家包（zip 或目录）到 user/project 层')
  .argument('<src>', 'zip 路径或包目录')
  .option('--layer <layer>', '目标层：user（默认）| project', 'user')
  .option('--force', '覆盖目标层同名包')
  .action((src: string, opts: { layer?: string; force?: boolean }) =>
    expertImportCommand(src, { projectRoot: process.cwd(), homeDir: process.env.HOME, layer: opts.layer, force: opts.force }));
expert
  .command('export')
  .description('导出专家包为 zip（内置专家不可导出）')
  .argument('<name>', '专家包名')
  .argument('<out>', '输出 zip 路径')
  .action((name: string, out: string) => expertExportCommand(name, out, { projectRoot: process.cwd(), homeDir: process.env.HOME }));
expert
  .command('new')
  .description('创建专家骨架（expert.json + agents md）')
  .argument('<name>', '专家包名')
  .option('--team', '创建团队骨架（主理人 + 产品/开发成员）')
  .option('--layer <layer>', '目标层：user（默认）| project', 'user')
  .option('--display-name <name>', '展示名（缺省 = 包名）')
  .option('--profession <prof>', '职业（缺省 = 专家/交付团队）')
  .action((name: string, opts: { team?: boolean; layer?: string; displayName?: string; profession?: string }) =>
    expertNewCommand(name, {
      projectRoot: process.cwd(),
      homeDir: process.env.HOME,
      team: opts.team,
      layer: opts.layer,
      displayName: opts.displayName,
      profession: opts.profession,
    }));
expert
  .command('trust')
  .description('记录对专家包的信任（首次召唤确认；版本/工具集变化后需重新确认）')
  .argument('<name>', '专家包名')
  .option('--yes', '跳过交互确认（脚本/CI）')
  .action((name: string, opts: { yes?: boolean }) =>
    expertTrustCommand(name, { projectRoot: process.cwd(), homeDir: process.env.HOME, yes: opts.yes }));

// ── delta models：Provider Key 本地管理（F-04a）──────────────────────────

const models = program.command('models').description('管理模型 Provider 配置（Key 加密存储于 ~/.delta/models.json）');

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
      console.log('（空）先用 `delta models add <id> -k <apiKey>` 添加');
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
      console.error('✘ 没有已启用的 Provider，先 `delta models add`');
      process.exitCode = 1;
      return;
    }
    console.log(`… 测试 ${target} …`);
    const r = await mgr.test(target);
    console.log(`${r.ok ? '✔' : '✘'} ${target}：${r.detail}（${r.latencyMs}ms）`);
    if (!r.ok) process.exitCode = 1;
  });

// ── F-32 模型路由：delta models routing 子命令组 ─────────────────────────

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

// ── delta memory：L2 动态记忆管理（memory-design §8）────────────────────

const memory = program.command('memory').description('管理 L2 长期动态记忆（memories 表）');

memory
  .command('list')
  .description('列出记忆条目（默认全局 + 全部 scope 汇总）')
  .option('--scope <scope>', '按 scope 过滤（global / project:<id> / session:<id>）')
  .option('--kind <kind>', '按类型过滤（preference/fact/decision/pitfall/workflow）')
  .option('--pending', '只看待确认队列')
  .option('--database <path>', 'SQLite 数据库路径（默认 ~/.delta/agent.db）')
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

// ── delta usage：F-31 成本与用量报告 ────────────────────────────────────

program
  .command('usage')
  .description('查看费用与 token 用量报告（按项目 / 模型 / 会话聚合；--json 与 /api/usage/summary 同构）')
  .option('--range <range>', '时间范围：today | 7d | 30d | all（默认 all，非法值归一化为 all）', 'all')
  .option('--project <id|name>', '按项目过滤（支持项目 id 或名称）')
  .option('--json', 'stdout 输出结构化 JSON（与 GET /api/usage/summary 同构，可直接供 jq 消费）', false)
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.delta/agent.db）')
  .action(async (opts: UsageCommandOptions) => {
    await usageCommand(opts);
  });

// ── delta export：F-49 会话分享导出（自包含 HTML / Markdown）────────────

program
  .command('export')
  .description('导出会话为自包含只读 HTML / Markdown 文件（纯本地生成；默认脱敏配置类字段并告警）')
  .argument('<sessionId>', '会话 ID')
  .option('--format <format>', '导出格式：html | md（默认 html）', 'html')
  .option('--out <file>', '输出文件（缺省 ./delta-export-<sessionId>.<ext>）')
  .option('--no-redact', '关闭默认脱敏（不推荐）')
  .option('--database <path>', 'SQLite 数据库路径（默认 ~/.delta/agent.db）')
  .action(async (sessionId: string, opts: { format: string; out?: string; redact: boolean; database?: string }) => {
    if (opts.format !== 'html' && opts.format !== 'md') {
      console.error(`✘ 非法导出格式：${opts.format}（可选 html | md）`);
      process.exitCode = 1;
      return;
    }
    const service = new SessionService(opts.database);
    try {
      const out =
        opts.out ?? path.resolve(`delta-export-${sessionId}.${opts.format}`);
      // AC-49-5：按块写入文件流，大会话不在内存中拼整篇文档
      const stream = fs.createWriteStream(out, { encoding: 'utf8' });
      const meta = await exportSession(
        service,
        sessionId,
        { format: opts.format, redact: opts.redact },
        (chunk) => stream.write(chunk),
      );
      await new Promise<void>((resolve, reject) => {
        stream.end(resolve);
        stream.on('error', reject);
      });
      console.log(`✔ 已导出 ${meta.messageCount} 条消息 / ${meta.runCount} 个任务 → ${out}`);
      if (meta.redactions.length) {
        const total = meta.redactions.reduce((sum, r) => sum + r.count, 0);
        console.error(`⚠ 默认脱敏已剔除 ${total} 处配置类字段：${meta.redactions.map((r) => `${r.kind}×${r.count}`).join('、')}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error(msg === 'session not found' ? `✘ 会话不存在：${sessionId}` : `✘ 导出失败：${msg}`);
      process.exitCode = msg === 'session not found' ? 1 : 2;
    } finally {
      service.close();
    }
  });

// ── delta migrate：F-35 Schema 版本迁移 ─────────────────────────────────

program
  .command('migrate')
  .description('查看/执行数据库 Schema 迁移（打开数据库时自动执行；此命令用于核对版本与迁移历史）')
  .option('--database <path>', 'SQLite 数据库路径（默认 ~/.delta/agent.db）')
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

// ── delta search：F-17 全文/语义搜索历史对话 ────────────────────────────

program
  .command('search')
  .description('搜索历史对话（全文 FTS5 + 语义 embedding 混合；无 embedding 配置时自动降级全文）')
  .argument('<query>', '检索词（中英文均可）')
  .option('--mode <mode>', 'auto（混合，默认）| fulltext | semantic', 'auto')
  .option('--limit <n>', '返回条数（默认 10）', '10')
  .option('--database <path>', 'SQLite 数据库路径（默认 ~/.delta/agent.db）')
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

// ── delta serve：Web 控制台本地服务（M4）────────────────────────────────

program
  .command('serve')
  .description('启动 Web 控制台本地服务（纯本地：默认 127.0.0.1:7900，仅监听回环地址）')
  .option('--port <n>', '监听端口（默认 7900）', '7900')
  .option('--web-dist <dir>', 'Vue 构建产物目录（缺省用包内嵌 packages/web/dist）')
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.delta/agent.db）')
  .action(async (opts: { port: string; webDist?: string; db?: string }) => {
    // Vue 构建产物候选：--web-dist > 包内嵌 cli/dist/web（npm 安装形态）> 仓库 packages/web/dist（开发形态）
    const distDir = path.dirname(fileURLToPath(import.meta.url));
    const webDist = [
      opts.webDist,
      path.resolve(distDir, 'web'),
      path.resolve(distDir, '../../web/dist'),
    ].find((d) => d && fs.existsSync(path.join(d, 'index.html')));
    const port = Number(opts.port) || 7900;

    // 组装编排已下移 core（createServeRuntime，桌面宿主共用同一工厂）；
    // CLI 形态差异：注册 cwd 为默认项目 + spawn cron 执行器（nodePath = process.execPath 由 core 内部缺省）
    const runtime = await createServeRuntime({
      port,
      dbPath: opts.db,
      webDistDir: webDist,
      projectRoot: process.cwd(),
      registerProject: true,
      cronExecutor: createSpawnExecutor(),
      notify: createDesktopNotifier({ projectRoot: process.cwd() }),
    });
    console.log(`✔ delta Web 控制台已启动：http://127.0.0.1:${runtime.port}`);
    console.log(webDist ? `静态资源：${webDist}` : '（未发现 Vue 构建产物，仅提供 /api；先构建 packages/web）');
    console.log('Ctrl+C 退出');
    const shutdown = () => {
      void runtime.dispose().finally(() => process.exit(0));
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

  // MCP servers: ~/.delta/mcp.json + .delta/mcp.json（项目级优先）
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
      // 未显式指定模型时留空，运行期按解析出的 Provider 取默认（见 defaultModelFor）
      model: opts.model ?? process.env.DELTA_MODEL,
      mode: normalizeMode(opts.mode),
    });
  } else if (opts.model) {
    session = { ...session, model: opts.model };
  }

  // ── F-39：专家解析与绑定（会话级、创建时绑定；恢复会话沿用落库绑定）──────
  const expertStore = new ExpertStore({ projectRoot: cwd, homeDir: process.env.HOME });
  let expert: ExpertRecord | undefined;
  if (opts.expert) {
    if (opts.resume) {
      console.error('✘ 专家绑定在会话创建时确定：--expert 不能与 --resume 同用（请去掉 -r 或去掉 --expert）');
      process.exit(1);
    }
    expert = await expertStore.get(opts.expert);
    if (!expert) {
      const names = (await expertStore.list()).experts.map((e) => e.name);
      console.error(`✘ 未找到专家 ${opts.expert}。可选：${names.join(', ') || '（专家库为空）'}`);
      process.exit(1);
    }
    // F-39 P1（T16）：首次召唤信任确认（builtin 免确认；拒绝 → 不建会话）
    const trustCfg = await readExpertsConfig(process.env.HOME ?? '');
    if (!isTrusted(trustCfg, expert)) {
      const info = await printTrustInfo(expert.name, { projectRoot: cwd, homeDir: process.env.HOME ?? undefined });
      if (!info.ok) process.exit(1);
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          console.error('✘ 非交互环境：请用 --yes 明确信任，或先运行 `delta expert trust <name>`');
          process.exit(1);
        }
        const answer = await askConfirm('信任并召唤该专家？[y/N] ');
        if (answer.trim().toLowerCase() !== 'y') {
          console.error('已取消（未创建会话）');
          process.exit(1);
        }
      }
      await recordTrust(process.env.HOME ?? '', expert);
    }
    session = service.createSession(project.id, {
      title: `${project.name} · ${new Date().toLocaleString('zh-CN')}`,
      model: opts.model ?? process.env.DELTA_MODEL,
      mode: expert.expertType === 'team' ? 'react' : normalizeMode(opts.mode),
      expert: expert.name,
      expertType: expert.expertType,
    });
  } else if (session.expert) {
    // 恢复历史会话：包可能已被删除（AC-9 降级：警告 + 无专家运行）
    expert = await expertStore.get(session.expert);
    if (!expert) {
      console.error(`⚠ 原绑定专家 ${session.expert} 已不存在，本次按无专家运行`);
    }
  }

  // F-39：白名单收窄（收窄点唯一；L4 工具清单与执行共用同一视图）
  const allow = resolveToolAllow(
    expert?.tools ?? null,
    registry.definitions().map((d) => d.name),
  );
  const runRegistry = restrictRegistry(registry, allow.allow) as typeof registry;
  if (expert && allow.unknown.length > 0) {
    console.error(`⚠ 专家声明的未知工具（已忽略）：${allow.unknown.join(', ')}`);
  }

  // M5: 启动时孤儿任务恢复（running 且租约过期 → queued，retries+1）
  const recovered = service.recoverTasks(session.id);
  if (recovered > 0) console.error(`♻ 已恢复 ${recovered} 个中断任务（重新排队）`);

  // ── F-37：会话恢复还原 worktree 绑定（设计文档 §4.3）──
  // 工作根单一来源：workRootRef 被提示词 getter 与 App 组件共享，切换后同步更新
  const workRootRef: { current: string } = { current: cwd };
  if (session.worktree_path) {
    if (fs.existsSync(session.worktree_path)) {
      workRootRef.current = session.worktree_path;
      console.error(`🌿 已恢复 worktree 绑定：${session.worktree_path}`);
    } else {
      console.error(`⚠ worktree 目录已丢失（${session.worktree_path}），已回退主工作区`);
    }
  }

  // F-34 项目 onboarding：新注册项目后台自动扫描生成静态记忆草案
  // （fire-and-forget 不阻塞 TUI 启动；完成情况看 `.delta/onboarding.json` 或 `delta onboarding status`）
  if (project.created) {
    console.error('✨ 新项目已注册：onboarding 扫描已在后台启动（完成后用 `delta onboarding confirm` 采纳）');
    void autoOnboardProject({
      projectRoot: cwd,
      provider,
      model: session.model || defaultModelFor(provider.id),
    }).catch(() => undefined); // 失败静默：状态留在 pending，下次启动重试
  };

  // ── M3 提示词体系：7 层组装 + 三级覆盖 + Skill 三层加载/两阶段加载 ──
  // F-37（D6）：projectRoot 传 getter——动态段 CWD 每轮取 workRootRef 实时值，
  // 切换分支/worktree 后由 App 调 rebuild() 重读静态段
  const model = session.model || defaultModelFor(provider.id);
  const expertRef: { current: ExpertRecord | null } = { current: expert ?? null };
  const promptAssembly = await assemblePrompt({
    projectRoot: () => workRootRef.current,
    model,
    contextWindow: 200_000,
    tools: runRegistry.definitions(),
    expertRef,
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
    registry: runRegistry,
    // F-39：团队委派基座（未收窄完整表）+ 底栏专家标签 + /expert 就地改绑
    baseRegistry: registry,
    expertRef,
    expertLabel: expert ? `◆ ${expert.displayName.zh || expert.displayName.en}` : null,
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
    // F-37：共享工作根引用 + 切换后提示词重组装
    workRootRef,
    rebuildPrompt: promptAssembly.rebuild,
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

// ── delta hooks：F-27 生命周期钩子配置查看 ──────────────────────────────

program
  .command('hooks')
  .description('查看已加载的 Hook 配置（~/.delta/hooks.json + .delta/hooks.json；事件与退出码语义见 PRD F-27）')
  .action(() => {
    const files = loadHookFiles(process.cwd());
    const render = (list: typeof files.user, label: string) => {
      console.log(`${label}（${list.length} 条）`);
      for (const h of list) {
        const matcher = h.tool ? ` tool=${h.tool}` : '';
        console.log(`  ${h.event.padEnd(12)} ${h.command}${matcher}${h.timeout_ms ? ` timeout=${h.timeout_ms}ms` : ''}`);
      }
    };
    render(files.user, '用户级 ~/.delta/hooks.json');
    render(files.project, '项目级 .delta/hooks.json');
    for (const e of files.errors) console.error(`✘ ${e}`);
    if (files.hooks.length === 0 && files.errors.length === 0) {
      console.log('（未配置任何钩子）示例：.delta/hooks.json → {"hooks":[{"event":"PreToolUse","tool":"write_file","command":"npx lint --fix"}]}');
    }
  });

// ── delta evals：F-28 评测体系 ───────────────────────────────────────────

program
  .command('evals')
  .description('F-28 Evals 评测体系：本地任务基准集 + 多 Provider 横向对比 + 回归基线保护')
  .argument('[sub]', 'list | run | baseline（缺省 run）')
  .addHelpText(
    'after',
    `
子命令：
  delta evals list                                查看内置/项目基准集
  delta evals run [options]                       运行基准集（--provider a,b,c 横向对比）
  delta evals baseline --save [options]           保存当前结果为回归基线（.delta/evals/baseline.json）
  delta evals baseline --check [options]          重跑并对比基线，回归即退出码 1

自定义套件：.delta/evals/suite.json（{"name","cases":[{id,title,task,checks}]}），--suite 指定任意路径。`,
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
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.delta/agent.db）')
  .action(async (sub: string | undefined, opts: EvalsOptions) => {
    if (sub && !['list', 'run', 'baseline'].includes(sub)) {
      console.error('✘ 未知子命令，可用：list / run / baseline');
      process.exitCode = 1;
      return;
    }
    if (sub === 'list') await evalsListCommand(opts);
    else await evalsRunCommand(opts);
  });

// ── delta sandbox：F-30 沙箱运维（status / enable / disable / pull / gc）──

const sandbox = program.command('sandbox').description('F-30 沙箱运维：查看状态、启用/关闭（seatbelt 为主后端，Docker 为可选）');

sandbox
  .command('status')
  .description('查看生效模式、后端探测结论与配置警告（不执行任何命令）')
  .option('--refresh', '强制重新探测（绕过 30s 缓存）', false)
  .action((opts: { refresh?: boolean }) => sandboxStatusCommand(opts));

sandbox
  .command('enable')
  .description('全局启用沙箱（写 ~/.delta/sandbox.json 的 mode；默认 seatbelt，其它字段保留）')
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
  .description('清理 delta 残留容器（上次运行未正常退出时的兜底）')
  .action(() => sandboxGcCommand());

// ── delta notify：F-33 桌面通知（status / enable / disable / test）────────

const notify = program.command('notify').description('F-33 桌面通知：长任务结束 / 需人工确认时系统级通知（macOS 通知中心 / Windows 通知）');

notify
  .command('status')
  .description('查看生效配置、配置来源与平台通知后端（不发送通知）')
  .action(() => notifyStatusCommand());

notify
  .command('enable')
  .description('全局启用桌面通知（写 ~/.delta/notify.json 的 enabled=true，其它字段保留）')
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

// ── delta skill：Skill Hub 搜索 / 安装 / hub 地址管理 ────────────────────

const skill = program
  .command('skill')
  .description('Skill 管理：从 Skill Hub 搜索/安装技能（地址可配置，存于 ~/.delta/skill-hub.json）');

skill
  .command('search <query...>')
  .description('在 Skill Hub 搜索技能')
  .option('--hub <url>', '一次性指定 hub 地址（优先级高于环境变量与配置文件）')
  .action((query: string[], opts: { hub?: string }) => {
    void skillSearchCommand(query, opts);
  });

skill
  .command('install <slug>')
  .description('安装技能：默认装到用户层 ~/.delta/skills/，--project 装到项目层 .delta/skills/')
  .option('--project', '安装到项目层（.delta/skills/）而非用户层', false)
  .option('--force', '目标已存在时覆盖重装', false)
  .option('--hub <url>', '一次性指定 hub 地址')
  .action((slug: string, opts: { hub?: string; project?: boolean; force?: boolean }) => {
    void skillInstallCommand(slug, opts);
  });

skill
  .command('list')
  .description('列出本机已装 Skill（builtin / user / project 三层分组）')
  .action(() => {
    void skillListCommand();
  });

const skillHub = skill.command('hub').description('查看 / 设置 Skill Hub 地址');

skillHub
  .command('get')
  .description('查看生效 hub 地址与来源')
  .action(() => skillHubGetCommand());

skillHub
  .command('set <url>')
  .description('持久化 hub 地址（写入 ~/.delta/skill-hub.json 的 url 字段，其余字段保留）')
  .action((url: string) => skillHubSetCommand(url));

skillHub
  .command('reset')
  .description('清除配置，恢复官方默认（api.skillhub.cn）')
  .action(() => skillHubResetCommand());

// ── delta onboarding：F-34 项目 onboarding（status / run / confirm / skip）────

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
  .description('采纳草案（改名到位为 .delta/agent.md 与 MEMORY.md；目标已存在时不覆盖）')
  .action(() => onboardingConfirmCommand());

onboarding
  .command('skip')
  .description('跳过 onboarding（新项目首次注册不再自动扫描）')
  .action(() => onboardingSkipCommand());

// ── delta run：F-29 Headless / SDK 非交互运行 ───────────────────────────

/** F-25：--image 可重复参数收集。 */
function collectImages(val: string, prev: string[] = []): string[] {
  return [...prev, val];
}

/** F-48：--env / --header / --arg 可重复参数收集。 */
function collectRepeatable(val: string, prev: string[] = []): string[] {
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
  .option('-m, --model <model>', '指定模型名（默认读 DELTA_MODEL，再退回各厂商默认）')
  .option('--provider <name>', '模型厂商：anthropic | deepseek | qwen | openai')
  .option('--yolo', 'YOLO 第二重开关（须与 --permission yolo 同时使用）')
  .option('--permission <mode>', 'F-23 权限模式：plan | default | yolo（headless 下需确认操作会被自动拒绝，写任务请用 --allow / yolo）', 'default')
  .option('--allow <tools>', '工具级 allowlist（逗号分隔，default 模式下命中跳过确认）')
  .option('--git <mode>', 'F-24 git 策略：off | suggest | auto（auto = 成功结束后自动提交本会话变更）', 'suggest')
  .option('--max-turns <n>', '单任务最大轮次', '50')
  .option('--max-cost <usd>', '本次任务费用预算（USD，默认 0.7）')
  .option('--mode <mode>', '执行模式：react | plan | multi（默认 react）')
  .option('--image <path>', 'F-25 多模态：附加图片（可重复，最多 5 张；png/jpeg/gif/webp，单张 ≤4MB）', collectImages)
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.delta/agent.db）')
  .action(async (task: string[] | undefined, opts: RunOptions) => {
    opts.task = task?.length ? task.join(' ') : undefined;
    await runHeadlessCommand(opts);
  });

// ── delta cron：F-22 定时任务/自动化（list / add / remove / enable / disable / run / daemon）────

const cron = program
  .command('cron')
  .description('F-22 定时任务：按 cron 表达式调度 agent 任务（配置 ~/.delta/cron.json，复用 delta run 非交互语义）');

cron
  .command('list')
  .description('查看定时任务清单（--json 输出原始结构）')
  .option('--json', '输出 JSON', false)
  .action((opts: { json?: boolean }) => cronListCommand(opts));

cron
  .command('add')
  .description('新增定时任务（name 唯一；cron 为 5 字段表达式或 @hourly/@daily/@weekly/@monthly 等别名）')
  .requiredOption('--name <name>', '任务名称（唯一，用于后续引用）')
  .requiredOption('--cron <expr>', '5 字段 cron 表达式，如 "30 8 * * *"（每天 08:30）或 @daily')
  .requiredOption('--prompt <text>', '任务描述（等价 delta run -p）')
  .option('--dir <path>', '运行目录（决定项目与上下文；缺省当前目录）')
  .option('--max-cost <usd>', '单次运行费用预算（USD）')
  .option('--disable', '创建为停用状态', false)
  .action((opts: { name: string; cron: string; prompt: string; dir?: string; maxCost?: string; disable?: boolean }) => {
    cronAddCommand(opts);
  });

cron
  .command('remove <id-or-name>')
  .description('删除定时任务（id 或名称）')
  .action((idOrName: string) => cronRemoveCommand(idOrName));

cron
  .command('enable <id-or-name>')
  .description('启用任务（从当下重算下次运行）')
  .action((idOrName: string) => cronToggleCommand(idOrName, true));

cron
  .command('disable <id-or-name>')
  .description('停用任务（不删除，历史保留）')
  .action((idOrName: string) => cronToggleCommand(idOrName, false));

cron
  .command('run')
  .description('手动补跑：无 --id 执行全部到期任务；--id 强制执行指定任务一次（无视调度，便于试跑）')
  .option('--id <id-or-name>', '只执行指定任务（强制一次，不推进调度时刻）')
  .action((opts: { id?: string }) => {
    void cronRunCommand(opts);
  });

cron
  .command('daemon')
  .description('常驻调度进程：每 tick 扫描到期任务并执行（SIGINT/SIGTERM 优雅退出）')
  .option('--tick-ms <n>', '扫描间隔毫秒数（默认 30000）', '30000')
  .option('--once', '单轮补跑后退出（配合系统 cron / systemd timer 使用）', false)
  .action((opts: { tickMs?: string; once?: boolean }) => {
    void cronDaemonCommand(opts);
  });

// ── delta worktree：F-37 worktree 生命周期管理（P1 顺手件，F-37-8）────────

const worktree = program
  .command('worktree')
  .description('F-37 worktree 生命周期管理：查看注册清单 / 显式移除 / 清理孤儿（目录有未提交改动时拒绝移除）');

worktree
  .command('list')
  .description('列出仓库的 worktree 注册清单（含主工作区与各会话目录）')
  .action(() => {
    void worktreeListCommand();
  });

worktree
  .command('remove <path>')
  .description('移除指定 worktree（路径为注册绝对路径，见 worktree list；脏目录拒绝）')
  .action((wtPath: string) => {
    void worktreeRemoveCommand(wtPath);
  });

worktree
  .command('prune')
  .description('清理孤儿注册项（目录已被手动删除的 worktree）')
  .action(() => {
    void worktreePruneCommand();
  });

// ── delta mcp：F-48 MCP 配置与 resources/prompts 显式通道 ────────────────

const mcp = program
  .command('mcp')
  .description('MCP 服务器配置（stdio / streamable HTTP）与 resources/prompts 显式读取');

mcp
  .command('list')
  .description('列出已配置的 MCP 服务器（全局与项目级合并视图；header 值一律掩码不回显）')
  .action(() => mcpListCommand());

mcp
  .command('add <name>')
  .description('添加服务器：stdio 用 --command；streamable HTTP 用 --transport http --url [--header K=V]（header 值加密落盘）')
  .option('--transport <mode>', '传输类型：stdio（默认）| http', 'stdio')
  .option('--command <cmd>', 'stdio 启动命令（含参数，如 "npx -y @modelcontextprotocol/server-filesystem /tmp"）')
  .option('--url <url>', 'streamable HTTP 端点 URL')
  .option('--env <key=value>', 'stdio 子进程环境变量（可重复）', collectRepeatable, [])
  .option('--header <key=value>', 'HTTP 请求头（可重复；值加密存储，展示仅掩码）', collectRepeatable, [])
  .option('--timeout-ms <ms>', '工具调用超时（毫秒，默认 60000）')
  .option('--project', '写入项目级 .delta/mcp.json（默认全局 ~/.delta/mcp.json）', false)
  .action((name: string, opts: Parameters<typeof mcpAddCommand>[1]) => mcpAddCommand(name, opts));

mcp
  .command('remove <name>')
  .description('从指定作用域的 mcp.json 移除服务器')
  .option('--project', '操作项目级 .delta/mcp.json（默认全局）', false)
  .action((name: string, opts: { project?: boolean }) => mcpRemoveCommand(name, opts));

mcp
  .command('resources <server>')
  .description('列出服务器暴露的 resources（仅清单；显式读取不自动轮询）')
  .action((server: string) => mcpResourcesCommand(server));

mcp
  .command('resource-read <server> <uri>')
  .description('显式读取一个 resource 并打印（内容 untrusted 包裹，等价 @ 引用语义）')
  .action((server: string, uri: string) => mcpResourceReadCommand(server, uri));

mcp
  .command('prompts <server>')
  .description('列出服务器暴露的 prompt 模板')
  .action((server: string) => mcpPromptsCommand(server));

mcp
  .command('prompt-show <server> <name>')
  .description('取 prompt 模板并装配为消息文本（--arg key=value 可重复）')
  .option('--arg <key=value>', '模板参数（可重复）', collectRepeatable, [])
  .action((server: string, name: string, opts: { arg?: string[] }) => mcpPromptShowCommand(server, name, opts));

// ── 裸任务路由：`delta "任务" --json` 等价于 `delta run "任务" --json` ──
// 首个非选项参数且不是已知子命令时，重写为 run 子命令。
const KNOWN_SUBCOMMANDS = new Set(['run', 'models', 'memory', 'migrate', 'search', 'serve', 'hooks', 'evals', 'usage', 'sandbox', 'notify', 'skill', 'onboarding', 'cron', 'worktree', 'expert', 'mcp', 'help', 'export']);
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
