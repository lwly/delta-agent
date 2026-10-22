import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HeadlessOutcome } from '../src/headless.js';
import { evaluateChecks, validateChecks } from '../src/evals/checks.js';
import { runEvalSuite, validateSuite } from '../src/evals/runner.js';
import { BUILTIN_SUITE, filterCases, loadEvalSuite } from '../src/evals/suites.js';
import {
  buildBaseline,
  compareBaseline,
  loadBaseline,
  renderComparison,
  renderComparisonText,
  renderSuiteRun,
  saveBaseline,
} from '../src/evals/report.js';
import type { CaseRunner, EvalCase, EvalSuite, SuiteRun } from '../src/evals/types.js';

// ── 伪造设施 ────────────────────────────────────────────────────────────────

function makeOutcome(over: Partial<HeadlessOutcome> = {}): HeadlessOutcome {
  return {
    status: 'completed',
    result: '共 1081 个结果',
    transcript: '共 1081 个结果',
    turns: 2,
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
    toolCalls: [{ id: 'c1', name: 'read_file', ok: true }],
    todos: [],
    deniedConfirmations: [],
    askUserQuestions: [],
    planApprovals: 0,
    error: null,
    durationMs: 500,
    sessionId: 's1',
    projectId: 'p1',
    ...over,
  };
}

const CASE: EvalCase = {
  id: 'demo',
  title: '演示用例',
  task: '做一件事',
  checks: [
    { kind: 'completed' },
    { kind: 'result_contains', pattern: '1081' },
    { kind: 'tool_used', name: 'read_file' },
    { kind: 'max_turns', value: 3 },
  ],
};

// ── evaluateChecks ──────────────────────────────────────────────────────────

describe('evaluateChecks', () => {
  it('全部通过：completed + result_contains + tool_used + max_turns', () => {
    const rs = evaluateChecks(CASE.checks, makeOutcome());
    expect(rs.map((r) => r.ok)).toEqual([true, true, true, true]);
  });

  it('result_not_contains：命中禁用内容判失败；flags 生效', () => {
    const out = makeOutcome({ result: '密码是 SECRET-123' });
    expect(evaluateChecks([{ kind: 'result_not_contains', pattern: 'SECRET' }], out)[0]!.ok).toBe(false);
    expect(
      evaluateChecks([{ kind: 'result_not_contains', pattern: 'secret', flags: 'i' }], out)[0]!.ok,
    ).toBe(false);
    expect(evaluateChecks([{ kind: 'result_not_contains', pattern: '密码不在这里' }], out)[0]!.ok).toBe(true);
  });

  it('tool_used 计数与 min；tool_not_used 零容忍', () => {
    const out = makeOutcome({
      toolCalls: [
        { id: 'c1', name: 'grep_search', ok: true },
        { id: 'c2', name: 'grep_search', ok: true },
        { id: 'c3', name: 'write_file', ok: true },
      ],
    });
    expect(evaluateChecks([{ kind: 'tool_used', name: 'grep_search' }], out)[0]!.ok).toBe(true);
    expect(evaluateChecks([{ kind: 'tool_used', name: 'grep_search', min: 3 }], out)[0]!.ok).toBe(false);
    expect(evaluateChecks([{ kind: 'tool_not_used', name: 'write_file' }], out)[0]!.ok).toBe(false);
  });

  it('tool_used_any 与 no_tools', () => {
    expect(evaluateChecks([{ kind: 'tool_used_any' }], makeOutcome())[0]!.ok).toBe(true);
    expect(evaluateChecks([{ kind: 'no_tools' }], makeOutcome())[0]!.ok).toBe(false);
    expect(
      evaluateChecks([{ kind: 'no_tools' }], makeOutcome({ toolCalls: [] }))[0]!.ok,
    ).toBe(true);
  });

  it('max_cost_usd：费用超限失败', () => {
    const out = makeOutcome({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 } });
    expect(evaluateChecks([{ kind: 'max_cost_usd', value: 0.4 }], out)[0]!.ok).toBe(false);
    expect(evaluateChecks([{ kind: 'max_cost_usd', value: 0.5 }], out)[0]!.ok).toBe(true);
  });

  it('非 completed 状态：completed 判失败且 detail 带错误信息', () => {
    const rs = evaluateChecks([{ kind: 'completed' }], makeOutcome({ status: 'failed', error: 'boom' }));
    expect(rs[0]!.ok).toBe(false);
    expect(rs[0]!.detail).toContain('boom');
  });

  it('validateChecks：非法正则被检出', () => {
    const errs = validateChecks([{ kind: 'result_contains', pattern: '([bad' }], 'case-x');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('case-x');
  });
});

// ── runEvalSuite ────────────────────────────────────────────────────────────

describe('runEvalSuite', () => {
  const suite: EvalSuite = {
    name: 't-suite',
    cases: [CASE, { ...CASE, id: 'demo-2', title: '演示用例 2', task: '做另一件事' }],
  };

  it('顺序执行 + 判分 + 汇总（全通过）', async () => {
    const done: string[] = [];
    const run = await runEvalSuite(
      suite,
      async () => makeOutcome(),
      {
        provider: 'mock',
        model: 'm1',
        onCaseDone: (r) => done.push(r.caseId),
      },
    );
    expect(run.suite).toBe('t-suite');
    expect(run.provider).toBe('mock');
    expect(run.summary).toMatchObject({ total: 2, passed: 2, failed: 0, passRate: 1 });
    expect(run.summary.avgTurns).toBe(2);
    expect(run.summary.totalCostUsd).toBeCloseTo(0.02);
    expect(done).toEqual(['demo', 'demo-2']);
    expect(run.results[0]!.checks).toHaveLength(4);
  });

  it('失败用例：failures 汇总 + passed=false，继续跑后续用例', async () => {
    const run = await runEvalSuite(
      suite,
      async (task) =>
        task === '做一件事'
          ? makeOutcome({ result: '答非所问', toolCalls: [] })
          : makeOutcome(),
      { provider: 'mock', model: 'm1' },
    );
    expect(run.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(run.results[0]!.passed).toBe(false);
    expect(run.results[0]!.failures).toHaveLength(2); // result 未命中 + read_file 未调用；completed/max_turns 通过
  });

  it('执行器异常：记为失败用例不中断整套', async () => {
    const run = await runEvalSuite(
      suite,
      async (task) => {
        if (task === '做一件事') throw new Error('provider 断连');
        return makeOutcome();
      },
      { provider: 'mock', model: 'm1' },
    );
    expect(run.results[0]!.passed).toBe(false);
    expect(run.results[0]!.error).toBe('provider 断连');
    expect(run.results[1]!.passed).toBe(true);
    expect(run.summary.failed).toBe(1);
  });

  it('validateSuite：重复 id / 缺 task / 缺 checks / 非法正则', () => {
    const errs = validateSuite({
      name: 'bad',
      cases: [
        { id: 'a', title: 'x', task: '', checks: [{ kind: 'completed' }] },
        { id: 'a', title: 'y', task: 't', checks: [] },
        { id: 'b', title: 'z', task: 't', checks: [{ kind: 'result_contains', pattern: '((' }] },
      ],
    });
    expect(errs.some((e) => e.includes('缺少 task'))).toBe(true);
    expect(errs.some((e) => e.includes('id 重复'))).toBe(true);
    expect(errs.some((e) => e.includes('缺少 checks'))).toBe(true);
    expect(errs.some((e) => e.includes('非法正则'))).toBe(true);
  });

  it('配置错误直接抛错（非法正则不进运行期）', async () => {
    await expect(
      runEvalSuite(
        { name: 'bad', cases: [{ ...CASE, checks: [{ kind: 'result_contains', pattern: '*bad' }] }] },
        async () => makeOutcome(),
        { provider: 'mock', model: 'm' },
      ),
    ).rejects.toThrow('配置错误');
  });
});

// ── 内置基准集 / 加载 / 过滤 ────────────────────────────────────────────────

describe('suites', () => {
  it('内置套件自洽：校验通过且判分规则非空', () => {
    expect(validateSuite(BUILTIN_SUITE)).toEqual([]);
    expect(BUILTIN_SUITE.cases.length).toBeGreaterThanOrEqual(5);
  });

  it('loadEvalSuite：JSON 文件加载 + 校验失败抛错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
    const file = path.join(dir, 'suite.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ name: 'custom', cases: [{ id: 'c1', title: 't', task: 'x', checks: [{ kind: 'completed' }] }] }),
    );
    const suite = loadEvalSuite(file);
    expect(suite.name).toBe('custom');
    expect(suite.cases).toHaveLength(1);
    fs.writeFileSync(file, JSON.stringify({ name: 'bad', cases: [{ id: '', title: 't', task: 'x', checks: [{ kind: 'completed' }] }] }));
    expect(() => loadEvalSuite(file)).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('filterCases：--only 与 --tag', () => {
    const only = filterCases(BUILTIN_SUITE, { only: 'calc-multiply,no-tool-explain' });
    expect(only.cases.map((c) => c.id)).toEqual(['calc-multiply', 'no-tool-explain']);
    const tag = filterCases(BUILTIN_SUITE, { tag: 'no-tool' });
    expect(tag.cases.map((c) => c.id)).toEqual(['calc-multiply', 'no-tool-explain']);
  });
});

// ── 报告与基线 ──────────────────────────────────────────────────────────────

describe('report', () => {
  function fakeRun(over: Partial<SuiteRun> = {}): SuiteRun {
    return {
      suite: 's',
      provider: 'mock',
      model: 'm1',
      startedAt: '2026-10-22T00:00:00.000Z',
      durationMs: 1200,
      results: [
        {
          caseId: 'a',
          title: '用例 A',
          passed: true,
          checks: [],
          failures: [],
          status: 'completed',
          turns: 2,
          durationMs: 600,
          usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
          toolCalls: 2,
          error: null,
          resultExcerpt: 'ok',
        },
        {
          caseId: 'b',
          title: '用例 B',
          passed: false,
          checks: [],
          failures: ['结果未命中 /x/'],
          status: 'completed',
          turns: 5,
          durationMs: 600,
          usage: { inputTokens: 200, outputTokens: 40, costUsd: 0.02 },
          toolCalls: 1,
          error: null,
          resultExcerpt: 'nope',
        },
      ],
      summary: {
        total: 2,
        passed: 1,
        failed: 1,
        passRate: 0.5,
        totalInputTokens: 300,
        totalOutputTokens: 60,
        totalCostUsd: 0.03,
        avgTurns: 3.5,
        avgDurationMs: 600,
      },
      ...over,
    };
  }

  it('renderSuiteRun：含通过率与失败明细', () => {
    const md = renderSuiteRun(fakeRun());
    expect(md).toContain('Evals 报告：s');
    expect(md).toContain('1/2（50%）');
    expect(md).toContain('| b ❌ |');
    expect(md).toContain('结果未命中 /x/');
    expect(md).toContain('失败用例详情');
  });

  it('renderComparison：多 provider 表格 + 最优标注', () => {
    const md = renderComparison([fakeRun(), fakeRun({ provider: 'other', model: 'm2' })]);
    expect(md).toContain('Evals 横向对比');
    expect(md).toContain('`mock`');
    expect(md).toContain('`other`');
    expect(md).toContain('综合最优');
  });

  it('baseline：save/load 往返 + compareBaseline 回归/改进/增删', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-b-'));
    const file = path.join(dir, 'baseline.json');
    const baseRun = fakeRun(); // a 通过 / b 失败
    saveBaseline(file, baseRun);
    const baseline = loadBaseline(file);
    expect(baseline.cases).toEqual({ a: true, b: false });

    // 回归：a 通过→失败；改进：b 失败→通过；新增 c / 移除 d
    const current = fakeRun({
      results: [
        { ...baseRun.results[0]!, passed: false, failures: ['结果未命中 /y/'] },
        { ...baseRun.results[1]!, passed: true, failures: [] },
        { caseId: 'c', title: '新用例', passed: true, checks: [], failures: [], status: 'completed', turns: 1, durationMs: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, toolCalls: 0, error: null, resultExcerpt: '' },
      ],
      summary: { ...baseRun.summary, passed: 2, failed: 0, passRate: 2 / 3 },
    });
    const cmp = compareBaseline(current, baseline);
    expect(cmp.ok).toBe(false);
    expect(cmp.regressions).toEqual([{ caseId: 'a', title: '用例 A', failures: ['结果未命中 /y/'] }]);
    expect(cmp.improvements.map((i) => i.caseId)).toEqual(['b']);
    expect(cmp.added).toEqual(['c']);
    expect(cmp.removed).toEqual([]);

    // 无回归：与基线一致
    const cmp2 = compareBaseline(baseRun, baseline);
    expect(cmp2.ok).toBe(true);
    expect(cmp2.regressions).toHaveLength(0);
    expect(renderComparisonText(cmp2)).toContain('回归检查通过');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── CaseRunner 契约（类型层面引用，防漂移）──────────────────────────────────

describe('caseRunner contract', () => {
  it('runEvalSuite 传入的 runner 收到用例 task 原文', async () => {
    const seen: string[] = [];
    const runner: CaseRunner = async (task) => {
      seen.push(task);
      return makeOutcome();
    };
    await runEvalSuite({ name: 's', cases: [CASE] }, runner, { provider: 'p', model: 'm' });
    expect(seen).toEqual(['做一件事']);
  });
});
