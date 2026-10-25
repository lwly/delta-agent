/**
 * F-38 面板尺寸计算（纯函数，无副作用）
 *
 * 依据 design D11 + PRD F-38-1：
 *   width = clamp(raw, 320, min(720, round(vw * 0.6), vw - 侧栏 268 - 主区保底 480))
 *   - 上界与下界倒挂（极窄视口）时取 320（宁可轻微挤压主区，也不出现 NaN / 负值）
 *   - 视口非法（0 / NaN）时按 1440 兜底，保证刷新后布局稳定
 * localStorage 只认 `yz.filePanel`（'1'/'0'）与 `yz.filePanelWidth`（数字），
 * 读取失败或非法值一律回落缺省、不抛错（对齐既有 yz.preferredModel 写法）。
 */

/** 面板默认宽度（PRD F-38-1）。 */
export const PANEL_DEFAULT_WIDTH = 420;
/** 拖拽下界。 */
export const PANEL_MIN_WIDTH = 320;
/** 拖拽上界。 */
export const PANEL_MAX_WIDTH = 720;
/** 面板展开时主区最小宽度（PRD F-38-1）。 */
export const PANEL_MAIN_MIN_WIDTH = 480;
/** 左侧栏固定宽度（与 WorkbenchView `.sidebar` 一致）。 */
export const PANEL_SIDEBAR_WIDTH = 268;
/** 窄屏断点：< 1200px 时面板默认收起（D11）。 */
export const PANEL_NARROW_BREAKPOINT = 1200;

/** localStorage 键（PRD F-38-1）。 */
export const PANEL_OPEN_KEY = 'yz.filePanel';
export const PANEL_WIDTH_KEY = 'yz.filePanelWidth';

/** 视口兜底宽度（无法读取时按常见桌面宽度处理）。 */
const FALLBACK_VIEWPORT_WIDTH = 1440;

/**
 * 面板宽度夹取：
 * - 下界固定 320
 * - 上界 = min(720, floor(vw*0.6), vw - 268 - 480)
 * - 上界 < 下界（倒挂）→ 取 320
 */
export function clampPanelWidth(raw: number | string | null | undefined, viewportWidth: number): number {
  const vw = Number(viewportWidth);
  const width = Number.isFinite(vw) && vw > 0 ? vw : FALLBACK_VIEWPORT_WIDTH;

  const upperBound = Math.min(
    PANEL_MAX_WIDTH,
    Math.round(width * 0.6),
    Math.round(width - PANEL_SIDEBAR_WIDTH - PANEL_MAIN_MIN_WIDTH),
  );
  const max = Math.max(PANEL_MIN_WIDTH, upperBound);

  // null / undefined / 空串视为「无值」：Number(null) === 0 会被误判成 0px
  const isBlank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
  const parsed = isBlank ? Number.NaN : Number(raw);
  const desired = Number.isFinite(parsed) ? Math.round(parsed) : PANEL_DEFAULT_WIDTH;
  return Math.min(max, Math.max(PANEL_MIN_WIDTH, desired));
}

/** 是否为窄屏（面板应默认收起 / 走覆盖式定位）。 */
export function isNarrowViewport(viewportWidth: number): boolean {
  const vw = Number(viewportWidth);
  return !Number.isFinite(vw) || vw <= 0 ? false : vw < PANEL_NARROW_BREAKPOINT;
}

/** localStorage 最小接口（测试可传内存实现；传入 null 表示不可用）。 */
export interface PanelStorage {
  getItem(key: string): string | null;
}

/**
 * 读取持久化宽度：非法值 / 读取异常 / 无存储 → 默认宽度（再按视口夹取）。
 */
export function readPanelWidth(storage: PanelStorage | null | undefined, viewportWidth: number): number {
  let raw: string | null = null;
  try {
    raw = storage ? storage.getItem(PANEL_WIDTH_KEY) : null;
  } catch {
    raw = null;
  }
  // Number('') === 0 会误判成 0px，这里显式挡掉空串
  const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return clampPanelWidth(Number.isFinite(parsed) ? parsed : PANEL_DEFAULT_WIDTH, viewportWidth);
}

/**
 * 读取持久化开合状态：只有显式 '1' 视为展开，其余（含缺失 / 异常）一律收起。
 */
export function readPanelOpen(storage: PanelStorage | null | undefined): boolean {
  try {
    return storage ? storage.getItem(PANEL_OPEN_KEY) === '1' : false;
  } catch {
    return false;
  }
}
