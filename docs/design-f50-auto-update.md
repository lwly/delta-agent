# F-50 设计：CLI/Desktop 自动更新

> 编号口径说明见成对 `docs/prd-f50-auto-update.md` 头注（交付线 PASI-18 口径）。

## 1. 总体结构

```
packages/core/src/update/
  types.ts     # UpdateConfig / UpdateState / UpdateCheckResult / UpdateAsset
  version.ts   # parseVersion / compareVersions / isNewerVersion（降级拒绝内核）
  config.ts    # ~/.delta/update.json 读写（读宽松、写原子，惯例对齐 notify/config.ts）
  checker.ts   # detectChannel / checkForUpdate / maybeCheckOnStartup（节流启动检查）
  install.ts   # SEA 渠道：downloadUpdateAsset + applyBinarySwap（原子换入 + 失败回滚）
packages/cli/src/update.ts      # delta update 子命令 + startupUpdateCheck（薄壳）
packages/desktop/src/main.ts    # 托盘「检查更新」+ 角标 + 跳转 Release
```

core 不 import cli/desktop；cli/desktop 只消费 core 桶导出（依赖方向合法）。

## 2. 关键决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 渠道判定 `node:sea` 的 `isSea()`，**动态 import**，解析失败按 `npm` 保守降级 | 运行时权威判定；静态 import 在 vitest / 部分环境不可解析，误判 sea 会走二进制替换，必须保守 |
| D2 | 版本单一来源 `APP_VERSION` 收口 `packages/core/src/paths.ts`（与 APP_NAME 同位） | CLI `--version` 原硬编码 `0.1.0`；SEA/npm 两渠道运行时需要一个可比较的当前版本；修改时同步各 package.json version |
| D3 | 配置与状态共用 `~/.delta/update.json`（FILES.update 新键）：配置面 `enabled/source/intervalMs`，状态面 `lastCheckAt/lastSeenVersion` | 单文件免新增多文件；状态回写只改两个状态字段（写前读 + tmp+rename 原子写，坏 JSON 拒写，对齐 notify 惯例） |
| D4 | 启动检查节流：`enabled=false` 或距 `lastCheckAt` < `intervalMs`（默认 7 天）直接跳过零网络；检查结果**含失败**都回写 `lastCheckAt` | AC-50-1 每周一次；失败也记账，避免每次启动打必败请求；`delta update` 手动检查不回写，不吃节流窗口 |
| D5 | 启动检查 fire-and-forget：TUI `start()` 顶部 `void startupUpdateCheck()`，发现新版本在 Ink 挂起前 `console.error` 一行；headless/serve 不提示（失败一律静默留档） | TUI 挂起后 stdout 输出不可靠（对齐 F-34 教训）；headless 非交互场景提示无消费方 |
| D6 | 降级拒绝收口在 `isNewerVersion`：latest 不**严格大于** current 一律 false，版本不可比较（parse 失败）同口径拒绝 | 更新通道绝不降级/盲替（AC-50-5）；不可比较时宁可漏更新不可错替换 |
| D7 | 更新源三种：github `api.github.com/repos/{repo}/releases/latest`；gitee `gitee.com/api/v5/...`（默认 `lwly/delta-agent`）；自定义 JSON `{version, url?, body?, tag_name?}`，按字段存在自适应（tag_name 优先） | AC-50-4；Gitee 作默认与仓库主仓一致；自定义 JSON 便于内网镜像 |
| D8 | SEA 替换流程：release 资产名严格匹配 `delta-<platform>-<arch>`（对齐 build-sea.mjs 产物）→ 下载到 `~/.delta/update-staging/`（临时名 + chmod 755）→ 旧二进制 rename 为 `.bak` → 新二进制 rename 到位 → 任一步失败回滚备份 | 更新失败绝不能弄坏现有安装（要么新版到位要么旧版原样，无中间态）；不做热替换，提示重启生效 |
| D9 | npm 渠道升级执行 `npm install -g @delta/cli@latest`（stdio inherit），失败打印手动命令；执行前先检查，非严格更新不动作 | 手动命令兜底（pnpm/bun 用户也能照做）；避免无谓的全局重装 |
| D10 | 手动检查失败**如实报错**并给排查建议，与启动检查静默口径相反 | 用户主动发起的命令必须给结果；启动检查才需要零打扰（AC-50-4 的静默仅约束启动路径） |
| D11 | Desktop 托盘菜单按检查状态重建（checking 禁用入口 / 有新版插入跳转项 + `tray.setTitle('●')` 角标 / 失败显示一条可忽略失败项）；点击新版本项 `shell.openExternal(releaseUrl)` | Electron Tray 无原生 badge，setTitle 是 macOS 菜单栏标准做法；当前版本取 `app.getVersion()`（electron-builder 打包口径） |
| D12 | 更新事件全部走 F-41 `RunLog`（source=`update`），宿主各自构造实例（cli/desktop 自建，core 只依赖 `RunLogSink`） | 对齐 F-41 D4 埋点最小接口；目录注入不可写时静默降级为不留档 |
| D13 | 已知限制：不校验下载资产签名（首版依赖 HTTPS + Gitee/GitHub 平台完整性）；`delta update` 执行中进程被杀极端情况下 SEA 存在 `.bak` 残留（下次更新自动清理） | 首版范围控制；签名校验随 electron-updater 二期一并补 |

## 3. 交互口径

- `delta update`：打印渠道与当前版本 → 检查 → 无更新/降级：`✔ 已是最新（远端 x.y.z，降级/同版拒绝动作）`；有更新：npm 直接执行安装、SEA 下载替换并提示重启。
- `delta update --check`：只检查不动作。
- `delta update status`：渠道、配置路径、更新源、上次检查时间（不发网络请求）。
- 启动提示（仅 TUI）：`⬆ 发现新版本 x.y.z（当前 a.b.c），运行 \`delta update\` 升级`。

## 4. 测试

`packages/core/test/update.test.ts`（18 例）：

- 版本：v 前缀/预发布解析、逐段比较、预发布口径、不可比较返回 null、降级拒绝矩阵（AC-50-5）
- 配置：缺省值、非法值降级 + warning、坏 JSON 不 throw、状态回写只改状态字段 + 坏 JSON 拒写
- 检查：三源 URL 解析、结果归一化（剥 v / 资产过滤 / 降级判定）、HTTP 错误抛错并留档、启动节流（关/未到点/到点回写/失败也回写）
- SEA：下载落盘 + 可执行位 + 失败清理半截文件、原子换入 + 失败回滚

`node:sea` 动态 import 使 `detectChannel` 在测试环境按 `npm` 降级（不强行伪造 SEA 进程）。
