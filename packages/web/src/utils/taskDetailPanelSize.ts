/**
 * 委派任务详情面板宽度（纯函数）：三档预设 + 拖拽夹取 + localStorage 读取。
 */

export const TDP_DEFAULT_WIDTH = 380;
export const TDP_RAIL_WIDTH = 48;
export const TDP_MAIN_MIN_WIDTH = 320;
export const TDP_NARROW_BREAKPOINT = 1024;
export const TDP_TRANSITION_MS = 220;

export const TDP_TIER_KEY = 'yz.taskDetailPanelTier';

export type TaskDetailPanelTier = 0 | 1 | 2;

const FALLBACK_VW = 1440;

export function viewportWidthOrFallback(vw: number): number {
  return Number.isFinite(vw) && vw > 0 ? vw : FALLBACK_VW;
}

export function isTaskDetailNarrowViewport(vw: number): boolean {
  const w = viewportWidthOrFallback(vw);
  return w < TDP_NARROW_BREAKPOINT;
}

/** 面板最大宽度：保留左侧 rail + 主区最小宽度 */
export function taskDetailPanelMaxWidth(vw: number): number {
  const w = viewportWidthOrFallback(vw);
  return Math.max(TDP_DEFAULT_WIDTH, Math.round(w - TDP_RAIL_WIDTH - TDP_MAIN_MIN_WIDTH));
}

/** 三档目标宽度：默认 380 / 约 60vw（上限 900）/ 约 85vw */
export function taskDetailTierWidth(tier: TaskDetailPanelTier, vw: number): number {
  const w = viewportWidthOrFallback(vw);
  const max = taskDetailPanelMaxWidth(w);
  if (isTaskDetailNarrowViewport(w)) {
    return Math.min(max, Math.max(TDP_DEFAULT_WIDTH, w - TDP_RAIL_WIDTH));
  }
  const targets: Record<TaskDetailPanelTier, number> = {
    0: TDP_DEFAULT_WIDTH,
    1: Math.min(900, Math.round(w * 0.6)),
    2: Math.round(w * 0.85),
  };
  return Math.min(max, Math.max(TDP_DEFAULT_WIDTH, targets[tier]));
}

export function clampTaskDetailDragWidth(raw: number, vw: number): number {
  const max = taskDetailPanelMaxWidth(vw);
  const parsed = Math.round(raw);
  if (!Number.isFinite(parsed)) return TDP_DEFAULT_WIDTH;
  return Math.min(max, Math.max(TDP_DEFAULT_WIDTH, parsed));
}

/** 松手后吸附到最近档位 */
export function snapTaskDetailWidthToTier(px: number, vw: number): TaskDetailPanelTier {
  const w = viewportWidthOrFallback(vw);
  const candidates: TaskDetailPanelTier[] = [0, 1, 2];
  let best: TaskDetailPanelTier = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of candidates) {
    const tw = taskDetailTierWidth(t, w);
    const d = Math.abs(px - tw);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

export function nextTaskDetailTier(current: TaskDetailPanelTier): TaskDetailPanelTier {
  return ((current + 1) % 3) as TaskDetailPanelTier;
}

export interface TaskDetailStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readTaskDetailTier(storage: TaskDetailStorage | null | undefined): TaskDetailPanelTier {
  try {
    const raw = storage?.getItem(TDP_TIER_KEY);
    if (raw === '1' || raw === '2') return Number(raw) as TaskDetailPanelTier;
  } catch {
    /* ignore */
  }
  return 0;
}

export function writeTaskDetailTier(storage: TaskDetailStorage | null | undefined, tier: TaskDetailPanelTier): void {
  try {
    storage?.setItem(TDP_TIER_KEY, String(tier));
  } catch {
    /* ignore */
  }
}
