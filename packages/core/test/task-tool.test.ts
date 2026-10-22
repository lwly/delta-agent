import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent, ToolCall } from '@y-zero/shared';
import { BudgetManager } from '../src/context/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { taskTool, MAX_SUBAGENT_DEPTH } from '../src/tools/builtin/task.js';
import type { ToolContext } from '../src/tools/types.js';

/** 脚本化 Mock Provider：每次 chat() 弹出一条响应（子代理循环驱动）。 */
class MockProvider implements LLMProvider {
  readonly id = 'mock';
  constructor(private script: Array<{ text?: string; toolCalls?: ToolCall[]; usage?: { input: number; output: number } }>) {}
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const next = this.script.shift();
    if (!next) {
      yield { type: 'error', message: 'mock script exhausted', retriable: false };
      return;
    }
    if (next.text) {
      yield { type: 'text_delta', text: next.text };
    }
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

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  argsJson: JSON.stringify(args),
  args,
});

let tmpRoot = '';
let registry: ToolRegistry;
let parentBudget: BudgetManager;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-task-'));
  await fs.writeFile(path.join(tmpRoot, 'note.txt'), 'hello world');
  registry = new ToolRegistry();
  parentBudget = new BudgetManager({ maxTokens: 1_000_000, maxCostUsd: 100 });
});

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

describe('task 子代理工具（F-26）', () => {
  it('已注册进内置工具表且对模型可见', () => {
    expect(registry.get('task')).toBeDefined();
    expect(registry.definitions().some((d) => d.name === 'task')).toBe(true);
  });

  it('隔离运行子代理：读文件 → 摘要回填 + 用量回写父预算', async () => {
    const provider = new MockProvider([
      { toolCalls: [call('c1', 'read_file', { path: 'note.txt' })], usage: { input: 100, output: 20 } },
      { text: 'note.txt 内容为 hello world（第 1 行）。', usage: { input: 200, output: 40 } },
    ]);
    const result = await taskTool.execute(
      { description: '读取 note', prompt: '读取 note.txt 并汇报内容' },
      makeCtx(provider),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('hello world');
    expect(result.meta).toMatchObject({ description: '读取 note', tool_calls: 1, failed_tool_calls: 0 });
    expect(result.meta!.turns).toBeGreaterThanOrEqual(1);
    // 用量回写父预算：input 100+200, output 20+40
    expect(parentBudget.state.usedInputTokens).toBe(300);
    expect(parentBudget.state.usedOutputTokens).toBe(60);
  });

  it('只读强制：子代理调用 write_file 被拒且不落盘', async () => {
    const provider = new MockProvider([
      { toolCalls: [call('c1', 'write_file', { path: 'evil.txt', content: 'x' })] },
      { text: '写入被拒绝，子代理为只读环境。' },
    ]);
    const result = await taskTool.execute(
      { description: '尝试写', prompt: '写入 evil.txt' },
      makeCtx(provider),
    );
    expect(result.ok).toBe(true); // 子代理正常收尾
    expect(result.meta!.failed_tool_calls).toBe(1); // 写调用失败
    await expect(fs.access(path.join(tmpRoot, 'evil.txt'))).rejects.toThrow(); // 未落盘
  });

  it('未注入子代理运行时 → task_unavailable', async () => {
    const { registry: _r, subagent: _s, ...noInject } = makeCtx(new MockProvider([]));
    void _r;
    void _s;
    const result = await taskTool.execute({ description: 'x', prompt: 'y' }, noInject as ToolContext);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('task_unavailable');
  });

  it('深度上限：子代理内不能再派生', async () => {
    const result = await taskTool.execute(
      { description: 'x', prompt: 'y' },
      makeCtx(new MockProvider([]), {
        subagent: {
          provider: new MockProvider([]),
          model: 'mock-model',
          depth: MAX_SUBAGENT_DEPTH,
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('task_depth_exceeded');
  });

  it('缺少 prompt → invalid_args', async () => {
    const result = await taskTool.execute({ description: 'x' }, makeCtx(new MockProvider([])));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_args');
  });

  it('子代理脚本耗尽（引擎报错）→ subagent_failed', async () => {
    const provider = new MockProvider([]); // 空 script → error
    const result = await taskTool.execute(
      { description: 'x', prompt: 'y' },
      makeCtx(provider),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('subagent_failed');
  });
});
