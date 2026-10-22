/**
 * SkillBuffer：跨轮次缓冲区（agent-modes-design.md §7.3）
 * - load_skill → SKILL.md 主体 + references 索引写入缓冲区，下一轮注入 L5 Skills 层
 * - 会话内持久；unload_skill 释放；会话结束清空
 * - 压缩时缓冲区内容视为保留区结构化内容参与滚动摘要（由调用方处理）
 */
import type { SkillMeta } from './loader.js';
import { estimateTextTokens } from '../context/tokens.js';

export interface LoadedSkill {
  name: string;
  layer: SkillMeta['layer'];
  /** 注入 Prompt 的完整内容（主体指令 + references 索引） */
  content: string;
  tokens: number;
  loadedAt: number;
}

export class SkillBuffer {
  private loaded = new Map<string, LoadedSkill>();

  /** 加载 Skill：已加载则返回现有内容（幂等） */
  load(skill: SkillMeta): LoadedSkill {
    const existing = this.loaded.get(skill.name);
    if (existing) return existing;

    const content = renderSkillContent(skill);
    const entry: LoadedSkill = {
      name: skill.name,
      layer: skill.layer,
      content,
      tokens: estimateTextTokens(content),
      loadedAt: Date.now(),
    };
    this.loaded.set(skill.name, entry);
    return entry;
  }

  /** 卸载：返回是否确实卸载了内容 */
  unload(name: string): boolean {
    return this.loaded.delete(name);
  }

  get(name: string): LoadedSkill | undefined {
    return this.loaded.get(name);
  }

  list(): LoadedSkill[] {
    return [...this.loaded.values()];
  }

  names(): string[] {
    return [...this.loaded.keys()];
  }

  /** 缓冲区总 token（供 L5 预算控制，默认上限 4k，超出提示 unload） */
  tokens(): number {
    return [...this.loaded.values()].reduce((sum, s) => sum + s.tokens, 0);
  }

  clear(): void {
    this.loaded.clear();
  }
}

/** 渲染 Skill 完整内容：主体指令 + references 索引（大文档按需 read_file 读取） */
export function renderSkillContent(skill: SkillMeta): string {
  const parts = [`## Skill：${skill.name}（来源：${skill.layer}）\n\n${skill.body}`];
  if (skill.references.length > 0) {
    parts.push(
      `### 参考资料（references/，按需读取）\n${skill.references.map((f) => `- ${f}`).join('\n')}`,
    );
  }
  if (skill.toolsAllowlist.length > 0) {
    parts.push(`### 允许的工具\n${skill.toolsAllowlist.map((t) => `- ${t}`).join('\n')}`);
  }
  return parts.join('\n\n');
}
