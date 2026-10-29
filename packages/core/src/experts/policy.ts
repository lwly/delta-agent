/**
 * F-39 工具白名单与预置技能（design §6.4）
 *
 * 白名单口径（D3）：
 *   名称级交集 = 专家白名单 ∩ 注册表实际工具（2 处）
 *   执行级否决 = PermissionState（第 3 处，既有实现；不参与名称裁剪）
 * 对外效果仍是「任何一处禁止即不可用」，且 yolo 也放不开角色边界。
 */
import { RestrictedRegistry, type RegistryLike } from '../engine/roles.js';
import { estimateTextTokens } from '../context/tokens.js';
import type { SkillRuntime } from '../tools/types.js';

/** 内置工具数（= ToolRegistry.registerBuiltins 的工具条数；与 TOOL_CAPABILITY 键数一致，见单测） */
export const BUILTIN_TOOL_COUNT = 17;

/** 单会话预置技能上限（个）与累计 token 上限 */
export const EXPERT_SKILLS_MAX_COUNT = 3;
export const EXPERT_SKILLS_MAX_TOKENS = 4096;

export interface ToolAllowResolution {
  /** null = 不收窄（专家未声明 tools，或声明的工具全部不存在） */
  allow: Set<string> | null;
  /** 声明了但注册表里没有的工具名（忽略 + 警示，不报错） */
  unknown: string[];
  /** 最终生效数量（详情页「限制 N/M」） */
  restrictedCount: number;
  totalCount: number;
}

/**
 * 名称级交集（D3 的第 1、2 处）。
 * - `tools` 缺省 / 空数组 → null（PRD：空 = 不收窄）
 * - 声明了但全部不存在 → 也回退为不收窄（否则模型零工具、专家直接废掉且用户看不出原因）
 */
export function resolveToolAllow(
  tools: readonly string[] | null | undefined,
  availableNames: readonly string[],
): ToolAllowResolution {
  const totalCount = availableNames.length;
  if (!tools || tools.length === 0) {
    return { allow: null, unknown: [], restrictedCount: totalCount, totalCount };
  }
  const available = new Set(availableNames);
  const unknown = tools.filter((t) => !available.has(t));
  const allow = new Set(tools.filter((t) => available.has(t)));
  if (allow.size === 0) {
    return { allow: null, unknown, restrictedCount: totalCount, totalCount };
  }
  return { allow, unknown, restrictedCount: allow.size, totalCount };
}

/**
 * 把注册表收窄为角色视图（allow === null 时返回原对象，零开销）。
 * 收窄点唯一：会话装配层（hub.send / cli start），引擎与工具内部不得再收窄父视图。
 */
export function restrictRegistry<T extends RegistryLike>(
  base: T,
  allow: Set<string> | null,
): T | RestrictedRegistry {
  return allow === null ? base : new RestrictedRegistry(base, allow);
}

/**
 * 预置技能装载：≤3 个且累计 ≤4k tokens；不存在 / 超限 → 跳过 + 警示（不抛错）。
 */
export async function seedExpertSkills(
  skills: SkillRuntime,
  names: readonly string[],
  opts: { maxCount?: number; maxTokens?: number } = {},
): Promise<{ loaded: string[]; warnings: string[] }> {
  const maxCount = opts.maxCount ?? EXPERT_SKILLS_MAX_COUNT;
  const maxTokens = opts.maxTokens ?? EXPERT_SKILLS_MAX_TOKENS;
  const loaded: string[] = [];
  const warnings: string[] = [];
  let tokens = 0;

  for (const name of names) {
    if (loaded.length >= maxCount) {
      warnings.push(`预置技能超过 ${maxCount} 个上限，已忽略：${names.slice(loaded.length).join(', ')}`);
      break;
    }
    let res: { ok: boolean; content: string };
    try {
      res = await skills.load(name);
    } catch (e) {
      warnings.push(`预置技能 ${name} 加载失败：${(e as Error).message}`);
      continue;
    }
    if (!res.ok) {
      warnings.push(`预置技能不存在：${name}`);
      continue;
    }
    const cost = estimateTextTokens(res.content);
    if (tokens + cost > maxTokens) {
      warnings.push(`预置技能累计超过 ${maxTokens} tokens 上限，已忽略：${name}`);
      continue;
    }
    tokens += cost;
    loaded.push(name);
  }
  return { loaded, warnings };
}
