/**
 * serve 运行时组装工厂（多宿主复用）。
 *
 * 从 @delta/cli 的 `delta serve` action（原 cli/src/index.ts）下移的组装编排：
 * SessionService + ToolRegistry/MCP + SkillRuntime + HookManager + SessionHub +
 * ProviderManager + createWebServer 的统一装配点。
 *
 * 宿主形态差异全部走参数注入，core 不内置任何环境假设：
 *  - CLI serve：registerProject: true（注册 process.cwd()）、cronExecutor 传 spawn 执行器、
 *    webDistDir 走包内嵌/仓库候选链；
 *  - Electron 桌面（方案 B）：registerProject: false（项目由 UI 创建）、cronExecutor
 *    由宿主显式决定（v1 缺省不传 → Web 面板「立即运行」返回 400）、authToken 必配。
 */
import * as http from 'node:http';
import * as path from 'node:path';
import { HookManager } from '../hooks/manager.js';
import { McpManager, loadMcpConfig } from '../mcp/client.js';
import { ModelRouter } from '../llm/router.js';
import { ProviderManager } from '../llm/manager.js';
import { defaultModelFor } from '../llm/defaults.js';
import { SessionService, resolveProviderFromEnv } from '../session/service.js';
import { ToolRegistry } from '../tools/registry.js';
import { autoOnboardProject } from '../onboarding/index.js';
import { createSkillRuntime, SessionHub } from './hub.js';
import { readBudgetSetting } from './settings-store.js';
import { createWebServer } from './http.js';
import { TerminalManager } from './terminal.js';
import { BackgroundTaskManager } from '../session/background-tasks.js';
import { cancelAllExternalRuns } from '../external/lifecycle.js';
import { Dispatcher } from '../router/dispatcher.js';
import { runPreflight } from '../router/preflight.js';
import { noopNotifier, type Notifier } from '../notify/types.js';
import { RunLog } from '../logging/logger.js';
import { userConfigDir, FILES } from '../paths.js';
import type { CronExecutor } from '../cron/runner.js';

export interface ServeRuntimeOptions {
  /** 监听端口（缺省 7900；CLI serve 托管形态默认 7902 / --dev 形态 7900，桌面宿主传 0 随机避让） */
  port?: number;
  /** SQLite 路径（缺省 ~/.delta/agent.db，由 SessionService 内部决定） */
  dbPath?: string;
  /** Vue 构建产物目录（缺省仅提供 /api；候选链由宿主解析后传入） */
  webDistDir?: string;
  /**
   * 本地 server 鉴权 token（desktop 宿主必配；CLI serve 不传保持现状）。
   * 配置后所有请求需携带 `x-delta-auth` 头或 `?auth=` 参数。
   */
  authToken?: string;
  /** 注册为默认项目的根目录（CLI serve 传 process.cwd()；desktop 缺省不注册，项目由 UI 创建） */
  projectRoot?: string;
  /** 是否注册 projectRoot 为项目并触发 onboarding（CLI serve = true） */
  registerProject?: boolean;
  /**
   * F-22 cron 执行器（Web 面板「立即运行」）。**无缺省实现**：必须由宿主显式传入；
   * 不传则「立即运行」返回 400（与 ServeOptions.cronExecutor 缺省语义一致）。
   */
  cronExecutor?: CronExecutor;
  /** 桌面通知（F-33）；缺省 no-op */
  notify?: Notifier;
  /** 信息日志（缺省 console.log） */
  log?: (line: string) => void;
  /** 警告/错误日志（缺省 console.error） */
  logError?: (line: string) => void;
  /** F-22 cron.json 存储目录（缺省用户主目录；透传 createWebServer） */
  cronHomeDir?: string;
  /**
   * F-41 运行日志（缺省自建：落盘 `~/.delta/logs/serve-YYYYMMDD.log`）。
   * 测试 / 桌面宿主可注入隔离目录的实例；不落盘场景传 `new RunLog()`。
   */
  runLog?: RunLog;
}

export interface ServeRuntime {
  /** 实际监听端口 */
  port: number;
  server: http.Server;
  /** 停止服务：关 server → 断 MCP → 关 SQLite（幂等） */
  dispose(): Promise<void>;
}

/**
 * 组装并启动 serve 运行时。解析完成（server 已 listen）后 resolve。
 */
export async function createServeRuntime(opts: ServeRuntimeOptions = {}): Promise<ServeRuntime> {
  // F-41 运行日志：缺省落盘 ~/.delta/logs/serve-YYYYMMDD.log（构造时清理过期文件）
  const runLog = opts.runLog ?? new RunLog({ dir: path.join(userConfigDir(), FILES.logsDir) });
  // log/logError 升级为 tee：console 照旧 + 落盘（MCP/onboarding 等既有调用点零改动即获得留盘）
  const log = (line: string): void => {
    runLog.append('info', 'serve', line);
    (opts.log ?? ((l: string) => console.log(l)))(line);
  };
  const logError = (line: string): void => {
    runLog.append('error', 'serve', line);
    (opts.logError ?? ((l: string) => console.error(l)))(line);
  };
  const projectRoot = opts.projectRoot;

  const service = new SessionService(opts.dbPath);
  const registry = new ToolRegistry();
  const mcp = new McpManager();
  const mcpConfig = loadMcpConfig(projectRoot);
  for (const [name, cfg] of Object.entries(mcpConfig)) {
    try {
      await mcp.connect(name, cfg);
      await mcp.registerInto(name, registry);
      log(`✔ MCP ${name}：已接入`);
    } catch (e) {
      logError(`✘ MCP ${name} 连接失败（已跳过）：${(e as Error).message}`);
    }
  }

  // 默认项目注册（仅 CLI 形态；desktop 由 UI 通过 POST /api/projects 创建）
  if (opts.registerProject && projectRoot) {
    const project = service.ensureProject(projectRoot);
    // F-34 项目 onboarding：新注册项目后台自动扫描生成静态记忆草案（fire-and-forget，失败不影响服务）
    if (project.created) {
      void (async () => {
        try {
          const onboardingProvider = await resolveProviderFromEnv(undefined);
          const r = await autoOnboardProject({
            projectRoot,
            provider: onboardingProvider,
            model: process.env.DELTA_MODEL || defaultModelFor(onboardingProvider.id),
          });
          if (r && !r.skipped) {
            log(`✔ onboarding 草案已生成：${r.agentMdDraftPath}（用 \`delta onboarding confirm\` 采纳）`);
          }
        } catch {
          logError('⚠ onboarding 扫描失败（可稍后手动运行 `delta onboarding run`）');
        }
      })();
    }
  }

  const skillRoot = projectRoot ?? process.cwd();
  const skills = await createSkillRuntime(skillRoot);
  // F-27 Hook 系统：加载用户级 + 项目级 hooks.json（工具钩子 + 生命周期）
  const hooks = HookManager.load(skillRoot, undefined, (o) => {
    if (!o.ok) logError(`⚠ hook ${o.hook.event}(${o.hook.command}) 异常：${o.reason ?? o.stderr.trim().slice(0, 200)}`);
  });

  // F-54 会话内后台任务（hub 与 http 共用同一实例；dispose 全杀防孤儿进程）
  const backgroundTasks = new BackgroundTaskManager();

  // ── F-58 调度层装配（design-f58 §12/§13）──────────────────────────────────
  // Worker 会话事件时钟（watchdog L2c 判据数据源）：订阅 hub 事件流记录每个 Worker
  // 会话最近一次事件时间（hub 不 import router/，靠运行时注入耦合）；运行结束清理。
  const workerEventClock = new Map<string, number>();
  const workerEventUnsubs = new Map<string, () => void>();
  // dispatcher 在 hub 之后装配（deps 互引），闭包延迟解析
  let dispatcher: Dispatcher | undefined;

  const hub = new SessionHub({
    service,
    registry,
    resolveProvider: () => resolveProviderFromEnv(undefined), // env → 存储配置，设置页修改后即时生效
    // 会话预算：每轮运行即时读取 settings.json（设置页修改后下一轮生效）
    resolveBudgetConfig: () => readBudgetSetting(),
    // F-32 模型路由：路由规则每次运行即时读取（settings 修改后生效）；目标 provider 走同一解析链
    modelRouter: new ModelRouter(),
    resolveProviderById: (id) => resolveProviderFromEnv(id),
    skills,
    hooks,
    // F-33 桌面通知：任务结束 / 确认卡出现时系统级通知（旁路 fire-and-forget）
    notify: opts.notify ?? noopNotifier,
    // F-41 运行日志：hub 埋点（任务开始/工具调用/完成/异常）
    runLog,
    // F-54 会话内后台任务：工具层（run_in_background/task_output）与 HTTP 端点共用同一实例
    backgroundTasks: backgroundTasks,
    // F-58（T3 接缝）：运行结束透传给 Dispatcher（收敛主路径，§13）
    onRunFinished: (sessionId, outcome) => {
      workerEventClock.delete(sessionId);
      workerEventUnsubs.get(sessionId)?.();
      workerEventUnsubs.delete(sessionId);
      dispatcher?.onRunFinished(sessionId, outcome);
    },
  });

  dispatcher = new Dispatcher({
    workerTasks: service.workerTasks,
    inbox: service.inbox,
    // hub.send 全链路复用（阻塞到整轮结束；Dispatcher 不 await，运行结果经 onRunFinished 收敛）
    send: (sessionId, input) => hub.send(sessionId, input),
    // 纯读运行态（不触发 zombieReap）——本层唯一存活判定来源（D15）
    peekRunning: (sessionId) => hub.peekRunning(sessionId),
    // ⚠️ 契约要求注入但 Dispatcher/watchdog 禁止调用（isRunning 带 zombieReap 副作用，§9.3）
    isRunning: (sessionId) => hub.isRunning(sessionId),
    abort: (sessionId) => {
      hub.abort(sessionId);
    },
    // 派单前置门禁（真实探测；测试侧不经过本装配，单测注入 fake）
    preflight: (task) => runPreflight(task),
    // Worker 会话创建（service 写死 kind='worker'，§7.5）；同时挂上事件时钟订阅
    createWorkerSession: (projectId, o) => {
      const s = service.createWorkerSession(projectId, o);
      workerEventUnsubs.set(
        s.id,
        hub.subscribe(s.id, () => {
          workerEventClock.set(s.id, Date.now());
        }),
      );
      return s;
    },
    // 内置 Worker model 推导第一优先：Router 会话当前 model（§7.5）
    getRouterModel: (routerSessionId) => service.getSession(routerSessionId)?.model ?? null,
    // done 收敛摘要：取 Worker 会话最后一条非空 assistant 消息（≤400 字，Dispatcher 再截断）
    getResultSummary: (workerSessionId) => {
      try {
        const msgs = service.getHistory(workerSessionId);
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]!;
          if (m.role === 'assistant' && m.content.trim()) return m.content.trim().slice(0, 400);
        }
        return null;
      } catch {
        return null; // 会话历史读取失败不阻塞收敛（摘要尽力而为）
      }
    },
    // 看门狗判据（§9）：L2a 文件变更 + work_root、L2c 事件时钟（Worker 订阅流）
    watchdog: {
      listFileChanges: (sessionId) => service.changes.list(sessionId).map((c) => ({ path: c.path })),
      getWorkRoot: (sessionId) => hub.resolveSessionWorkRoot(sessionId) ?? null,
      lastEventAt: (sessionId) => workerEventClock.get(sessionId) ?? null,
    },
  });
  // 启动收敛（§18-1）：重启后 running/preflight 且进程已不在的行标 failed(runtime)
  dispatcher.bootstrap();
  // 60s tick（§9/§10.1）：派发泵补槽 → 看门狗 L1/L2 → 逐 Router 播报；unref 不阻止进程退出
  const dispatchTimer = setInterval(() => {
    void dispatcher?.tick().catch(() => undefined);
  }, 60_000);
  dispatchTimer.unref?.();

  const providers = new ProviderManager(); // 设置中心共用同一存储（~/.delta/models.json）
  // F-47 Web 内置终端：node-pty 为 optionalDependencies——缺失/不可用时 status 端点明确降级
  const terminal = new TerminalManager({
    resolveWorkRoot: (sessionId) => hub.resolveSessionWorkRoot(sessionId),
  });
  const port = opts.port ?? 7900;
  const server = createWebServer({
    service,
    hub,
    port,
    ...(opts.webDistDir !== undefined ? { webDistDir: opts.webDistDir } : {}),
    providers,
    ...(opts.cronExecutor !== undefined ? { cronExecutor: opts.cronExecutor } : {}),
    ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {}),
    ...(opts.cronHomeDir !== undefined ? { cronHomeDir: opts.cronHomeDir } : {}),
    runLog, // F-41：/api/logs 端点 + cron 立即运行调度行落盘
    terminal, // F-47：/api/terminal/* + /ws/terminal
    backgroundTasks, // F-54：/api/sessions/:id/background-tasks
    dispatcher, // F-58：6 个调度端点（缺省时端点 501）
  });

  let disposed = false;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  // port 传 0（桌面宿主用临时端口避让）时回读实际端口
  const addr = server.address();
  const actualPort = addr && typeof addr === 'object' ? addr.port : port;

  return {
    port: actualPort,
    server,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      clearInterval(dispatchTimer); // F-58：先停 60s tick，不再派发/播报
      // 先停 accepting（server.close 立即返回、等待存量连接收尾）：全杀子进程的
      // 数百 ms 窗口内不再接受新的运行，避免新外部 run 不在全杀快照而成孤儿
      server.close();
      terminal.killAll(); // F-47：serve 退出全杀 pty（防孤儿 shell 进程）
      backgroundTasks.killAll(); // F-54：serve 退出全杀后台任务（防孤儿命令进程）
      // F-58：dispose 不留孤儿任务——abort 所有运行中 Worker 会话，running/preflight
      // 行收敛 failed(runtime)（failOrphaned 带 WHERE status IN 守卫，若 onRunFinished
      // 已按 aborted 先收敛则此处自动让位，不二次改写）
      for (const status of ['running', 'preflight'] as const) {
        for (const task of service.workerTasks.list({ status })) {
          if (task.worker_session_id) hub.abort(task.worker_session_id);
          service.workerTasks.failOrphaned(task.id, 'runtime');
        }
      }
      // F-55 AC-55-5：serve 退出全杀运行中的外部 agent 子进程（防孤儿 CLI 进程；
      // 与 backgroundTasks.killAll 同一 dispose 收尾语义，内部单项容错不阻塞其余步骤）
      await cancelAllExternalRuns();
      await mcp.disconnectAll().finally(() => service.close());
    },
  };
}
