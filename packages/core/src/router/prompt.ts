/**
 * F-58 Router–Worker 调度层：提示词资产（设计稿 §12：唯一提示词资产，集中在本文件）。
 * 包含三块：
 *   - buildDispatchToolPrompt()   dispatch_task 的参数说明（T4 工具 description 消费）
 *   - buildWorkerFirstMessage()   Worker 会话的首条用户消息（= task.goal 原文 + acceptance + 依赖产出）
 *   - buildDigestMessage()        pumpDigest 发给 Router 的播报文本
 *
 * 红线（§1.4）：role_label 只做 UI 标签——本文件任何文本不得出现 role_label，
 * 也不把它拼进 Worker 消息；T2a 有一条单测盯死这一点。
 */
import type { InboxItem, WorkerTaskRow } from './types.js';

/**
 * dispatch_task 参数说明（裁决 Q3：必须写明「派单不执行，仅落库并创建 Worker 会话」；
 * Router 固定 plan 档，dispatch_task 归 read，不阻断派单）。
 */
export function buildDispatchToolPrompt(): string {
  return [
    '派单给一个独立的 Worker 会话去执行。注意：派单不执行——本工具只把任务落库并创建 Worker 会话，',
    '不会在当前会话里做任何事；并发上限由系统控制，超出的任务自动排队。',
    '',
    '参数：',
    '- goal（必填）：做什么。原文就是 Worker 的首条用户消息，请把背景、约束、期望产物写全，',
    '  不要依赖 Worker 知道当前对话的任何内容（Worker 之间不共享上下文）。',
    '- acceptance（可选）：怎么算完。缺省时请在 goal 里写清完成判据。',
    '- executor（可选）：执行后端。\'cli:xxx\' / \'acp:xxx\' = 外部 agent（须已探测注册）；',
    '  缺省 = 内置引擎。派单后不可变——改执行后端等于新建任务。',
    '- permission_mode（可选）：plan / default / yolo。外部 Worker 若请求只读（plan），',
    '  目标 agent 必须支持只读档，否则任务会停在待裁决。',
    '- priority（可选）：数字越大越先派发，缺省 1。',
    '- depends_on（可选）：依赖的任务 id 数组。存在未完成依赖时不派发；依赖失败则本任务取消。',
    '',
    '任务完成后结果会自动汇总回报，无需轮询；查询单个任务状态用 task_status。',
  ].join('\n');
}

/** 安全解析 depends_on JSON 列（与 store 同口径：损坏回退空数组） */
export function parseDependsOn(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Worker 首条用户消息（§1.3：一次性上下文，goal 原文，无跨任务继承；
 * D11：不共享对话上下文，但拼入依赖任务的 result_summary 与产物路径——
 * 路径 + ≤400 字摘要双轨（裁决 Q2），不传对话历史）。
 */
export function buildWorkerFirstMessage(task: WorkerTaskRow, depRows: WorkerTaskRow[]): string {
  const parts: string[] = [task.goal];
  if (task.acceptance) {
    parts.push('', `完成条件：${task.acceptance}`);
  }
  const doneDeps = depRows.filter((d) => d.status === 'done');
  if (doneDeps.length > 0) {
    parts.push('', '依赖任务的产出（仅供参考，不共享其对话过程）：');
    for (const dep of doneDeps) {
      const summary = dep.result_summary ? `：${dep.result_summary}` : '';
      parts.push(`- [${dep.title}]${summary}`);
      for (const artifact of parseArtifactsOf(dep)) {
        parts.push(`  - 产物 ${artifact.kind}: ${artifact.ref}`);
      }
    }
  }
  return parts.join('\n');
}

function parseArtifactsOf(row: WorkerTaskRow): { kind: string; ref: string }[] {
  try {
    const v = JSON.parse(row.artifacts) as unknown;
    return Array.isArray(v) ? (v as { kind: string; ref: string }[]) : [];
  } catch {
    return [];
  }
}

/** 任务短标识（播报/台账一致的 [T-xxxxxx] 口径，设计稿 §8.2） */
export function shortTaskId(id: string): string {
  return id.length > 6 ? `[T-${id.slice(-6)}]` : `[T-${id}]`;
}

/**
 * pumpDigest 播报文本（§10.1：digest 消息体只含播报条目，不含历史）。
 * 头一句明确「自动触发、只需简短确认」，防止 Router 把播报当用户指令展开长篇回应。
 */
export function buildDigestMessage(items: InboxItem[]): string {
  const lines = ['[系统] 任务播报（自动触发，只需简短确认，不要复述全文）'];
  for (const item of items) {
    const p = (item.payload ?? {}) as Record<string, unknown>;
    const title = typeof p.title === 'string' ? p.title : '';
    const id = typeof p.taskId === 'string' ? shortTaskId(p.taskId) : '';
    const prefix = `${id} ${title}`.trim();
    switch (item.kind) {
      case 'task_done': {
        const summary = typeof p.summary === 'string' && p.summary !== '' ? `：${p.summary}` : '';
        lines.push(`- 完成 ${prefix}${summary}`);
        break;
      }
      case 'task_failed': {
        const message = typeof p.message === 'string' && p.message !== '' ? `：${p.message}` : '';
        lines.push(`- 失败 ${prefix}${message}`);
        break;
      }
      case 'needs_decision': {
        const message = typeof p.message === 'string' && p.message !== '' ? `：${p.message}` : '';
        lines.push(`- 需要你决定 ${prefix}${message}`);
        break;
      }
      default:
        lines.push(`- ${prefix}`);
    }
  }
  return lines.join('\n');
}
