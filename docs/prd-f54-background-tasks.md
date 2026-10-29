# PRD F-54：会话内后台任务（run_in_background + Web 任务条）

> 关联 issue：PASI-22。配套设计：docs/design-f54-background-tasks.md。
> 注意区分：F-49 后台任务队列（jobs 表 + JobRunner，任务级"派活—跑—回 PR"）面向跨会话任务编排；
> 本特性面向**单会话内**的长耗时命令（安装依赖 / 构建 / dev server），是工具层能力 + 会话级 UI。

## 1. 背景与问题

当前 `run_command` 是同步阻塞执行（超时上限 10 分钟）。长耗时命令会：
- 占满整轮运行，用户在 Web 端只能干等（停止即丢）；
- dev server 这类"永不退出"的命令根本无法用它启动。

参考产品形态（Claude Code / CodeBuddy）：命令可转后台运行，输入框上方出现
"N 个后台任务运行中"胶囊，点开可看每个任务的描述与已运行时长，并可停止任务。

## 2. 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-54-1 | 用户让 agent 启动 dev server / 安装依赖 | agent 用 `run_command` + `run_in_background=true` 启动后立即继续对话；Web 输入框上方出现「⏱ 1 个后台任务运行中」胶囊 |
| US-54-2 | 用户想了解后台在跑什么 | 点击胶囊展开面板：每行显示任务描述 + 已运行时长（实时刷新），右上角 × 收起 |
| US-54-3 | 用户想终止某个后台任务 | 展开面板后每行有停止按钮，点击即终止（SIGKILL）并从列表移除 |
| US-54-4 | agent 需要后台命令的产出 | agent 用 `task_output` 工具按任务 id 查询状态与输出尾；任务完成后状态收敛 done/failed/killed |

## 3. 范围

**做**：
- `run_command` 新增 `run_in_background` / `description` 参数（后台执行不经沙箱，v1 限制）；
- 新内置工具 `task_output`（查询状态与输出尾，只读）；
- core `BackgroundTaskManager`（进程级，serve 运行时注入 hub 与 HTTP 层共用）；
- HTTP 端点：`GET /api/sessions/:id/background-tasks`、`DELETE /api/sessions/:id/background-tasks/:taskId`；
- Web：输入区上方任务条组件（胶囊 + 展开面板 + 停止按钮），2s 轮询刷新。

**不做**（P2 / 明确出范围）：
- 任务持久化（serve 重启即丢，进程崩溃不恢复——区别于 F-15b/F-49）；
- 沙箱模式下的后台执行（Seatbelt/Docker 后端不支持非阻塞执行）；
- 完成事件推送（协议无增量事件，Web 用轮询，与 RunStatusBar token 小字同口径）；
- "后台任务不消耗积分"类文案（产品确认不需要）。

## 4. 验收标准（AC）

- AC-54-1 后台启动立即返回任务 id（bg_*），不阻塞本轮对话；meta 带 `background_task_id`。
- AC-54-2 Web 有运行中任务时输入区上方出现胶囊，数量 = running 数；无任务时零残留 UI。
- AC-54-3 胶囊可展开/收起；任务行实时显示已运行时长（s → m s → h m 进制）。
- AC-54-4 停止按钮终止任务（SIGKILL），列表随之更新；跨会话 id 拒绝（404）。
- AC-54-5 `task_output` 返回 status/exit_code/输出尾（50k 字符封顶保尾）；未知 id 报 unknown_task。
- AC-54-6 能力未装配（TUI/headless/旧宿主）时后台执行与 task_output 明确报错，端点 501（对齐 terminal 口径）。
- AC-54-7 serve dispose 全杀后台任务（防孤儿进程）。
