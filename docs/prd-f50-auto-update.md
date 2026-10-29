# F-50 PRD：CLI/Desktop 自动更新

> 编号口径说明：仓库早期 `prd-f41-f53-next-round.md` 的 F-50 为「企业治理层」，与交付线编号冲突。
> 本文件是交付线（issue PASI-18）口径下的 F-50 成对 PRD；企业治理层此后另起编号。

## 背景

delta 当前没有任何版本检查与升级通道：

- CLI 版本硬编码（`packages/cli/src/index.ts`），用户升级全靠手动重装，SEA 与 npm 两种安装形态的升级路径不同且无提示；
- Desktop 壳（packages/desktop）把 electron-updater 明确挂为二期（design-f40 §5），托盘没有「检查更新」入口，用户无法感知新版本。

## 需求

1. **启动版本检查**：CLI 启动时后台检查新版本，fire-and-forget 绝不阻塞；默认每周一次（状态落盘节流），可配置关闭。
2. **`delta update` 手动通道**：按渠道执行正确升级动作——npm 渠道走 `npm i -g @delta/cli@latest`；SEA 渠道下载 release 资产（`delta-<platform>-<arch>`）原子替换当前二进制。首版「检查 + 下载 + 替换」，不做热替换。
3. **降级拒绝**：远端版本不严格大于当前版本时拒绝任何替换动作（更新通道绝不降级）。
4. **Desktop 托盘检查**：托盘菜单「检查更新」；发现新版本时托盘角标（macOS 菜单栏 ●）+ 菜单插入新版本项，点击跳转 Release 页引导下载。
5. **更新源可配**：GitHub / Gitee / 自定义 JSON 三种源（`~/.delta/update.json`）；拉取失败静默并按 F-41 口径留档（source=update）。
6. **版本单一来源**：`APP_VERSION` 常量收口 core（paths.ts），CLI `--version` 与更新检查共用。

## 非目标

- 不做 electron-updater 热替换 / 全量自动更新（仍是二期）。
- 不做差量更新、签名校验（替换前不校验签名；资产完整性依赖 HTTPS 通道，设计文档记录该限制）。
- 不做 Web 控制台更新 UI（托盘 + CLI 已覆盖 AC）。

## 验收标准（对应 issue AC）

- AC-50-1 启动检查 fire-and-forget，默认每周一次，可配置关闭（`enabled=false`）
- AC-50-2 `delta update` 按渠道（SEA/npm）给出正确升级动作
- AC-50-3 Desktop 托盘「检查更新」+ 新版本角标，跳转 Release 页
- AC-50-4 更新源可配（GitHub/Gitee/自定义 JSON）；失败静默留档 F-41 日志
- AC-50-5 版本比较与降级拒绝逻辑单测
