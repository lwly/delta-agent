/**
 * checkpoint 幂等 + LLM 兜底分类（agent-modes-design §3.1 / §6 幂等行）
 * - 分类：规则三值 + LLM 兜底 + 兜底失败回退规则默认
 * - checkpoint：文件变更清单落库 → 重试/续跑注入提示跳过已完成步骤
 */
import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  StreamEvent,
  TaskNode,
  Plan,
  ToolCall,
  ToolResult,
} from '@y-zero/shared';
import { SessionStore } from '../src/session/store.js';
import { TaskStore, emptyCheckpoint } from '../src/session/tasks.js';
import {
  classifyByRules,
  classifyComplexity,
  resolveSimpleTask,
  detectSimpleTask,
} from '../src/engine/planner.js';
import { recordToolResult, resumeNote, runSubTask } from '../src/engine/subtask.js';
import { runPlanWithPool } from '../src/engine/worker-pool.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { BudgetManager } from '../src/context/budget.js';
import type { RunContext } from '../src/engine/react.js';
import type { ToolContext } from '../src/tools/types.js';

/** 可脚本化并记录收到的 messages 的 mock provider。 */
class ScriptProvider implements LLMProvider {
  readonly id = 'mock';
  seenMessages: ChatMessage[][] = [];
  constructor(
    private script: Array<{
      text?: string;
      toolCall?: { name: string; args: Record<string, unknown> };
      error?: string;
    }>,
  ) {}
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.seenMessages.push(req.messages.map((m) => ({ ...m })));
    const next = this.script.shift();
    if (!next) {
      yield { type: 'error', message: 'script exhausted', retriable: false };
      return;
    }
    if (next.error) {
      yield { type: 'error', message: next.error, retriable: false };
      return;
    }
    if (next.toolCall) {
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: 'c1',
        name: next.toolCall.name,
        argsDelta: JSON.stringify(next.toolCall.args),
      };
    }
    if (next.text) {
      for (const chunk of next.text.match(/.{1,5}/gs) ?? []) {
        yield { type: 'text_delta', text: chunk };
      }
    }
    yield { type: 'usage', input: 10, output: 5 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

let tmpRoot = '';
let store: SessionStore;
let tasks: TaskStore;

beforeEach(async () => {
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yz-cp-'));
  store = new SessionStore(path.join(tmpRoot, 'test.db'));
  tasks = new TaskStore(store.db);
});

function makeCtx(provider: LLMProvider, over: Partial<RunContext> = {}): RunContext {
  const toolCtx: ToolContext = {
    projectRoot: tmpRoot,
    signal: new AbortController().signal,
    confirm: async () => ({ kind: 'allow' }),
    askUser: async () => 'ok',
    todos: [],
  };
  return {
    sessionId: 's1',
    projectId: 'p1',
    mode: 'plan-execute',
    model: 'mock-model',
    systemPrompt: 'SYS',
    maxTurns: 10,
    signal: new AbortController().signal,
    provider,
    registry: new ToolRegistry(),
    toolContext: toolCtx,
    budget: new BudgetManager({ maxTokens: 10_000_000, maxCostUsd: 1000 }),
    windowTokens: 200_000,
    tasks,
    ...over,
  };
}

function planOf(nodes: TaskNode[]): Plan {
  return { goal: 'g', revision: 1, createdAt: 0, nodes };
}

// ── LLM 兜底分类 ─────────────────────────────────────────────────────────────

describe('classifyByRules（规则三值）', () => {
  it('强复杂：关键词 / 多文件信号', () => {
    expect(classifyByRules('重构整个项目的模块')).toBe('strong-complex');
    expect(classifyByRules('把 a.ts 和 b.ts 里的逻辑合并')).toBe('strong-complex');
  });

  it('强简单：问答/查询前缀', () => {
    expect(classifyByRules('什么是闭包？')).toBe('strong-simple');
    // 「查看」带 \b，需紧跟 ASCII 词字符（如文件名）才命中
    expect(classifyByRules('查看README.md 的使用说明')).toBe('strong-simple');
    expect(classifyByRules('解释一下闭包')).toBe('strong-simple');
  });

  it('不确定：无强信号的普通输入', () => {
    expect(classifyByRules('帮我处理一下这个函数的边界情况')).toBe('ambiguous');
  });
});

describe('classifyComplexity（LLM 兜底层）', () => {
  it('解析 LLM 返回的 JSON 判定', async () => {
    const p = new ScriptProvider([{ text: '{"complexity":"complex","reason":"多文件改动"}' }]);
    expect(await classifyComplexity(p, 'm', '任意输入')).toBe('complex');
  });

  it('容忍 markdown 围栏', async () => {
    const p = new ScriptProvider([{ text: '```json\n{"complexity":"simple","reason":"问答"}\n```' }]);
    expect(await classifyComplexity(p, 'm', '任意输入')).toBe('simple');
  });

  it('LLM 报错 → undefined（调用方回退规则默认）', async () => {
    const p = new ScriptProvider([{ error: 'boom' }]);
    expect(await classifyComplexity(p, 'm', '任意输入')).toBeUndefined();
  });

  it('输出非法 JSON / 字段缺失 → undefined', async () => {
    expect(await classifyComplexity(new ScriptProvider([{ text: '哈哈' }]), 'm', 'x')).toBeUndefined();
    expect(
      await classifyComplexity(new ScriptProvider([{ text: '{"foo":1}' }]), 'm', 'x'),
    ).toBeUndefined();
  });
});

describe('resolveSimpleTask（两层分类入口）', () => {
  it('规则强判定不消耗 LLM 调用', async () => {
    const p = new ScriptProvider([]);
    expect(await resolveSimpleTask(p, 'm', '什么是闭包？')).toBe(true);
    expect(await resolveSimpleTask(p, 'm', '重构整个项目')).toBe(false);
    expect(p.seenMessages.length).toBe(0);
  });

  it('不确定 → LLM 兜底', async () => {
    const simple = new ScriptProvider([{ text: '{"complexity":"simple","reason":"单点修改"}' }]);
    expect(await resolveSimpleTask(simple, 'm', '帮我处理下这个函数')).toBe(true);
    const complex = new ScriptProvider([{ text: '{"complexity":"complex","reason":"需要规划"}' }]);
    expect(await resolveSimpleTask(complex, 'm', '帮我处理下这个函数')).toBe(false);
  });

  it('兜底失败回退规则默认（短=简单，长=复杂）', async () => {
    const bad = new ScriptProvider([{ text: '乱码输出' }]);
    expect(await resolveSimpleTask(bad, 'm', '短输入')).toBe(true);
    const bad2 = new ScriptProvider([{ text: '乱码输出' }]);
    expect(await resolveSimpleTask(bad2, 'm', `${'很长很长的输入'.repeat(30)}`)).toBe(false);
  });

  it('detectSimpleTask 原语义不变（回归）', () => {
    expect(detectSimpleTask('什么是闭包？')).toBe(true);
    expect(detectSimpleTask('重构 x 模块')).toBe(false);
  });
});

// ── checkpoint 幂等 ──────────────────────────────────────────────────────────

describe('recordToolResult / resumeNote（纯函数）', () => {
  const call = (name: string, args: Record<string, unknown>): ToolCall => ({
    id: 'c1',
    name,
    argsJson: JSON.stringify(args),
    args,
  });
  const result = (ok: boolean): ToolResult => ({ callId: 'c1', name: 'x', ok, content: '' });

  it('成功的文件变更记入清单', () => {
    const cp = emptyCheckpoint();
    recordToolResult(cp, call('write_file', { path: 'a.ts' }), result(true));
    expect(cp.steps).toEqual(['write_file(a.ts)']);
    expect(cp.files).toEqual(['a.ts']);
  });

  it('失败调用与非变更工具不记录', () => {
    const cp = emptyCheckpoint();
    recordToolResult(cp, call('write_file', { path: 'a.ts' }), result(false));
    recordToolResult(cp, call('read_file', { path: 'a.ts' }), result(true));
    expect(cp.steps).toEqual([]);
    expect(cp.files).toEqual([]);
  });

  it('同文件多次修改：files 去重，steps 顺序追加', () => {
    const cp = emptyCheckpoint();
    recordToolResult(cp, call('write_file', { path: 'a.ts' }), result(true));
    recordToolResult(cp, call('edit_file', { path: 'a.ts' }), result(true));
    expect(cp.files).toEqual(['a.ts']);
    expect(cp.steps).toEqual(['write_file(a.ts)', 'edit_file(a.ts)']);
  });

  it('resumeNote：空 checkpoint 为空串；有内容含续跑提示', () => {
    expect(resumeNote(emptyCheckpoint())).toBe('');
    const cp = emptyCheckpoint();
    cp.steps = ['write_file(a.ts)'];
    cp.files = ['a.ts'];
    const note = resumeNote(cp);
    expect(note).toContain('断点续跑');
    expect(note).toContain('write_file(a.ts)');
    expect(note).toContain('a.ts');
  });
});

describe('TaskStore checkpoint 持久化', () => {
  it('checkpoint → getCheckpoint 往返', () => {
    tasks.createPlan('s1', planOf([nodeOf('n1')]));
    const cp = { steps: ['write_file(a.ts)'], files: ['a.ts'], updatedAt: 123 };
    tasks.checkpoint('s1', 'n1', cp);
    expect(tasks.getCheckpoint('s1', 'n1')).toEqual(cp);
  });

  it('损坏 JSON → undefined（不阻断重试）', () => {
    tasks.createPlan('s1', planOf([nodeOf('n1')]));
    store.db.prepare("UPDATE tasks SET checkpoint_json = '{bad json' WHERE id = 's1:n1'").run();
    expect(tasks.getCheckpoint('s1', 'n1')).toBeUndefined();
  });

  it('重规划（createPlan 冲突覆盖）清空旧 checkpoint', () => {
    tasks.createPlan('s1', planOf([nodeOf('n1')]));
    tasks.checkpoint('s1', 'n1', { steps: ['x'], files: ['f'], updatedAt: 1 });
    tasks.createPlan('s1', planOf([nodeOf('n1')]));
    expect(tasks.getCheckpoint('s1', 'n1')).toBeUndefined();
  });

  it('重试回队（requeue）保留 checkpoint', () => {
    tasks.createPlan('s1', planOf([nodeOf('n1')]));
    tasks.claim('s1', 'n1', 'w1');
    tasks.checkpoint('s1', 'n1', { steps: ['s'], files: ['f'], updatedAt: 1 });
    tasks.fail('s1', 'n1', 1, 'boom');
    tasks.requeue('s1', 'n1');
    expect(tasks.getCheckpoint('s1', 'n1')?.files).toEqual(['f']);
  });
});

// ── 子任务 / worker pool 集成 ─────────────────────────────────────────────────

function nodeOf(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return { id, goal: `goal ${id}`, deps: [], suggestedTools: [], status: 'pending', retries: 0, ...over };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('runSubTask checkpoint 集成', () => {
  it('执行期记录文件变更并回调 onCheckpoint', async () => {
    const p = new ScriptProvider([
      { toolCall: { name: 'write_file', args: { path: 'cp-test.txt', content: 'hello' } } },
      { text: '已写入文件' },
    ]);
    const seen: Array<{ steps: string[]; files: string[] }> = [];
    const node = nodeOf('n1');
    const res = await runSubTask(node, {
      parent: makeCtx(p),
      planGoal: 'g',
      upstream: new Map(),
      onCheckpoint: (cp) => seen.push({ steps: [...cp.steps], files: [...cp.files] }),
    });
    expect(res.ok).toBe(true);
    // 文件真实写入
    expect(fs.existsSync(path.join(tmpRoot, 'cp-test.txt'))).toBe(true);
    // checkpoint 增量回调，最终清单正确
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)!.files).toEqual(['cp-test.txt']);
    expect(seen.at(-1)!.steps).toEqual(['write_file(cp-test.txt)']);
  });

  it('传入 checkpoint 时在系统提示注入续跑清单', async () => {
    const p = new ScriptProvider([{ text: '直接完成' }]);
    const node = nodeOf('n1');
    await runSubTask(node, {
      parent: makeCtx(p),
      planGoal: 'g',
      upstream: new Map(),
      checkpoint: { steps: ['write_file(a.ts)'], files: ['a.ts'], updatedAt: 1 },
    });
    const sys = p.seenMessages[0]!.find((m) => m.role === 'system');
    expect(sys?.content).toContain('断点续跑');
    expect(sys?.content).toContain('write_file(a.ts)');
    expect(sys?.content).toContain('a.ts');
  });
});

describe('runPlanWithPool 重试幂等（checkpoint 跨重试保留）', () => {
  it('第一次执行写文件后失败 → 重试时注入续跑提示并合并清单', async () => {
    const p = new ScriptProvider([
      // 第 1 次执行：写文件后输出为空 → 视为失败
      { toolCall: { name: 'write_file', args: { path: 'retry1.txt', content: 'v1' } } },
      { text: '' },
      // 第 2 次执行：再写一个文件后成功
      { toolCall: { name: 'write_file', args: { path: 'retry2.txt', content: 'v2' } } },
      { text: '全部完成' },
    ]);
    const ctx = makeCtx(p);
    const plan = planOf([nodeOf('n1')]);
    tasks.createPlan('s1', plan);
    await runPlanWithPool(ctx, plan);
    const row = tasks.get('s1', 'n1')!;
    expect(row.status).toBe('completed');
    // 两次执行的文件变更都进入清单（第 1 次的 checkpoint 在重试中保留并合并）
    expect(tasks.getCheckpoint('s1', 'n1')?.files).toEqual(['retry1.txt', 'retry2.txt']);
    // 第 2 次执行的系统提示包含第 1 次已完成的步骤（跳过不重复）
    const resumeSys = p.seenMessages.some((ms) =>
      ms.some((m) => m.role === 'system' && m.content.includes('retry1.txt') && m.content.includes('断点续跑')),
    );
    expect(resumeSys).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'retry1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'retry2.txt'))).toBe(true);
  });

  it('recoverOrphans 后任务带着 checkpoint 重新可领', async () => {
    const plan = planOf([nodeOf('n1')]);
    tasks.createPlan('s1', plan);
    tasks.claim('s1', 'n1', 'w1');
    tasks.checkpoint('s1', 'n1', { steps: ['write_file(a.ts)'], files: ['a.ts'], updatedAt: 1 });
    // 模拟租约过期：把 lease_until 拨回过去
    store.db
      .prepare("UPDATE tasks SET lease_until = 1 WHERE id = 's1:n1'")
      .run();
    expect(tasks.recoverOrphans('s1')).toBe(1);
    const row = tasks.get('s1', 'n1')!;
    expect(row.status).toBe('queued');
    expect(tasks.getCheckpoint('s1', 'n1')?.files).toEqual(['a.ts']);
  });
});
