/**
 * PromptAssembler：7 层组装 + 三级覆盖 + 格式化
 * - 层顺序恒定：identity → environment → project → tools → skills → memory → session
 * - 静态段在前、动态段在后，保证 Provider 前缀缓存可命中（prompt-design.md §2.2）
 * - fingerprint = sha256(ASSEMBLER_VERSION + 各层最终值)，供静态缓存 key（M3-2 接入缓存）
 */
import { createHash } from 'node:crypto';
import { applyOverrides } from './merge.js';
import { createDefaultLayers } from './layers.js';
import type {
  AssembleContext,
  AssembleResult,
  LayerValue,
  OverrideSet,
  PromptLayer,
  PromptSection,
} from './types.js';
import { estimateTextTokens } from '../context/tokens.js';

export const ASSEMBLER_VERSION = 'm3.1';

export interface PromptAssemblerOptions {
  /** 自定义层列表（默认 7 层）；用于测试注入 */
  layers?: PromptLayer[];
}

export class PromptAssembler {
  private readonly layers: PromptLayer[];

  constructor(options: PromptAssemblerOptions = {}) {
    this.layers = options.layers ?? createDefaultLayers();
  }

  /**
   * 组装完整系统提示词。
   * @param ctx 层构建输入
   * @param overrides 三级覆盖集（project < session）
   */
  assemble(ctx: AssembleContext, overrides: OverrideSet = {}): AssembleResult {
    const warnings: AssembleResult['warnings'] = [];
    const sections: PromptSection[] = [];

    for (const layer of this.layers) {
      const base = layer.build(ctx);
      const { value, warnings: layerWarnings } = applyOverrides(layer, base, overrides);
      warnings.push(...layerWarnings);
      sections.push({
        id: layer.id,
        title: layer.title,
        value,
        locked: layer.locked,
        kind: layer.kind,
        tokens: estimateTextTokens(renderValue(value)),
      });
    }

    const text = formatPrompt(sections);
    const fingerprint = this.fingerprint(sections);
    return {
      sections,
      text,
      tokens: sections.reduce((sum, s) => sum + s.tokens, 0),
      fingerprint,
      warnings,
    };
  }

  /** 缓存指纹：组装器版本 + 各层最终值的稳定哈希 */
  fingerprint(sections: PromptSection[]): string {
    const hash = createHash('sha256');
    hash.update(ASSEMBLER_VERSION);
    for (const s of sections) {
      hash.update(`\n${s.id}:\n${renderValue(s.value)}`);
    }
    return hash.digest('hex');
  }
}

/** 值 → 文本渲染：字符串原样；对象/数组转 Markdown 列表 */
export function renderValue(value: LayerValue): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  }
  return Object.entries(value)
    .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

/**
 * 格式化最终 Prompt：静态段在前（<static>），动态段在后（<dynamic>）。
 * 结构恒定不变，保证缓存前缀稳定。
 */
export function formatPrompt(sections: PromptSection[]): string {
  const block = (kind: 'static' | 'dynamic') =>
    sections
      .filter((s) => s.kind === kind && renderValue(s.value).length > 0)
      .map((s) => `## ${s.title}\n\n${renderValue(s.value)}`)
      .join('\n\n');

  const staticBlock = block('static');
  const dynamicBlock = block('dynamic');
  return `<static>\n\n${staticBlock}\n\n</static>\n\n<dynamic>\n\n${dynamicBlock}\n\n</dynamic>`;
}
