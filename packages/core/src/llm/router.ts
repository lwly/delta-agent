/**
 * F-32 模型路由（PRD：按任务难度自动选模型，路由规则可配）
 * - 分类 / 提炼 / 摘要等辅助调用 → 规则指定的小模型（省成本、提速）
 * - 规划 / 执行等核心调用 → 固定走会话主模型（不在本路由器职责内）
 * - 规则持久化于 ~/.delta/models.json 的 routing 字段（keychain.ts RoutingConfig）
 * - 任何配置缺失 / 非法 / 目标 provider 不可用时，调用方一律回退会话主模型
 */
import { loadModelsFile, modelsConfigPath, type RoutingConfig, type RoutingRule } from './keychain.js';

/** 已知任务类型（未覆盖的辅助调用可按需扩展，自定义 kind 同样可配） */
export const KNOWN_TASK_KINDS = ['distill', 'classify', 'summarize', 'subagent'] as const;

export type RoutingTaskKind = (typeof KNOWN_TASK_KINDS)[number] | (string & {});

export interface RoutedTarget {
  /** 命中规则时的目标 provider id（缺省 = 会话主 Provider） */
  provider?: string;
  /** 目标模型 id */
  model: string;
  /** 命中的任务类型（便于日志/用量归因） */
  kind: string;
}

/** F-32 模型路由器：读取 routing 配置并解析任务类型 → 目标模型 */
export class ModelRouter {
  private file: string;

  constructor(file?: string) {
    this.file = file ?? modelsConfigPath();
  }

  /** 当前生效的路由配置（未配置时返回 undefined，供 CLI/Web 展示） */
  config(): RoutingConfig | undefined {
    return loadModelsFile(this.file).routing;
  }

  /**
   * 解析某任务类型的路由目标。
   * 仅当总开关开启且该 kind 配置了合法规则时返回；否则返回 undefined（调用方回退主模型）。
   */
  resolve(kind: RoutingTaskKind): RoutedTarget | undefined {
    const cfg = this.config();
    if (!cfg?.enabled) return undefined;
    const rule: RoutingRule | undefined = cfg.rules[kind];
    if (!rule || typeof rule.model !== 'string' || rule.model.trim() === '') return undefined;
    return {
      provider: typeof rule.provider === 'string' && rule.provider.trim() !== '' ? rule.provider : undefined,
      model: rule.model,
      kind,
    };
  }
}
