// F-55 外部 adapter 进程级注册表：P0 最小机制，P4 改工厂语义（多外部 agent 并发）。
// P2 detect 阶段会真正填充注册表（探测到的 CLI 按此注册）；
// 本文件只提供机制，供 hub 引擎分派与 runExternalAgent 按 ctx.model 解析。
//
// P4 并发语义（设计稿 §13）：注册表存工厂而非实例——runExternalAgent 每次 run
// 执行工厂得到独立 adapter 实例，AcpExternalAdapter / CodexExternalAdapter /
// StreamJsonExternalAdapter / ScriptedExternalAdapter 的实例状态（pending /
// pendingPermissions / lastProc / threadId 等）天然按会话隔离，两会话并行跑同一
// model 不再互踩。registerExternalAdapter 保留旧签名（包装为共享单例工厂），
// 既有内联 adapter 注册零改动。

import type { ExternalAgentAdapter } from './types.js';

/** 进程级外部 adapter 注册表：key = spec.id（cli:xxx / acp:xxx 虚拟 model id），值为工厂 */
const factories = new Map<string, () => ExternalAgentAdapter>();

/** 注册外部 adapter（同 id 覆盖，重复注册 = 版本/路径变化后的重探测）；向后兼容：包装为共享单例工厂 */
export function registerExternalAdapter(adapter: ExternalAgentAdapter): void {
  registerExternalAdapterFactory(adapter.spec.id, () => adapter);
}

/**
 * 注册外部 adapter 工厂（P4）：resolve 命中后由调用方执行工厂，每次 run 得到
 * 独立实例（并发会话实例状态天然隔离）。同 id 覆盖。
 */
export function registerExternalAdapterFactory(id: string, factory: () => ExternalAgentAdapter): void {
  factories.set(id, factory);
}

/** 按会话 model 解析 adapter 工厂：model === id 时命中；调用方执行工厂得到本 run 独立实例 */
export function resolveExternalAdapter(model: string): (() => ExternalAgentAdapter) | undefined {
  return factories.get(model);
}

/** 会话 model 是否指向外部 CLI Agent（cli:xxx / acp:xxx 虚拟 id 前缀）——hub 与 CLI 入口共用的唯一判定点 */
export function isExternalModel(model: string): boolean {
  return /^(cli|acp):/.test(model);
}
