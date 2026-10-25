# F-33 桌面通知 —— 技术设计

> 日期：2026-10-23 ｜ 关联：docs/prd-f33-desktop-notify.md ｜ 样例沿用：F-30（配置/原子写/子命令组）、F-30 D8（事件旁路 sink）

## 1. 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D1 | 触发点全部在**入口层**（TUI App / SessionHub / headless-run），引擎与工具零改动 | 对齐 F-30 D8「事件进 sink、由入口注入」；确认与完成事件本来就发生在入口的 confirm 回调与 run 生命周期里 |
| D2 | 后端：macOS `osascript -e 'display notification …'`；Windows PowerShell `System.Windows.Forms.NotifyIcon.ShowBalloonTip`；Linux `notify-send`（best-effort）；其它平台 no-op | 三者均为系统自带零 npm 依赖；备选 node-notifier 引入原生依赖树，违背「可开源、装完即用」约束 |
| D3 | 防噪：`done` 通知受 `minDurationMs`（默认 30_000）约束；`confirm` 通知不受时长约束 | PRD 语义是"长任务"；确认卡是等人事件，天然低频且必须尽快知晓 |
| D4 | 默认 `enabled: true` | 功能价值即"切走后有感知"；30s 门槛 + 确认低频使噪声可控；`delta notify disable` 一键关 |
| D5 | 配置两级文件 `~/.delta/notify.json` < `.delta/notify.json`，逐字段覆盖 | 对齐 F-30 sandbox.json 惯例；无统一 settings.json（既有架构按特性分文件） |
| D6 | 发送 fire-and-forget：`spawn(detached + unref)`、stdio ignore、10s 超时强杀、错误静默 | 通知失败绝不能影响任务主流程（AC-7）；detached 使 headless 进程退出后子进程仍能完成弹窗 |
| D7 | `Notifier` 以可选依赖注入三端（`AppOptions.notify` / `SessionHubDeps.notify`），缺省不通知 | 与 hooks / modelRouter 同一注入模式；测试可伪造 |
| D8 | 文本统一清洗：换行折叠为空格、正文截断 200 字符 | 系统通知面板对长文本展示差；AppleScript/PowerShell 字面量转义后不可含裸换行 |

## 2. 抽象分层

```
packages/core/src/notify/
├── types.ts      NotifyConfig / NotifyTrigger / Notifier 接口 / 默认值
├── config.ts     两级加载 + 归一化 + merge + updateUserNotifyEnabled（原子写）
└── notifier.ts   DesktopNotifier：平台探测 → 命令构造（转义）→ spawn 发送
```

```ts
export interface Notifier {
  /** 任务结束通知：内部检查 enabled / onDone / minDurationMs（不满足直接返回） */
  notifyDone(info: { status: string; durationMs: number; summary?: string }): void;
  /** 需人工确认通知：内部检查 enabled / onConfirm */
  notifyConfirm(info: { tool: string; reason: string }): void;
}
```

`DesktopNotifier` 构造可注入 `platform` 与 `runner(cmd, args, timeoutMs)`（测试伪造），缺省取 `process.platform` 与 `child_process.spawn` 实现。

## 3. 配置

```jsonc
// ~/.delta/notify.json（用户级） 或 .delta/notify.json（项目级，逐字段覆盖）
{
  "enabled": true,        // 总开关（CLI enable/disable 只改此字段）
  "onDone": true,         // 任务结束通知
  "onConfirm": true,      // 确认卡通知
  "minDurationMs": 30000  // done 通知的最短任务时长门槛
}
```

- 加载**永不 throw**：坏 JSON / 非法值 → 该层忽略或字段降级默认 + warning（对齐 sandbox/config.ts）。
- `updateUserNotifyEnabled(enabled)`：写前读、只改 `enabled`、tmp+rename 原子写；既有文件坏 JSON 时拒绝写入（宁可不写也不覆盖用户文件）。

## 4. 平台命令构造（D8 转义后）

| 平台 | 命令 |
|------|------|
| darwin | `osascript -e 'display notification "<body>" with title "<title>"'`（AppleScript 字面量：`\` 与 `"` 转义） |
| win32 | `powershell.exe -NoProfile -NonInteractive -Command <script>`，script 用 `NotifyIcon.ShowBalloonTip(8000, '<title>', '<body>', Info)`（PS 单引号字面量 `'` 翻倍转义；含 `Start-Sleep` + `Dispose` 让托盘图标收敛） |
| linux | `notify-send <title> <body>` |
| 其它 | 不构造命令，直接返回（no-op） |

## 5. 三端接线

| 端 | 注入点 | done 触发 | confirm 触发 |
|----|--------|-----------|--------------|
| TUI | `AppOptions.notify`（cli/src/index.ts `start()` 构造） | `run()` finally（状态：completed / aborted / failed，时长 = 本轮 run 起止差） | `confirm` 回调（ConfirmCard 渲染前） |
| Web | `SessionHubDeps.notify`（`delta serve` 构造） | `send()` finally（状态含 aborted / failed 判定） | `toolContext.confirm` 回调（publish `confirm_request` 处） |
| Headless | `runHeadlessCommand` 内直接构造 | `runHeadless` 返回后（status ∈ 全部终态，时长用 `outcome.durationMs`） | 不触发（headless 自动拒绝，无等人环节） |

## 6. CLI 子命令

```
delta notify status            生效配置 + 来源（用户/项目文件） + 平台后端 + 配置警告
delta notify enable            写 ~/.delta/notify.json enabled=true（其它字段保留）
delta notify disable           写 enabled=false
delta notify test              发送一条样例通知（人工验证端到端链路）
```

注册于 `cli/src/index.ts`，并加入 `KNOWN_SUBCOMMANDS`（裸任务路由白名单）。

## 7. 文件清单

| 文件 | 动作 |
|------|------|
| `packages/core/src/notify/types.ts` / `config.ts` / `notifier.ts` | 新增 |
| `packages/core/src/index.ts` | 导出 notify 模块 |
| `packages/core/src/server/hub.ts` | `SessionHubDeps.notify` + confirm/finally 两处触发 |
| `packages/cli/src/ui/app.tsx` | `AppOptions.notify` + confirm/finally 两处触发 |
| `packages/cli/src/notify.ts` | 新增（status/enable/disable/test） |
| `packages/cli/src/index.ts` / `headless-run.ts` | 注册子命令；start/serve/run 三处构造注入 |
| `packages/core/test/notify-config.test.ts` / `notify.test.ts` | 新增 |
| `docs/PRD.md` | F-33 行补交付标注 |

## 8. 测试策略

- 配置：缺省值、项目覆盖用户、非法值降级 + warning、坏 JSON 层忽略、未知键 warning、原子写只改 enabled、坏 JSON 拒写。
- 通知：三平台命令构造与转义（darwin 引号、win32 单引号翻倍、linux 参数序）、未知平台 no-op、门槛/enabled/onDone/onConfirm 开关、正文清洗（换行折叠 + 截断）。
- 不真发系统通知（runner 全部伪造）。

## 9. 风险与裁决

| 风险 | 裁决 |
|------|------|
| macOS 未授权 delta/终端发通知 | 通知静默丢弃不报错；`notify status` 提示检查「系统设置 → 通知」 |
| Windows PowerShell 启动慢（数百 ms） | detached + fire-and-forget，主流程零等待 |
| CI 环境（无桌面会话）频繁误发 | headless 用户可 `delta notify disable` 或项目级 `onDone:false`；发送失败静默 |
| 通知内容泄漏敏感信息 | 正文只用状态/耗时/工具名/reason 前缀（reason 本就是给用户看的风险提示），不携带文件路径参数全文 |
