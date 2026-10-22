/**
 * 静态/动态分段组装：在 PromptAssembler 之上提供按 kind 拆分的组装能力。
 * 静态段（identity/environment/project/tools）可缓存复用；
 * 动态段（skills/memory/session）每轮重组装。
 */
import { createHash } from 'node:crypto';
import { ASSEMBLER_VERSION, PromptAssembler, renderValue } from './assembler.js';
import { createDefaultLayers } from './layers.js';
import type {
  AssembleContext,
  AssembleWarning,
  OverrideSet,
  PromptLayer,
  PromptSection,
} from './types.js';

/** 静态段缓存条目 */
export interface StaticPromptEntry {
  /** 静态段格式化文本（static 块内容） */
  text: string;
  tokens: number;
  /** 缓存 key：hash(版本 + 覆盖后各静态层值) */
  fingerprint: string;
  /** 缓存命中次数（调试用） */
  hits: number;
  createdAt: number;
}

/** 动态段组装结果 */
export interface DynamicPromptResult {
  sections: PromptSection[];
  text: string;
  tokens: number;
  /** 覆盖告警（locked 层等） */
  warnings: AssembleWarning[];
}

export interface AssembleSplitResult {
  staticEntry: StaticPromptEntry;
  dynamic: DynamicPromptResult;
  /** 完整 section 列表（static + dynamic，供调试导出） */
  sections: PromptSection[];
  warnings: AssembleWarning[];
}

export interface SplitAssemblerOptions {
  layers?: PromptLayer[];
  /** 缓存容量上限（LRU 语义，默认 32） */
  cacheSize?: number;
}

/**
 * 分段组装器：静态段走缓存（fingerprint 命中 O(1)），动态段每轮重建。
 * 缓存失效由 fingerprint 自动覆盖（prompt-design.md §2.3）：
 *   - MCP 工具注册/断开 → tools 层值变化 → key 变化 → 自动失效
 *   - .y-zero/ 配置或 MEMORY.md 变更 → project 层值变化 → 自动失效
 *   - 版本升级 → ASSEMBLER_VERSION 参与 hash → 全量失效
 */
export class SplitPromptAssembler {
  private readonly assembler: PromptAssembler;
  private readonly cache = new Map<string, StaticPromptEntry>();
  private readonly cacheSize: number;

  constructor(options: SplitAssemblerOptions = {}) {
    this.assembler = new PromptAssembler({ layers: options.layers ?? createDefaultLayers() });
    this.cacheSize = options.cacheSize ?? 32;
  }

  /** 分段组装：一次完整组装，静态段按 fingerprint 查缓存，动态段直接使用本次结果。 */
  assemble(ctx: AssembleContext, overrides: OverrideSet = {}): AssembleSplitResult {
    const result = this.assembler.assemble(ctx, overrides);
    const staticSections = result.sections.filter((s) => s.kind === 'static');
    const dynamicSections = result.sections.filter((s) => s.kind === 'dynamic');

    const key = staticFingerprint(staticSections);
    const hit = this.cache.get(key);
    const staticEntry: StaticPromptEntry = hit
      ? { ...hit, hits: hit.hits + 1 }
      : {
          text: blockText(staticSections),
          tokens: staticSections.reduce((sum, s) => sum + s.tokens, 0),
          fingerprint: key,
          hits: 0,
          createdAt: Date.now(),
        };

    if (hit) {
      // LRU touch：移到 Map 尾部
      this.cache.delete(key);
      this.cache.set(key, { ...hit, hits: hit.hits + 1 });
    } else {
      this.cache.set(key, staticEntry);
      if (this.cache.size > this.cacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }

    const dynamic: DynamicPromptResult = {
      sections: dynamicSections,
      text: blockText(dynamicSections),
      tokens: dynamicSections.reduce((sum, s) => sum + s.tokens, 0),
      warnings: result.warnings,
    };

    return {
      staticEntry,
      dynamic,
      sections: result.sections,
      warnings: result.warnings,
    };
  }

  cacheStats(): { size: number; keys: string[] } {
    return { size: this.cache.size, keys: [...this.cache.keys()] };
  }
}

/** 静态段缓存 key：组装器版本 + 覆盖后各静态层最终值 */
function staticFingerprint(sections: PromptSection[]): string {
  const hash = createHash('sha256');
  hash.update(`${ASSEMBLER_VERSION}:static`);
  for (const s of sections) {
    hash.update(`\n${s.id}:\n${renderValue(s.value)}`);
  }
  return hash.digest('hex');
}

/** 按 section 列表渲染 Markdown 块（空内容段跳过） */
function blockText(sections: PromptSection[]): string {
  return sections
    .filter((s) => renderValue(s.value).length > 0)
    .map((s) => `## ${s.title}\n\n${renderValue(s.value)}`)
    .join('\n\n');
}

/**
 * 拼装最终系统消息内容：静态 → 动态，顺序恒定。
 * 历史/本轮输入由引擎追加在其后，保证 Provider 前缀缓存可命中
 * （Anthropic cache_control / OpenAI 自动前缀缓存）。
 */
export function composeSystemPrompt(staticText: string, dynamicText: string): string {
  return [staticText, dynamicText].filter((t) => t.length > 0).join('\n\n');
}
