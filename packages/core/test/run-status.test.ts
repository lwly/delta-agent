/**
 * 架构收口 T5 —— CanonicalRunStatus 映射表单测。
 *
 * 判据 1：映射表覆盖 4 套状态机的**每一个**枚举值（4×N 条用例），
 * 无 undefined、无落到 unknown/枚举外的值；未知输入防御性落到 pending。
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalRunStatus } from '@delta/shared';
import { fromPlanTask, fromWorkerTask, fromCronRun, fromBgTask } from '../src/run-status.js';

const CANONICAL: readonly CanonicalRunStatus[] = [
  'pending',
  'queued',
  'running',
  'needs_input',
  'succeeded',
  'failed',
  'canceled',
];

/** 断言映射结果合法且逐值覆盖 */
function expectAllMapped(
  machine: string,
  fn: (s: string | undefined) => CanonicalRunStatus,
  inputs: string[],
  expected: Record<string, CanonicalRunStatus>,
): void {
  for (const input of inputs) {
    const got = fn(input);
    expect(got, `${machine}:${input}`).toBeDefined();
    expect(CANONICAL, `${machine}:${input} → ${got}`).toContain(got);
    expect(got, `${machine}:${input}`).toBe(expected[input]!);
  }
  // undefined（无记录）也有确定映射，不返回 undefined
  expect(fn(undefined)).toBeDefined();
  expect(CANONICAL).toContain(fn(undefined));
}

describe('T5 fromPlanTask（tasks 表状态机，逐值覆盖）', () => {
  it('5 个枚举值全部映射', () => {
    expectAllMapped('plan', fromPlanTask, ['queued', 'running', 'completed', 'failed', 'canceled'], {
      queued: 'queued',
      running: 'running',
      completed: 'succeeded',
      failed: 'failed',
      canceled: 'canceled',
    });
  });
});

describe('T5 fromWorkerTask（worker_tasks 状态机，逐值覆盖）', () => {
  it('8 个枚举值全部映射', () => {
    expectAllMapped(
      'worker',
      fromWorkerTask,
      ['draft', 'queued', 'preflight', 'running', 'needs_decision', 'done', 'failed', 'canceled'],
      {
        draft: 'pending',
        queued: 'queued',
        preflight: 'pending',
        running: 'running',
        needs_decision: 'needs_input',
        done: 'succeeded',
        failed: 'failed',
        canceled: 'canceled',
      },
    );
  });
});

describe('T5 fromCronRun（cron 运行记录状态机，逐值覆盖）', () => {
  it('7 个枚举值全部映射；缺失记录 → pending', () => {
    expectAllMapped(
      'cron',
      fromCronRun,
      ['completed', 'failed', 'max_turns', 'budget_exhausted', 'aborted', 'timeout', 'error'],
      {
        completed: 'succeeded',
        failed: 'failed',
        max_turns: 'failed',
        budget_exhausted: 'failed',
        aborted: 'canceled',
        timeout: 'failed',
        error: 'failed',
      },
    );
    expect(fromCronRun(undefined)).toBe('pending'); // 从未运行
  });
});

describe('T5 fromBgTask（后台命令状态机，逐值覆盖）', () => {
  it('4 个枚举值全部映射', () => {
    expectAllMapped('bg', fromBgTask, ['running', 'done', 'failed', 'killed'], {
      running: 'running',
      done: 'succeeded',
      failed: 'failed',
      killed: 'canceled',
    });
  });
});

describe('T5 防御分支', () => {
  it('未知输入落到 pending（绝不返回枚举外值 / undefined）', () => {
    for (const fn of [fromPlanTask, fromWorkerTask, fromCronRun, fromBgTask]) {
      expect(fn('bogus-status')).toBe('pending');
      expect(fn('')).toBe('pending');
      expect(CANONICAL).toContain(fn('bogus-status'));
    }
  });
});
