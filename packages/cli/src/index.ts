#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SessionService, resolveProviderFromEnv } from '@delta/core/session';
import { APP_VERSION } from '@delta/core/paths';
import { ProviderManager, defaultModelFor } from '@delta/core/llm';
import { ToolRegistry } from '@delta/core/tools';
import { estimateMessagesTokens } from '@delta/core/context';
import {
  ExpertStore,
  readExpertsConfig,
  isTrusted,
  recordTrust,
  resolveToolAllow,
  restrictRegistry,
  toTeamRuntime,
  type ExpertRecord,
} from '@delta/core/experts';
import { McpManager, loadMcpConfig } from '@delta/core/mcp';
import { HookManager } from '@delta/core/hooks';
import { App } from './ui/app.js';
import { commandNames, mountCommands } from './commands.js';
import { loadCliPlugins } from './cli-plugins.js';
import { assemblePrompt } from './prompt.js';
import { externalAgentBlockLines } from './external-block.js';
import { expertTrustCommand, printTrustInfo, askConfirm } from './expert.js';
import { createDesktopNotifier } from '@delta/core/notify';
import { autoOnboardProject } from '@delta/core/onboarding';
import { startupUpdateCheck } from './update.js';
import {
  normalizeGitPolicy,
  normalizeMode,
  parseAllowTools,
  resolvePermissionMode,
} from './shared.js';
import { BUILTIN_CLI_TOP_LEVEL_COMMANDS, mountBuiltinCommands } from './builtin-commands/mount.js';

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

program.enablePositionalOptions();

program
  .name('delta')
  .description('Delta-Agent —— AI 编程命令行工具（M2：4 家 Provider + MCP 扩展 + 并行工具）')
  .version(APP_VERSION)
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

mountBuiltinCommands(program);

async function start(opts: CliOpts): Promise<void> {
  // F-50 启动版本检查：fire-and-forget 周节流（可经 ~/.delta/update.json 关闭），
  // 失败静默留档 F-41；发现新版本在 TUI 挂起前提示一行，绝不阻塞启动
  void startupUpdateCheck();

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
// ── 裸任务路由：`delta "任务" --json` 等价于 `delta run "任务" --json` ──
async function runCli(): Promise<void> {
  try {
    await loadCliPlugins(process.cwd());
  } catch (e) {
    console.error(`⚠ 插件加载失败（已跳过）：${(e as Error).message}`);
  }
  mountCommands(program);
  const KNOWN_SUBCOMMANDS = new Set([...BUILTIN_CLI_TOP_LEVEL_COMMANDS, 'help', ...commandNames()]);
  const argv = process.argv.slice(2);
  if (argv.length > 0 && !argv[0]!.startsWith('-') && !KNOWN_SUBCOMMANDS.has(argv[0]!)) {
    process.argv.splice(2, 0, 'run');
  }
  await program.parseAsync(process.argv);
}

runCli().catch((e) => {
  console.error(`✘ ${(e as Error).message}`);
  process.exit(1);
});

void path;

