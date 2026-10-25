import { describe, expect, it } from 'vitest';
import type { Plan, TaskNode } from '@delta/shared';
import {
  isReady,
  maxParallelism,
  skipDownstream,
  topoLayers,
  validatePlan,
  PlanValidationError,
} from '../src/engine/plan.js';
import {
  buildPlan,
  detectSimpleTask,
  extractJson,
  normalizeNodes,
} from '../src/engine/planner.js';
import { RestrictedRegistry } from '../src/engine/roles.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@delta/shared';

function node(id: string, deps: string[] = [], over: Partial<TaskNode> = {}): TaskNode {
  return { id, goal: `goal ${id}`, deps, suggestedTools: [], status: 'pending', retries: 0, ...over };
}

describe('topoLayers / validatePlan', () => {
  it('layers a diamond DAG', () => {
    const plan: Plan = { goal: 'g', revision: 1, createdAt: 0, nodes: [node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])] };
    const layers = topoLayers(plan.nodes);
    expect(layers.map((l) => l.map((n) => n.id).sort())).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(validatePlan(plan)).toEqual([]);
    expect(maxParallelism(plan.nodes)).toBe(2);
  });

  it('rejects cycles and unknown deps', () => {
    const cyclic: Plan = { goal: 'g', revision: 1, createdAt: 0, nodes: [node('a', ['b']), node('b', ['a'])] };
    expect(() => topoLayers(cyclic.nodes)).toThrow(PlanValidationError);
    expect(validatePlan(cyclic).join('\n')).toMatch(/cycle/);

    const unknown: Plan = { goal: 'g', revision: 1, createdAt: 0, nodes: [node('a', ['ghost'])] };
    expect(validatePlan(unknown).join('\n')).toMatch(/unknown dependency/);
  });

  it('flags empty goals and duplicate ids', () => {
    const bad: Plan = {
      goal: 'g', revision: 1, createdAt: 0,
      nodes: [node('a', [], { goal: '' }), node('a'), node('')],
    };
    const problems = validatePlan(bad);
    expect(problems.some((p) => p.includes('goal is empty'))).toBe(true);
    expect(problems.some((p) => p.includes('duplicate node id'))).toBe(true);
  });

  it('skipDownstream marks transitive successors', () => {
    const nodes = [node('a'), node('b', ['a']), node('c', ['b']), node('x')];
    skipDownstream(nodes, 'a');
    expect(nodes.find((n) => n.id === 'b')!.status).toBe('skipped');
    expect(nodes.find((n) => n.id === 'c')!.status).toBe('skipped');
    expect(nodes.find((n) => n.id === 'x')!.status).toBe('pending');
    expect(isReady(nodes[3]!, nodes)).toBe(true);
  });
});

describe('detectSimpleTask', () => {
  it('detects simple Q&A and lookups', () => {
    expect(detectSimpleTask('什么是闭包？')).toBe(true);
    expect(detectSimpleTask('看一下 README')).toBe(true);
    expect(detectSimpleTask('explain how promises work')).toBe(true);
  });

  it('flags refactor/migration/multi-file signals as complex', () => {
    expect(detectSimpleTask('重构整个项目的错误处理')).toBe(false);
    expect(detectSimpleTask('把 a.ts 和 b.ts 的公共逻辑抽出来')).toBe(false);
    expect(detectSimpleTask('批量修改所有测试文件中的断言风格')).toBe(false);
  });
});

describe('planner JSON handling', () => {
  it('extractJson tolerates fences and prose', () => {
    const raw = '好的，以下是计划：\n```json\n{"goal":"g","nodes":[{"id":"n1","goal":"x"}]}\n```\n请确认。';
    const parsed = extractJson(raw) as { goal: string };
    expect(parsed.goal).toBe('g');
  });

  it('normalizeNodes repairs ids/deps/roles', () => {
    const nodes = normalizeNodes(
      { nodes: [{ goal: 'a' }, { id: 'n1', goal: 'b', deps: ['n1'], role: 'boss' }, { id: 'n1', goal: 'c' }] },
      8,
    );
    expect(nodes.map((n) => n.id)).toEqual(['n1', 'n1_x', 'n1_x_x']);
    expect(nodes[1]!.role).toBe('worker');
    expect(nodes[1]!.deps).toEqual(['n1']); // 撞名后不再是自依赖
    const self = normalizeNodes({ nodes: [{ id: 'x', goal: 'a', deps: ['x'] }] }, 8);
    expect(self[0]!.deps).toEqual([]); // 自依赖移除
  });

  it('buildPlan validates and repairs with error feedback', async () => {
    const bad = '{"goal":"g","nodes":[{"id":"a","goal":"x","deps":["missing"]}]}';
    const good = '{"goal":"g","nodes":[{"id":"a","goal":"x"},{"id":"b","goal":"y","deps":["a"]}]}';
    const calls: string[] = [];
    const provider: LLMProvider = {
      id: 'mock',
      async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
        calls.push(req.messages.at(-1)!.content);
        yield { type: 'text_delta', text: calls.length === 1 ? bad : good };
        yield { type: 'done' };
      },
      estimateTokens: (m: ChatMessage[]) => m.length,
    };
    const plan = await buildPlan(provider, 'm', '总目标');
    expect(plan.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('unknown dependency');
  });
});

describe('RestrictedRegistry', () => {
  it('filters definitions and blocks non-allowlisted calls', async () => {
    const base = new ToolRegistry();
    const rr = new RestrictedRegistry(base, new Set(['read_file']));
    expect(rr.definitions().map((d) => d.name)).toEqual(['read_file']);
    const results = await rr.executeAll(
      [
        { id: '1', name: 'read_file', argsJson: '{"path":"package.json"}' },
        { id: '2', name: 'run_command', argsJson: '{"command":"ls"}' },
      ],
      {
        projectRoot: process.cwd(),
        signal: new AbortController().signal,
        confirm: async () => ({ kind: 'allow' }),
        askUser: async () => 'ok',
        todos: [],
      },
    );
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
    expect(results[1]!.error).toBe('tool_not_allowed');
  });
});
