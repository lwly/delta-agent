# 架构术语表（唯一权威口径）

> 状态：✅ 架构收口改造 T3（PASI-98）交付，2026-11-09 ｜ 上游规格：`docs/architecture-consolidation-plan.md` §T3
>
> 本文件是**唯一术语表**：每个词给出「是什么 / 不是什么 / 代码位置（`file:line`）」。
> 各模块文档与注释与本表冲突时，以本表为准并回写漂移（T3 机制）；实施期发现新同名词
> 应先登记进本表再使用。行号以 T3 交付时的代码为准，后续漂移按语义就近校正。

## 1. Session（会话）

- **是什么**：`sessions` 表的一行 = 一次可恢复的对话上下文（消息 + 用量 + 状态），是唯一权威数据主干（「主干 sessions + messages + usage + AgentEvent」）。
- **三种 kind**：`chat`（用户对话）/ `router`（F-58 调度会话，派发 Worker 任务的「工头」）/ `worker`（一任务一会话，任务终态即封存）。kind 由服务端写入且**不可变**（裁决 Q1：无任何 PATCH / 客户端写入口）。
- **不是什么**：不是「任务」（任务见 §3 PlanTaskNode / §4 Delegation）；kind 也不是执行模式（见 §2 EngineMode）。
- **代码位置**：类型 `packages/core/src/session/store.ts:8`（`SessionKind`）；字段 `packages/core/src/session/store.ts:32`；写入口 `packages/core/src/session/store.ts:297`（`setSessionKind`，仅服务端创建路径调用）；Worker 会话创建 `packages/core/src/session/service.ts:164`（`createWorkerSession`）。
- **可见性口径（T2/D2 裁决）**：core 列表缺省**全量**；`kind=chat` 过滤只由 Web 侧栏显式发起；日志归属（`LogsView`）、搜索、用量、回收站、CLI `--resume` 恒为全量。

## 2. EngineMode（执行模式）

- **是什么**：一轮运行的引擎选择：`react` | `plan-execute` | `multi-agent`，决定 hub 四路引擎分派走向。
- **不是什么**：不是会话持久属性（`sessions.mode` 只是恢复时的缺省值）；不是会话 kind（router 会话派发的 Worker 子任务同样跑 EngineMode）；也不是权限档位（plan/default/yolo，见 §10 备注与 F-22b）。
- **代码位置**：`packages/core/src/engine/mode-prompt.ts:7`（`EngineMode` 定义）；分派 `packages/core/src/server/hub.ts:894-902` 附近（四路引擎分派，收口红线：不得改）。

## 3. PlanTaskNode（Plan 节点任务，`tasks` 表）

- **是什么**：F-15b plan-execute 模式下，一个 Plan 的节点执行记录（状态机 queued → running → completed|failed|canceled，带租约/心跳崩溃恢复）。「任务」在本模块语境 = Plan 节点。
- **不是什么**：不是 `worker_tasks`（见 §4）；不是会话（每个节点属于一个 plan_revision）；两表**禁止合并**（`packages/core/src/session/migrations.ts:190-193` 注释与 design-f58 §7.3 明令）。
- **代码位置**：DDL `packages/core/src/session/migrations.ts:84`（`CREATE TABLE tasks`）；行类型 `packages/core/src/session/tasks.ts:15`（`TaskRow`）；状态机 `packages/core/src/session/tasks.ts:13`；访问层 `packages/core/src/session/tasks.ts:56`（`TaskStore`，T3 起另有别名 `PlanTaskStore`，见 §11）；节点 JSON 结构 `packages/shared/src/index.ts:76`（`TaskNode`）。

## 4. Delegation（委派任务，`worker_tasks` 表）

- **是什么**：F-58 用户级委派任务的生命周期行（queued → preflight → running → ok|failed|canceled|…），由 Router 会话派发、Dispatcher 认领（claimSlot 原子抢占）、Watchdog 看护。「委派」在本语境 = 这张表的一行 + 其 Worker 会话。
- **不是什么**：不是 `tasks` 表（Plan 节点租约，见 §3）；不是 cron 定时任务（见 §5）；金额不入本表（从 usage 按 session_id 聚合，禁止双写）。
- **代码位置**：DDL `packages/core/src/session/migrations.ts:200`（`CREATE TABLE worker_tasks`）；行类型 `packages/core/src/router/types.ts:48`（`WorkerTaskRow`）；访问层 `packages/core/src/router/store.ts:101`（`WorkerTaskStore`）；派发泵 `packages/core/src/router/dispatcher.ts`。

## 5. ScheduledJob（定时任务，`cron.json`）

- **是什么**：F-22 用户级定时任务（5 字段 cron 表达式 + prompt），存储于用户级单文件 `~/.delta/cron.json`，与 CLI 共用；调度器随 `delta serve` 托管（T1/D1 裁决）或独立 daemon。
- **不是什么**：不是 DB 表（用户级 JSON 文件，无外键，`project_id` 归属见 T6）；不是委派任务；不做分布式/多机调度。
- **代码位置**：`packages/core/src/cron/store.ts:36`（`CronJob`）；执行编排 `packages/core/src/cron/runner.ts`；调度循环 `packages/core/src/cron/scheduler.ts:36`；运行锁 CAS `packages/core/src/cron/store.ts`（`acquireCronLock`，T1）。

## 6. BackgroundCommand（会话内后台命令）

- **是什么**：F-54 会话内后台任务（`run_in_background` / `task_output` 工具拉起的命令进程），**纯内存**（进程内 `Map`），serve 退出全杀，不落库。
- **不是什么**：不持久化（无表无文件）；不是 cron；不是 Worker 任务（无调度/看护）。
- **代码位置**：`packages/core/src/session/background-tasks.ts:56-57`（`BackgroundTaskManager` + 内存 `Map`）。

## 7. ExternalAgent（外部 Agent，第 4 引擎）

- **是什么**：以 `cli:*` / `acp:*` 标识注册的外部 CLI/ACP agent（claude-code、codex 等），作为 hub 四路分派中 `external` 一路的执行体；executor 形态即该标识。
- **不是什么**：不是内置引擎（react/plan-execute/multi-agent）；不是 Expert（Prompt 层概念，见 §8）；注册条目持久于 `~/.delta/external.json`。
- **代码位置**：已知清单 `packages/core/src/external/detect.ts:124`（`KNOWN_AGENTS`，`cli:*`）；executor 形态约束 `packages/core/src/tools/builtin/dispatch.ts:22`；执行引擎 `packages/core/src/external/`（adapter/lifecycle）。

## 8. Expert / ExpertTeam（专家 / 专家团，Prompt 层）

- **是什么**：F-39 三层专家库（builtin < user < project）中的提示词包：单专家（agent）或团队（team，主理人 + 成员卡），以 expert.json + agents/*.md 组织，绑定到会话后注入系统提示层。
- **不是什么**：不改变引擎分派与执行逻辑（纯 Prompt 层）；不是外部 Agent（§7）；团队绑定强制 react 模式。
- **代码位置**：包协议 `packages/core/src/experts/types.ts:11-13`（`ExpertType` / `ExpertPackage`）；团队运行时 `packages/core/src/experts/team.ts`；路由 `packages/core/src/server/experts-routes.ts`。

## 9. Workbench（工作台，UI 分支）

- **是什么**：Web 控制台的主视图形态（`WorkbenchView`）：对话流 / 委派轻首页。收口后的定位：**只是 UI 分支，不是运行模式**。
- **不是什么**：不是 EngineMode（§2）；不是会话 kind；不引入任何执行语义。
- **代码位置**：`packages/web/src/views/WorkbenchView.vue`；路由 `packages/web/src/router/`；文件面板联动 scope 见 §10-②。

## 10. scope（四处同名异义——按关注点各有唯一权威来源）

`scope` 在仓库内四处同名词、四个互不相干的关注点，**没有全局统一的 "scope" 概念**；每个关注点的唯一权威来源如下：

| # | 含义 | 关注点 | 唯一权威来源（file:line） | 不是什么 |
| --- | --- | --- | --- | --- |
| ① | **F-59 项目作用域** | cron 任务 / 运行日志在 Web 页按项目可见性过滤（cwd 前缀 / sessionId 归属）。**前端可见性过滤，非权限边界**；T6 后端化为 `project_id` 过滤 | `packages/web/src/utils/scope.ts:5-11`（`cwdInRoot` / `logEntryInProject`） | 不是权限；不是 §10-②③④ 的任何一种 |
| ② | **BrowseScope（文件面板作用域）** | 文件面板的数据根（session 工作根 → project 根 → null），变化即失效重拉 | `packages/web/src/stores/filePanel.ts:205`（`setScope`）、类型 `packages/web/src/api/client.ts`（`BrowseScope`） | 不是日志/任务过滤；不是 Skill 层级 |
| ③ | **SkillLayer（技能三层）** | 技能包发现层级 builtin < user < project（同名覆盖） | `packages/core/src/skills/loader.ts:17`（`SkillLayer`）、`packages/core/src/skills/layered.ts:11` | 不是专家库层级（Expert 同为三层但独立实现，§8） |
| ④ | **ToolContext 记忆/审计 scope** | 工具调用上下文携带 `sessionId`/`projectId`，作为记忆里程碑归属与审计归属 | `packages/core/src/tools/types.ts:86-88`（`ToolContext` 注释） | 不是可见性过滤；不是面板数据根 |

> 需要新增第 5 处同名者时，先在本表登记并给出「不是什么」，再写代码。

## 11. Task 模块导航（本仓库「Task」一词的四种语境）

四个模块都有「Task」字样，语境互斥；各模块文件顶部有对齐本节的锚点注释（T3）：

1. `packages/core/src/session/tasks.ts` —— **Plan 节点任务**（§3）。类型别名 `PlanTaskStore`（T3 新增导出）= 本文件的 `TaskStore`，语义更精确，优先在新代码使用；旧名保留兼容。
2. `packages/core/src/router/types.ts` / `router/store.ts` —— **委派任务**（§4，worker_tasks）。
3. `packages/web/src/stores/tasks.ts` —— **Web 任务台 store**：消费 worker_tasks（§4）的视图状态。
4. `packages/web/src/stores/bgTasks.ts` —— **后台命令 store**：消费 §6 内存后台任务的视图状态。

## 12. Plugin（插件）

- **是什么**：`~/.delta/plugins/<dir>` 或 `<project>/.delta/plugins/<dir>` 里的一个目录，根上有 `delta.plugin.json`（`id`，可选 `main`）。`delta serve` / `delta` 启动时调用 `loadPlugins`（传 `PluginHost` 则执行 `activate` / `default(host)`）：项目级同 id 覆盖用户级；`main` 必须落在插件目录内。
- **不是什么**：不是 Skill / Expert（提示词包，见 §8 与 SkillLayer）；不是 MCP Server（外部进程工具）；不是内置引擎源码搬到独立包。没有 `main` 的目录只作为内容包被发现，不执行。
- **代码位置**：加载 `packages/core/src/plugins/loader.ts:27`（`loadPlugins`）；激活 `plugins/activate.ts`（`createPluginHost` / 六槽）；信任 `plugins/loader.ts:127`（`readTrusted`）；目录名 `paths.ts`（`FILES.pluginsDir` / `FILES.pluginTrust`）。CLI `cli-plugins.ts`；serve 闭包 `server/runtime.ts`（P6）；发现端点 `GET /api/plugins`（system 组）。

## 13. Contribution（贡献）

- **是什么**：插件（或内置模块）向宿主登记的一种能力。当前六槽：引擎、工具、服务、路由、命令、视图。内置实现仍在原模块，启动时登记进槽；重复 id / 工具名 / 路由 method+pattern / 命令名 / 视图名直接抛错。
- **不是什么**：不是替换宿主。会话库、`RunGateway`、`ToolRegistry.executeOne`、工作台壳与旧地址重定向仍由宿主持有。路由处理函数由调用方闭合 `service` / `hub` 后经 `ServeOptions.routes` 并入，不从贡献槽里拿数据库连接。
- **代码位置**：子路径 `@delta/core/plugins`（`packages/core/src/plugins/index.ts`）。**P7**：`@delta/host` 聚合内置贡献 workspace 包 + `createServeRuntime`；`@delta/core/server` 收口 `SessionHub` / `routes` / 只读 API 路由；主桶仅兼容再导出。真机验收：`e2e/cli/e2e-plugins.mjs`（CLI 命令 + serve）、Web `e2e/web/plugins-api.spec.ts` + `plugin-views/bootstrap.ts`。
  - 引擎 `packages/core/src/plugins/host.ts`（`registerEngine` / `resolveEngine`）；登记 `plugins/engines-register.ts`，内置包 `packages/plugins/builtin-engines`（P2）；hub 经 `plugins/contract` 分派
  - 服务 `packages/core/src/plugins/services.ts`（`createServiceHost`）；内置 `plugins/builtin-services/`（P3），包 `packages/plugins/builtin-services`
  - HTTP 路由 `packages/core/src/server/routes.ts`（`RouteDef` / `matchRoute` / `assertRouteDecls`）；内置表 `server/builtin-routes/`（P4：cron、worker-tasks、sessions、system），包 `packages/plugins/builtin-routes`；装配 `server/http.ts`（`createWebServer`）；静态托管 `server/static-host.ts`
  - CLI 命令 `packages/cli/src/commands.ts`（`registerCommand`）；内置树 `cli/builtin-commands/mount.ts`（P4），包 `packages/plugins/builtin-commands`
  - 工具 `packages/core/src/plugins/tools.ts:20`（`registerTool`）
  - 服务 `packages/core/src/plugins/services.ts:17`（`createServiceHost`）
  - 路由 `packages/core/src/server/routes.ts:107`（`appendRoutes`）；缺 `auth` 仍由同文件 `assertRouteDecls` 在构造期抛错
  - 命令 `packages/cli/src/commands.ts:14`（`registerCommand`）
  - 视图 `packages/web/src/view-slot.ts:18`（`registerView` / `shellRoutes`）；内置页 `web/builtin-views/register.ts`（P5）；用户插件视图元数据 `core/plugins/view-meta.ts` + Web `plugin-views/bootstrap.ts`（P6）

## 14. Trust（插件信任）

- **是什么**：`~/.delta/plugin-trust.json` 的 `{ trusted: string[] }`，按插件 `id` 列出允许执行 `main` 的进程内插件。未列入的有 `main` 的插件状态为 `untrusted`，不 `import`。清单缺失或 JSON 损坏视为无人被信任。
- **不是什么**：不是专家信任（`~/.delta/experts.json`，见 §8，带 version / toolsHash）；不是权限档（plan/default/yolo）；不是能力授权界面。信任只决定是否执行 `main`，工具确认与沙箱仍在 `executeOne`。
- **代码位置**：文件名 `packages/core/src/paths.ts:81`（`FILES.pluginTrust`）；判定 `packages/core/src/plugins/loader.ts:119`（`readTrusted`），未信任 `packages/core/src/plugins/loader.ts:55`（`status: 'untrusted'`）。单个 `main` 抛错记 `status: 'error'`，其余插件继续加载。

## 维护约定

- 术语新增/含义变更 → 先改本表（docs 提交），再改代码注释；两者同一迭代交付。
- 模块顶部锚点注释格式：「本模块的 Task 指的是 X（见 glossary §N），不是 Y」。
