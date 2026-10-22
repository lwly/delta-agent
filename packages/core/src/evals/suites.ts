/**
 * F-28 Evals —— 内置基准集 + 套件加载。
 *
 * 内置集（builtin）：一组与具体项目解耦的通用能力用例（算术 / 文件读取 /
 * 目录检索 / 纯文本禁工具 / 组合任务），用于横评 Provider 与回归基线；
 * 用户可用 `--suite <path>` 加载自己的 JSON 套件（结构同 EvalSuite）。
 */
import * as fs from 'node:fs';
import { validateSuite } from './runner.js';
import type { EvalCase, EvalSuite } from './types.js';

// ── 内置基准集 ──────────────────────────────────────────────────────────────

export const BUILTIN_SUITE_NAME = 'builtin-core';

/**
 * 内置通用能力基准集。设计原则：
 * - 判分全部确定性（正则 / 工具统计 / 轮次与费用上限），无 LLM 评审
 * - 不依赖特定项目结构，可在任意工作目录运行
 * - max_turns / max_cost_usd 兜底，防单用例失控拖垮整套评测
 */
export const BUILTIN_SUITE: EvalSuite = {
  name: BUILTIN_SUITE_NAME,
  description: '通用能力基准：工具使用、文件读取、目录检索、纯文本约束、组合任务',
  cases: [
    {
      id: 'calc-multiply',
      title: '算术：23 × 47',
      task: '计算 23 × 47 的结果。只回答算式和得数一行，不要解释。',
      tags: ['reasoning', 'no-tool'],
      checks: [
        { kind: 'completed' },
        { kind: 'result_contains', pattern: '\\b1081\\b' },
        { kind: 'max_turns', value: 4 },
        { kind: 'tool_not_used', name: 'write_file' },
      ],
    },
    {
      id: 'read-package-name',
      title: '文件读取：package.json 的 name 字段',
      task: '读取当前工作目录下的 package.json，告诉我 name 字段的值。',
      tags: ['tools', 'fs'],
      checks: [
        { kind: 'completed' },
        { kind: 'tool_used', name: 'read_file' },
        { kind: 'result_contains', pattern: 'y-zero-agent' },
        { kind: 'max_turns', value: 6 },
      ],
    },
    {
      id: 'docs-inventory',
      title: '目录检索：docs 下的 Markdown 清单',
      task: '查看当前工作目录的 docs 目录，列出其中所有 .md 文件的文件名（一行一个，只要文件名）。',
      tags: ['tools', 'search'],
      checks: [
        { kind: 'completed' },
        { kind: 'tool_used_any' },
        { kind: 'result_contains', pattern: 'PRD\\.md' },
        { kind: 'max_turns', value: 8 },
      ],
    },
    {
      id: 'no-tool-explain',
      title: '纯文本：零工具调用解释幂等性',
      task: '用不超过 80 字解释「幂等性」是什么。不要使用任何工具。',
      tags: ['reasoning', 'no-tool'],
      checks: [
        { kind: 'completed' },
        { kind: 'no_tools' },
        { kind: 'result_contains', pattern: '幂等' },
        { kind: 'max_turns', value: 2 },
      ],
    },
    {
      id: 'combo-count-tools',
      title: '组合：统计内置工具数量',
      task: '查看当前工作目录 packages/core/src/tools/builtin 目录，数一数里面共有几个工具实现文件，最后单独一行回答「共 N 个」。',
      tags: ['tools', 'search', 'reasoning'],
      checks: [
        { kind: 'completed' },
        { kind: 'tool_used_any' },
        { kind: 'result_contains', pattern: '共\\s*\\d+\\s*个' },
        { kind: 'max_cost_usd', value: 0.5 },
      ],
    },
  ],
};

// ── 套件加载 ────────────────────────────────────────────────────────────────

/**
 * 加载基准集：path 缺省 → 内置集；path 为文件 → JSON 套件（结构校验失败即抛错）。
 * 允许 JSON 用例只写增量字段：缺失的 tags 可省略。
 */
export function loadEvalSuite(path?: string): EvalSuite {
  if (!path) return BUILTIN_SUITE;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`无法读取基准集 ${path}：${(e as Error).message}`);
  }
  const suite = raw as EvalSuite;
  if (!suite || typeof suite !== 'object' || !Array.isArray(suite.cases)) {
    throw new Error(`基准集格式错误（需 {"name": "...", "cases": [...]}）：${path}`);
  }
  const errors = validateSuite(suite);
  if (errors.length > 0) {
    throw new Error(`基准集「${suite.name}」校验失败：\n  ${errors.join('\n  ')}`);
  }
  return suite;
}

/** 用例 id 过滤（逗号分隔）与标签过滤，供 --only / --tag 使用。 */
export function filterCases(suite: EvalSuite, opts: { only?: string; tag?: string }): EvalSuite {
  const only = opts.only ? new Set(opts.only.split(',').map((s) => s.trim()).filter(Boolean)) : undefined;
  return {
    ...suite,
    cases: suite.cases.filter((c: EvalCase) => {
      if (only && !only.has(c.id)) return false;
      if (opts.tag && !(c.tags ?? []).includes(opts.tag)) return false;
      return true;
    }),
  };
}
