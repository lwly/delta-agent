# F-59 设计：定时任务 / 运行日志项目作用域化 —— 增量设计与实施记录

> 状态：已实施回填 v1 · 2026-11-09 ｜ 上游：prd-f59-scope-cron-logs.md
> 零协议变更：F-22 的 cron.json（任务自带 `cwd`）与 F-41 的 LogEntry（自带 `sessionId`，D10 明确「Web 过滤用」）已携带归属字段，过滤在 Web 端完成；core / cli / shared 不动。
>
> **定位标注（架构收口 T3 回写）**：本特性是**前端可见性过滤，非权限边界**——
> 数据 API 不带过滤参数，绕过 Web 前端仍可见全量。架构收口 T6 将后端化为
> `project_id` 参数过滤（届时 `web/src/utils/scope.ts` 标注 legacy）。术语口径见
> `docs/architecture-glossary.md` §10-①。

## 1. 方案概述

两页同构的作用域模式：

```
原始全量数据（既有 API，不变）
  └─ scoped 集合（projectScoped && activeRoot 时过滤；否则透传）
       └─ Tab/级别计数（基于 scoped 集合 → 数字与所见一致）
            └─ 既有 tab/级别 + 文本过滤（原逻辑不动，输入换成 scoped 集合）
```

作用域开关 UI：两页各一个 chip/按钮（激活态「📁 项目名」/ 关闭态「全部项目」「全部日志」），未选项目时隐藏。

## 2. 归属判定（utils/scope.ts，纯函数 + 单测）

### 2.1 cron：cwd 字面匹配

```ts
cwdInRoot(cwd, root) = cwd === root || cwd.startsWith(root.endsWith('/') ? root : root + '/')
```

- 用**字面前缀**而非路径归一化：cron.json 的 cwd 与项目注册的 root_path 都是用户配置原值（F-22 语义：cwd 是任务属性），不做 `..` 解析、不做 symlink 解析。
- 关键边界：兄弟目录前缀陷阱——`/a/b-c` 不得命中根 `/a/b`（拼接 `/` 后比较天然规避）；root 尾斜杠容忍；空值恒 false。
- 已知限制：项目目录改名/移动后旧任务 cwd 不再命中（prd §5.2，保持 F-22 语义）。

### 2.2 日志：sessionId 归属集合

```ts
logEntryInProject(sessionId, projectSessionIds) = sessionId != null && projectSessionIds.has(sessionId)
```

- 会话集合来源：进入页面 / 切项目 / 开关切回作用域时 `GET /api/projects/:id/sessions?limit=500` 一次拉取构建 `Set<string>`（LogsView 内 watch immediate）。
- **无 sessionId 的条目在作用域下隐藏**：serve / cron 调度级日志没有会话维度，无法归属；这是有意的（用户要看「这个项目发生了什么」），切「全部日志」可见。
- 已知限制：会话 > 500 条的项目的极老会话可能漏显（prd §5.1）；环形缓冲 1000 条 + 会话列表按最近更新排序，实际覆盖充分。

## 3. 页面接线

### 3.1 CronView（views/CronView.vue）

- `jobs` 仍拉全量（既有 `cronList`）；新增 `scopedJobs` computed → `counts` / `filteredJobs` 改为其下游，Tab 逻辑零改动。
- 作用域 chip 渲染在 `.tabs` 首位（级别 tab 之前），激活态样式复用 `.tab.active`。

### 3.2 LogsView（views/LogsView.vue）

- `entries` 仍为环形缓冲镜像（tail 500 + SSE 追加，既有逻辑不动）；新增 `scopedEntries` computed → `counts` / `filtered` 改为其下游。
- 作用域按钮渲染在 `.head-actions` 首位（自动滚动之前）；`loadProjectSessions` 对过期响应做项目切换防御（await 后比对 activeProjectId）。

## 4. 测试增量

`utils/scope.test.ts`（9 例）：
- cwdInRoot：根本身 / 子目录 / 尾斜杠 root / 兄弟目录前缀陷阱（`/project-x` vs `/project`）/ 不相关路径 / 空值。
- logEntryInProject：命中 / 未命中 / sessionId 缺失（null、undefined）/ 空集合。

## 5. 验收要点（对应 prd §4）

1. 作用域默认开：两页数字、列表与当前项目一致；切「全部」恢复全量。
2. 左侧切项目：两页过滤即时跟随（无需刷新按钮）。
3. 既有操作（批量启停 / 删除 / 立即运行 / 日志复制、暂停、自动滚动）行为不变。
4. 门禁：typecheck / web 单测（115 + 9）/ smoke:web / web e2e 全绿。
