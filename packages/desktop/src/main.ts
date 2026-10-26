/**
 * delta-agent 桌面壳 —— Electron main 进程（方案 B）。
 *
 * 架构：main 进程进程内托管 core 的 serve 运行时（createServeRuntime），
 * BrowserWindow 加载本地 server（127.0.0.1 随机端口），API 走 authToken 鉴权。
 * 不 spawn 子进程、不依赖 @delta/cli（react/ink 零引入）。
 *
 * 安全基线：contextIsolation + sandbox 开启、nodeIntegration 关闭；
 * server 仅监听回环地址，/api/* 强制 token（静态资源豁免，无敏感数据）。
 *
 * v1 范围：cron「立即运行」不可用（cronExecutor 缺省 → POST 返回 400）；
 * 签名/公证挂起（发布前补齐）；自动更新二期。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import { createServeRuntime, type ServeRuntime } from '@delta/core';
import { ElectronNotifier } from './electron-notifier.js';

const APP_ID = 'com.delta.agent';
const DEV_SERVER_ORIGIN = process.env.DELTA_DESKTOP_DEV_ORIGIN ?? '';

/** 单实例锁：防双实例并发写 ~/.delta/agent.db（WAL 下读安全、写竞争无收益） */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Windows 通知（toast）必须设置 AppUserModelId，否则不显示/来源错误
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

// 控制台为纯深色 UI：强制 dark 原生主题，避免 Windows 默认白色标题栏/窗框与深色页面割裂
nativeTheme.themeSource = 'dark';

/** Vue 构建产物解析：打包形态 extraResources > 仓库 dev 形态 > 显式 env */
function resolveWebDistDir(): string | undefined {
  const candidates = [
    process.env.DELTA_WEB_DIST,
    // electron-builder extraResources（打包后 resources/web）
    process.resourcesPath ? path.join(process.resourcesPath, 'web') : undefined,
    // 仓库开发形态：packages/desktop/dist/main.js → packages/web/dist
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  ].filter((d): d is string => Boolean(d));
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
}

async function bootstrap(): Promise<void> {
  const authToken = crypto.randomBytes(32).toString('hex');
  let runtime: ServeRuntime;
  try {
    runtime = await createServeRuntime({
      port: 0, // 临时端口避让（实际端口经 runtime.port 回读）
      authToken,
      webDistDir: resolveWebDistDir(),
      registerProject: false, // 桌面端无 cwd 概念：项目由 UI 创建（POST /api/projects）
      notify: new ElectronNotifier(),
      log: (line) => console.log(line),
      logError: (line) => console.error(line),
    });
  } catch (e) {
    console.error(`✘ serve 运行时启动失败：${(e as Error).message}`);
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'delta-agent',
    autoHideMenuBar: true,
    // 与 web 主题 --bg 对齐：消除首帧白闪与深色标题栏下的色差
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.js'),
    },
  });

  if (DEV_SERVER_ORIGIN) {
    // Web 控制台 vite dev 形态（HMR；API 直连本地 server 由 vite 代理配置承接）
    void win.loadURL(DEV_SERVER_ORIGIN);
  } else {
    void win.loadURL(`http://127.0.0.1:${runtime.port}/?auth=${authToken}`);
  }

  // 注册项目：渲染进程经桥接请求系统目录选择器（sandbox 开启，渲染侧无 Node 能力）。
  // 仅回传所选绝对路径字符串，不做任何 fs 操作；鉴权沿用 /api 侧（注册仍走 POST /api/projects）。
  ipcMain.handle('dialog:pick-directory', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择项目根目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // 优雅退出：关 server → 断 MCP → 关 SQLite（desktop v1 全平台关窗即退出，简化 SQLite 生命周期）
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    void runtime
      .dispose()
      .catch(() => undefined)
      .finally(() => app.quit());
  });
}

app.whenReady().then(bootstrap).catch((e) => {
  console.error(`✘ 桌面壳初始化失败：${(e as Error).message}`);
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});
