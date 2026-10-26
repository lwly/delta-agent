/**
 * 桌面壳（@delta/desktop preload）桥接探测与目录选择。
 *
 * Web 控制台同时服务于两种宿主：
 *  - CLI serve（浏览器打开）：无桥接，且浏览器安全模型拿不到绝对路径 → 仅手输；
 *  - Electron 桌面（contextIsolation + sandbox）：preload 经 contextBridge
 *    暴露 window.deltaDesktop.pickDirectory()，走 IPC 调系统目录选择器。
 *
 * 调用方（注册项目弹窗）按 hasDesktopBridge() 决定是否展示「浏览…」入口。
 */

/** 与 packages/desktop/src/preload.ts 暴露面保持一致 */
interface DeltaDesktopBridge {
  /** 打开系统目录选择器；取消返回 null，选中返回绝对路径 */
  pickDirectory(): Promise<string | null>;
}

declare global {
  interface Window {
    deltaDesktop?: DeltaDesktopBridge;
  }
}

/** 桥接是否可用（浏览器形态 / 单测 node 环境下恒为 false） */
export function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.deltaDesktop?.pickDirectory === 'function';
}

/**
 * 请求选择项目根目录。
 * 返回 null 的三种情形：桥接不可用、用户取消、桥接调用异常（降级不弹错）。
 */
export async function pickDirectory(): Promise<string | null> {
  if (!hasDesktopBridge()) return null;
  try {
    return await window.deltaDesktop!.pickDirectory();
  } catch {
    return null;
  }
}
