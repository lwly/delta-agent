/**
 * delta-agent 桌面壳 —— preload（contextIsolation + sandbox）。
 *
 * 仅暴露最小白名单桥接：渲染进程可请求系统目录选择器（注册项目用）。
 * 不暴露 fs / shell / 任意 IPC，通道名固定 'dialog:pick-directory'。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('deltaDesktop', {
  /** 打开系统目录选择器；取消返回 null，选中返回绝对路径 */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-directory'),
});
