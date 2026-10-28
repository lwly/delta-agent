/**
 * F-29 Headless / SDK 形态 —— `delta run` 非交互入口。
 *
 * 用法：
 *   delta run "任务描述"                     # 人类可读：流式文本到 stdout，过程到 stderr
 *   delta run -p "任务描述" --json           # 结构化输出：单个 JSON 到 stdout
 *   delta run "任务" --output result.txt     # 结果落文件
 *   delta run "任务" -r <sessionId>          # 追加到既有会话
 *
 * 退出码协议（headlessExitCode）：
 *   0 成功 / 1 配置参数错误 / 2 引擎致命错误 / 3 达最大轮次 / 4 预算耗尽 / 5 SIGINT 中断
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  autoOnboardProject,
  BudgetManager,
  createRunFileLogger,
  defaultModelFor,
  FILES,
  GitIntegration,
  McpManager,
  ModelRouter,
  PermissionState,
  SessionService,
  ToolRegistry,
  buildHeadlessReport,
  headlessExitCode,
  loadMcpConfig,
  prepareImages,
  describeImage,
  ImageError,
  resolveProviderFromEnv,
  runHeadless,
  runMultiAgent,
  runPlanExecute,
  runReAct,
  modeSegment,
  createDesktopNotifier,
  userConfigDir,
  type AgentEvent,
  type ChatMessage,
  type EngineMode,
  type MessageImage,
  type PreparedImage,
  type RunContext,
} from '@delta/core';
import { assemblePrompt } from './prompt.js';
import { HookManager } from '@delta/core';
import {
  normalizeGitPolicy,
  normalizeMode,
  parseAllowTools,
  renderMemoryRecallBlock,
  resolvePermissionMode,
} from './shared.js';

export interface RunOptions {
  task?: string; // 位置参数（可多词）
  prompt?: string; // -p 别名（对齐 PRD `agent -p "任务" --json`）
  json?: boolean;
  output?: string;
  resume?: string;
  model?: string;
  provider?: string;
  permission?: string;
  yolo?: boolean;
  allow?: string;
  git?: string;
  maxTurns?: string;
  maxCost?: string;
  mode?: string;
  db?: string;
  /** F-25 多模态：图片附件路径（可重复传 --image a.png --image b.jpg） */
  image?: string[];
}

export async function runHeadlessCommand(opts: RunOptions): Promise<void> {
  const task = (opts.prompt ?? (Array.isArray(opts.task) ? opts.task.join(' ') : opts.task) ?? '').trim();
  if (!task) {
    console.error('✘ 缺少任务描述。用法：delta run "任务描述"（或 delta run -p "任务" --json）');
    process.exitCode = 1;
    return;
  }

  // provider（失败 → 退出码 1）
  let provider;
  try {
    provider = await resolveProviderFromEnv(opts.provider);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // MCP：~/.delta/mcp.json + .delta/mcp.json（项目级优先）
  const registry = new ToolRegistry();
  const mcp = new McpManager();
  for (const [name, cfg] of Object.entries(loadMcpConfig(process.cwd()))) {
    try {
      await mcp.connect(name, cfg);
      const n = await mcp.registerInto(name, registry);
      console.error(`✔ MCP ${name}：已接入 ${n} 个工具`);
    } catch (e) {
      console.error(`✘ MCP ${name} 连接失败（已跳过）：${(e as Error).message}`);
    }
  }

  // 会话
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
    process.exitCode = 1;
    service.close();
    return;
  }
  if (!session) {
    session = service.createSession(project.id, {
      title: `headless · ${task.slice(0, 40)}`,
      // 未显式指定模型时留空，运行期按解析出的 Provider 取默认（见 defaultModelFor）
      model: opts.model ?? process.env.DELTA_MODEL,
      mode: normalizeMode(opts.mode),
    });
  } else if (opts.model) {
    session = { ...session, model: opts.model };
  }
  service.recoverTasks(session.id);

  // F-34 项目 onboarding：新注册项目时同步扫描一次，生成静态记忆草案
  // （一次性成本可接受；失败静默——状态留在 pending，下次新项目启动重试）
  if (project.created) {
    console.error('✨ 新项目已注册：开始 onboarding 扫描…');
    try {
      const r = await autoOnboardProject({
        projectRoot: cwd,
        provider,
        model: session.model || defaultModelFor(provider.id),
      });
      if (r && !r.skipped) {
        console.error(`✔ onboarding 草案已生成：${r.agentMdDraftPath}（用 \`delta onboarding confirm\` 采纳）`);
      }
    } catch {
      console.error('⚠ onboarding 扫描失败（已跳过，可稍后运行 `delta onboarding run`）');
    }
  }

  // 提示词组装（7 层 + Skill 三层）
  const model = session.model || defaultModelFor(provider.id);
  const promptAssembly = await assemblePrompt({
    projectRoot: cwd,
    model,
    contextWindow: 200_000,
    tools: registry.definitions(),
  });

  // 权限 / 记忆召回
  const engineMode: EngineMode = normalizeMode(opts.mode);
  const perms = new PermissionState({
    mode: resolvePermissionMode(Boolean(opts.yolo), opts.permission),
    allowlist: parseAllowTools(opts.allow),
  });
  const memoryBlock = renderMemoryRecallBlock(service.memory, task, [
    'global',
    `project:${project.id}`,
    `session:${session.id}`,
  ]);

  const budget = new BudgetManager(
    opts.maxCost ? { maxCostUsd: Number(opts.maxCost) || 0.7 } : {},
  );

  // E-1 子代理模型路由：命中 F-32 routing 的 subagent 规则时子代理走小模型；
  // 目标 provider 构建失败 / 规则缺失 → 回退主模型（预算/用量仍回写任务预算，口径不变）
  let subProvider = provider;
  let subModel = model;
  try {
    const r = new ModelRouter().resolve('subagent');
    if (r) {
      if (r.provider) {
        subProvider = await resolveProviderFromEnv(r.provider);
      }
      subModel = r.model;
    }
  } catch {
    // 回退主模型
  }

  // F-42：压缩摘要（summarize kind）路由见下方 runLogFile 初始化之后——
  // 回退时需要 F-41 run log 做 debug 留档（AC-42-4），故解析延后到落盘句柄就绪

  // F-27 Hook 系统：加载用户级 + 项目级 hooks.json
  const hooks = HookManager.load(cwd);

  const baseCtx: RunContext = {
    sessionId: session.id,
    projectId: project.id,
    mode: engineMode,
    model,
    systemPrompt: promptAssembly.parts.staticText,
    systemPromptParts: {
      staticText: promptAssembly.parts.staticText,
      dynamicText: [promptAssembly.parts.dynamicText, memoryBlock, modeSegment(engineMode)]
        .filter((t) => t.length > 0)
        .join('\n\n'),
    },
    dynamicProvider: promptAssembly.refreshDynamic,
    maxTurns: Number(opts.maxTurns) || 50,
    signal: new AbortController().signal, // runHeadless 覆盖
    provider,
    registry,
    toolContext: {
      projectRoot: cwd,
      signal: new AbortController().signal,
      sessionId: session.id,
      projectId: project.id,
      memory: service.memory,
      changes: service.changes,
      confirm: async () => ({ kind: 'allow' }), // runHeadless 覆盖为自动拒绝
      askUser: async () => '',
      todos: [],
      skills: promptAssembly.skills,
      permissions: perms,
      // F-26 子代理即工具：注入父注册表与子代理运行时（只读隔离，用量回写任务预算）
      registry,
      subagent: {
        provider: subProvider,
        model: subModel,
        budget,
        budgetConfig: budget.config,
        windowTokens: 200_000,
        depth: 0,
      },
      // F-27 Hook 系统：PreToolUse（可阻断）/ PostToolUse（记录）
      hooks,
    },
    budget,
    windowTokens: 200_000,
    tasks: service.tasks,
  };

  // SIGINT/SIGTERM → 中断（退出码 5）
  const external = new AbortController();
  const onSignal = () => external.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // F-27 SessionStart 钩子（旁路触发，不阻塞主流程）
  void hooks.emit('SessionStart', { sessionId: session.id, projectId: project.id });

  // 进度输出：文本流到 stdout（人类模式）；工具/系统行到 stderr（两模式都有）
  let streamed = false;

  // F-41 运行日志留档：~/.delta/logs/runs/<YYYYMMDD-HHmmss>-<sessionId8>.log
  // （cron spawn 子进程即 delta run，自动获得同一份留档；写入失败静默，不影响主流程）
  const stamp = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const runLogName = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${session.id.slice(0, 8)}.log`;
  const runLogFile = createRunFileLogger(path.join(userConfigDir(), FILES.logsDir, 'runs'), runLogName);
  runLogFile.log(`# delta run 留档  ${stamp.toISOString()}`);
  runLogFile.log(`# 任务：${task}`);
  runLogFile.log(`# 模式：${engineMode}  会话：${session.id}`);

  // F-42：压缩摘要（summarize kind）路由——命中规则时压缩摘要走小模型，用量按 aux model 归因；
  // 规则缺失 / 目标 provider 构建失败 → 回退主模型（与 subagent 路由降级语义一致），
  // 回退时以 debug 级别写入留档（AC-42-4）
  let summarizeTarget: ReturnType<ModelRouter['resolve']>;
  try {
    summarizeTarget = new ModelRouter().resolve('summarize');
  } catch {
    summarizeTarget = undefined;
  }
  if (summarizeTarget) {
    try {
      baseCtx.summarizeRoute = {
        provider: summarizeTarget.provider ? await resolveProviderFromEnv(summarizeTarget.provider) : provider,
        model: summarizeTarget.model,
      };
    } catch (e) {
      runLogFile.log(
        `[DEBUG] summarize 路由目标不可用（provider=${summarizeTarget.provider ?? '主'}，model=${summarizeTarget.model}）→ 回退主模型：${(e as Error).message}`,
      );
    }
  }
  const onEvent = (ev: AgentEvent) => {
    if (!opts.json && ev.type === 'text_delta') {
      process.stdout.write(ev.text);
      streamed = true;
      return;
    }
    if (ev.type === 'tool_call_start') {
      const args = ev.call.args ?? {};
      const brief = JSON.stringify(args);
      runLogFile.log(`⚙ ${ev.call.name}${brief.length > 160 ? ` ${brief.slice(0, 160)}…` : ` ${brief}`}`);
      console.error(`⚙ ${ev.call.name}${brief.length > 160 ? ` ${brief.slice(0, 160)}…` : ` ${brief}`}`);
    } else if (ev.type === 'tool_result') {
      runLogFile.log(`${ev.result.ok ? '✔' : '✘'} ${ev.call.name}（${ev.ms}ms）`);
      console.error(`${ev.result.ok ? '✔' : '✘'} ${ev.call.name}（${ev.ms}ms）`);
    } else if (ev.type === 'budget_alert') {
      const line = `⚠ 预算告警：${(ev.level * 100).toFixed(0)}%（token ${(ev.usedTokenPct * 100).toFixed(0)}% / 费用 ${(ev.usedCostPct * 100).toFixed(0)}%）`;
      runLogFile.log(line);
      console.error(line);
    } else if (ev.type === 'compact_done') {
      runLogFile.log(`🗜 上下文压缩：${ev.beforeTokens} → ${ev.afterTokens} tokens`);
      console.error(`🗜 上下文压缩：${ev.beforeTokens} → ${ev.afterTokens} tokens`);
    } else if (ev.type === 'error') {
      runLogFile.log(`${ev.fatal ? '✘' : '⚠'} 引擎错误：${ev.message}`);
    }
  };

  // F-25 多模态：加载图片附件（失败 → 退出码 1）
  let images: PreparedImage[] = [];
  if (opts.image?.length) {
    try {
      images = prepareImages(opts.image);
      for (const img of images) console.error(`🖼 ${describeImage(img)}`);
    } catch (e) {
      console.error(`✘ ${(e instanceof ImageError ? e.message : (e as Error).message)}`);
      process.exitCode = 1;
      return;
    }
  }

  const outcome = await runHeadless(
    { base: baseCtx, service, engine: dispatchEngine(engineMode), externalSignal: external.signal, onEvent },
    task,
    images,
  );

  // F-41：结束状态留档
  runLogFile.log(`# 结束：${outcome.status}（轮次 ${outcome.turns}，${outcome.durationMs}ms）`);
  runLogFile.log(
    `# 用量：in ${outcome.usage.inputTokens} / out ${outcome.usage.outputTokens} / $${outcome.usage.costUsd.toFixed(4)}`,
  );
  if (outcome.error) runLogFile.log(`# 错误：${outcome.error}`);
  runLogFile.log(`# 工具调用 ${outcome.toolCalls.length} 次，留档文件：${runLogFile.path}`);

  // F-33 桌面通知：长任务结束（旁路 fire-and-forget；enabled/onDone/minDurationMs 在 notifier 内判定；
  // detached spawn 使本进程退出后子进程仍可完成弹窗，CI 无桌面环境时发送失败静默）
  try {
    createDesktopNotifier({ projectRoot: cwd }).notifyDone({
      status: outcome.status,
      durationMs: outcome.durationMs,
      summary: outcome.result,
    });
  } catch {
    // 通知失败不影响结果输出
  }

  // F-24 git auto：任务成功结束后提交本会话记录在案的文件变更
  if (normalizeGitPolicy(opts.git) === 'auto' && outcome.status === 'completed') {
    try {
      const git = new GitIntegration(cwd, { mode: 'auto' });
      const out = await git.autoCommitChanges(session.id, service.changes, task);
      if (out.ok && out.hash) console.error(`⎇ 已自动提交 ${out.hash}（仅本会话变更的文件）`);
      else if (out.reason && out.reason !== 'nothing to commit for recorded paths') {
        console.error(`⎇ 自动提交跳过：${out.reason}`);
      }
    } catch {
      // 自动提交失败不影响结果
    }
  }

  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  // F-27 生命周期收尾：Stop（单次任务结束）+ SessionEnd（进程结束）
  try {
    await hooks.emit('Stop', { sessionId: session.id, projectId: project.id });
    await hooks.emit('SessionEnd', { sessionId: session.id, projectId: project.id });
  } catch {
    // 生命周期钩子失败不影响结果
  }

  await mcp.disconnectAll();
  service.close();

  // ── 输出 ──
  const payload = opts.json ? JSON.stringify(buildHeadlessReport(outcome), null, 2) : outcome.result;
  if (opts.json) {
    if (streamed) console.error(); // 分隔 stderr 进度
    console.log(payload);
  } else {
    if (streamed) console.log(); // 收尾换行
    else console.log(payload);
  }
  if (opts.output) {
    fs.writeFileSync(opts.output, payload + '\n', 'utf8');
    console.error(`✔ 结果已写入 ${opts.output}`);
  }

  process.exitCode = headlessExitCode(outcome.status);
}

/** M5 模式 → 引擎分发（与 TUI App 同构）。 */
function dispatchEngine(
  mode: EngineMode,
): (ctx: RunContext, history: ChatMessage[], input: string, images?: MessageImage[]) => AsyncIterable<AgentEvent> {
  switch (mode) {
    case 'plan-execute':
      return runPlanExecute;
    case 'multi-agent':
      return runMultiAgent;
    default:
      return runReAct;
  }
}
