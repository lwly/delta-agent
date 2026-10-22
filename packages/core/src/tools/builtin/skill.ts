/**
 * load_skill / unload_skill 内置工具（agent-modes-design.md §7.3）
 * 两阶段加载：LLM 调用 load_skill → 内容进跨轮次缓冲区 → 下一轮注入 Prompt。
 */
import type { AgentTool, ToolContext } from '../types.js';
import { fail, ok } from '../types.js';

export const loadSkillTool: AgentTool = {
  name: 'load_skill',
  description:
    '加载指定 Skill 的完整能力（主体指令 + references 索引）到会话缓冲区，下一轮起生效。仅可加载 Skill 索引中列出的技能。',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill 名称（见 Skill 索引）' },
    },
    required: ['name'],
  },
  danger: 'safe',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    if (!ctx.skills) {
      return fail('skill 系统未在本会话启用（缺少 skills runtime）', 'skills_unavailable');
    }
    const name = String(args.name ?? '');
    const r = await ctx.skills.load(name);
    return r.ok ? ok(r.content) : fail(r.content, 'skill_not_found');
  },
};

export const unloadSkillTool: AgentTool = {
  name: 'unload_skill',
  description: '卸载已加载的 Skill，释放缓冲区 token（长会话控制上下文占用）。',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '已加载的 Skill 名称' },
    },
    required: ['name'],
  },
  danger: 'safe',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    if (!ctx.skills) {
      return fail('skill 系统未在本会话启用（缺少 skills runtime）', 'skills_unavailable');
    }
    const name = String(args.name ?? '');
    const r = ctx.skills.unload(name);
    return r.ok ? ok(r.content) : fail(r.content, 'skill_not_loaded');
  },
};
