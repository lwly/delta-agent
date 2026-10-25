/**
 * F-38：面板宽度 clamp / 持久化读取单测（D11 + PRD F-38-1）
 * 四组口径：320 下界、720 上界、视口 60%、主区 480 保底；另覆盖倒挂兜底与非法存储值。
 */
import { describe, expect, it } from 'vitest';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_NARROW_BREAKPOINT,
  PANEL_WIDTH_KEY,
  clampPanelWidth,
  isNarrowViewport,
  readPanelOpen,
  readPanelWidth,
} from './panelSize.js';

describe('clampPanelWidth —— 四组边界', () => {
  it('320 下界：过小值 / 负值 / 0 都抬到 320', () => {
    expect(clampPanelWidth(100, 1600)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(0, 1600)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(-50, 1600)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth('200', 1600)).toBe(PANEL_MIN_WIDTH);
  });

  it('720 上界：大视口下的过大值夹到 720', () => {
    expect(clampPanelWidth(1200, 1920)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(720, 1920)).toBe(720);
  });

  it('视口 60%：1366 视口下上界 = min(720, 820, 618) = 618', () => {
    expect(clampPanelWidth(900, 1366)).toBe(618);
    expect(clampPanelWidth(PANEL_DEFAULT_WIDTH, 1366)).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('主区 480 保底：1100 视口下上界 = min(720, 660, 352) = 352', () => {
    // 268（侧栏）+ 352（面板）+ 480（主区）= 1100
    expect(clampPanelWidth(700, 1100)).toBe(352);
    expect(clampPanelWidth(320, 1100)).toBe(320);
  });

  it('上界与下界倒挂时取 320（极窄视口）', () => {
    expect(clampPanelWidth(500, 500)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(500, 300)).toBe(PANEL_MIN_WIDTH);
  });

  it('视口非法值按 1440 兜底；非法 raw 用默认宽度', () => {
    expect(clampPanelWidth(PANEL_DEFAULT_WIDTH, Number.NaN)).toBe(PANEL_DEFAULT_WIDTH);
    expect(clampPanelWidth(Number.NaN, 1600)).toBe(PANEL_DEFAULT_WIDTH);
    expect(clampPanelWidth(null, 1600)).toBe(PANEL_DEFAULT_WIDTH);
    expect(clampPanelWidth(undefined, 1600)).toBe(PANEL_DEFAULT_WIDTH);
  });
});

describe('isNarrowViewport —— <1200px 默认收起', () => {
  it('断点两侧', () => {
    expect(PANEL_NARROW_BREAKPOINT).toBe(1200);
    expect(isNarrowViewport(1199)).toBe(true);
    expect(isNarrowViewport(1200)).toBe(false);
    expect(isNarrowViewport(1920)).toBe(false);
    expect(isNarrowViewport(Number.NaN)).toBe(false);
  });
});

describe('readPanelWidth / readPanelOpen —— 存储读取容错', () => {
  const fake = (value: string | null) => ({ getItem: (k: string) => (k === PANEL_WIDTH_KEY ? value : null) });

  it('合法数字按视口夹取', () => {
    expect(readPanelWidth(fake('600'), 1920)).toBe(600);
    expect(readPanelWidth(fake('900'), 1366)).toBe(618);
  });

  it('空串 / 非数字 / 缺失 → 默认宽度', () => {
    expect(readPanelWidth(fake(''), 1920)).toBe(PANEL_DEFAULT_WIDTH);
    expect(readPanelWidth(fake('abc'), 1920)).toBe(PANEL_DEFAULT_WIDTH);
    expect(readPanelWidth(fake(null), 1920)).toBe(PANEL_DEFAULT_WIDTH);
    expect(readPanelWidth(null, 1920)).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('getItem 抛错不冒泡（回落默认）', () => {
    const throwing = {
      getItem(): string | null {
        throw new Error('SecurityError');
      },
    };
    expect(readPanelWidth(throwing, 1920)).toBe(PANEL_DEFAULT_WIDTH);
    expect(readPanelOpen(throwing)).toBe(false);
  });

  it('开合状态：只有 "1" 视为展开', () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(readPanelOpen(store('1'))).toBe(true);
    expect(readPanelOpen(store('0'))).toBe(false);
    expect(readPanelOpen(store(null))).toBe(false);
    expect(readPanelOpen(store('true'))).toBe(false);
    expect(readPanelOpen(null)).toBe(false);
  });
});
