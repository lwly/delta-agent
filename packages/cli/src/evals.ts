/**
 * F-28 Evals 评测体系 —— `delta evals` 子命令。
 *
 *   delta evals list                                  # 内置/自定义基准集清单
 *   delta evals run  [--provider a,b,c] ...           # 跑基准集（多 provider 自动横向对比）
 *   delta evals baseline --save | --check ...         # 回归保护：保存基线 / 对比基线
 *
 * 复用 F-29 headless 内核：每用例独立会话 + 独立预算 + 独立权限状态，
 * 判分在 core/evals 内确定性完成；报告默认 Markdown，--json 输出结构化结果。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BUILTIN_SUITE,
  BudgetManager,
  CONFIG_DIR,
  FILES,
  projectConfigDir,
  HookManager,
  McpManager,
  PermissionState,
  SessionService,
  ToolRegistry,
  compareBaseline,
  defaultModelFor,
  filterCases,
  loadBaseline,
  loadEvalSuite,
  loadMcpConfig,
  renderComparison,
  renderComparisonText,
  renderSuiteRun,
  resolveProviderFromEnv,
  runEvalSuite,
  runReAct,
  runHeadless,
  saveBaseline,
  type EvalSuite,
  type SuiteRun,
} from '@delta/core';
import { assemblePrompt } from './prompt.js';
import { normalizeMode, parseAllowTools, resolvePermissionMode } from './shared.js';

export interface EvalsOptions {
  suite?: string;
  provider?: string;
  model?: string;
  tag?: string;
  only?: string;
  json?: boolean;
  output?: string;
  maxTurns?: string;
  maxCost?: string;
  permission?: string;
  yolo?: boolean;
  allow?: string;
  save?: boolean;
  check?: boolean;
  db?: string;
}

const BASELINE_PATH = path.join(CONFIG_DIR, FILES.evalsDir, 'baseline.json');

// ── evals list ──────────────────────────────────────────────────────────────

export async function evalsListCommand(opts: EvalsOptions): Promise<void> {
  if (opts.suite) {
    const suite = loadEvalSuite(opts.suite);
    printSuite(suite, opts.suite);
    return;
  }
  printSuite(BUILTIN_SUITE, '内置');
  const local = path.join(projectConfigDir(process.cwd()), FILES.evalsDir, 'suite.json');
  if (fs.existsSync(local)) {
    console.log(`\n发现项目套件：${local}（--suite 使用）`);
    try {
      printSuite(loadEvalSuite(local), local);
    } catch (e) {
      console.error(`⚠ 项目套件加载失败：${(e as Error).message}`);
    }
  } else {
    console.log(`\n提示：把自定义套件放到 ${local}，即可被 evals list / baseline 自动发现。`);
  }
}

function printSuite(suite: EvalSuite, source: string): void {
  console.log(`\n套件：${suite.name}（${source}）${suite.description ? ` —— ${suite.description}` : ''}`);
  for (const c of suite.cases) {
    const checks = c.checks.map((k) => k.kind).join('+');
    console.log(`  ${c.id.padEnd(22)} ${c.title}  [${checks}]${c.tags?.length ? ` {${c.tags.join(',')}}` : ''}`);
  }
  console.log(`  共 ${suite.cases.length} 个用例`);
}

// ── evals run / baseline ────────────────────────────────────────────────────

export async function evalsRunCommand(opts: EvalsOptions): Promise<void> {
  if (opts.save || opts.check) {
    await evalsBaselineCommand(opts);
    return;
  }
  const runs = await runSelectors(opts);
  if (runs.length === 0) {
    process.exitCode = 1;
    return;
  }

  // ── 输出 ──
  const markdown = runs.length === 1 ? renderSuiteRun(runs[0]!) : renderComparison(runs);
  if (opts.json) {
    console.log(JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 2));
  } else {
    console.log(`\n${markdown}`);
  }
  if (opts.output) {
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    fs.writeFileSync(opts.output, (opts.json ? JSON.stringify(runs, null, 2) : markdown) + '\n', 'utf8');
    console.error(`✔ 报告已写入 ${opts.output}`);
  }

  // 有失败用例 → 退出码 1（供 CI 判定）
  if (runs.some((r) => r.summary.failed > 0)) process.exitCode = 1;
}

/** 回归保护：--save 覆写基线；--check 与基线逐用例对比，回归即退出码 1。 */
async function evalsBaselineCommand(opts: EvalsOptions): Promise<void> {
  const baselineFile = path.join(process.cwd(), BASELINE_PATH);
  if (opts.save && opts.check) {
    console.error('✘ --save 与 --check 互斥');
    process.exitCode = 1;
    return;
  }
  if (opts.save) {
    const [run] = await runSelectors({ ...opts, provider: opts.provider });
    if (!run) {
      process.exitCode = 1;
      return;
    }
    saveBaseline(baselineFile, run);
    console.log(`✔ 基线已保存：${baselineFile}（通过 ${run.summary.passed}/${run.summary.total}）`);
    return;
  }
  // --check
  if (!fs.existsSync(baselineFile)) {
    console.error(`✘ 未找到基线 ${baselineFile}，请先运行 delta evals baseline --save`);
    process.exitCode = 1;
    return;
  }
  const baseline = loadBaseline(baselineFile);
  const [run] = await runSelectors({ ...opts, provider: baseline.provider });
  if (!run) {
    process.exitCode = 1;
    return;
  }
  const cmp = compareBaseline(run, baseline);
  console.log(`\n${renderComparisonText(cmp)}`);
  if (opts.output) {
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    fs.writeFileSync(opts.output, renderSuiteRun(run) + '\n\n' + renderComparisonText(cmp) + '\n', 'utf8');
    console.error(`✔ 报告已写入 ${opts.output}`);
  }
  if (!cmp.ok) process.exitCode = 1;
}

// ── 选择器 → 多 provider 执行 ───────────────────────────────────────────────

async function runSelectors(opts: EvalsOptions): Promise<SuiteRun[]> {
  const suite = filterCases(loadEvalSuite(opts.suite), { only: opts.only, tag: opts.tag });
  if (suite.cases.length === 0) {
    console.error('✘ 过滤后没有可用用例（检查 --only / --tag）');
    return [];
  }
  const providers = (opts.provider ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = providers.length > 0 ? providers : [''];
  const runs: SuiteRun[] = [];
  for (const p of list) {
    try {
      const run = await runSuiteForProvider(suite, p, opts);
      runs.push(run);
    } catch (e) {
      console.error(`✘ provider ${p || '(auto)'} 运行失败：${(e as Error).message}`);
    }
  }
  return runs;
}

/** 单 provider 全套用例：headless 内核接线（同 `delta run` 语义，逐用例隔离）。 */
async function runSuiteForProvider(
  suite: EvalSuite,
  providerId: string,
  opts: EvalsOptions,
): Promise<SuiteRun> {
  const label = providerId || 'auto';
  console.error(`▶ 套件 ${suite.name} · provider ${label} · ${suite.cases.length} 用例`);

  const provider = await resolveProviderFromEnv(providerId || undefined);
  const cwd = process.cwd();

  // MCP 工具接入（与 run 命令同源；连接失败跳过不阻断评测）
  const registry = new ToolRegistry();
  const mcp = new McpManager();
  for (const [name, cfg] of Object.entries(loadMcpConfig(cwd))) {
    try {
      await mcp.connect(name, cfg);
      await mcp.registerInto(name, registry);
    } catch {
      // 评测环境 MCP 不稳定时降级为纯内置工具
    }
  }

  const service = new SessionService(opts.db);
  const project = service.ensureProject(cwd);
  const model = opts.model ?? process.env.DELTA_MODEL ?? defaultModelFor(provider.id);
  const engineMode = normalizeMode(undefined);
  const permissionMode = resolvePermissionMode(Boolean(opts.yolo), opts.permission);
  const maxTurns = Number(opts.maxTurns) || 30;
  const promptAssembly = await assemblePrompt({
    projectRoot: cwd,
    model,
    contextWindow: 200_000,
    tools: registry.definitions(),
  });
  const hooks = HookManager.load(cwd);

  try {
    return await runEvalSuite(
      suite,
      async (task) => {
        // 逐用例隔离：独立会话 / 预算 / 权限状态（allowlist 记忆不跨用例）
        const session = service.createSession(project.id, {
          title: `evals · ${task.slice(0, 36)}`,
          model,
          mode: engineMode,
        });
        const budget = new BudgetManager(
          opts.maxCost ? { maxCostUsd: Number(opts.maxCost) } : { maxCostUsd: 0.7 },
        );
        const perms = new PermissionState({
          mode: permissionMode,
          allowlist: parseAllowTools(opts.allow),
        });
        const outcome = await runHeadless(
          {
            base: {
              sessionId: session.id,
              projectId: project.id,
              mode: engineMode,
              model,
              systemPrompt: promptAssembly.parts.staticText,
              systemPromptParts: {
                staticText: promptAssembly.parts.staticText,
                dynamicText: promptAssembly.parts.dynamicText,
              },
              dynamicProvider: promptAssembly.refreshDynamic,
              maxTurns,
              signal: new AbortController().signal,
              provider,
              registry,
              toolContext: {
                projectRoot: cwd,
                signal: new AbortController().signal,
                sessionId: session.id,
                projectId: project.id,
                memory: service.memory,
                changes: service.changes,
                confirm: async () => ({ kind: 'allow' }),
                askUser: async () => '',
                todos: [],
                skills: promptAssembly.skills,
                permissions: perms,
                registry,
              },
              budget,
              windowTokens: 200_000,
              tasks: service.tasks,
            },
            service,
            engine: runReAct,
          },
          task,
        );
        try {
          await hooks.emit('Stop', { sessionId: session.id, projectId: project.id });
        } catch {
          // 钩子失败不影响评测
        }
        return outcome;
      },
      {
        provider: label,
        model,
        onCaseDone: (r, i, total) => {
          console.error(
            `  [${i + 1}/${total}] ${r.passed ? '✔' : '✘'} ${r.caseId}（${r.turns} 轮 · $${r.usage.costUsd.toFixed(4)}）` +
              (r.passed ? '' : ` ← ${r.failures.join('；')}`),
          );
        },
      },
    );
  } finally {
    await mcp.disconnectAll().catch(() => {});
    service.close();
  }
}
