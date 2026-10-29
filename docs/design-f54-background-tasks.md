# 设计 F-54：会话内后台任务（run_in_background + Web 任务条）

> 配套 PRD：docs/prd-f54-background-tasks.md。关联 issue：PASI-22。

## 1. 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D54-1 | `BackgroundTaskManager` 进程级单例（serve 运行时创建，hub deps 与 http opts 共用同一实例），不落 SQLite | 会话内短生命周期状态；持久化属 F-49 范畴，本特性不重复建设。备选"复用 F-15b tasks 表"被否：那是 Plan 任务编排语义，塞命令进程会污染状态机 |
| D54-2 | spawn 直连 ShellAdapter（复用 `engine/shell.ts` 的 detectShell，跨平台一致），不走 `execViaBackend` / `runWithShell` | 后台任务无超时语义（runWithShell 强绑 timeoutMs + signal）；沙箱后端不支持非阻塞执行 → 明确拒绝而非降级 |
| D54-3 | 输出环形收集保尾巴（`MAX_BG_OUTPUT = 50_000` 字符），不落数据库 | task_output 只需尾部诊断；全量落盘的日志需求由用户重定向文件解决（agent 可自主组合 `> /tmp/x.log 2>&1`） |
| D54-4 | 与运行的 AbortSignal 解耦：本轮 abort / 会话停止不影响后台任务 | 这正是后台语义（用户停止对话 ≠ 杀 dev server）；serve dispose 时 killAll 兜底 |
| D54-5 | 完成不产生 AgentEvent；Web 侧 GET 轮询（2s） | 协议无增量事件通道下最小实现；与 RunStatusBar token 小字"无增量不做假实时"口径一致。P2 可加 SSE |
| D54-6 | kill 权限按会话隔离：DELETE 校验 task.sessionId 与路径会话一致 | 防 A 会话终止 B 会话任务（404）；跨项目共用 serve 时是必要边界 |
| D54-7 | 每会话已完成记录封顶 30 条（超限淘汰最早完成），运行中永不淘汰 | task_output 可查询窗口有界；防 Map 无界增长 |
| D54-8 | Web 轮询器在 store（bgTasks.ts），组件只做渲染；`watch(sessionId)` 切会话即重置 | 对齐 filePanel store 模式（组件不持业务状态）；切会话清列表防串台 + 过期响应丢弃 |

## 2. 模块

```
core/src/session/background-tasks.ts   BackgroundTaskManager（start/list/kill/killAll/getOutput）
core/src/tools/builtin/exec.ts         run_command 增 run_in_background/description；新增 taskOutputTool
core/src/tools/permissions.ts          TOOL_CAPABILITY 增 task_output: 'read'（BUILTIN_TOOL_COUNT 16→17）
core/src/tools/types.ts                ToolContext.backgroundTasks?（缺省 = 能力未装配）
core/src/server/hub.ts                 SessionHubDeps.backgroundTasks → toolContext 注入
core/src/server/http.ts                GET/DELETE /api/sessions/:id/background-tasks（未装配 501）
core/src/server/runtime.ts             装配单例 + dispose killAll
web/src/api/client.ts                  BackgroundTaskView 类型 + backgroundTasks/killBackgroundTask
web/src/stores/bgTasks.ts              轮询 store（2s；watch/refresh/kill/toggle）
web/src/components/BackgroundTasksBar.vue  胶囊 + 展开面板（已运行时长 1s 现算、停止按钮）
web/src/views/WorkbenchView.vue        挂载于聊天区与 composer 之间 + 会话切换接线（TerminalPane 已迁至右侧栏底部，不再位于主区）
```

## 3. 关键语义

### 3.1 工具协议（模型视角）

- `run_command {command, run_in_background: true, description?}` → 立即返回
  `后台任务已启动：bg_xxx`，meta 带 `background_task_id`；confirm 流程与同步执行完全一致
  （danger:'confirm' 不因后台而放宽——后台跑的命令风险相同）。
- `task_output {task_id}` → `[bg_xxx] 运行中（输出为部分内容，可稍后再次查询）` / `已结束（done，exit code: 0）`
  + 输出尾（10k 截断）。danger:'safe'，只读。
- 未注入 manager（TUI/headless）：两者都报 `background_tasks_unavailable`，引导回同步执行
  （对齐 F-26 task_unavailable 口径：定义可见、执行降级）。

### 3.2 任务状态机

```
running ──(close code=0)──────────→ done
running ──(close code≠0 / error)──→ failed
running ──(kill by user)──────────→ killed   （killedByUser 标记优先于退出码判定）
```

### 3.3 Web 任务条

- 胶囊：`⏱ N 个后台任务运行中`（呼吸点），N = running 数；v-if 条件渲染，无任务零 DOM。
- 面板：描述（title 悬浮完整命令）+ `已运行 42s / 7m19s / 1h02m`（1s ticker 现算，胶囊隐藏即停表）
  + 🗑 停止按钮（hover 显形，确认流不做——终止后台命令是低风险可逆操作）。
- 轮询失败（501/网络）静默保持现状，下一轮重试；kill 后立即 refresh 不等下轮。

## 4. 测试策略

- manager 单测：start→done 收敛 / kill→killed / 跨会话拒绝 / 描述缺省截断 / 封顶淘汰。
- 工具单测：未注入报错 / meta 带 id / 沙箱拒绝 / task_output 三分支。
- 端点单测：未装配 501 / 列表按会话过滤 / DELETE 200 与 404。
- Web store 单测：runningCount 口径 / 空会话不发请求 / 过期响应丢弃 / kill 即刷 / 失败保持现状。
- 已知平台边界：spawn 语义测试 `skipIf(win32)`（PowerShell 分支由 shell.test.ts 覆盖）。

## 5. 已知限制与后续演进

- 不持久化：serve 重启后任务与输出丢失（前端表现为任务条消失，符合直觉）。
- 不做沙箱后台执行：Seatbelt/Docker 均为阻塞 run 语义，需执行器层支持 detach 后再议。
- 无完成事件推送：P2 可在 finish() 时经 hub.publish 发 `background_task_done` 事件，
  前端由轮询升级为 SSE 推送（现有 events 通道即可承载）。
- 孙进程残留：SIGKILL 直接子进程后，孙进程若脱离管道可能存活（Windows 尤甚）——
  与既有 runWithShell 的 kill 语义同一水平，不做进程组级清理（P2 可用 detached + process group）。
