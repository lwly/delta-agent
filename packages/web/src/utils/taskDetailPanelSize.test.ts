import { describe, expect, it } from 'vitest';
import {
  TDP_DEFAULT_WIDTH,
  clampTaskDetailDragWidth,
  nextTaskDetailTier,
  snapTaskDetailWidthToTier,
  taskDetailTierWidth,
} from './taskDetailPanelSize';

describe('taskDetailPanelSize', () => {
  it('三档宽度在 1440 视口下递增', () => {
    expect(taskDetailTierWidth(0, 1440)).toBe(TDP_DEFAULT_WIDTH);
    expect(taskDetailTierWidth(1, 1440)).toBe(864);
    expect(taskDetailTierWidth(2, 1440)).toBe(1072); // 85vw 受主区保底夹取
  });

  it('nextTaskDetailTier 循环 0→1→2→0', () => {
    expect(nextTaskDetailTier(0)).toBe(1);
    expect(nextTaskDetailTier(1)).toBe(2);
    expect(nextTaskDetailTier(2)).toBe(0);
  });

  it('snapTaskDetailWidthToTier 吸附最近档', () => {
    expect(snapTaskDetailWidthToTier(400, 1600)).toBe(0);
    expect(snapTaskDetailWidthToTier(850, 1600)).toBe(1);
  });

  it('clampTaskDetailDragWidth 受主区保底限制', () => {
    expect(clampTaskDetailDragWidth(2000, 1100)).toBeLessThanOrEqual(732);
    expect(clampTaskDetailDragWidth(100, 1600)).toBe(TDP_DEFAULT_WIDTH);
  });
});
