# F-58b 设计：工作台委派式改版（轻首页 + 任务详情面板）—— 增量设计与实施记录

> 状态：已实施回填 v1 · 2026-11-09 ｜ 上游：prd-f58b-delegate-home-ui.md、design-f58-router-worker.md
> 本文档为**增量设计**：F-58 的数据模型（§7）、API 契约（§14）、状态机（§7.4）完全不变，本文只描述 web 前端增量。
> 实施记录：commit `fd742a8`（feat(web)）+ `c0dce4b`（test(e2e)）。

## 1. 增量方案概述

### 1.1 为什么零后端改动

F-58 已确立「Worker = 独立会话」（design-f58 §5.1）：每个任务派发即创建一个独立 Worker 会话，`worker_tasks.worker_session_id` 是它的句柄。因此「任务详情视图」不需要任务级消息通道——它就是**该 Worker 会话的一个轻量视图**：

| 面板能力 | 复用的既有通道 |
|---|---|
| 历史消息 | `GET /api/sessions/:id/messages`（F-53 分页端点，`limit=50` 首屏） |
| 实时状态 / 流式 | `GET /api/sessions/:id/events`（SSE，`subscribeSession`） |
| 续发消息 | `POST /api/sessions/:id/messages`（hub 单槽：空闲直发即触发 run；运行中 409） |
| 任务行 / 状态 chip | tasks store 既有 2s 轮询（`GET /api/projects/:id/worker-tasks`） |
| 派单 | `POST /api/projects/:id/worker-tasks`（`dispatch: true` 立即派发，F-58 §14 已有） |

### 1.2 增量面

```
packages/web/src/
├── views/WorkbenchView.vue        # 空态 hero 重写为轻首页；挂载 TaskDetailPanel + 接手 toast
├── components/TaskBoard.vue       # 单列表 → 三组分组渲染；行点击 openTaskPanel
├── components/TaskDetailPanel.vue # 新增：Worker 会话轻量视图（右滑面板）
└── stores/tasks.ts                # +groups getter / +openTaskId、openTaskPanel / +dispatch action
e2e/web/workbench-load.spec.ts     # 首屏断言对齐轻首页三要素
```

依赖方向不变（web 消费 core HTTP API，无新包依赖）；不动 cli / core / shared。

## 2. tasks store 增量（stores/tasks.ts）

### 2.1 分组 getter（唯一口径，侧栏与首页共用）

```ts
groups: (s): TaskGroups => ({
  needYou:  s.tasks.filter(t => t.status === 'needs_decision'),
  active:   s.tasks.filter(t => t.status === 'queued' || t.status === 'preflight' || t.status === 'running'),
  finished: s.tasks.filter(t => t.status === 'done' || t.status === 'failed' || t.status === 'canceled'),
}),
```

渲染顺序固定：需要你 → 处理中 → 已完成；空组不渲染。七态全覆盖、无遗漏、无重复（与 `WorkerTaskStatus` 枚举一一对应）。

### 2.2 面板状态

- `openTaskId: string | null`（state）；`openTaskPanel(taskId | null)`（action）。
- `openTask` getter = `tasks.find(t => t.id === openTaskId)`：轮询刷新后自动跟随最新任务行（状态 chip / result_summary 实时变化，面板无需自建任务轮询）。
- 清理点：`stop()` 与 `watch(null)` 清空 `openTaskId`（项目切换不泄漏）。

### 2.3 dispatch action（轻首页「输入即派」）

```ts
dispatch(projectId, { goal, executor?, permissionMode? }) → Promise<WorkerTaskView>
```

- title 收敛：goal 首行 trim，> 24 字截断加 `…`（与目标形态「标题 = 一句话」一致）；goal 为空抛 `任务内容为空`。
- 透传 `{ title, goal, executor: executor ?? null, permission_mode: permissionMode ?? 'default', dispatch: true }`。
- 成功后 `refresh()`（依赖 `projectId` 上下文——首页接线与任务台一致，watch 中调用）；失败向上抛给调用方 toast，不做乐观状态机（红线，沿用 F-58 惯例）。

## 3. TaskDetailPanel（components/TaskDetailPanel.vue）

### 3.1 触发与生命周期

- 非模态右滑固定面板（380px，`position: fixed`，z-index 60），`v-if="task"`（store.openTask 非空才渲染）。
- watch `[openTaskId, worker_session_id]`：面板打开且会话句柄就绪 → `openStream(sid)`；面板关闭或会话未创建（queued/preflight）→ `closeStream()`。
- `worker_session_id` 变化（如 retry 换新会话）自动重开流；组件 `onUnmounted` 兜底 `closeStream()`。

### 3.2 SSE 事件最小子集（与 stores/chat.ts 的差异）

面板是**只读为主的会话视图**，只处理六类事件，完整口径以 chat store 为准：

| 事件 | 面板行为 |
|---|---|
| `state` | `running` 标志（输入框禁用 / 「正在思考思路…」展示） |
| `text_delta` | 流式文本累积（打字机光标） |
| `tool_call_start` | 流式文本落 assistant 消息；新建 running 工具卡 |
| `tool_result` | 按 callId 配对回填卡片状态 / 内容；孤儿结果兜底建卡 |
| `ask_user` | 澄清问题渲染为助手消息卡（❓ 前缀）；回答走普通消息通道（不复用 pendingAsks 卡队列——面板无审批卡区） |
| `done` | 流式尾巴落消息；`refetchAfterDone()` 增量重拉 |

**不处理**：confirm_request / plan_approval（审批卡仍在主会话流；Worker 会话的确认应在主工作台或后续迭代裁决）、budget_* / notice 类（面板不设 notice 区，降噪）。

### 3.3 历史重建与 done 增量（诚实性口径）

- 历史卡片重建：assistant 消息的 `toolCalls[]`（含 name / argsJson）建卡，`role:'tool'` 消息按 `toolCallId` 配对回填；调用消息被折叠窗口截掉时孤儿结果兜底建卡（name 兜底 `tool`）。历史消息无本地耗时数据，`durationMs` 恒为 null（不伪造，沿用 ToolCallCard 诚实性口径）。
- `refetchAfterDone()`：以本地最大 `seq` 为 after 游标循环分页拉增量（上限 20 轮 × 500 条），本地 UI 消息不回带耗时（与 chat store 的 carry 策略不同——面板不接受「回退观感」级别的细节损失，简化为直接追加）。

### 3.4 续发消息与 409 兜底

- `canSend = worker_session_id && !running && !sending`；输入框 + 占位文案禁用双兜底。
- 发送：本地先入列 user 消息 → `api.send(sid, text)`；失败（含轮询间隙 409）回滚该条并显示错误行。发送即隐式触发新一轮 run（hub 语义），面板靠 `state` 事件切回运行态。

## 4. 轻首页（WorkbenchView.vue 增量）

### 4.1 结构

```
.hero（保留基础 flex 居中规则）
└── .hero-home
    ├── .home-slogan        # 把工作交出去。/ 回来就能看到答案。（答案 = accent 色）
    ├── .home-sub           # 副文案 / 无项目提示（二选一）
    ├── .home-composer      # 输入卡：textarea（Enter 发送）+ .home-ops
    │   ├── .home-executor  # 助手选择器：内置助手 Δ / externalAgents[].id
    │   └── .home-send      # ↑ 圆钮
    └── .home-group × N     # 三组任务卡（点击 openTaskPanel）
.delegate-toast            # 固定底部居中（z-index 70，8s 自动消失）
```

- 助手选择器直接消费 `externalAgents`（F-56 已加载）；展示名 `displayName || label || id`，未登录条目带「（未登录）」后缀。executor 值即 `a.id`（`cli:*` / `acp:*`），与模型选择器同源（§3 现状核实）。
- Enter 精确匹配发送（`@keydown.enter.exact.prevent`），Shift+Enter 换行；空输入禁用发送。
- toast「打开」= `openTaskPanel(taskId)` 并收掉 toast；toast 状态仅存于视图（不入 store）。
- 旧 hero 三特性卡 / 按钮组整体移除：注册项目入口仍在侧栏「＋ 新项目」；文件面板 / 回放入口仍在 rail 与 tabbar，无能力丢失。

### 4.2 与既有动线的关系

- 轻首页只出现在「无打开会话」空态（沿用原 hero 条件 `!chat.sessionId || !chat.sessionMeta`）；打开任一会话即回到完整工作台。
- 侧栏任务台（TaskBoard）与首页分组列表共用 `groups` getter，两条入口打开同一个 TaskDetailPanel。
- 委派任务**不**自动打开 Router 会话：dispatch 后用户停留在轻首页看任务进展（目标形态），Router 播报仍走主会话（F-58 §10）。合并动线列为 P2 候选（prd-f58b Q3）。

## 5. 测试增量

- `stores/tasks.test.ts`（+5）：
  1. groups 三组映射（七态全采样断言归属）；
  2. openTaskPanel / openTask：轮询刷新后 getter 跟随最新行、关闭置空；
  3. dispatch：title 首行截断、executor / `dispatch: true` 透传、内部 refresh（依赖 watch 上下文）、空 goal 拒绝；
  4. dispatch 失败向上抛（不吞错）；
  5. stop 清 `openTaskId`。
- `e2e/web/workbench-load.spec.ts`：首屏断言 `.brand-name` / `.sidebar` / `.home-slogan`（含「把工作交出去」）/ `.home-composer` / `.home-executor`（含「内置助手」）。

## 6. 验收要点（对应 prd-f58b §6）

1. 全量 `pnpm typecheck` / `pnpm --filter @delta/web test`（115 通过）/ web e2e（10 passed, 2 skipped）/ `pnpm smoke:web` 通过。
2. 详情面板对 done / running / queued 三态任务的渲染行为（历史完整 / 实时流 / 排队占位）手工验收路径见 prd-f58b §6.4-6.6。
3. 已知限制：面板不处理审批卡（confirm / plan）——外部 Worker 的 needs_decision 仍走侧栏任务台裁决弹窗；「等待中」独立分组待 prd-f58b Q1 决策。
