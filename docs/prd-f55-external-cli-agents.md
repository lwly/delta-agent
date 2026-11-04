# F-55 PRD：外部 CLI Agent 接入

> 状态：已评审 ｜ 日期：2026-11-04 ｜ 编号：F-55 ｜ 设计：`docs/design-f55-external-cli-agents.md`

## 背景与目标

delta 当前三类执行后端（ReAct / Plan / Multi-Agent）都要求用户自备 LLM Provider API Key。大量目标用户已在 Claude Code / Codex / 其他 ACP agent 上有付费订阅，希望 delta 直接复用这些订阅登录态跑任务，无需再配 Key。

**目标**：外部 CLI agent 成为 delta 的**第 4 种执行后端（引擎）**，与内置三引擎在同一会话/消息/报表/渲染体系下无差别工作。

## 用户故事

1. **无 Key 用户**：未配置任何 Provider Key，`delta --external cli:claude-code` 启动并完成一次改码任务；`delta models list` 能看到探测到的外部 agent。
2. **谨慎用户**：在 `plan` 档下使用外部 agent，任何写文件/执行命令的请求都被拒绝；`default` 档下每次工具调用在 TUI/Web 弹确认卡，选择「本会话允许」后同工具不再询问。
3. **多后端用户**：外部会话的消息流、usage 报表与内置引擎会话在同一界面呈现，无差异分支；订阅调用不计入「已花费」金额（显示「订阅内 N 次调用（未计量）」）。
4. **续跑用户**：`delta -r <id>` 继续一个外部会话；CLI 侧令牌失效时降级为摘要重建并提示一次，不崩溃。

## 范围

- **做**：ACP（Tier A）/ Claude stream-json（Tier B）/ Codex app-server（Tier C）三类适配器；三档权限映射与能力降级声明；MCP 配置透传；会话续跑（resume 令牌）；探测与配置（`external.json`、doctor、models list、Web 设置面板）；迁移 v6（`sessions.external_id/external_agent` + `usage.billing`）。
- **不做**：见设计稿 §16（不自动下载 CLI、不接 Plan DAG、不做 agent 间编排等）。

## 验收标准（与设计稿 §14 一致）

- **AC-55-1** 未配置任何 Provider Key 时，`delta --external cli:claude-code` 能启动并完成一次任务；`delta models list` 显示探测到的外部 agent。
- **AC-55-2** 外部会话的全部产出走同一 `AgentEvent` 流：TUI/Web 渲染、消息落库、usage 报表与内置引擎无差异分支（代码上不出现散落 `if (external)`，仅 `ctx.model` 前缀可用于展示）。
- **AC-55-3** `plan` 档下外部 agent 的任何 write/exec 请求被拒绝；Tier A 逐次拦截、Tier C 拒绝启动并报 `external_no_plan_mode`。
- **AC-55-4** `default` 档下 Tier A 的每次工具调用在 Web 端弹出确认卡，`allow_session` 后同工具不再询问（与 F-23 会话记忆同语义）。
- **AC-55-5** 用户点停止后 1s 内进程退出（跨平台）；serve dispose 后无孤儿进程。
- **AC-55-6** 外部会话 `usage` 行 `billing='subscription'`；F-31 报表金额列不把订阅调用计入「已花费」。
- **AC-55-7** 外部会话下沙箱 / 压缩 / 蒸馏 / `task` 四项能力显式降级：UI 有提示条，`doctor` 有说明，日志有 `debug` 记录，但不弹错误。
- **AC-55-8** 会话续跑：`delta -r <id>` 命中外部会话时用 resume 令牌；令牌失效时降级为摘要重建并提示一次，不崩溃。
- **AC-55-9** 外部会话不写任何凭证到 `~/.delta/`；`external.json` 中不含 token 字段（测试断言）。

## 里程碑

P0 引擎接缝 + 映射 + 假 CLI → P1 ACP + 权限桥接 → P2 Claude stream-json + 检测 + MCP → P3 Codex + resume + Web → P4 并发。各阶段出口标准见实施计划。

## 风险与声明

- 上游 CLI 版本漂移 → 适配器「能力探测 + 运行时实测」，不匹配明确报错。
- 权限契约错位（用户以为 delta 沙箱在生效）→ 四项能力降级显式提示，不静默。
- 订阅内调用不是零成本但拿不到单价 → `billing` 口径分离，不报 ¥0.00。
