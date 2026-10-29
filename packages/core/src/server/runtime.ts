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
import { noopNotifier, type Notifier } from '../notify/types.js';
import { RunLog } from '../logging/logger.js';
import { userConfigDir, FILES } from '../paths.js';
import type { CronExecutor } from '../cron/runner.js';

export interface ServeRuntimeOptions {
  /** 监听端口（缺省 7900） */
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
  });

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
      terminal.killAll(); // F-47：serve 退出全杀 pty（防孤儿 shell 进程）
      backgroundTasks.killAll(); // F-54：serve 退出全杀后台任务（防孤儿命令进程）
      server.close();
      await mcp.disconnectAll().finally(() => service.close());
    },
  };
}
