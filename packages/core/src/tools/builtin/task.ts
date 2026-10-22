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
import type { AgentEvent, ToolResult, Usage } from '@y-zero/shared';
import { fail, type AgentTool, type ToolContext } from '../types.js';
import { BudgetManager } from '../../context/budget.js';
import { PermissionState } from '../permissions.js';
import { RestrictedRegistry } from '../../engine/roles.js';
import { runReAct, type RunContext } from '../../engine/react.js';

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
    const maxTurns = Math.min(
      Math.max(Math.floor(Number(args['max_turns'] ?? DEFAULT_SUBAGENT_TURNS) || DEFAULT_SUBAGENT_TURNS), 1),
      MAX_SUBAGENT_TURNS,
    );

    const registry = new RestrictedRegistry(ctx.registry, new Set<string>(SUBAGENT_TOOLS));
    const budget = new BudgetManager(ctx.subagent.budgetConfig ?? {});
    const childCtx: RunContext = {
      sessionId: ctx.sessionId ?? '',
      projectId: ctx.projectId ?? '',
      mode: 'react',
      model: ctx.subagent.model,
      systemPrompt: SUBAGENT_SYSTEM,
      maxTurns,
      signal: ctx.signal,
      provider: ctx.subagent.provider,
      registry,
      toolContext: {
        ...ctx,
        signal: ctx.signal,
        todos: [],
        // 双保险：白名单之外再叠 plan 只读模式（未来白名单扩充也拦得住写/执行）
        permissions: new PermissionState({ mode: 'plan' }),
        // 子代理无交互对象：提问自动应答、确认自动拒绝
        confirm: async () => ({ kind: 'reject', reason: '子代理为只读探索环境，无确认流' }),
        askUser: async () => '（子代理无用户可交互，请基于已有信息自行决策）',
        registry, // 深度防线已由 depth 拒绝，此处保持一致视图
        subagent: { ...ctx.subagent, depth: (ctx.subagent.depth ?? 0) + 1 },
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
    // 用量回写父预算：会话级费用口径包含子代理消耗
    ctx.subagent.budget?.record(usageTotal);

    if (ctx.signal.aborted) {
      const partial = clip(blocks.join(''));
      return fail(partial || '子代理被中断', 'canceled');
    }
    const finalText = current || (blocks.length > 0 ? blocks[blocks.length - 1]! : '');
    if (!finalText.trim()) {
      return fail(clip(error ?? '子代理未产出任何汇报'), error ? 'subagent_failed' : 'empty_result');
    }
    return {
      callId: '',
      name: 'task',
      ok: true,
      content: clip(finalText),
      meta: {
        description,
        turns,
        tool_calls: toolCount,
        failed_tool_calls: failedToolCount,
        usage: usageTotal,
        error,
      },
    };
  },
};

function clip(s: string): string {
  return s.length > SUMMARY_MAX_CHARS ? `${s.slice(0, SUMMARY_MAX_CHARS)}\n...[truncated]` : s;
}
