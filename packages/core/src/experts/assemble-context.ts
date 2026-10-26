/**
 * F-39：AssembleContext 的唯一构造入口（CLI + Web 共用）
 *
 * 双端都只调用 `buildAssembleContext()`，禁止各自拼 `AssembleContext` 字面量：
 * 专家段的注入位置与内容处理（转义/截断/成员映射）因此只有一份实现。
 */
import type { AssembleContext } from '../prompt/types.js';
import { prepareExpertSegment } from './prompt.js';
import type { ExpertRecord } from './types.js';

export interface BuildAssembleContextInput {
  projectName: string;
  projectInstructions: string;
  staticMemory?: string;
  /** 工具清单（registry.definitions() 的 name/description/parameters 三字段） */
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  skillIndex: Array<{ name: string; description: string; triggers: string[] }>;
  loadedSkills?: Array<{ name: string; content: string }>;
  memoryEntries?: AssembleContext['memoryEntries'];
  memoryRecall?: string;
  session: AssembleContext['session'];
  /** 绑定专家（缺省 / null = 无专家会话） */
  expert?: ExpertRecord | null;
}

export function buildAssembleContext(input: BuildAssembleContextInput): AssembleContext {
  const ctx: AssembleContext = {
    projectName: input.projectName,
    projectInstructions: input.projectInstructions,
    ...(input.staticMemory ? { staticMemory: input.staticMemory } : {}),
    tools: input.tools.map((t) => ({ name: t.name, description: t.description, schema: t.parameters })),
    skillIndex: input.skillIndex,
    ...(input.loadedSkills ? { loadedSkills: input.loadedSkills } : {}),
    ...(input.memoryEntries ? { memoryEntries: input.memoryEntries } : {}),
    ...(input.memoryRecall ? { memoryRecall: input.memoryRecall } : {}),
    session: input.session,
  };

  if (input.expert) ctx.expert = prepareExpertSegment(input.expert);
  return ctx;
}
