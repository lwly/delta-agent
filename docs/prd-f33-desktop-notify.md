# F-33 桌面通知 —— PRD 增量

> 状态：已实现 ｜ 日期：2026-10-23 ｜ 关联：docs/PRD.md §3.2 F-33

## 1. 需求回顾

PRD F-33：**长任务完成、需人工确认时系统级通知（macOS 通知中心 / Windows 通知）**。

痛点：`yzero` 长任务（Plan / Multi-Agent / 大型重构）动辄数分钟，用户切走后：
- 任务结束无感知，回来才发现早已完成（或早已失败）；
- 高危操作确认卡静默挂起，任务停在原地等人。

## 2. 需求细化为验收标准

| # | 验收项 |
|---|--------|
| AC-1 | 任务（一次 send / 一轮 run）结束时发系统级通知，正文含结束状态与耗时；运行时长低于阈值（默认 30s）**不**通知（防噪，只打扰"长任务"） |
| AC-2 | 确认卡（`confirm_request`）出现时发通知，正文含工具名与风险提示；确认是等待人的天然低频事件，不受时长阈值约束 |
| AC-3 | 后端：macOS 用系统自带 `osascript`（通知中心）；Windows 用 PowerShell `NotifyIcon.ShowBalloonTip`（Win10+ 以 toast 形式呈现，PS 5.1 内置零依赖）；Linux 附带 best-effort `notify-send`；其它平台自动 no-op |
| AC-4 | 三端生效：TUI（App）、Web 控制台（SessionHub）、Headless（`yzero run`） |
| AC-5 | 配置两级文件：`~/.y-zero/notify.json` < `.y-zero/notify.json`（项目覆盖用户）；字段 `enabled` / `onDone` / `onConfirm` / `minDurationMs`；非法值降级默认 + warning，**永不 throw** |
| AC-6 | CLI 开关：`yzero notify status / enable / disable / test`（test 发送样例通知供人工验证）；enable/disable 只改 `enabled` 字段、写前读、tmp+rename 原子写 |
| AC-7 | 通知发送 fire-and-forget：spawn 失败 / 超时（10s 强杀）静默吞掉，**绝不影响主流程**；引擎零改动（旁路 sink 模式，对齐 F-30 `sandbox_notice` 决策） |
| AC-8 | 单测覆盖配置加载/合并/归一化、三平台命令构造（含转义）、防噪门槛；不真发系统通知 |

## 3. 范围外（本期不做）

- `ask_user` 提问通知（PRD 只提"需人工确认"；后续可在同一 `Notifier` 上扩展触发点）
- Web 控制台设置页 UI（配置文件 + CLI 已闭环）
- 声音 / 点击跳转会话等富交互
- macOS 未授权通知时的引导（`yzero notify status` 会提示检查系统设置）
