# y-zero-agent 执行模式与 Sub-agent 编排设计

> 版本：v1.0 ｜ 日期：2026-10-21 ｜ 参考：PaiCLI 三模式/Worker Pool/Skill 体系方案 ｜ 关联：technical-design.md §2/§7、memory-design.md

---

## 1. 三种执行模式总览

| 模式 | 适用 | 核心机制 | 一句话 |
|------|------|----------|--------|
| ReAct | 快问快答、单点修复 | 循环决策：用户输入 → LLM 决策 → 工具调用 → 结果回传 → 再次决策，直至完成 | **先观察，再思考，再行动，直到任务完成** |
| Plan-and-Execute | 中等复杂度、多步骤 | 简单任务直达；复杂任务 LLM 规划 → DAG → 拓扑排序 → 按层并行 → 汇总 | **简单任务直达，复杂任务先规划再并行** |
| Multi-Agent | 大型工程、需质量把关 | 编排器 → 规划者(DAG) → 执行者工作池 → 检查者，反馈重试闭环 | **规划、并行执行、质量检查形成协作闭环** |

模式选择：用户显式指定优先；未指定时由**简单任务检测**自动路由（§3.1）。

## 2. ReAct 模式（已实现于 technical-design §2，此处不重复）

状态机 + 预算管理 + 自动压缩 + 自愈重试。循环五步：①用户输入 ②LLM 决策（思考下一步）③工具调用（采取行动）④结果回传（观察结果）⑤再次决策（调整思路）。

## 3. Plan-and-Execute 模式

### 3.1 执行路径决策

```
用户任务 ──→ 简单任务检测 ──是──→ 跳过规划 → 直接执行（走 ReAct 循环）
                  │否
                  └──→ LLM 规划 → 生成 DAG → 拓扑排序 → 按层并行执行 → 汇总结果
```

**简单任务检测**（启发式，两层）：
1. 快速规则：意图分类（问答/单文件修改/信息查询 → 简单）；涉及 ≥2 模块、跨文件重构、"重构/迁移/批量"关键词 → 复杂
2. LLM 兜底：规则不确定时，用小模型一次调用分类（返回 `simple | complex` + 理由）
3. 用户可强制：`/plan` 强制规划，`/direct` 强制直达

### 3.2 DAG 任务图与并行执行

```typescript
interface TaskNode {
  id: string;
  goal: string;                    // 子任务目标（可独立执行的自然语言）
  deps: string[];                  // 依赖的上游节点 id
  suggestedTools: string[];        // 规划者建议工具（约束子任务能力）
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: TaskResult;
}

interface Plan {
  goal: string;                    // 总目标
  dag: Map<string, TaskNode>;
  createdAt: number;
  revision: number;                // Reviewer 反馈后调整时递增
}

// 执行：拓扑排序分层，层内并行（等价 asyncio.gather → Promise.allSettled）
async function executePlan(plan: Plan, ctx: RunContext): AsyncIterable<AgentEvent> {
  for (const layer of topoLayers(plan.dag)) {          // 逐层
    const results = await Promise.allSettled(          // 层内并行
      layer.map(node => runSubTask(node, ctx))
    );
    // 单节点失败：标记 failed，其后继节点标 skipped；
    // 若失败节点被标记 critical → 整个 Plan 终止并汇报
  }
}
```

- 规划产出在 Web 端渲染为计划卡（原型已有），用户可**编辑/删除节点/调整依赖**后确认执行
- 每个节点独立上下文（注入：总目标 + 本节点目标 + 上游结果摘要），避免互相污染

## 4. Multi-Agent 模式（三角色协作闭环）

```
① 编排器 Orchestrator          ② 规划者 Planner            ③ 执行者 Executor（并行工作池）      ④ 质量层 Reviewer / Verifier
   接收目标 → 理解/拆解需求  →    接收需求 → 产出 DAG 任务图 →   接收任务图 → worker 领取执行  →    汇总执行结果 → 质量检查
   输出结果交付用户  ←────────────────────────────────────────────── 结果收集 ──────────────────────  通过 ✔ / 重试 ✘
                                                                    ↑──────── 不通过：返回规划者调整 DAG 或重试 ────────┘
```

### 4.1 完整角色集（四层十角色，2026-10-22 确认）

| 层级 | 角色 | 职责 | MVP |
|------|------|------|-----|
| 决策层 | **Orchestrator**（总编排） | 拆解任务、制定计划、调度其他角色、汇总结果 | ✔ |
| 决策层 | **Planner**（规划者） | 任务分解为子任务（DAG）、确定依赖顺序；收到重试反馈时调整 DAG | ✔ |
| 执行层 | **Worker / Executor**（执行者） | 执行具体子任务（写代码、生成内容），并行工作池竞争领取 | ✔ |
| 执行层 | Researcher（研究员） | 信息检索、数据采集、事实核验（web_fetch/grep 密集型） | 按需启用 |
| 执行层 | Writer / Creator（创作者） | 内容生成、文案撰写、设计输出 | 按需启用 |
| 执行层 | Tool Caller（工具调用者） | 调用外部 API、操作文件、运行命令（高危操作专属代理） | 按需启用 |
| 质量层 | **Reviewer / Critic**（评审者） | 检查产物、找缺陷、提出修改意见（打回闭环） | ✔ |
| 质量层 | **Verifier**（验证者） | 运行测试、构建、执行校验规则（与 Reviewer 分工：主观审查 vs 客观验证） | ✔ |
| 协调层 | Memory Keeper（记忆管理者） | 维护跨节点共享状态、长期记忆读写（衔接 memory-design L2） | 按需启用 |
| 协调层 | Router（路由者） | 意图识别、分发给合适的 Specialist 角色衔接 | 按需启用 |

- **MVP 核心五角色**：Orchestrator / Planner / Worker / Reviewer / Verifier（Reviewer 管主观质量，Verifier 管客观测试构建，二者分工不合并）
- **动态启用角色**：Researcher / Writer / Tool Caller / Memory Keeper / Router 由 Planner 在生成 DAG 时按子任务类型标注 `role` 字段，编排器按需实例化——无对应任务则不创建，节省 token
- 角色实现为同一 Worker Pool 的不同"上下文模板 + 工具白名单"组合，而非独立进程：`role` 决定系统提示词模板与可用工具集

**反馈重试闭环**：Reviewer 打回时携带失败原因 → 编排器路由给规划者（调整 DAG：拆分/增删节点）或直接让失败节点重新执行；重试次数上限可配（默认 2），超限终止并汇报遗留问题。

## 5. Worker Pool 并行调度

```typescript
class TaskQueue {                      // TS 版 asyncio.Queue
  private q: TaskNode[] = [];
  push(t: TaskNode) { this.q.push(t); this.wake(); }
  async get(): Promise<TaskNode> { /* 无任务时挂起，新任务唤醒 */ }
  requeue(t: TaskNode) { this.q.unshift(t); }        // 审查失败：回队首重新排队
}

async function workerLoop(id: string, queue: TaskQueue, ctx: RunContext) {
  while (!ctx.signal.aborted) {
    const node = await queue.get();                  // 多个 worker 从同一队列竞争领取
    node.status = 'running';
    try {
      node.result = await runSubTask(node, ctx);
      node.status = 'done';
    } catch (e) {
      node.retries++;
      queue.requeue(node.retries < MAX_RETRY ? node : markFailed(node));
    }
  }
}

// 编排器启动：workerCount = min(4, dag 可并行度)；结果全部完成后交 Reviewer
```

要点：
- **共享队列分发任务**，worker 竞争领取，天然负载均衡
- **并行执行提高效率**，worker 数默认 4（可配 1–8）
- **审查失败自动重试**：Reviewer 判失败的任务返回队列重新排队（优先级高于新任务，`unshift`）
- 事件回传：节点状态变化以 `AgentEvent`（`subtask_start/done/failed`）推送给 CLI/Web 渲染

## 6. 后台任务可靠恢复（状态机 + 租约 + 心跳）

### 6.1 状态机

```
queued ──→ running ──→ completed
   ↑          │  │
   │          │  └──→ canceled（用户取消/会话删除级联）
   └──────────┴───→ failed
        租约过期或心跳丢失（崩溃恢复）→ 判定孤儿任务
```

### 6.2 持久化与恢复机制

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT, plan_revision INTEGER,
  node_json TEXT,                 -- TaskNode 序列化
  status TEXT,                    -- queued/running/completed/failed/canceled
  worker_id TEXT,                 -- 当前持有者
  lease_until INTEGER,            -- 租约到期时间戳
  heartbeat_at INTEGER,           -- 最近心跳
  retries INTEGER DEFAULT 0,
  updated_at INTEGER
);
```

| 机制 | 设计 |
|------|------|
| 状态落库 | 每次状态迁移原子写 SQLite（WAL），崩溃后可精确恢复 |
| 租约 | worker 领取任务即获 60s 租约，续期至任务完成；防多 worker 重复执行 |
| 心跳 | 运行中每 15s 更新 heartbeat_at；租约到期未续 = worker 已死 |
| 崩溃恢复 | CLI/Web 启动时扫描：`running` 且租约过期 → 视为孤儿，回 `queued` 重新排队（retries+1） |
| 幂等 | 子任务执行前写 checkpoint（已完成的文件变更清单），重试时可先回滚或跳过已完成步骤 |
| 中断传播 | 会话删除/用户停止 → running 任务标 canceled，AbortSignal 传播至子进程 |

> 口诀：**状态落库 + 租约心跳，让任务崩溃后可恢复。**

## 7. Skill 分层体系（升级设计，取代 technical-design §7 原方案）

### 7.1 三层覆盖（离项目越近，优先级越高）

```
优先级 3（最高）：项目级  .y-zero/skills/        ← 同名覆盖
优先级 2：        用户级  ~/.y-zero/skills/      ← 同名覆盖
优先级 1（最低）：内置    packages/core/skills/
```

同名 Skill 高层覆盖低层；合并后在 `/skills` 命令与 Web 面板标注来源层级。

### 7.2 Skill 包结构（按需加载）

```
skill-name/
├── SKILL.md          # 元信息 + 主体指令（frontmatter: name/description/triggers/tools_allowlist）
├── references/       # 参考资料（大文档，按需读取）
└── scripts/          # 可执行脚本（经 run_command 白名单调用）
```

### 7.3 两阶段加载（先按需加载，下一轮获得完整能力）

```
① Skill 索引进入当前 Prompt：仅注入 name + description + 触发词（轻量，常驻）
② LLM 判断需要某技能 → 调用 load_skill("skill-name")   ← M3 已落地（内置工具 11 → 13：+load_skill/unload_skill）
③ 引擎读取该 Skill 的 SKILL.md 主体 + references 索引
④ 内容写入「跨轮次缓冲区」（SkillBuffer）
⑤ 下一轮组装 Prompt 时：缓冲区内容注入 L5 Skills 层（标记"已加载的专家内容"）
   → 模型从下一轮起获得该技能完整能力
```

- 缓冲区跨轮次持久（会话内），压缩时视为保留区结构化内容参与滚动摘要
- 会话结束缓冲区清空；索引常驻（保证模型始终知道有哪些技能可用）
- 卸载：`unload_skill` 释放缓冲区（长会话控制 token）

### 7.4 Skill 匹配评分（自动触发用）

```
查询词（如"数据库性能优化"）→ 分词器 → 候选评分 → Skill 排名

评分 = 精确匹配（name/triggers 完全命中 +10000）
     + 名称命中 ×12
     + 标签命中 ×6
     + 描述命中 ×2
```

**滑动窗口中文分词**：对查询做窗口 2/3/4 的 n-gram 切分并去重（"数据库性能优化" 切出 数据库/据库性/库性能/性能/优化/数据库性/据库性能/库性能优/性能优化 等，节选；窗口上限 4，不产生 5 字以上切片），解决中文无空格分词的召回问题；英文按词切分。

- Top-1 且分数 ≥ 阈值（默认 5000）→ 提示用户"检测到可用技能，是否加载？"
- 否则不主动打扰，仅靠模型看到索引自行调用 `load_skill`
- 分词器同时服务记忆召回（memory-design.md §5 词汇覆盖率）

## 8. 对既有文档的修订

| 文档 | 修订 |
|------|------|
| PRD | F-14/F-15/F-16 细化指向本文档；F-06 工具数 11 → 13（+`load_skill`/`unload_skill`，记忆工具 save_memory/recall_memory 在记忆里程碑再加） |
| technical-design.md | §2 Plan/Multi-Agent 桩指向本文档；§7 Skills 标注已被本文档 §7 取代 |
| 里程碑 | M3 增加两阶段加载与评分匹配；M5 增加 Worker Pool + 任务恢复 |

## 9. 里程碑归属

- M3：Skill 三层加载 + 两阶段加载 + 匹配评分 + `load_skill` 工具 ✅ 2026-10-22 交付（含 unload_skill 与 suggestSkill 自动触发 TUI 询问）
- M5：Plan DAG 引擎 + Worker Pool + Reviewer 闭环 + 任务状态机/租约/崩溃恢复 ✅ 2026-10-22 交付
  - §3：engine/plan.ts（拓扑分层/校验/skipDownstream）+ planner.ts（启发式检测 + LLM DAG 修复重试）+ plan-execute.ts（简单直达/复杂规划，事件泵实时推送）
  - §4/§5：worker-pool.ts（TaskQueue 竞争领取/unshift 优先重试/critical 终止）+ roles.ts（角色=提示词模板+工具白名单，RestrictedRegistry 越权拒绝）+ reviewer.ts/orchestrator.ts（主观+客观合并裁决，requeueFailed 带反馈重排，重试上限 2）
  - §6：session/tasks.ts（tasks 表 + 60s 租约 + 15s 心跳 + recoverOrphans + checkpoint 字段 + 会话删除级联 canceled），CLI/Web 启动扫描恢复
  - §9 跨平台：engine/shell.ts ShellAdapter（win PowerShell→cmd 降级、darwin zsh）+ `.github/workflows/ci.yml` 双平台 matrix；模式提示词段（prompt-design §5）由 hub/CLI 最后追加

### 9.1 2026-10-23 增量（F-14/F-15 补齐）

- **multi-agent 计划确认流**：`orchestrator.ts` 规划后走 `ctx.planApproval`（approve / edit：validatePlan 校验，非法回退原计划并提示 / reject：取消执行）；hub 与 TUI 接线条件放宽为 plan-execute ∪ multi-agent，TUI 拒绝语义按模式区分（plan=跳过计划直达，multi=取消本次任务）
- **编排层用量入账闭环**：`buildPlan` / `classifyComplexity` / `review` 增可选 `onUsage` 回调，`summarize` 直接入账；`settleUsage`（record 预算 + usage 事件）+ `usageAccumulator`/`addUsage`（plan-execute.ts）；worker 用量经事件泵截获累计，`done.usage` 不再恒 0，headless/hub/TUI 费用口径覆盖规划/分类/审查/汇总段
- **TUI 强制路由命令**：`/plan`（强制规划）/ `/direct`（强制直达）/ `/auto`（恢复自动检测），一次性覆盖下一次任务（RunContext.plan.force），仅 plan-execute / multi-agent 模式可用
- **子任务事件过滤**：`subtask.ts` 不再外传内层 ReAct 的 done / error / budget_exhausted（生命周期归编排层，以 subtask_done/subtask_failed 与最终 done 表达），修复消费端把单个子任务结束误判为整轮运行结束
- 单测 `test/orchestrator.test.ts` 8 例（审批四路 + 确认流故障降级 + 用量入账 + 生命周期过滤）
