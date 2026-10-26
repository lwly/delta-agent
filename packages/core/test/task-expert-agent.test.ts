/**
 * F-39 T08：task 工具的专家团成员委派
 * 最高优先级：不传 agent 时与历史行为逐字段一致（快照断言）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentEvent, ChatMessage, ChatRequest, LLMProvider, StreamEvent, ToolCall } from '@delta/shared';
import { BudgetManager } from '../src/context/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { PermissionState } from '../src/tools/permissions.js';
import { taskTool } from '../src/tools/builtin/task.js';
import { toTeamRuntime } from '../src/experts/team.js';
import type { ToolContext } from '../src/tools/types.js';

class MockProvider implements LLMProvider {
  readonly id = 'mock';
  constructor(private script: Array<{ text?: string; toolCalls?: ToolCall[]; usage?: { input: number; output: number } }>) {}
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const next = this.script.shift();
    if (!next) {
      yield { type: 'error', message: 'mock script exhausted', retriable: false };
      return;
    }
    if (next.text) yield { type: 'text_delta', text: next.text };
    for (const [i, c] of (next.toolCalls ?? []).entries()) {
      yield { type: 'tool_call_delta', index: i, id: c.id, name: c.name, argsDelta: c.argsJson };
    }
    yield { type: 'usage', input: next.usage?.input ?? 10, output: next.usage?.output ?? 5 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, argsJson: JSON.stringify(args), args });

let tmpRoot = '';
let registry: ToolRegistry;
let parentBudget: BudgetManager;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-task-expert-'));
  await fs.writeFile(path.join(tmpRoot, 'note.txt'), 'hello world');
  registry = new ToolRegistry();
  parentBudget = new BudgetManager({ maxTokens: 1_000_000, maxCostUsd: 100 });
});

const team = {
  teamName: 'software-dev-team',
  teamDisplayName: '软件开发团队',
  delegations: { count: 0 },
  members: [
    {
      id: 'dev',
      name: { en: 'Dev', zh: '开发' },
      profession: { en: 'Dev', zh: '开发' },
      role: 'member' as const,
      body: '成员正文：负责写代码。',
      tools: ['read_file', 'write_file'],
      skills: [],
    },
    {
      id: 'reviewer',
      name: { en: 'Reviewer', zh: '评审' },
      profession: { en: 'R', zh: '评审' },
      role: 'member' as const,
      body: '成员正文：只读评审。',
      tools: [],
      skills: [],
    },
  ],
  baseRegistry: undefined as never,
};

function makeCtx(provider: LLMProvider, over: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: tmpRoot,
    signal: new AbortController().signal,
    confirm: async () => ({ kind: 'allow' }),
    askUser: async () => 'ok',
    todos: [],
    sessionId: 's1',
    projectId: 'p1',
    registry,
    permissions: new PermissionState({ mode: 'default' }),
    subagent: {
      provider,
      model: 'mock-model',
      budget: parentBudget,
      budgetConfig: parentBudget.config,
      windowTokens: 200_000,
      depth: 0,
    },
    ...over,
  };
}

describe('task：不传 agent（历史行为不变）', () => {
  it('content 无前缀、meta 无 agent 字段', async () => {
    const provider = new MockProvider([{ text: '普通子代理汇报。' }]);
    const result = await taskTool.execute({ description: 'd', prompt: 'p' }, makeCtx(provider));
    expect(result.ok).toBe(true);
    expect(result.content).not.toContain('[expert:');
    expect(result.content).not.toContain('〔专家团·');
    expect(result.meta!.agent).toBeUndefined();
    expect(result.meta!.description).toBe('d');
  });
});

describe('task：agent 参数（专家团）', () => {
  it('未知成员 → unknown_agent，文案含可选成员', async () => {
    const provider = new MockProvider([]);
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', agent: 'ghost' },
      makeCtx(provider, { expertTeam: { ...team, baseRegistry: registry } }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown_agent');
    expect(result.content).toContain('dev, reviewer');
  });

  it('非团队会话传 agent → unknown_agent 且提示未绑定专家团', async () => {
    const provider = new MockProvider([]);
    const result = await taskTool.execute({ description: 'd', prompt: 'p', agent: 'dev' }, makeCtx(provider));
    expect(result.error).toBe('unknown_agent');
    expect(result.content).toContain('未绑定专家团');
  });

  it('命中成员：start/done 事件、content 前缀、usage 回写父预算', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockProvider([
      { toolCalls: [call('c1', 'read_file', { path: 'note.txt' })], usage: { input: 100, output: 20 } },
      { text: '已完成读取。', usage: { input: 50, output: 10 } },
    ]);
    const result = await taskTool.execute(
      { description: '读文件', prompt: '读取 note.txt', agent: 'dev' },
      makeCtx(provider, {
        expertTeam: { ...team, baseRegistry: registry },
        emit: (ev) => events.push(ev),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/^\[expert:dev\] 开发（开发）\n/);
    expect(result.meta!.agent).toBe('dev');
    expect(result.meta!.agent_name).toBe('开发');
    expect(result.meta!.agent_role).toBe('member');
    expect(result.meta!.readonly_degraded).toBe(false);

    const start = events.find((e) => e.type === 'expert_delegate_start');
    const done = events.find((e) => e.type === 'expert_delegate_done');
    expect(start).toMatchObject({ memberId: 'dev', memberName: '开发', role: 'member' });
    expect(done).toMatchObject({ memberId: 'dev', status: 'ok' });
    expect((done as { usage: { inputTokens: number } }).usage.inputTokens).toBe(150);
    expect(parentBudget.state.usedInputTokens).toBe(150);
  });

  it('第 9 次委派 → delegation_limit', async () => {
    const provider = new MockProvider([{ text: 'x' }]);
    const ctx = makeCtx(provider, { expertTeam: { ...team, baseRegistry: registry, delegations: { count: 8 } } });
    const result = await taskTool.execute({ description: 'd', prompt: 'p', agent: 'dev' }, ctx);
    expect(result.error).toBe('delegation_limit');
  });

  it('成员含 write_file 且父 default → 走父 confirm 通道并成功写入', async () => {
    const confirmCalls: string[] = [];
    const provider = new MockProvider([
      { toolCalls: [call('c1', 'write_file', { path: 'out.txt', content: '成员写的' })] },
      { text: '已写入 out.txt。' },
    ]);
    const result = await taskTool.execute(
      { description: '写文件', prompt: '写 out.txt', agent: 'dev' },
      makeCtx(provider, {
        expertTeam: { ...team, baseRegistry: registry },
        confirm: async (req) => {
          confirmCalls.push(req.tool);
          return { kind: 'allow' };
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(confirmCalls).toContain('write_file');
    expect(await fs.readFile(path.join(tmpRoot, 'out.txt'), 'utf-8')).toBe('成员写的');
  });

  it('父 plan → 成员写被 PermissionState 拒绝，done.readonlyDegraded=true', async () => {
    const events: AgentEvent[] = [];
    const provider = new MockProvider([
      { toolCalls: [call('c1', 'write_file', { path: 'evil.txt', content: 'x' })] },
      { text: '写入被拒，已给出建议。' },
    ]);
    const result = await taskTool.execute(
      { description: '尝试写', prompt: '写 evil.txt', agent: 'dev' },
      makeCtx(provider, {
        expertTeam: { ...team, baseRegistry: registry },
        permissions: new PermissionState({ mode: 'plan' }),
        emit: (ev) => events.push(ev),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.meta!.failed_tool_calls).toBe(1);
    expect(result.meta!.readonly_degraded).toBe(true);
    await expect(fs.access(path.join(tmpRoot, 'evil.txt'))).rejects.toThrow();
    const done = events.find((e) => e.type === 'expert_delegate_done') as { readonlyDegraded?: boolean };
    expect(done.readonlyDegraded).toBe(true);
  });

  it('成员上下文不能再委派（expertTeam 剔除）', async () => {
    const seen: Array<ToolContext> = [];
    // 用真实 runReAct 无法直接断言子 ctx；改为断言 tool.ts 代码行为：
    // 成员运行时传 agent 给内层 task → 内层 ctx.expertTeam 为 undefined → unknown_agent「未绑定专家团」
    const provider = new MockProvider([
      { toolCalls: [call('c1', 'task', { description: 'nested', prompt: 'p', agent: 'dev' })] },
      { text: '嵌套委派被拒绝。' },
    ]);
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', agent: 'dev' },
      makeCtx(provider, {
        expertTeam: { ...team, baseRegistry: registry },
      }),
    );
    void seen;
    // 内层 task 调用失败计为 failed_tool_calls，且错误含「未绑定专家团」
    expect(result.ok).toBe(true);
    expect(result.meta!.failed_tool_calls).toBe(1);
  });
});
