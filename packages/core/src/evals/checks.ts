/**
 * F-28 Evals —— 确定性判分器。
 *
 * 全部基于 HeadlessOutcome 的结构化字段（状态 / 结果文本 / 工具调用 / 用量），
 * 无 LLM 评审参与：同一结果多次判分恒一致，回归对比才有意义。
 */
import type { HeadlessOutcome } from '../headless.js';
import type { CheckResult, EvalCheck } from './types.js';

function testRegex(pattern: string, flags: string | undefined, text: string): boolean {
  try {
    return new RegExp(pattern, flags).test(text);
  } catch {
    return false; // 非法正则视为不命中（加载期会校验并提前报错）
  }
}

/** 校验用例 checks 的正则可编译（加载基准集时调用，尽早暴露配置错误）。 */
export function validateChecks(checks: EvalCheck[], where: string): string[] {
  const errors: string[] = [];
  for (const c of checks) {
    if (
      (c.kind === 'result_contains' || c.kind === 'result_not_contains') &&
      c.pattern.length > 0
    ) {
      try {
        new RegExp(c.pattern, c.flags);
      } catch (e) {
        errors.push(`${where}: 非法正则 /${c.pattern}/${c.flags ?? ''} — ${(e as Error).message}`);
      }
    }
  }
  return errors;
}

/** 对一次 headless 结果逐条判分。 */
export function evaluateChecks(checks: EvalCheck[], outcome: HeadlessOutcome): CheckResult[] {
  return checks.map((check) => {
    switch (check.kind) {
      case 'completed': {
        const ok = outcome.status === 'completed';
        return { check, ok, detail: `status=${outcome.status}${outcome.error ? `（${outcome.error}）` : ''}` };
      }
      case 'result_contains': {
        const ok = testRegex(check.pattern, check.flags, outcome.result);
        return { check, ok, detail: ok ? '结果命中' : `结果未命中 /${check.pattern}/${check.flags ?? ''}` };
      }
      case 'result_not_contains': {
        const ok = !testRegex(check.pattern, check.flags, outcome.result);
        return { check, ok, detail: ok ? '结果未出现禁用内容' : `结果命中禁用 /${check.pattern}/${check.flags ?? ''}` };
      }
      case 'tool_used': {
        const n = outcome.toolCalls.filter((c) => c.name === check.name).length;
        const min = check.min ?? 1;
        const ok = n >= min;
        return { check, ok, detail: `${check.name} 调用 ${n} 次（要求 ≥${min}）` };
      }
      case 'tool_used_any': {
        const n = outcome.toolCalls.length;
        const min = check.min ?? 1;
        const ok = n >= min;
        return { check, ok, detail: `工具调用 ${n} 次（要求 ≥${min}）` };
      }
      case 'no_tools': {
        const n = outcome.toolCalls.length;
        const ok = n === 0;
        return { check, ok, detail: ok ? '全程零工具调用' : `工具被调用 ${n} 次（要求 0）` };
      }
      case 'tool_not_used': {
        const n = outcome.toolCalls.filter((c) => c.name === check.name).length;
        const ok = n === 0;
        return { check, ok, detail: ok ? `${check.name} 未被调用` : `${check.name} 被调用 ${n} 次（要求 0）` };
      }
      case 'max_turns': {
        const ok = outcome.turns <= check.value;
        return { check, ok, detail: `轮次 ${outcome.turns}（上限 ${check.value}）` };
      }
      case 'max_cost_usd': {
        const ok = outcome.usage.costUsd <= check.value;
        return { check, ok, detail: `费用 $${outcome.usage.costUsd.toFixed(4)}（上限 $${check.value}）` };
      }
    }
  });
}
