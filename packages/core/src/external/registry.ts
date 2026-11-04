// F-55 外部 adapter 进程级注册表：P0 最小机制。
// P2 detect 阶段会真正填充注册表（探测到的 CLI 按此注册）；
// 本文件只提供机制，供 hub 引擎分派与 runExternalAgent 按 ctx.model 解析。

import type { ExternalAgentAdapter } from './types.js';

/** 进程级外部 adapter 注册表：key = spec.id（cli:xxx / acp:xxx 虚拟 model id） */
const adapters = new Map<string, ExternalAgentAdapter>();

/** 注册外部 adapter（同 id 覆盖，重复注册 = 版本/路径变化后的重探测） */
export function registerExternalAdapter(adapter: ExternalAgentAdapter): void {
  adapters.set(adapter.spec.id, adapter);
}

/** 按会话 model 解析 adapter：model === spec.id 时命中 */
export function resolveExternalAdapter(model: string): ExternalAgentAdapter | undefined {
  return adapters.get(model);
}
