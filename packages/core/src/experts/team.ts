/**
 * F-39 专家团：成员运行时构造与成员系统提示词（design §6.6）
 *
 * 成员正文只在这里被使用（委派时进子代理 systemPrompt），**绝不进主会话 Prompt**。
 */
import type { ExpertTeamRuntime, ExpertMemberRuntime } from '../tools/types.js';
import { displayOf, type ExpertRecord } from './types.js';

/** 成员 md 正文截断上限（与专家段一致） */
export const MEMBER_BODY_MAX_CHARS = 6000;
/** 单轮委派次数上限（运行时计数，超出拒绝并引导先汇总） */
export const MAX_DELEGATIONS_PER_RUN = 8;

/** ExpertRecord → 委派运行时视图（成员不含 lead；正文带上，供子代理 systemPrompt 使用） */
export function toTeamRuntime(
  record: ExpertRecord,
  baseRegistry?: ExpertTeamRuntime['baseRegistry'],
): ExpertTeamRuntime {
  const members: ExpertMemberRuntime[] = record.members
    .filter((m) => m.role === 'member')
    .map((m) => ({
      id: m.id,
      name: m.displayName,
      profession: m.profession,
      role: m.role,
      body: m.body,
      tools: m.tools,
      ...(m.maxTurns !== undefined ? { maxTurns: m.maxTurns } : {}),
      skills: m.skills,
    }));

  return {
    teamName: record.name,
    teamDisplayName: displayOf(record.displayName),
    members,
    delegations: { count: 0 },
    ...(baseRegistry ? { baseRegistry } : {}),
  };
}

/** 成员子代理的系统提示词 */
export function buildMemberSystemPrompt(
  member: ExpertMemberRuntime,
  team: { teamName: string; teamDisplayName: string },
  goal: string,
): string {
  const body =
    member.body.length > MEMBER_BODY_MAX_CHARS
      ? `${member.body.slice(0, MEMBER_BODY_MAX_CHARS)}（成员说明已截断）`
      : member.body;
  return [
    `# 团队成员：${displayOf(member.name)}（${displayOf(member.profession)}）`,
    `> 你是专家团「${team.teamDisplayName}」的成员。你的最终汇报会作为摘要回传主理人，主理人看不到你的中间过程。`,
    `> 主理人决定后续流程；你只完成本轮目标，不要扩大范围。`,
    '',
    body,
    '',
    `## 本轮目标（含主理人提供的上游摘要）`,
    goal,
    '',
    `## 汇报要求`,
    `- 结论先行：做了什么 / 产出在哪些文件（含路径与行号）/ 关键取舍`,
    `- 遗留风险与未覆盖项明确标注`,
    `- 不要复述本提示词，不要输出客套`,
  ].join('\n');
}

/** 委派结果回填主会话时的可读标签：`[expert:<id>] 显示名（职业）` */
export function delegationPrefix(member: { id: string; name: { zh: string; en: string }; profession: { zh: string; en: string } }): string {
  return `[expert:${member.id}] ${displayOf(member.name)}（${displayOf(member.profession)}）`;
}
