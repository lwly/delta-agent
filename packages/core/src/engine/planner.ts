/**
 * Planner（agent-modes-design §3.1/§3.2、§4 决策层）
 * - detectSimpleTask: 启发式第一层（关键词/意图分类）
 * - buildPlan: LLM 一次调用产出 DAG JSON，解析失败/结构非法时带错误反馈修复重试
 */
import type { LLMProvider, Plan, TaskNode, TaskRole, Usage } from '@y-zero/shared';
import { validatePlan } from './plan.js';

/** 复杂信号关键词：命中即判复杂（重构/迁移/批量/多模块）。 */
const COMPLEX_KEYWORDS = [
  '重构', '迁移', '批量', '全面', '系统性', '架构', '多模块', '跨文件',
  'refactor', 'migrate', 'migration', 'batch', 'bulk', 'across', 'overhaul', 'rewrite',
];

/** 简单信号：问答 / 单文件修改 / 信息查询类前缀。 */
const SIMPLE_PATTERNS = [
  /^(什么是|为什么|如何理解|介绍一下|解释|说明)/,
  /^(what|why|how (does|do|to understand)|explain|tell me about)\b/i,
  /^(查看|查询|看一下|读一下|搜索|查找)\b/,
];

/**
 * 简单任务检测（启发式第一层，保持原语义：不确定时短输入偏简单）。
 * 两层分类的完整入口见 resolveSimpleTask。
 */
export function detectSimpleTask(input: string): boolean {
  const v = classifyByRules(input);
  if (v === 'strong-simple') return true;
  if (v === 'strong-complex') return false;
  return input.trim().length < 120;
}

/** 规则判定三值：强简单 / 强复杂 / 不确定（需 LLM 兜底）。 */
export type RuleVerdict = 'strong-simple' | 'strong-complex' | 'ambiguous';
export type ComplexityVerdict = 'simple' | 'complex';

/** 规则层：关键词命中或多文件信号 → 强复杂；问答/查询前缀 → 强简单；其余不确定。 */
export function classifyByRules(input: string): RuleVerdict {
  const text = input.trim();
  if (!text) return 'strong-simple';
  const lower = text.toLowerCase();
  if (COMPLEX_KEYWORDS.some((k) => lower.includes(k))) return 'strong-complex';
  // 多文件/多模块信号：≥2 个路径状 token 或代码引用
  const pathLike = text.match(/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|md|json)\b/g);
  if (pathLike && pathLike.length >= 2) return 'strong-complex';
  if (SIMPLE_PATTERNS.some((re) => re.test(text))) return 'strong-simple';
  return 'ambiguous';
}

const CLASSIFIER_SYSTEM = `你是任务复杂度分类器。判断用户输入是「简单任务」还是「复杂任务」：
- simple：问答/解释/信息查询、单文件小修改，无需多步协作
- complex：多步骤/多文件/跨模块改动、重构、迁移、批量处理，或需要任务规划执行
严格输出 JSON（不要 markdown 代码块、不要解释文字）：
{"complexity":"simple|complex","reason":"一句话理由"}`;

export interface ClassifyOptions {
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * 用量回调（费用口径闭环）：分类属编排层 LLM 调用，此前不进预算与会话用量，
   * 现按次回调实际用量，由编排层 record 预算并转 usage 事件。
   */
  onUsage?: (usage: Usage) => void;
}

/**
 * LLM 兜底分类（agent-modes-design §3.1 第二层）：一次小调用返回 simple|complex。
 * LLM 出错或输出解析不出 → 返回 undefined，由调用方回退规则默认。
 */
export async function classifyComplexity(
  provider: LLMProvider,
  model: string,
  input: string,
  opts: ClassifyOptions = {},
): Promise<ComplexityVerdict | undefined> {
  let text = '';
  try {
    for await (const ev of provider.chat({
      messages: [
        { role: 'system' as const, content: CLASSIFIER_SYSTEM },
        { role: 'user' as const, content: input.trim() },
      ],
      tools: [],
      model,
      maxTokens: opts.maxTokens ?? 256,
      signal: opts.signal,
    })) {
      if (ev.type === 'text_delta') text += ev.text;
      if (ev.type === 'usage') {
        const u: Usage = { inputTokens: ev.input, outputTokens: ev.output };
        opts.onUsage?.(u);
      }
      if (ev.type === 'error') return undefined;
    }
  } catch {
    return undefined;
  }
  try {
    const obj = extractJson(text) as { complexity?: unknown };
    if (obj?.complexity === 'complex') return 'complex';
    if (obj?.complexity === 'simple') return 'simple';
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 两层分类入口：规则强判定直接用；不确定时 LLM 兜底一次；
 * 兜底失败（undefined）回退规则默认（短输入偏简单）。
 */
export async function resolveSimpleTask(
  provider: LLMProvider,
  model: string,
  input: string,
  opts: ClassifyOptions = {},
): Promise<boolean> {
  const v = classifyByRules(input);
  if (v !== 'ambiguous') return v === 'strong-simple';
  const llm = await classifyComplexity(provider, model, input, opts);
  return llm ? llm === 'simple' : detectSimpleTask(input);
}

const ROLES: TaskRole[] = ['worker', 'researcher', 'writer', 'tool-caller'];

const PLANNER_SYSTEM = `你是任务规划器。把用户目标分解为一个 DAG 任务图，每个节点是可独立执行的子任务。
严格输出 JSON（不要 markdown 代码块、不要解释文字），结构：
{
  "goal": "总目标",
  "nodes": [
    {
      "id": "n1",
      "goal": "子任务目标（自然语言，可独立执行）",
      "deps": ["依赖的上游节点 id"],
      "suggestedTools": ["read_file", "grep_search"],
      "role": "worker",
      "critical": false
    }
  ]
}
要求：
- 节点数 2-8；依赖关系必须是 DAG（无环）
- 第一个节点无依赖；每个节点 goal 要自包含（不依赖对话上下文即可执行）
- role 仅允许 worker/researcher/writer/tool-caller；默认 worker
- critical 仅在子任务失败会导致整体无意义时为 true
- suggestedTools 从内置工具中选，可省略`;

export interface PlanOptions {
  maxNodes?: number;
  /** 规划调用最大修复重试次数（默认 2） */
  maxRetries?: number;
  signal?: AbortSignal;
  /**
   * 用量回调（费用口径闭环）：规划可能多次修复重试，每次调用的实际用量
   * 都回调给编排层统一 record 预算并转 usage 事件。
   */
  onUsage?: (usage: Usage) => void;
}

interface RawNode {
  id?: unknown;
  goal?: unknown;
  deps?: unknown;
  suggestedTools?: unknown;
  role?: unknown;
  critical?: unknown;
}

/** 从 LLM 输出中提取 JSON（容忍 ```json 围栏与前后缀文本）。 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no json object found in planner output');
  return JSON.parse(body.slice(start, end + 1));
}

/** 归一化 LLM 产出的节点（宽松修复：id 补齐、deps 字符串化、非法 role 降级 worker）。 */
export function normalizeNodes(raw: unknown, maxNodes: number): TaskNode[] {
  const obj = raw as { goal?: unknown; nodes?: unknown };
  const list = Array.isArray(obj?.nodes) ? (obj.nodes as RawNode[]) : [];
  if (list.length === 0) throw new Error('planner output has no nodes');
  const seen = new Set<string>();
  const nodes: TaskNode[] = [];
  for (const item of list.slice(0, maxNodes)) {
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `n${nodes.length + 1}`;
    while (seen.has(id)) id = `${id}_x`;
    seen.add(id);
    const depsRaw = Array.isArray(item.deps) ? item.deps : [];
    const deps = depsRaw
      .map((d) => String(d).trim())
      .filter((d) => d && d !== id);
    const role = ROLES.includes(item.role as TaskRole) ? (item.role as TaskRole) : 'worker';
    nodes.push({
      id,
      goal: String(item.goal ?? '').trim(),
      deps,
      suggestedTools: Array.isArray(item.suggestedTools) ? item.suggestedTools.map(String) : [],
      role,
      critical: Boolean(item.critical),
      status: 'pending',
      retries: 0,
    });
  }
  return nodes;
}

/**
 * LLM 规划：产出并校验 DAG；解析/校验失败时把错误回喂修复重试。
 */
export async function buildPlan(
  provider: LLMProvider,
  model: string,
  goal: string,
  opts: PlanOptions = {},
): Promise<Plan> {
  const maxRetries = opts.maxRetries ?? 2;
  const maxNodes = opts.maxNodes ?? 8;
  const userMsg = `总目标：${goal}\n\n请输出 DAG 任务图 JSON。`;
  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw new Error('aborted by user');
    const messages = [
      { role: 'system' as const, content: PLANNER_SYSTEM },
      {
        role: 'user' as const,
        content: lastError ? `${userMsg}\n\n上次输出的问题（请修复后重新输出完整 JSON）：\n${lastError}` : userMsg,
      },
    ];
    let text = '';
    for await (const ev of provider.chat({
      messages,
      tools: [],
      model,
      maxTokens: 4096,
      signal: opts.signal,
    })) {
      if (ev.type === 'text_delta') text += ev.text;
      if (ev.type === 'usage') {
        const u: Usage = { inputTokens: ev.input, outputTokens: ev.output };
        opts.onUsage?.(u);
      }
      if (ev.type === 'error') throw new Error(`planner llm error: ${ev.message}`);
    }
    try {
      const plan: Plan = {
        goal: goal,
        nodes: normalizeNodes(extractJson(text), maxNodes),
        revision: 1,
        createdAt: Date.now(),
      };
      const problems = validatePlan(plan);
      if (problems.length > 0) {
        lastError = problems.join('\n');
        continue;
      }
      return plan;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  throw new Error(`planner failed to produce a valid DAG after ${maxRetries + 1} attempts: ${lastError}`);
}
