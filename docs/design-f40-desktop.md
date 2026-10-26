# F-40 桌面化（Electron，方案 B）技术设计

> 日期：2026-10-26 ｜ 状态：v1 已实现（packages/desktop）｜ 决策记录：工厂放 core / mac+win 双平台首发 / 首版即原生通知

## 1. 目标与形态

把 delta-agent 的 Web 控制台形态打包为桌面应用（Electron）。采用**方案 B**：Electron main 进程直接 import `@delta/core`，进程内托管 serve 运行时；BrowserWindow 加载本地 server（回环随机端口）。

```
┌─ Electron main（@delta/desktop）─────────────────────────┐
│  createServeRuntime(...)  ← core 组装工厂（多宿主共用）      │
│   ├─ SessionService / ToolRegistry+MCP / Skills / Hooks    │
│   ├─ SessionHub（notify 注入 ElectronNotifier）             │
│   └─ createWebServer(127.0.0.1:<随机端口>, authToken)       │
│  BrowserWindow ── http://127.0.0.1:<port>/?auth=<token> ── │
│  （contextIsolation + sandbox，无 nodeIntegration）          │
└──────────────────────────────────────────────────────────┘
```

## 2. 已定决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 组装工厂位置 | core（`server/runtime.ts`） | desktop 只依赖 core/shared，不拉 react/ink/commander；与 core/server 既有职责一致 |
| cronExecutor | 工厂**无缺省实现**，宿主显式传入 | 消除 `process.execPath` 隐患（Electron main 里是 GUI 二进制而非 Node）；桌面 v1 不传 → cron「立即运行」400 |
| 首发平台 | mac + win 双平台 | CI matrix + electron-builder dmg/NSIS |
| 通知 | 首版即 Electron 原生 `Notification` | 注入点替换，core/notify 零改动；win 需 `setAppUserModelId`；发送失败静默回退语义保持（AC-7） |
| 签名/分发 | 挂起（发布前补齐） | Apple 证书 / win 证书 / 渠道确认三项延后；开发期无签名构建；不做 MAS（sandbox-exec spawn 会被沙箱卡死） |

## 3. 改动清单（v1）

| 层 | 改动 |
|----|------|
| core | 新增 `server/runtime.ts`（createServeRuntime 组装工厂 + dispose 生命周期）；`cron/spawn-executor.ts`（自 cli 下移，cliEntry/nodePath/env 参数化）；`ServeOptions.authToken`（`/api/*` 恒定时间比较鉴权，静态资源豁免） |
| cli | serve action 改调工厂（行为不变）；cron-executor 变薄壳（缺省 cliEntry = 包内 dist/index.js） |
| web | `api/auth.ts`（token 承载：URL query 读取即清除、fetch 头、EventSource/下载链接 query）——CLI 形态无 `?auth=`，行为不变 |
| desktop | 新包：main.ts（单实例锁 / setAppModelId / 工厂接入 / BrowserWindow 安全基线 / before-quit dispose）、ElectronNotifier、electron-builder.yml |

## 4. 鉴权设计

- main 生成 32 字节随机 token；`?auth=` 一次性交付，前端读取后 `history.replaceState` 清除；
- `/api/*` 强制校验（`x-delta-auth` 头或 `?auth=` query，长度不同直接拒绝 + 逐字符异或恒定时间比较）；
- 静态资源豁免：资产请求无法附带凭据，且 bundle 无敏感数据；敏感面全在 `/api` 下；
- CLI serve 不传 authToken，行为与历史版本一致。

## 5. 遗留与二期

- cron「立即运行」：桌面 v2 通过可选依赖 `@delta/cli` + `ELECTRON_RUN_AS_NODE` 接入 spawn 执行器（core 执行器已支持 nodePath/env 注入）；
- 自动更新（electron-updater）、safeStorage 迁移评估；
- CI matrix（macos/windows 构建 + better-sqlite3 双平台 ABI 缓存）与签名配置随证书到位补充；
- 桌面端 SkillRuntime 绑定启动时 home（项目级 skills 需 UI 创建项目后重启生效）—— v1 已知限制。

## 6. v1.1 增量（2026-10-26）

| 项 | 决策 |
|----|------|
| 深色标题栏 | `nativeTheme.themeSource = 'dark'`（控制台为纯深色 UI，强制原生主题深色渲染 Windows 标题栏/窗框）；BrowserWindow `backgroundColor: '#0f1115'` 对齐 web `--bg` 消除首帧白闪。不采用 `titleBarStyle: hidden`（需页面拖拽区改造，收益低） |
| 注册项目目录选择 | preload（`src/preload.ts`）经 contextBridge 暴露 `window.deltaDesktop.pickDirectory()` → IPC `dialog:pick-directory` → main `dialog.showOpenDialog({ properties: ['openDirectory'] })`，仅回传绝对路径字符串；web 侧 `utils/desktop.ts` 探测桥接，注册项目弹窗桥接可用时展示「浏览…」回填输入框，浏览器形态（CLI serve）无桥接自动隐藏、保留手输（浏览器安全模型拿不到绝对路径）。安全基线不变：sandbox 开启、仅白名单单一通道、注册仍走 `POST /api/projects` 鉴权 |
| 应用图标 | 源 `packages/desktop/icons/icon.svg`（与 web favicon.svg 同款：品牌渐变圆角方块 + 白描边 Δ，外扩 11% 留白）；生成 `icon.icns`（iconutil，1024 起）与 `icon.ico`（png-to-ico，16/32/48/256）、`icon.png`（512，BrowserWindow 开发态）；electron-builder 显式 `mac.icon` / `win.icon`。置于 `icons/`（`.gitignore` 全局忽略 `build/`） |
