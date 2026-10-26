/**
 * F-39 专家段内容处理（纯函数）
 *
 * 职责分离：本文件负责「内容处理」（剥离由 parser 完成 → 转义 → 截断 → 只映射 4 个成员字段）；
 * `prompt/layers.ts` 的 ExpertLayer 只做拼接，不含任何业务规则。
 */
import { escapeReservedMarkers } from './parser.js';
import { EXPERT_BODY_MAX_CHARS, type ExpertRecord } from './types.js';
import type { ExpertSegmentInput } from '../prompt/types.js';

export const TRUNCATE_SUFFIX = '（专家说明已截断）';
/** 团队专家段成员清单上限（行） */
export const EXPERT_MEMBERS_LINE_MAX = 6;

export { escapeReservedMarkers, EXPERT_BODY_MAX_CHARS };

/**
 * 把 ExpertRecord 转成 Prompt 段的输入。
 * 成员只映射 id/name/profession/role 四个字段——成员 md 正文在类型层面就带不出去。
 */
export function prepareExpertSegment(record: ExpertRecord): ExpertSegmentInput {
  const raw = record.agent.body;
  const escaped = escapeReservedMarkers(raw);
  const truncated = escaped.length > EXPERT_BODY_MAX_CHARS;
  const body = truncated ? escaped.slice(0, EXPERT_BODY_MAX_CHARS) + TRUNCATE_SUFFIX : escaped;

  return {
    name: record.name,
    displayName: record.displayName.zh || record.displayName.en,
    profession: record.profession.zh || record.profession.en,
    body,
    truncated,
    ...(record.members.length > 0
      ? {
          members: record.members.slice(0, EXPERT_MEMBERS_LINE_MAX).map((m) => ({
            id: m.id,
            name: m.displayName.zh || m.displayName.en,
            profession: m.profession.zh || m.profession.en,
            role: m.role,
          })),
        }
      : {}),
  };
}
