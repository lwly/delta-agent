/**
 * PromptBuilder：去重 · 裁剪 · 预算控制（prompt-design.md §4）
 *
 * 去重：记忆条目内容与静态项目指令重复 → 保留静态版，记忆条标记 deduped（仍计访问）
 * 裁剪优先级（预算不足时从低到高保，先弃前者）：
 *   Skill 索引描述 < 低分记忆 < 高分记忆 < 动态环境(session) < 静态核心段（永不裁剪）
 * token 预算分配（200k 窗口示例）见 DEFAULT_PROMPT_BUDGET。
 */
import type { AssembleSplitResult } from './split-assembler.js';
import type { LayerId, PromptSection, RecalledMemory } from './types.js';

/** 系统 prompt 各段 token 预算（prompt-design.md §4 表格） */
export interface PromptBudget {
  /** 静态段上限（人格+准则+项目+工具 schema），超出仅告警不裁剪 */
  staticTokens: number;
  /** 动态环境段上限（时间/模型/环境） */
  dynamicTokens: number;
  /** 记忆 Top-K 上限 */
  memoryTokens: number;
  /** Skill 已加载缓冲区上限（M3-4 接入） */
  skillLoadedTokens: number;
  /** 系统与回复安全预留 */
  reserveTokens: number;
}

export const DEFAULT_PROMPT_BUDGET: PromptBudget = {
  staticTokens: 8_000,
  dynamicTokens: 2_000,
  memoryTokens: 1_500,
  skillLoadedTokens: 4_000,
  reserveTokens: 1_024,
};

/** 裁剪动作日志（供 --debug-prompt 与 prompt_sections 日志） */
export interface TrimAction {
  section: LayerId | 'memory-entry';
  /** dropped：整段或单条被裁剪；kept：保留；over-budget：静态段超预算告警 */
  action: 'dropped' | 'kept' | 'over-budget';
  detail?: string;
  tokens?: number;
}

export interface FinalPrompt {
  /** 静态段文本（进 systemPromptParts.staticText） */
  staticText: string;
  /** 动态段文本（进 systemPromptParts.dynamicText） */
  dynamicText: string;
  tokens: number;
  trimLog: TrimAction[];
  /** 被去重的记忆条目 id（仍计访问，由调用方回写） */
  dedupedMemoryIds: string[];
}

export interface BuilderOptions {
  budget?: Partial<PromptBudget>;
  /** 是否执行记忆去重（默认开） */
  dedupe?: boolean;
}

export class PromptBuilder {
  private readonly budget: PromptBudget;
  private readonly dedupe: boolean;

  constructor(options: BuilderOptions = {}) {
    this.budget = { ...DEFAULT_PROMPT_BUDGET, ...options.budget };
    this.dedupe = options.dedupe ?? true;
  }

  /**
   * 从分段组装结果构建最终系统提示词。
   * 静态段永不裁剪（超预算仅告警）；动态段按优先级从低到高裁剪至预算内。
   * @param opts.memoryEntries 结构化记忆条目（来自 MemoryProvider.recall），
   *   提供时按 score 参与裁剪与去重；缺省时从 memory section 文本按行降级解析（score=0）
   */
  build(split: AssembleSplitResult, opts: { memoryEntries?: RecalledMemory[] } = {}): FinalPrompt {
    const trimLog: TrimAction[] = [];
    const staticEntry = split.staticEntry;

    // ── 静态段：永不裁剪，超预算告警 ──
    if (staticEntry.tokens > this.budget.staticTokens) {
      trimLog.push({
        section: 'project',
        action: 'over-budget',
        detail: `static ${staticEntry.tokens} > budget ${this.budget.staticTokens}（静态核心段永不裁剪）`,
        tokens: staticEntry.tokens,
      });
    }

    // ── 记忆去重：与静态项目指令重复的条目标记 deduped ──
    const memorySection = split.dynamic.sections.find((s) => s.id === 'memory');
    let memoryEntries =
      opts.memoryEntries ?? this.extractMemoryEntries(memorySection);
    const dedupedMemoryIds: string[] = [];
    if (this.dedupe && memoryEntries.length > 0) {
      const staticHaystack = staticEntry.text;
      for (const m of memoryEntries) {
        if (isDuplicateOfStatic(m.content, staticHaystack)) {
          m.deduped = true;
          dedupedMemoryIds.push(m.id);
        }
      }
    }

    // ── 动态段裁剪：预算 = dynamic + memory（记忆条可单独裁剪）──
    const dynamicBudget = this.budget.dynamicTokens;
    const memoryBudget = this.budget.memoryTokens;
    const others = split.dynamic.sections.filter((s) => s.id !== 'memory');
    const othersTokens = others.reduce((sum, s) => sum + s.tokens, 0);

    // 优先级从低到高：skills 索引 → 低分记忆 → 高分记忆 → session（环境）
    // 1) skills 索引段可整段裁剪
    let keptSections: PromptSection[] = [...others];
    const skillsSection = keptSections.find((s) => s.id === 'skills');
    if (skillsSection && othersTokens > dynamicBudget) {
      keptSections = keptSections.filter((s) => s.id !== 'skills');
      trimLog.push({
        section: 'skills',
        action: 'dropped',
        detail: 'skills 索引超动态预算，整段裁剪（模型仍可通过 load_skill 按需加载）',
        tokens: skillsSection.tokens,
      });
    }

    // 2) 记忆条目：低分先弃，直到 memory 预算内
    const keptAfterSkills = keptSections.filter((s) => s.id !== 'session');
    const keptAfterSkillsTokens = keptAfterSkills.reduce((sum, s) => sum + s.tokens, 0);
    const sessionSection = others.find((s) => s.id === 'session');
    const baseTokens = keptAfterSkillsTokens + (sessionSection?.tokens ?? 0);

    memoryEntries = trimMemoryEntries(memoryEntries, memoryBudget, baseTokens, trimLog);

    // 3) session 环境段：最后保（若仍超预算，仅告警——时间/模型信息不可缺）
    const finalTokens =
      keptAfterSkillsTokens
      + (sessionSection?.tokens ?? 0)
      + memoryEntries.reduce((sum, m) => sum + estimateLineTokens(m), 0);
    if (finalTokens > dynamicBudget + memoryBudget) {
      trimLog.push({
        section: 'session',
        action: 'over-budget',
        detail: `动态段 ${finalTokens} > 预算 ${dynamicBudget + memoryBudget}（环境段不可裁剪）`,
        tokens: sessionSection?.tokens,
      });
    }

    const dynamicText = renderDynamicText(keptSections, memoryEntries, sessionSection);
    return {
      staticText: staticEntry.text,
      dynamicText,
      tokens: staticEntry.tokens + estimateText(dynamicText),
      trimLog,
      dedupedMemoryIds,
    };
  }

  /** 从 memory section 降级提取条目（纯文本按行拆，score=0 裁剪时先弃） */
  private extractMemoryEntries(memorySection: PromptSection | undefined): RecalledMemory[] {
    if (!memorySection || typeof memorySection.value !== 'string') return [];
    return memorySection.value
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, i) => ({
        id: `mem_line_${i}`,
        content: line.replace(/^- \[..\] /, '').replace(/^- /, ''),
        score: 0,
        source: 'l3' as const,
      }));
  }
}

/**
 * 记忆条目裁剪：按 score 升序（低分先）逐条弃置，直到 (剩余条目 tokens + base) ≤ budget。
 * 全弃后仍超预算则保留空段（memory 为可缺段）。
 */
function trimMemoryEntries(
  entries: RecalledMemory[],
  budget: number,
  baseTokens: number,
  trimLog: TrimAction[],
): RecalledMemory[] {
  const sorted = [...entries].sort((a, b) => a.score - b.score);
  let total = baseTokens + entries.reduce((sum, m) => sum + estimateLineTokens(m), 0);
  const dropped: RecalledMemory[] = [];
  while (total > budget && sorted.length > 0) {
    const m = sorted.shift()!;
    total -= estimateLineTokens(m);
    dropped.push(m);
  }
  for (const m of dropped) {
    trimLog.push({ section: 'memory-entry', action: 'dropped', detail: m.id, tokens: estimateLineTokens(m) });
  }
  // 返回保持 score 降序（高分在前，渲染顺序稳定）
  return [...sorted].sort((a, b) => b.score - a.score);
}

/** 渲染裁剪后的动态段文本：保持 skills/memory/session 恒定顺序 */
function renderDynamicText(
  keptSections: PromptSection[],
  memoryEntries: RecalledMemory[],
  sessionSection: PromptSection | undefined,
): string {
  const parts: string[] = [];
  const renderSection = (s: PromptSection) => {
    const text = sectionText(s);
    if (text.length > 0) parts.push(`## ${s.title}\n\n${text}`);
  };
  for (const s of keptSections) renderSection(s);
  if (memoryEntries.length > 0) {
    parts.push(
      `## 相关记忆\n\n${memoryEntries
        .map((m) => {
          const tag = m.deduped ? '（与项目指令重复，以静态版为准）' : '';
          return `- [${m.source}] ${m.content}${tag}`;
        })
        .join('\n')}`,
    );
  }
  if (sessionSection) renderSection(sessionSection);
  return parts.join('\n\n');
}

function sectionText(s: PromptSection): string {
  const v = s.value;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((i) => `- ${typeof i === 'string' ? i : JSON.stringify(i)}`).join('\n');
  return Object.entries(v).map(([k, val]) => `- ${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`).join('\n');
}

/** 去重判定：记忆内容（≥12 字符）作为整行/子串出现在静态文本中 */
function isDuplicateOfStatic(content: string, staticText: string): boolean {
  const normalized = content.trim().replace(/^- \[..\] /, '').replace(/^- /, '');
  if (normalized.length < 12) return false;
  return staticText.includes(normalized);
}

function estimateLineTokens(m: RecalledMemory): number {
  return estimateText(m.content) + 8; // 行开销（标记 + 序号）
}

function estimateText(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3200-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 3);
}
