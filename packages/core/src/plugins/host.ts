/**
 * P0 引擎注册表；内置四路由 @delta/plugin-builtin-engines（P2）在 builtins 侧载时登记。
 * 匹配：模型前缀 cli:/acp: 优先于 sessions.mode；未知 mode 落 react。
 * 工具槽在 plugins/tools.ts。路由、命令、视图、服务见 glossary §13。
 */
import type { AgentEvent, ChatMessage, MessageImage } from '@delta/shared';
import type { RunContext } from '../engine/react.js';
import { isExternalModel } from '../external/registry.js';

export type EngineId = 'react' | 'plan-execute' | 'multi-agent' | 'external' | (string & {});

export type EngineRun = (
  ctx: RunContext,
  history: ChatMessage[],
  input: string,
  images?: MessageImage[],
) => AsyncIterable<AgentEvent>;

const engines = new Map<EngineId, EngineRun>();

export function registerEngine(id: EngineId, run: EngineRun): void {
  if (engines.has(id)) throw new Error(`engine already registered: ${id}`);
  engines.set(id, run);
}

/** 已登记引擎 id（测试 / 诊断）；未知 mode 运行时仍落 react。 */
export function registeredEngineIds(): readonly EngineId[] {
  return [...engines.keys()];
}

/** 与 hub / headless / TUI 原先的四路选择同一结果。 */
export function resolveEngine(mode: string, model?: string | null): EngineRun {
  if (model && isExternalModel(model)) return engines.get('external') ?? engines.get('react')!;
  return engines.get(mode as EngineId) ?? engines.get('react')!;
}
