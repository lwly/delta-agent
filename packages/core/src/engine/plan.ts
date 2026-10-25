/**
 * Plan DAG 基础设施（agent-modes-design §3.2）
 * - validatePlan: 结构校验（id 唯一 / deps 存在 / goal 非空 / 无环）
 * - topoLayers: Kahn 分层拓扑，层内可并行
 * - skipDownstream: 失败节点的全部后继标 skipped
 */
import type { Plan, TaskNode } from '@delta/shared';

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

/** 结构校验，返回问题列表（空 = 合法）。 */
export function validatePlan(plan: Plan): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (!plan.goal?.trim()) problems.push('plan.goal is empty');
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    problems.push('plan has no nodes');
    return problems;
  }
  for (const n of plan.nodes) {
    if (!n.id?.trim()) problems.push('node id is empty');
    else if (ids.has(n.id)) problems.push(`duplicate node id: ${n.id}`);
    else ids.add(n.id);
    if (!n.goal?.trim()) problems.push(`node ${n.id || '?'}: goal is empty`);
  }
  for (const n of plan.nodes) {
    for (const d of n.deps ?? []) {
      if (!ids.has(d)) problems.push(`node ${n.id}: unknown dependency "${d}"`);
      else if (d === n.id) problems.push(`node ${n.id}: depends on itself`);
    }
  }
  try {
    topoLayers(plan.nodes);
  } catch (e) {
    problems.push((e as Error).message);
  }
  return problems;
}

/** Kahn 分层拓扑：返回逐层节点数组；有环抛 PlanValidationError。 */
export function topoLayers(nodes: TaskNode[]): TaskNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  const succ = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    succ.set(n.id, []);
  }
  for (const n of nodes) {
    const deps = new Set(n.deps ?? []);
    for (const d of deps) {
      if (!byId.has(d)) continue; // validatePlan 已单独报 unknown dep
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
      succ.get(d)!.push(n.id);
    }
  }
  const layers: TaskNode[][] = [];
  let frontier = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  let visited = 0;
  while (frontier.length > 0) {
    visited += frontier.length;
    layers.push(frontier.map((id) => byId.get(id)!));
    const next: string[] = [];
    for (const id of frontier) {
      for (const s of succ.get(id) ?? []) {
        const left = (indeg.get(s) ?? 0) - 1;
        indeg.set(s, left);
        if (left === 0) next.push(s);
      }
    }
    frontier = next;
  }
  if (visited !== nodes.length) {
    throw new PlanValidationError('plan dag contains a dependency cycle');
  }
  return layers;
}

/** 失败（或被跳过）节点的全部直接/间接后继标 skipped。返回被标记的节点。 */
export function skipDownstream(nodes: TaskNode[], failedId: string): TaskNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const marked: TaskNode[] = [];
  const stack = nodes.filter((n) => (n.deps ?? []).includes(failedId)).map((n) => n.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = byId.get(id);
    if (!node || node.status === 'skipped' || node.status === 'done') continue;
    node.status = 'skipped';
    node.error = `upstream ${failedId} failed`;
    marked.push(node);
    for (const s of nodes.filter((n) => (n.deps ?? []).includes(id))) stack.push(s.id);
  }
  return marked;
}

/** 就绪判定：全部依赖 done。 */
export function isReady(node: TaskNode, nodes: TaskNode[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (node.deps ?? []).every((d) => byId.get(d)?.status === 'done');
}

/** 可并行度：就绪层最大宽度（worker 数量参考）。 */
export function maxParallelism(nodes: TaskNode[]): number {
  try {
    return Math.max(1, ...topoLayers(nodes).map((l) => l.length));
  } catch {
    return 1;
  }
}
