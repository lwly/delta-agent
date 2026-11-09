import type * as http from 'node:http';
import type { SessionHub } from '../hub.js';
import type { SessionService } from '../../session/service.js';
import type { CronExecutor } from '../../cron/runner.js';
import type { Dispatcher } from '../../router/dispatcher.js';
import type { QuotaStore } from '../../quota/store.js';
import type { RunLog } from '../../logging/logger.js';
import type { TerminalManager } from '../terminal.js';
import type { BackgroundTaskManager } from '../../session/background-tasks.js';
import type { LoadedPlugin } from '../../plugins/loader.js';
import type { ExpertStore } from '../../experts/store.js';
import type { ProviderManager } from '../../llm/manager.js';
import type { BrowseDeps } from '../browse-routes.js';
import type { DetectedAgent } from '../../external/detect.js';
import type { upsertManualEntry, removeManualEntry, setExternalAgentModel, resolveAgentModels } from '../../external/detect.js';

export type JsonWriter = (res: http.ServerResponse, code: number, body: unknown) => void;
export type ErrWriter = (res: http.ServerResponse, code: number, message: string) => void;

/** createWebServer 注入子集（避免 builtin-routes ↔ http 循环依赖）。 */
export interface BuiltinHttpRouteOptions {
  cronHomeDir?: string;
  cronExecutor?: CronExecutor;
  cronStatus?: () => { running: boolean; mode: 'auto' | 'off' };
  dispatcher?: Dispatcher;
  quota?: QuotaStore;
  runLog?: RunLog;
  backgroundTasks?: BackgroundTaskManager;
  terminal?: TerminalManager;
  /** P6：serve 装配时 loadPlugins 快照（GET /api/plugins） */
  pluginsSnapshot?: LoadedPlugin[];
  /** Composer / Skills 发现目录（缺省 os.homedir()；测试注入隔离） */
  skillsHomeDir?: string;
  /** Skills/MCP 配置读写根（缺省回落 skillsHomeDir） */
  configHomeDir?: string;
  /** F-04a 设置中心 Provider（未装配则 providers / models/routing 路由不登记） */
  providers?: ProviderManager;
  /** F-55/F-56 外部 Agent 端点注入（缺省走 detect 实现） */
  externalDetect?: () => Promise<DetectedAgent[]>;
  externalRegister?: typeof upsertManualEntry;
  externalRemove?: typeof removeManualEntry;
  externalSetModel?: typeof setExternalAgentModel;
  externalModelsProbe?: typeof resolveAgentModels;
}

export interface BuiltinHttpRouteContext {
  opts: BuiltinHttpRouteOptions;
  service: SessionService;
  hub: SessionHub;
  json: JsonWriter;
  err: ErrWriter;
  /** F-39：按项目根缓存专家库（createWebServer 注入；缺省不能建带 expert 的会话） */
  expertStoreFor?: (projectRoot: string | undefined) => ExpertStore;
  /** F-39 import/create 后清空专家库缓存 */
  resetExpertStores?: () => void;
  /** F-38 browse/reveal 注入 */
  browseDeps?: BrowseDeps;
}

/** P4 已声明式登记的内置 HTTP 路由组。 */
export const BUILTIN_HTTP_ROUTE_GROUPS = [
  'cron',
  'worker-tasks',
  'sessions',
  'projects',
  'skills',
  'market',
  'mcp',
  'logs',
  'providers',
  'models',
  'sessions-stream',
  'browse',
  'experts',
  'terminal',
  'external-agents',
  'memory',
  'usage',
  'settings',
  'trash',
  'search',
  'system',
] as const;
