/**
 * Planner（agent-modes-design §3.1/§3.2、§4 决策层）
 * - detectSimpleTask: 启发式第一层（关键词/意图分类）
 * - buildPlan: LLM 一次调用产出 DAG JSON，解析失败/结构非法时带错误反馈修复重试
 */
import type { LLMProvider, Plan, TaskNode, TaskRole } from '@y-zero/shared';
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
 * 简单任务检测（启发式第一层）。返回 true 时跳过规划直达 ReAct。
 * LLM 兜底分类与用户强制（/plan /direct）由调用方处理。
 */
export function detectSimpleTask(input: string): boolean {
  const text = input.trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  if (COMPLEX_KEYWORDS.some((k) => lower.includes(k))) return false;
  // 多文件/多模块信号：≥2 个路径状 token 或代码引用
  const pathLike = text.match(/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|md|json)\b/g);
  if (pathLike && pathLike.length >= 2) return false;
  if (SIMPLE_PATTERNS.some((re) => re.test(text))) return true;
  // 默认：短输入偏简单
  return text.length < 120;
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
