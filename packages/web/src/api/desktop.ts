/**
 * 桌面宿主能力探测（与 packages/desktop/src/preload.ts 的暴露面逐字对应）。
 *
 * CLI `delta serve` / 普通浏览器形态：window.deltaDesktop 不存在 →
 * 相关 UI 入口隐藏、函数安全返回 null，行为与既往版本一致。
 */

declare global {
  interface Window {
    deltaDesktop?: {
      /** 打开原生目录选择对话框；取消返回 null */
      pickFolder(): Promise<string | null>;
    };
  }
}

/** 当前是否运行在桌面宿主（决定「选择文件夹」按钮显隐） */
export function hasNativeFolderPicker(): boolean {
  return typeof window !== 'undefined' && typeof window.deltaDesktop?.pickFolder === 'function';
}

/** 原生目录选择；非桌面宿主 / 用户取消返回 null */
export async function pickFolder(): Promise<string | null> {
  if (!hasNativeFolderPicker()) return null;
  try {
    return await window.deltaDesktop!.pickFolder();
  } catch {
    return null;
  }
}
