/**
 * F-58 Router 台账（design-f58 §8）：`worker_tasks` + `task_inbox` 的投影，不是新表。
 * Router 每轮运行前由 hub 现算一个纯文本块，注入动态提示词段（§8.1）。
 *
 * 红线（§8.2 禁止项）：禁止读 messages（任何会话）、file_changes、工具调用明细——
 * 这些是 Worker 内部过程，Router 不需要且会击穿预算。本模块签名上就没有这些入口，
 * 纯函数零 IO（数据行由调用方从 store 读好后传入）。
 *
 * 台账一份数据两个用途（§8.3）：此文本既是 Router 冷启动的恢复视图，也是 L3 看门狗
 * 偏离判定的参照系（task.goal 原文 + 完成桶最近 5 条 result_summary）——口径必须一致，
 * 否则会出现「Router 认为任务还没做、看门狗认为在重做」的矛盾。任何裁剪规则的改动都
 * 同时影响两个用途。
 */
import type { InboxItem, WorkerTaskRow } from './types.js';

/**
 * estTokens 口径（§8.2，与 llm/providers/openai-compatible.ts:29 注释的共享规则一致）：
 * CJK（含中文标点/全角字符）1 tok/char，latin 3 chars/tok 向上取整。
 * countTokensOf 在 openai-compatible.ts / anthropic.ts 均为模块私有——为不扩大 llm/
 * 的导出面，此处本地实现同一规则（设计稿 §8.2 给出的原文），不 import llm/。
 */
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

export function estTokensOf(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) CJK.test(ch) ? cjk++ : latin++;
  return cjk + Math.ceil(latin / 3);
}

/** 默认预算：estTokens 口径（非字符）。全中文 ≈ 4000 字符、全英文 ≈ 12000 字符（§8.2）。 */
export const LEDGER_BUDGET_TOKENS = 4000;

/** 每行 goal 保留前 200 字、决策摘要 ≤100 字（§8.2 第 1 步行格式）。 */
const GOAL_MAX = 200;
const DECISION_SUMMARY_MAX = 100;

const LEDGER_HEADER = '[系统] 台账（自动维护，任务状态以此为准）';

/** 输入：数据行入参 + budget 可选的纯函数形态（store 读取由调用方 hub 注入处完成）。 */
export interface RouterLedgerInput {
  /** 该 Router 会话的 worker_tasks 全量行（WorkerTaskStore.list 的结果；桶序由本函数内按 §8.2 重排） */
  tasks: WorkerTaskRow[];
  /** 未送达 interrupt（InboxStore.listUndelivered(routerSessionId, {severity:'interrupt'})，全量）；无则省略 */
  interrupts?: InboxItem[];
  /** estTokens 预算，默认 4000 */
  budget?: number;
}

export interface RouterLedger {
  text: string;
  estTokens: number;
}

/** 代码点截断（for..of 迭代），避免劈开代理对。 */
function clip(text: string, max: number): string {
  const cps = [...text];
  return cps.length <= max ? text : cps.slice(0, max).join('');
}

/** 短 id：`[T-<id 前 6 位>]`（§8.2 行格式；id 形如 wt-<uuid>）。 */
function shortId(id: string): string {
  return id.slice(0, 6);
}

/**
 * decision_json → 人类可读片段（≤100 字）。payload 形如 { reason, message }（dispatcher
 * needsDecision 的写入形状），优先 message、其次 reason；解析失败宽容回退为原文。
 */
function decisionSnippet(row: WorkerTaskRow): string {
  if (!row.decision_json) return row.failure_kind ?? '';
  try {
    const d = JSON.parse(row.decision_json) as Record<string, unknown>;
    const message = typeof d.message === 'string' && d.message.trim() !== '' ? d.message : '';
    const reason = typeof d.reason === 'string' && d.reason.trim() !== '' ? d.reason : '';
    const snippet = message || reason || row.failure_kind || row.decision_json;
    return clip(snippet, DECISION_SUMMARY_MAX);
  } catch {
    return clip(row.decision_json, DECISION_SUMMARY_MAX);
  }
}

/**
 * 待办桶行：`[T-x] <status> <title>｜goal 前 200 字｜<failure_kind/decision 摘要 100 字>`。
 * withGoal=false 对应第 4 步的丢 goal 裁剪（needs_decision 永不裁，恒 true）。
 */
function todoLine(row: WorkerTaskRow, withGoal: boolean): string {
  const segs = [`[T-${shortId(row.id)}] ${row.status} ${row.title}`];
  if (withGoal && row.goal) segs.push(clip(row.goal, GOAL_MAX));
  if (row.status === 'needs_decision') {
    const summary = decisionSnippet(row);
    if (summary) segs.push(summary);
  } else if (row.failure_kind) {
    segs.push(row.failure_kind);
  }
  return segs.join('｜');
}

/** 完成桶行：`[T-x] <status> <title>｜result_summary`（§8.2 第 2 步）。 */
function terminalLine(row: WorkerTaskRow): string {
  const segs = [`[T-${shortId(row.id)}] ${row.status} ${row.title}`];
  const summary = row.result_summary ?? row.failure_kind ?? '';
  if (summary) segs.push(summary);
  return segs.join('｜');
}

/** 未送达 interrupt 行：`[T-x] interrupt <title>｜<message/reason>`（payload 形状宽容读取）。 */
function interruptLine(item: InboxItem): string {
  const p = (item.payload ?? {}) as Record<string, unknown>;
  const taskId = typeof p.taskId === 'string' ? p.taskId : '';
  const title = typeof p.title === 'string' ? p.title : '';
  const detail = [p.message, p.reason].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  const segs = [`[T-${taskId ? shortId(taskId) : '未知'}] interrupt ${title}`];
  if (detail) segs.push(clip(detail, DECISION_SUMMARY_MAX));
  return segs.join('｜');
}

/**
 * 台账裁剪（§8.2 五步，逐字实现）：
 * 1. 待办桶（priority DESC, created_at ASC）：needs_decision 全量 → running 全量 → queued 全量；
 * 2. 完成桶：最近 5 条终态（finished_at DESC，与 listTerminalSince 同序）；
 * 3. inbox：未送达 interrupt 全量（调用方传入）；
 * 4. 超预算按序丢弃：完成桶从最旧丢 → queued 只留标题（丢 goal）→ running 丢 goal；
 *    needs_decision 与 interrupt 永不丢（宁可超预算，也不让用户错过需要决策的事）；
 * 5. 硬上限保险：estTokens > 2× 预算 → 只输出计数摘要。
 */
export function buildRouterLedger(input: RouterLedgerInput): RouterLedger {
  const budget = input.budget ?? LEDGER_BUDGET_TOKENS;
  const rows = input.tasks;
  const interrupts = input.interrupts ?? [];

  // 第 1 步：桶序 = priority DESC, created_at ASC（store.list 的默认序，函数内再保证一次）
  const byPriority: (a: WorkerTaskRow, b: WorkerTaskRow) => number =
    (a, b) => b.priority - a.priority || a.created_at - b.created_at;
  const needs = rows.filter((r) => r.status === 'needs_decision').sort(byPriority);
  const running = rows.filter((r) => r.status === 'running').sort(byPriority);
  const queued = rows.filter((r) => r.status === 'queued').sort(byPriority);

  // 第 2 步：完成桶 = 最近 5 条终态（终态 finished_at 非空；容错按 0 处理排最后）
  const terminal = rows
    .filter((r) => r.status === 'done' || r.status === 'failed' || r.status === 'canceled')
    .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0))
    .slice(0, 5);

  const render = (keptTerminal: number, queuedGoal: boolean, runningGoal: boolean): string => {
    const sections: string[] = [LEDGER_HEADER];
    const todoLines = [
      ...needs.map((r) => todoLine(r, true)),
      ...running.map((r) => todoLine(r, runningGoal)),
      ...queued.map((r) => todoLine(r, queuedGoal)),
    ];
    if (todoLines.length > 0) sections.push('待办：', ...todoLines);
    if (keptTerminal > 0) {
      // terminal 按 finished_at DESC 排列，slice(0, keptTerminal) 保留最新、丢最旧（第 4 步）
      sections.push('最近完成：', ...terminal.slice(0, keptTerminal).map(terminalLine));
    }
    if (interrupts.length > 0) {
      sections.push('未送达中断：', ...interrupts.map(interruptLine));
    }
    return sections.join('\n');
  };

  let keptTerminal = terminal.length;
  let queuedGoal = true;
  let runningGoal = true;
  let text = render(keptTerminal, queuedGoal, runningGoal);
  let est = estTokensOf(text);

  // 第 4 步：超预算按序丢弃；可丢项尽后仍超 → 保留（needs_decision/interrupt 永不丢）
  while (est > budget) {
    if (keptTerminal > 0) keptTerminal--;
    else if (queuedGoal) queuedGoal = false;
    else if (runningGoal) runningGoal = false;
    else break;
    text = render(keptTerminal, queuedGoal, runningGoal);
    est = estTokensOf(text);
  }

  // 第 5 步：硬上限保险（2× 预算）——只输出计数摘要
  if (est > budget * 2) {
    const parts: string[] = [];
    if (needs.length > 0) parts.push(`另有 ${needs.length} 个待决策任务`);
    if (running.length > 0) parts.push(`${running.length} 个运行中任务`);
    if (queued.length > 0) parts.push(`${queued.length} 个排队任务`);
    if (interrupts.length > 0) parts.push(`${interrupts.length} 条未送达中断`);
    text = `${LEDGER_HEADER}\n（任务台账超长，降级为计数摘要）${parts.join('，')}`;
    est = estTokensOf(text);
  }

  return { text, estTokens: est };
}
