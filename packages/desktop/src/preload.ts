/**
 * 桌面宿主桥（preload）—— 最小暴露面。
 *
 * 仅暴露目录选择一个能力；contextIsolation + sandbox 开启下
 * contextBridge/ipcRenderer 是沙箱 preload 的合法 API。
 * 渲染层通过 window.deltaDesktop 判定桌面宿主（CLI/浏览器形态该字段不存在）。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('deltaDesktop', {
  /** 打开原生目录选择对话框；取消返回 null */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('desktop:pick-folder'),
});
