/**
 * F-26 子代理即工具（Task 工具）——主循环中模型可自主派生隔离子代理，
 * 执行探索/搜索类任务（会大量污染主上下文的勘察工作），结果摘要回填主上下文。
 *
 * 隔离语义：
 * - 上下文隔离：子代理独立消息循环（runReAct 复用，预算/压缩/自愈同源），历史不落主会话
 * - 工具隔离：RestrictedRegistry 只读白名单（read/list/glob/grep/web_fetch/todo），
 *   叠加 plan 权限模式双保险（写/执行类即使注册表被扩展也会被拒）
 * - 成本隔离：独立 BudgetManager；用量回写父预算保持会话费用口径完整
 * - 深度上限：子代理不可再派生（MAX_SUBAGENT_DEPTH = 1），防递归放大
 */
import type { AgentEvent, ToolResult, Usage } from '@delta/shared';
import { fail, type AgentTool, type ToolContext } from '../types.js';
import { BudgetManager, DEFAULT_SESSION_BUDGET } from '../../context/budget.js';
import { PermissionState } from '../permissions.js';
import { RestrictedRegistry } from '../../engine/roles.js';
import { runReAct, type RunContext } from '../../engine/react.js';
import {
  buildMemberSystemPrompt,
  delegationPrefix,
  MAX_DELEGATIONS_PER_RUN,
} from '../../experts/team.js';

/** 子代理可用工具（只读 + 信息收集） */
export const SUBAGENT_TOOLS = [
  'read_file',
  'list_dir',
  'glob_search',
  'grep_search',
  'web_fetch',
  'todo_write',
] as const;

/** 子代理不可再派生子代理（防递归放大） */
export const MAX_SUBAGENT_DEPTH = 1;

export const DEFAULT_SUBAGENT_TURNS = 15;
export const MAX_SUBAGENT_TURNS = 30;

/**
 * 单个子代理的 token 预算上限（方案 C）：min(父预算剩余, 60k)。
 * 子代理超限只终止该子代理（budget_exhausted → "子代理预算耗尽"），父代理继续跑；
 * 并行派生时父预算按序预留（reserveTokens），保证预留总量不超过父剩余，避免一次并行超卖。
 */
export const SUBAGENT_MAX_TOKENS = 60_000;

/** 回填主上下文的摘要上限（与 engine/subtask.ts 口径一致） */
const SUMMARY_MAX_CHARS = 4_000;

const SUBAGENT_SYSTEM = `你是一个只读探索子代理（Explore Subagent）。你的最终汇报会作为摘要回填给主代理，主代理看不到你的中间过程。
职责：读代码、检索、信息收集与事实核验；不做任何写操作或命令执行（工具集已限定为只读）。
要求：信息足够时立即输出最终汇报——结论要点 + 关键文件路径与行号 + 证据引用；不确定之处明确标注。不要向用户提问，不要输出多余客套。`;

export const taskTool: AgentTool = {
  name: 'task',
  description:
    '派生隔离子代理执行探索/搜索类任务（只读工具集），结果摘要回填主上下文。' +
    '适用于大范围代码勘察、多文件信息收集、背景调研等会产生大量中间输出的子任务；' +
    '简单单文件读取或直接编辑请使用对应工具，不要派生子代理。',
  schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '任务简述（3-5 词，用于日志与结果定位）' },
      prompt: {
        type: 'string',
        description: '给子代理的完整任务描述：目标、范围、期望产出格式',
      },
      max_turns: { type: 'number', description: `子代理最大轮次（默认 ${DEFAULT_SUBAGENT_TURNS}，上限 ${MAX_SUBAGENT_TURNS}）` },
      agent: {
        type: 'string',
        description: '专家团成员 id（仅团队专家会话可用）；缺省 = 普通只读探索子代理',
      },
    },
    required: ['description', 'prompt'],
  },
  danger: 'safe',
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.registry || !ctx.subagent) {
      return fail('task 工具不可用：当前运行环境未注入子代理运行时，请直接用只读工具完成任务', 'task_unavailable');
    }
    if ((ctx.subagent.depth ?? 0) >= MAX_SUBAGENT_DEPTH) {
      return fail('已达子代理嵌套上限（子代理不能再派生子代理）', 'task_depth_exceeded');
    }
    const description = String(args['description'] ?? '').trim();
    const prompt = String(args['prompt'] ?? '').trim();
    if (!prompt) {
      return fail('缺少 prompt 参数：请描述子代理要完成的任务', 'invalid_args');
    }
    // ── 方案 C：子代理预算 = min(父剩余, 60k)，并行派生按序预留防超卖 ──
    // 预算校验/预留必须先于委派副作用（delegation 计数、expert_delegate_start），
    // 预算不足时直接失败，不留下悬挂的成员卡
    const parentBudget = ctx.subagent.budget;
    const parentConfig = ctx.subagent.budgetConfig ?? {};
    let reserved = 0;
    let childMaxTokens: number;
    if (parentBudget) {
      reserved = parentBudget.reserveTokens(SUBAGENT_MAX_TOKENS);
      if (reserved <= 0) {
        return fail(
          `父预算剩余不足，无法派生子代理（剩余 ${parentBudget.remainingTokens()} tokens）`,
          'subagent_budget_exhausted',
        );
      }
      childMaxTokens = reserved;
    } else {
      // 无父预算实例（部分测试/嵌入场景）：仍封顶 60k，费用维度沿用传入配置
      childMaxTokens = Math.min(parentConfig.maxTokens ?? DEFAULT_SESSION_BUDGET.maxTokens, SUBAGENT_MAX_TOKENS);
    }
    const budget = new BudgetManager({
      ...parentConfig,
      maxTokens: childMaxTokens,
      ...(parentBudget
        ? { maxCostUsd: Math.max(0, parentBudget.config.maxCostUsd - parentBudget.state.usedCostUsd) }
        : {}),
    });
    // ── F-39：专家团成员解析（不传 agent 时以下分支全部跳过，行为与历史一致）──
    const agentId = String(args['agent'] ?? '').trim();
    const member = agentId ? ctx.expertTeam?.members.find((m) => m.id === agentId) : undefined;
    if (agentId && !member) {
      const available = (ctx.expertTeam?.members ?? []).map((m) => m.id);
      return fail(
        ctx.expertTeam
          ? `未知成员：${agentId}。可选成员：${available.join(', ') || '（空）'}`
          : `当前会话未绑定专家团，不支持 agent 参数（agent=${agentId}）`,
        'unknown_agent',
      );
    }
    let delegationPrefixText = '';
    let delegationStartedAt = 0;
    if (member) {
      const counter = ctx.expertTeam!.delegations;
      if (counter.count >= MAX_DELEGATIONS_PER_RUN) {
        return fail(
          `本轮委派次数已达上限（${MAX_DELEGATIONS_PER_RUN} 次），请先汇总已有成员产出`,
          'delegation_limit',
        );
      }
      counter.count += 1;
      delegationPrefixText = `${delegationPrefix(member)}\n`;
      delegationStartedAt = Date.now();
      ctx.emit?.({
        type: 'expert_delegate_start',
        memberId: member.id,
        memberName: member.name.zh || member.name.en,
        profession: member.profession.zh || member.profession.en,
        role: member.role,
        goal: (description || prompt).slice(0, 120),
        startedAt: delegationStartedAt,
      });
    }
    const withPrefix = (text: string): string => (delegationPrefixText ? `${delegationPrefixText}${text}` : text);

    const requestedTurns = member?.maxTurns ?? Number(args['max_turns'] ?? DEFAULT_SUBAGENT_TURNS);
    const maxTurns = Math.min(
      Math.max(Math.floor(Number(requestedTurns) || DEFAULT_SUBAGENT_TURNS), 1),
      MAX_SUBAGENT_TURNS,
    );

    // 成员：成员白名单 ∩ 完整注册表（主理人视图不含写工具，不能作为成员基座）
    const baseRegistry = member ? (ctx.expertTeam?.baseRegistry ?? ctx.registry) : ctx.registry;
    let allow: Set<string> = new Set<string>(SUBAGENT_TOOLS);
    if (member) {
      if (member.tools.length > 0) {
        const names = new Set(baseRegistry.definitions().map((d) => d.name));
        allow = new Set(member.tools.filter((t) => names.has(t)));
        if (allow.size === 0) allow = new Set<string>(SUBAGENT_TOOLS);
      }
    }
    const registry = new RestrictedRegistry(baseRegistry, allow);
    const parentMode = ctx.permissions?.policy.mode ?? 'default';
    const childCtx: RunContext = {
      sessionId: ctx.sessionId ?? '',
      projectId: ctx.projectId ?? '',
      mode: 'react',
      model: ctx.subagent.model,
      systemPrompt: member
        ? buildMemberSystemPrompt(member, { teamName: ctx.expertTeam!.teamName, teamDisplayName: ctx.expertTeam!.teamDisplayName }, prompt)
        : SUBAGENT_SYSTEM,
      maxTurns,
      signal: ctx.signal,
      provider: ctx.subagent.provider,
      registry,
      toolContext: {
        ...ctx,
        signal: ctx.signal,
        todos: [],
        // 普通子代理：plan 只读双保险；团队成员：克隆父模式（写操作走父确认通道，D4）
        permissions: member
          ? new PermissionState({
              mode: parentMode,
              ...(ctx.permissions?.policy.allowlist ? { allowlist: ctx.permissions.policy.allowlist } : {}),
            })
          : new PermissionState({ mode: 'plan' }),
        // 子代理无交互对象：提问自动应答、确认自动拒绝；成员继承父会话通道
        confirm: member
          ? ctx.confirm
          : async () => ({ kind: 'reject', reason: '子代理为只读探索环境，无确认流' }),
        askUser: member
          ? ctx.askUser
          : async () => '（子代理无用户可交互，请基于已有信息自行决策）',
        registry, // 深度防线已由 depth 拒绝，此处保持一致视图
        subagent: { ...ctx.subagent, depth: (ctx.subagent.depth ?? 0) + 1 },
        // D12：成员不能再派生（编译期/配置期的第二道防线）
        expertTeam: undefined,
        emit: undefined,
      },
      budget,
      windowTokens: ctx.subagent.windowTokens ?? 200_000,
    };

    // 事件消费：文本块切分（最终块 = 汇报），用量回写父预算
    const blocks: string[] = [];
    let current = '';
    let turns = 0;
    let toolCount = 0;
    let failedToolCount = 0;
    let usageTotal: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let error: string | undefined;

    try {
      for await (const ev of runReAct(childCtx, [], prompt)) {
        const e = ev as AgentEvent;
        switch (e.type) {
          case 'turn_start':
            turns = e.turn;
            break;
          case 'text_delta':
            current += e.text;
            break;
          case 'tool_call_start':
            if (current) blocks.push(current);
            current = '';
            break;
          case 'tool_result':
            toolCount++;
            if (!e.result.ok) failedToolCount++;
            break;
          case 'usage':
            usageTotal = {
              inputTokens: usageTotal.inputTokens + e.usage.inputTokens,
              outputTokens: usageTotal.outputTokens + e.usage.outputTokens,
              costUsd: (usageTotal.costUsd ?? 0) + (e.usage.costUsd ?? 0),
            };
            break;
          case 'error':
            if (e.fatal) error = e.message;
            break;
          case 'budget_exhausted':
            error = '子代理预算耗尽';
            break;
          default:
            break;
        }
      }
    } catch (err) {
      error = (err as Error).message;
    }
    if (current) blocks.push(current);
    // 用量回写父预算：会话级费用口径包含子代理消耗；随后释放本子代理的配额预留
    ctx.subagent.budget?.record(usageTotal);
    if (parentBudget && reserved > 0) parentBudget.releaseTokens(reserved);

    const emitDone = (status: 'ok' | 'failed' | 'canceled', summary: string): void => {
      if (!member) return;
      ctx.emit?.({
        type: 'expert_delegate_done',
        memberId: member.id,
        memberName: member.name.zh || member.name.en,
        status,
        usage: usageTotal,
        ms: Date.now() - delegationStartedAt,
        summary: summary.slice(0, 400),
        ...(parentMode === 'plan' ? { readonlyDegraded: true } : {}),
      });
    };

    if (ctx.signal.aborted) {
      const partial = clip(blocks.join(''));
      emitDone('canceled', partial);
      return fail(withPrefix(partial || '子代理被中断'), 'canceled');
    }
    const finalText = current || (blocks.length > 0 ? blocks[blocks.length - 1]! : '');
    if (!finalText.trim()) {
      emitDone('failed', error ?? '子代理未产出任何汇报');
      return fail(withPrefix(clip(error ?? '子代理未产出任何汇报')), error ? 'subagent_failed' : 'empty_result');
    }
    emitDone('ok', finalText);
    return {
      callId: '',
      name: 'task',
      ok: true,
      content: withPrefix(clip(finalText)),
      meta: {
        description,
        turns,
        tool_calls: toolCount,
        failed_tool_calls: failedToolCount,
        usage: usageTotal,
        error,
        ...(member
          ? {
              agent: member.id,
              agent_name: member.name.zh || member.name.en,
              agent_profession: member.profession.zh || member.profession.en,
              agent_role: member.role,
              readonly_degraded: parentMode === 'plan',
            }
          : {}),
      },
    };
  },
};

function clip(s: string): string {
  return s.length > SUMMARY_MAX_CHARS ? `${s.slice(0, SUMMARY_MAX_CHARS)}\n...[truncated]` : s;
}
