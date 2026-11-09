# PRD F-58b：工作台委派式改版（轻首页 + 任务详情面板）

> 状态：已实施回填 v1 · 2026-11-09 · 依赖 F-58（Router–Worker 调度层已交付，见 design-f58-router-worker.md）
> 本文档为**增量 PRD**，只描述变更部分；F-58 已有内容（worker_tasks 数据模型、任务状态机、dispatch/decision/cancel API、任务台列表）不再重复。
> 实施记录：commit `fd742a8`（feat(web)）+ `c0dce4b`（test(e2e)），2026-11-09。

## 1. 变更目标

1. **G1 形态升级**：工作台空态从「功能陈列式 hero」（图标 + 三特性卡 + 按钮组）升级为「委派式轻首页」——居中 slogan + 输入即派任务，把「把工作交给助手」做成默认动线。
2. **G2 任务成为一等公民**：任务从侧栏单列列表升级为按注意力状态三组分组（需要你 / 处理中 / 已完成），并补齐任务详情视图（实时状态 / 步骤摘要 / 续发消息）。
3. **G3 零新通道**：不改后端、不加端点。任务详情面板 = Worker 会话的轻量视图（F-58 已确立「Worker = 独立会话」，§5.1），历史 / 实时 / 续发消息全部复用既有会话 API。

## 2. 用户故事

1. 作为想快速委派工作的用户，我打开工作台就看到一句「把工作交出去。回来就能看到答案。」和一个输入框，我选一个助手、写一句话，Enter 即派任务，不用先理解「项目 / 会话 / 模式」这些概念。
2. 作为同时跟进多个任务的用户，我想按「需要你 / 处理中 / 已完成」三组看任务，一眼知道哪个在等我裁决、哪个在跑、哪些已完结。
3. 作为派了任务的用户，我提交后想立刻看到「{助手} 接手了"{标题}"」的确认提示，并能一键打开任务详情。
4. 作为关心任务进展的用户，我想点开任务看到它的实时状态（"正在思考思路…"）、工具调用卡和「N 个步骤 · X 秒」摘要，而不必找到并打开那个 Worker 会话。
5. 作为被助手提问的用户（澄清问答），我想直接在任务面板底部回复，让任务继续推进。

## 3. 现状核实（决定「零后端改动」的结论）

| 项 | 现状 | 结论 |
|---|---|---|
| `worker_tasks.worker_session_id` | DTO 已下发 web（client.ts WorkerTaskView） | 详情面板的历史 / SSE / 发消息可直接落到该会话 |
| `POST /api/projects/:id/worker-tasks` | 已支持 `dispatch: true` 立即派发（body 同 dispatch_task） | 轻首页「输入即派」无需新端点 |
| executor 值格式 | `null` = 内置引擎；`cli:*` / `acp:*` = 外部 agent；web 端 `externalAgents[].id` 即该值（F-56 已在模型选择器使用） | 首页助手选择器直接复用探测结果，无新枚举 |
| 任务级消息通道 | **无**，也不需要——hub 单槽（一会话一 run，§2.2）下续发消息 = 会话级 POST messages，运行中 409 | 前端禁用兜底 + 409 回滚 |
| 状态分组 | `WorkerTaskStatus` 七态齐备 | 纯前端分组映射，不动状态机 |

## 4. 需求池（P0 本期已全部实施）

- **前端-轻首页**（WorkbenchView 空态 hero 重写）：
  - 居中 slogan「把工作交出去。回来就能看到答案。」（答案 二字强调色）+ 一行副文案。
  - 派任务输入卡：多行输入（Enter 发送，Shift+Enter 换行）+ 助手选择器（内置助手 Δ / 探测到的外部 Agent，未登录条目带「（未登录）」后缀）+ 发送按钮（↑ 圆钮）。
  - 提交 = `createWorkerTask(pid, { title, goal, executor, permission_mode: 'default', dispatch: true })`；title 由 goal 首行截断（24 字 + …）收敛。
  - 接手 toast：底部居中「{助手} 接手了"{标题}"」+ 打开按钮（开详情面板）+ 关闭钮；8s 自动消失。
  - 首页下方按三组渲染当前项目任务卡（状态点呼吸动画区分运行中；点击打开详情面板）；无项目时提示「先在左侧注册一个项目」。
- **前端-状态分组**（TaskBoard 改版 + tasks store）：`groups` getter 输出 `needYou(needs_decision) / active(queued|preflight|running) / finished(done|failed|canceled)` 三组；任务台入口 = tabbar 最右侧按钮唤出的右侧抽屉（closable，含 interrupt 红点角标），与首页共用同一分组映射，空组不渲染。
- **前端-任务详情右滑面板**（新增 TaskDetailPanel，`openTaskId` 驱动）：
  - 头部：任务标题 + 状态 chip（随 2s 轮询刷新）+ 关闭钮；结论行：`result_summary`（失败红色）。
  - 步骤摘要折叠条：「N 个步骤 · X 秒」（N = 工具调用卡计数，X = started_at → finished_at / now 现算秒）+ 派单原文 / 验收条件折叠展示；运行中默认展开并显示「正在思考思路…」。
  - 会话流：历史消息（F-53 分页端点，最近 50 条）+ SSE 实时（text_delta / tool_call / tool_result / ask_user / state / done 最小子集）+ 工具调用卡按 callId 配对（复用 ToolCallCard）。
  - 续发消息：底部输入框（占位「在「{标题}」中给助手发消息」）；运行中禁用（hub 单槽提示）；发送失败 409 时本地回滚并提示。
  - Worker 会话尚未创建（queued/preflight 阶段）时显示「任务排队中，执行会话尚未创建…」；外部 agent 会话加载失败降级提示。
- **测试**：tasks store 新增 5 条单测（分组 / 面板状态跟随轮询 / dispatch 透传与 title 收敛 / dispatch 失败上抛 / stop 清面板态）；e2e workbench-load 断言改为轻首页三要素（slogan / 输入卡 / 内置助手选项）。

## 5. 交互要点说明

### 5.1 状态分组映射（唯一口径，任务台抽屉与首页共用）

| 分组 | 状态 | 说明 |
|---|---|---|
| 需要你 | `needs_decision` | 占人不占槽位（§18-7），置顶最优先，裁决按钮保留 |
| 处理中 | `queued` / `preflight` / `running` | 已派发或排队；运行中呼吸点 + 「已运行 N 分钟」/「正在处理…」 |
| 已完成 | `done` / `failed` / `canceled` | 终态；failed 附 failure_kind 文案 |

> 目标截图中的「等待中」组并入「处理中」（排队态）；如需独立「等待中」组（如等待依赖完成 / 等待用户补充输入），需扩展任务状态机，见待确认 Q1。

### 5.2 详情面板与 hub 单槽（§2.2）

- 续发消息走会话级 `POST /api/sessions/:id/messages`：会话空闲时直发即触发新一轮 run；运行中输入框禁用（title 提示「任务执行中，输入暂不可用（会话单槽）」）。
- 轮询间隙状态漂移导致的 409：本地回滚该条 user 消息并显示错误行，不静默丢字。

### 5.3 面板生命周期

- `openTaskId` 存于 tasks store：`watch(null)` / `stop()` 时一并清空（不跨项目泄漏）；轮询刷新后 `openTask` getter 自动跟随最新任务行（状态 chip 实时变化）。
- 面板关闭 / 切任务即 `EventSource.close()` 并重置会话视图状态；面板随 Worker 会话切换（`worker_session_id` 变化，如 retry 换会话）自动重开流。

## 6. 验收标准

1. 打开工作台（无会话态）显示轻首页：slogan、派任务输入卡、助手选择器（默认内置助手）三要素可见（e2e workbench-load）。
2. 首页输入「做一个ppt」+ Enter：`worker_tasks` 落一行（title = 首行 24 字截断，executor = 选中值，dispatch 立即派发），toast 出现且「打开」能开详情面板。
3. 任务行在「需要你 / 处理中 / 已完成」三组中按 §5.1 映射正确归组，任务台抽屉与首页一致。
4. 点开 done 任务详情：历史消息与工具卡完整（调用/结果按 callId 配对，含失败态），「N 个步骤 · X 秒」与任务时长一致。
5. 点开运行中任务详情：状态 chip = running、显示「正在思考思路…」、工具卡实时到达；输入框禁用。
6. 会话空闲时在面板发消息：user 消息入列并触发新一轮 run；运行中尝试发送被禁用兜底，409 时本地回滚并提示。
7. `tasks.openTaskId` 在项目切换 / stop 后清空，面板不显示其他项目的任务。
8. 既有单测（115+）与 web e2e 全绿；新增 store 单测覆盖分组 / dispatch / 面板态。

## 7. 待确认问题

1. **Q1「等待中」独立分组**：目标截图有「等待中」组。当前排队任务并入「处理中」。若「等待中」定义为「等待依赖完成（depends_on 未终态）」或「等待用户补充输入」，需要后端状态机/查询支持，建议下一期评估。
2. **Q2 外部 Agent 权限档**：首页派单当前固定 `permission_mode: 'default'`；外部 agent 不支持 default 档时的降级行为沿用 F-58（任务台「已请求只读」角标口径）。是否在首页派单时暴露权限选择，待定。
3. **Q3 P2 候选项**（本期不做）：语音输入（截图含麦克风钮）、首页展示 token/费用摘要、任务卡缩略图、首页与「项目 × 会话」树的合并动线（委派后自动打开 Router 会话）。
