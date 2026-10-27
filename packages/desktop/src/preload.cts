/**
 * delta-agent 桌面壳 —— preload（contextIsolation + sandbox）。
 *
 * 仅暴露最小白名单桥接：渲染进程可请求系统目录选择器（注册项目用）。
 * 不暴露 fs / shell / 任意 IPC，通道名固定 'dialog:pick-directory'。
 *
 * 文件扩展名必须是 .cts：本包 package.json 是 "type": "module"，若写成 .ts 会编译出
 * ESM（import 语法）的 preload.js，而 sandbox: true 的窗口只接受 CommonJS preload，
 * ESM preload 会被 Electron 静默忽略 —— 结果就是 window.deltaDesktop 不存在、
 * 注册项目弹窗的「选择文件夹…」按钮消失。.cts 经 tsc（module: NodeNext）产出
 * preload.cjs（require 语义），与 sandbox 兼容。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('deltaDesktop', {
  /** 打开系统目录选择器；取消返回 null，选中返回绝对路径 */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-directory'),
});
