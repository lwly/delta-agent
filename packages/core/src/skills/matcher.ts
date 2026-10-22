/**
 * Skill 匹配评分（agent-modes-design.md §7.4，自动触发用）
 *
 * 评分 = 精确匹配（name/triggers 完全命中 +10000）
 *      + 名称命中 ×12
 *      + 标签（triggers）命中 ×6
 *      + 描述命中 ×2
 *
 * 中文滑动窗口分词：窗口 2/3/4 n-gram 去重；英文按词切分。
 * 分词器同时服务记忆召回（memory-design.md §5 词汇覆盖率）。
 */
import type { SkillMeta } from './loader.js';

/** Top-1 建议阈值（默认 5000）：达到则提示用户"检测到可用技能，是否加载？" */
export const MATCH_THRESHOLD = 5000;

const CJK_RE = /[\u3200-\u9FFF\uF900-\uFAFF]/;

/**
 * 查询分词：英文/数字按词；中文连续段做窗口 2/3/4 的 n-gram 去重。
 * "数据库性能优化" → 数据库/性能/优化/数据库性能/性能优化/数据库性能优化…
 */
export function tokenize(query: string): string[] {
  const tokens = new Set<string>();
  for (const word of query.match(/[a-zA-Z0-9_+-]+/g) ?? []) {
    tokens.add(word.toLowerCase());
  }
  for (const run of query.match(/[\u3200-\u9FFF\uF900-\uFAFF]+/g) ?? []) {
    for (const n of [2, 3, 4]) {
      for (let i = 0; i + n <= run.length; i++) {
        tokens.add(run.slice(i, i + n));
      }
    }
  }
  return [...tokens];
}

export interface SkillScore {
  skill: SkillMeta;
  score: number;
  /** 命中明细（调试用） */
  breakdown: { exact: number; name: number; triggers: number; description: number };
}

/** 对单个 Skill 评分 */
export function scoreSkill(skill: SkillMeta, query: string, tokens = tokenize(query)): SkillScore {
  const normalizedQuery = query.trim().toLowerCase();
  let exact = 0;
  let nameHits = 0;
  let triggerHits = 0;
  let descHits = 0;

  // 精确匹配：查询整体等于 name 或某个 trigger
  if (normalizedQuery === skill.name.toLowerCase() || skill.triggers.some((t) => t.toLowerCase() === normalizedQuery)) {
    exact = 10_000;
  }

  const nameLower = skill.name.toLowerCase();
  const descLower = skill.description.toLowerCase();
  const triggersLower = skill.triggers.map((t) => t.toLowerCase());

  for (const token of tokens) {
    if (nameLower.includes(token)) nameHits += 12;
    if (triggersLower.some((t) => t.includes(token))) triggerHits += 6;
    if (descLower.includes(token)) descHits += 2;
  }

  return {
    skill,
    score: exact + nameHits + triggerHits + descHits,
    breakdown: { exact, name: nameHits, triggers: triggerHits, description: descHits },
  };
}

/** 对全部 Skills 评分并降序排名 */
export function matchSkills(skills: SkillMeta[], query: string): SkillScore[] {
  const tokens = tokenize(query);
  return skills
    .map((s) => scoreSkill(s, query, tokens))
    .sort((a, b) => b.score - a.score);
}

/**
 * 自动触发判定：Top-1 分数 ≥ MATCH_THRESHOLD 才建议加载；
 * 否则不打扰（模型仍可通过索引自行调用 load_skill）。
 */
export function suggestSkill(skills: SkillMeta[], query: string): SkillScore | undefined {
  const top = matchSkills(skills, query)[0];
  return top && top.score >= MATCH_THRESHOLD ? top : undefined;
}
