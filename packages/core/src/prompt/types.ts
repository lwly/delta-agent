/**
 * Prompt 组装类型定义（M3 提示词体系）
 * 设计来源：docs/prompt-design.md、docs/technical-design.md §5
 *
 * 7 层架构：L1 Identity / L2 Environment / L3 Project / L4 Tools /
 *          L5 Skills / L6 Memory / L7 Session
 * 三级覆盖：builtin < project(.delta/) < session(runtime)
 */

/** 层 id，按拼装顺序排列（F-39 新增静态层 `expert`，位于 tools 与 skills 之间） */
export type LayerId =
  | 'identity'
  | 'environment'
  | 'project'
  | 'tools'
  | 'expert'
  | 'skills'
  | 'memory'
  | 'session';

/** 层内容值：字符串 section 后者覆盖；对象深度合并；数组并集去重 */
export type LayerValue = string | Record<string, unknown> | unknown[];

/** 单层覆盖请求（project 级或 session 级） */
export type LayerOverride = LayerValue;

/** 三级覆盖集：project 来自 .delta/，session 来自运行时注入 */
export interface OverrideSet {
  project?: Partial<Record<LayerId, LayerOverride>>;
  session?: Partial<Record<LayerId, LayerOverride>>;
}

/** 组装后的单段提示词 */
export interface PromptSection {
  id: LayerId;
  title: string;
  /** 覆盖合并后的最终内容值 */
  value: LayerValue;
  /** 是否为 locked 层（identity：覆盖请求被忽略） */
  locked: boolean;
  /** 静态段（可缓存）或动态段（每轮更新） */
  kind: 'static' | 'dynamic';
  /** 估算 token 数 */
  tokens: number;
  /** 段内容来源标注（如 "expert:code-architect"；--debug-prompt 用） */
  source?: string;
}

/** 最终系统提示词 */
export interface SystemPrompt {
  /** 按 7 层顺序排列的 section 列表 */
  sections: PromptSection[];
  /** 格式化后的完整文本（<static>…</static><dynamic>…</dynamic> 结构） */
  text: string;
  /** 总 token 估算 */
  tokens: number;
  /** 指纹 = hash(层内容 + 组装器版本)，用于静态缓存 key */
  fingerprint: string;
}

/** 组装期间的覆盖告警（如 identity 层覆盖被忽略） */
export interface AssembleWarning {
  layer: LayerId;
  message: string;
}

/** Assembler 组装结果（含调试信息，供 --debug-prompt 使用） */
export interface AssembleResult extends SystemPrompt {
  warnings: AssembleWarning[];
}

/** Layer.build 的输入上下文 */export interface AssembleContext {
  /** L3：项目名 */
  projectName: string;
  /** L3：README 摘要 / 技术栈 / 目录结构（项目指令静态部分） */
  projectInstructions: string;
  /** L3：项目静态记忆（MEMORY.md / .delta/agent.md 原文），可选 */
  staticMemory?: string;
  /** L4：已注册工具（name + description + schema） */
  tools: Array<{ name: string; description: string; schema: Record<string, unknown> }>;
  /** L5：Skill 索引（name + description + 触发词） */
  skillIndex: Array<{ name: string; description: string; triggers: string[] }>;
  /** L5：已加载 Skill 的完整内容（跨轮次缓冲区，load_skill 后注入） */
  loadedSkills?: Array<{ name: string; content: string }>;
  /** L6：记忆召回结构化条目（MemoryProvider 产出，优先于 memoryRecall 文本） */
  memoryEntries?: RecalledMemory[];
  /** L6：记忆召回文本（简化接入，未提供 memoryEntries 时使用） */
  memoryRecall?: string;
  /** L7：会话动态信息 */
  session: {
    cwd: string;
    now: Date;
    model: string;
    contextWindow: number;
  };
  /**
   * F-39：专家段（缺省 = 无专家会话，ExpertLayer 返回空串）。
   * 内容已由 `experts/prompt.ts` 完成剥离/转义/截断/包装前处理。
   */
  expert?: ExpertSegmentInput;
}

/** 专家段输入（团队只带成员 4 字段，成员正文在类型层面就进不了主会话） */
export interface ExpertSegmentInput {
  name: string;
  displayName: string;
  profession: string;
  /** 已剥离 frontmatter、已转义保留标记、已按 6000 字截断的正文 */
  body: string;
  truncated: boolean;
  members?: Array<{ id: string; name: string; profession: string; role: 'lead' | 'member' }>;
}

/** 记忆召回条目（memory-design.md §5 评分召回的输出单元） */
export interface RecalledMemory {
  id: string;
  content: string;
  /** 召回评分（越高越重要，裁剪时低分先弃） */
  score: number;
  /** 来源层级：L1 项目静态 / L2 动态 / L3 会话内 */
  source: 'l1' | 'l2' | 'l3';
  /** 去重标记：与静态项目指令重复（保留静态版，仍计访问） */
  deduped?: boolean;
}

/** 单个 PromptLayer：产出该层的基础内容值 */export interface PromptLayer {
  readonly id: LayerId;
  readonly title: string;
  /** locked 层忽略覆盖请求并告警 */
  readonly locked: boolean;
  /** 静态段（identity/environment/project/tools/expert）或动态段（skills/memory/session） */
  readonly kind: 'static' | 'dynamic';
  build(ctx: AssembleContext): LayerValue;
  /** 可选：段来源标注（仅 ExpertLayer 实现，其余 7 层不实现、零影响） */
  source?(ctx: AssembleContext): string | undefined;
}
