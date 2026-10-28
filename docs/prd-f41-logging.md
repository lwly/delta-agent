# F-41 运行日志 —— PRD 增量

> 状态：已实现 ｜ 日期：2026-10-28 ｜ 关联：docs/PRD.md §4 非功能需求「可观测」

## 1. 需求回顾

PRD 非功能需求「可观测」：全链路 trace 日志（轮次、token 消耗、工具耗时）。

痛点：delta-agent 当前的运行日志只有 console 输出，进程退出后无处可查：

- `delta serve`（Web 控制台 / cron daemon 宿主）运行时的服务端日志不留档，排查「昨天那次任务为什么失败」只能复现；
- cron 定时任务（F-22）spawn 的 headless 子进程输出只取一份 JSON 报告进 `cron.json` 运行历史（20 条滚动），过程中的工具调用、错误细节全部丢失；
- headless `delta run` 的事件流只打到 stderr，管道里一晃就没；
- Web 控制台看不到服务端在干什么，只能从会话消息流间接推断。

## 2. 需求细化为验收标准（用户确认范围：文件落盘 + Web 实时展示 + cron/headless 留档）

| # | 验收项 |
|---|--------|
| AC-1 | serve 运行时日志落文件：`~/.delta/logs/serve-YYYYMMDD.log`（按日分文件，LF），含 MCP 接入、onboarding、会话运行生命周期（开始/工具调用/完成/失败/中止）、cron 调度等 |
| AC-2 | 内存环形缓冲（默认 1000 条）+ 实时订阅扇出：`GET /api/logs?limit=N` 尾读 + `GET /api/logs/stream` SSE 实时推送 |
| AC-3 | Web 控制台新增「运行日志」页（工作台侧栏入口）：进入拉取历史尾部 + SSE 实时追加，支持级别过滤（info/warn/error）、文本过滤、自动滚动开关 |
| AC-4 | headless `delta run` 全过程事件留档：`~/.delta/logs/runs/<时间戳>-<sessionId 前 8 位>.log`，含任务开始/结束状态与工具调用过程行；cron spawn 子进程即 `delta run`，自动获得同一份留档 |
| AC-5 | 日志写入失败（目录不可写等）静默降级为仅 console，**绝不影响主流程**（对齐 F-33 fire-and-forget 原则） |
| AC-6 | 零新增 npm 依赖：文件写入用 `node:fs`，SSE 复用既有事件流基建 |
| AC-7 | 日志过期清理：`~/.delta/logs/` 下超过保留期（默认 14 天）的 `.log` 文件在 serve 启动时清理一次 |
| AC-8 | 单测覆盖：RunLog（环形缓冲/落盘/清理/订阅/tail）、HTTP 端点（尾读/SSE）、hub 日志埋点；不依赖真实文件系统之外的环境 |

## 3. 范围外（本期不做）

- 日志级别动态调节（`--log-level` / 设置页开关）——固定 info 及以上
- TUI 侧日志查看（终端里 stderr 已可见）
- 结构化 JSONL 格式与日志导出命令（`delta logs` 子命令）
- token 消耗逐轮 trace（F-31 用量报告已覆盖费用/用量口径）
- 日志上传/远程收集（纯本地部署形态不做）

## 4. 隐私说明

运行日志落盘内容包含用户输入预览（截断 200 字符）与工具调用摘要。日志文件仅存在于本机 `~/.delta/logs/`，与 `~/.delta/agent.db` 同级同信任域；文档明示不做脱敏（本地工具形态可接受），后续如做远程收集需先补脱敏层。
