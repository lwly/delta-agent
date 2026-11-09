/**
 * 进程内插件激活：trusted 插件的 main 导出 activate / default(host)。
 * 路由、工具、引擎走宿主注册表；服务槽仅在 serve 装配时可选注入。
 */
import type { RouteDef } from '../server/routes.js';
import type { AgentTool } from '../tools/types.js';
import { registerEngine, type EngineId, type EngineRun } from './host.js';
import { registerTool } from './tools.js';
import type { HostService } from './services.js';
import { registerViewMeta, type ViewContributionMeta } from './view-meta.js';

export interface CommandContribution {
  name: string;
  mount(program: unknown): void;
}

export interface PluginHost {
  registerEngine(id: EngineId, run: EngineRun): void;
  registerTool(tool: AgentTool): void;
  registerRoute(route: RouteDef): void;
  registerView(meta: ViewContributionMeta): void;
  /** 仅 CLI 宿主注入 */
  registerCommand?(command: CommandContribution): void;
  /** 仅 serve 装配时注入（createServiceHost.add） */
  registerService?(service: HostService): void;
}

export interface CreatePluginHostOptions {
  routes?: RouteDef[];
  registerService?: (service: HostService) => void;
  registerCommand?: (command: CommandContribution) => void;
}

export function createPluginHost(opts: CreatePluginHostOptions = {}): PluginHost {
  const routes = opts.routes ?? [];
  return {
    registerEngine,
    registerTool,
    registerRoute(def) {
      const key = `${def.method} ${def.pattern}`;
      if (routes.some((r) => `${r.method} ${r.pattern}` === key)) {
        throw new Error(`route already registered: ${key}`);
      }
      routes.push(def);
    },
    registerView: registerViewMeta,
    ...(opts.registerService ? { registerService: opts.registerService } : {}),
    ...(opts.registerCommand ? { registerCommand: opts.registerCommand } : {}),
  };
}

export async function invokePluginActivate(
  mainHref: string,
  host: PluginHost,
): Promise<void> {
  const mod = (await import(mainHref)) as {
    activate?: (h: PluginHost) => void | Promise<void>;
    default?: (h: PluginHost) => void | Promise<void>;
  };
  const fn = mod.activate ?? mod.default;
  if (typeof fn === 'function') await fn(host);
}
