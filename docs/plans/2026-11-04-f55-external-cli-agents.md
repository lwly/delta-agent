# F-55 外部 CLI Agent 接入 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 delta 在不自带 API Key 的前提下，复用用户已有的 Claude Code / Codex / ACP agent 登录态，作为第 4 种执行后端（引擎）。

**Architecture:** 外部 CLI 实现为「引擎」而非「Provider」：新增 `packages/core/src/external/`（协议适配，产出与 delta 无关的 `ExternalEvent`）+ `packages/core/src/engine/external.ts`（映射为 `AgentEvent`），在 `hub.ts:792` 的三元分派处加第 4 分支。会话、落库、SSE、TUI/Web 渲染零改动复用。权威设计见 `docs/design-f55-external-cli-agents.md`（由评审稿落库）。

**Tech Stack:** TypeScript / vitest / JSON-RPC over stdio（ACP）/ JSONL（Claude stream-json、Codex app-server）/ better-sqlite3 迁移 v6。

**分支：** `feat/F-55`（自 master 切出）。提交格式 `类型(模块): 描述`；docs 与代码分开提交。

**门禁（每个 Task 收尾必跑）：** `pnpm typecheck && pnpm test`（改动涉及的 package 全量跑）；P0 结束加跑 `pnpm smoke`。

**协议纪律：** 所有 ACP / CLI flags 字段名按实测为准，只依赖语义不依赖拼写（设计稿 §2 警示）。实测结果记入 design-f55 附录「兼容性表」。

---

## Task 0: 落 PRD 与设计文档（docs 提交）

**Files:**
- Create: `docs/prd-f55-external-cli-agents.md`
- Create: `docs/design-f55-external-cli-agents.md`

**Steps:**
1. 将评审稿（本次粘贴稿）整理为 `design-f55-external-cli-agents.md`：保留 §1–§16 全部内容，头部状态改「已评审」；补充「协议实测附录」空表（agent / spec 版本 / 实测字段 / 日期）。
2. 依据设计稿目标写 `prd-f55-external-cli-agents.md`：用户故事（无 Key 用户用订阅跑任务）、范围（AC-55-1 ~ AC-55-9 为验收标准）、明确不做（§16）。
3. 提交：`docs: F-55 外部 CLI Agent 接入成对 PRD 与设计文档`

---

## P0：引擎接缝 + 事件映射 + 假 CLI + 迁移 v6

出口标准：假 CLI 全场景单测通过；三引擎回归零失败；`pnpm smoke` 通过。

### Task 1: 迁移 v6 + store 字段

**Files:**
- Modify: `packages/core/src/session/migrations.ts:188`（MIGRATIONS 数组末尾追加）
- Modify: `packages/core/src/session/store.ts`
- Test: `packages/core/test/migrations-f55.test.ts`

**Steps:**
1. 写失败测试：新建内存库跑迁移到 v6，断言 `sessions` 有 `external_id`/`external_agent` 列（DEFAULT NULL）、`usage` 有 `billing` 列（DEFAULT 'metered'）；断言 v5 旧库升级后历史行 `billing='metered'`。
2. Run: `pnpm --filter @delta/core test -- migrations-f55` → FAIL。
3. 实现：追加 `{ version: 6, name: 'f55-external-agents', sql: ... }`（对齐 v5 的「列已存在跳过 ALTER 仍推进版本」写法）；store 读写带上新字段。
4. Run 同上 → PASS。
5. Commit: `feat(core): F-55 迁移 v6——sessions.external_id/external_agent + usage.billing`

### Task 2: external/types.ts + UnavailableProvider

**Files:**
- Create: `packages/core/src/external/types.ts`（内容 = 设计稿 §3 原文：`ExternalAgentSpec` / `ExternalEvent` / `ExternalAgentAdapter` / `ExternalTier`）
- Create: `packages/core/src/llm/placeholders.ts`（`UnavailableProvider`：`chat()` 抛 `external_agent_no_llm`，`estimateTokens()` 返回 0，`id` 返回注入的虚拟 id）
- Test: `packages/core/test/external-types.test.ts`

**Steps:**
1. 失败测试：`UnavailableProvider.chat()` reject 且 error message 含 `external_agent_no_llm`；`estimateTokens()` === 0；`ExternalEvent` 各变体可被窄化（compile-only 断言即可）。
2. 实现（types.ts 直接抄设计稿 §3，勿改字段）。
3. Run → PASS。 Commit: `feat(core): F-55 external 类型契约 + UnavailableProvider 占位`

### Task 3: external/spawn.ts（进程生命周期底座）

**Files:**
- Create: `packages/core/src/external/spawn.ts`
- Test: `packages/core/test/external-spawn.test.ts`

**要点（设计稿 §9 全条目）：** cwd 固定传 `projectRoot`；环境变量白名单透传（PATH/HOME/SHELL/LANG + provider 自身变量），不注入 delta 密钥；stdout 逐行读、单行上限 1 MiB 超限截断+stderr 警告；stderr 环形缓冲 200 行；abort → 先协议取消钩子，300ms 后 POSIX `kill(-pid)` / Windows `taskkill /T /F`；Windows `.cmd` shim 走 `shell: true` + `JSON.stringify` 单引号包参。

**Steps:**
1. 失败测试（全部用 fixture 脚本，零网络）：
   - 正常逐行产出 → 行事件依序到达；
   - 超过 1 MiB 的单行 → 被截断且不崩；
   - abort 后（POSIX）目标 pid 不存在（`process.kill(pid, 0)` 抛 ESRCH）；
   - stderr 环形缓冲行数 ≤ 200；
   - 非零退出码透传。
2. 实现 `spawnLines(cmd, args, opts): { events: AsyncIterable<ProcEvent>, abort(): Promise<void>, stderrTail(): string[] }`。
3. Run → PASS。 Commit: `feat(core): F-55 外部进程 spawn/杀进程组/stderr 环形缓冲`

### Task 4: engine/external.ts —— ExternalEvent → AgentEvent 映射

**Files:**
- Create: `packages/core/src/engine/external.ts`（`runExternalAgent`，签名对齐 `headless.ts:105` 的 engine 形状）
- Test: `packages/core/test/external-mapper.test.ts`

**映射逐条 = 设计稿 §4 表格，重点断言：**
- `done` 必达（即使上游漏发，进程退出码 0 也要补发）——hub `saveTurnAssistant()` 依赖收尾；
- `fatal: true` 仅当「无任何 text 产出 且 退出码非 0」；用户 abort → `error{message:'aborted by user', fatal:false}`（与三引擎文案一致）；
- tool_result 内容截断到 50k 保尾（与 F-54 `task_output` 同口径）；`ms` 由本地 start 打点算；
- `usage` → `costUsd=0` + `meta.billing='subscription'`；
- 不发 `compact_*` / `budget_degraded` / `subtask_*` / `review_verdict`。

**Steps:**
1. 失败测试：每条映射规则 ≥1 用例（含乱序、无 done 补发、半行、fatal 判定两分支、abort 文案）。
2. 实现 mapper（纯函数 + AsyncIterable 包装，不 import 任何 adapter —— 职责切分见设计稿 §3 尾注）。
3. Run → PASS。 Commit: `feat(core): F-55 runExternalAgent 事件映射引擎`

### Task 5: 假 CLI fixture + hub 第 4 分支 + RunContext 兼容

**Files:**
- Create: `packages/core/test/fixtures/fake-cli.mjs`（读 `FAKE_CLI_SCRIPT` 指向的场景 JSON，逐步吐事件行；覆盖乱序/半行/超大行/stderr 混杂/非零退出）
- Modify: `packages/core/src/server/hub.ts:792`（三元分派 → 四元：外部队列命中 → `runExternalAgent`；`resolveProvider` 前置分流 → `UnavailableProvider`；`subagent`/`distillMemories`/`sandbox` 置空并记 debug 日志）
- Modify: `packages/core/src/server/hub.ts:683,700,762` 附近（外部会话跳过 `defaultModelFor(provider.id)`，`ctx.model` 直接用 `session.model` 的 `cli:*` 虚拟 id）
- Test: `packages/core/test/external-hub.test.ts`

**红线（AC-55-2）：** 代码中不得出现散落的 `if (external)` 业务分支；唯一允许的区分点是 `ctx.model` 的 `cli:` 前缀用于展示。

**Steps:**
1. 失败测试：`DELTA_FAKE_CLI` 指向 fixture，起 hub 会话（model=`cli:fake`）跑一轮，断言：事件流与内置引擎同构（有 done、消息落库、usage.billing='subscription'）、`ctx.subagent` 不可用报 `task_unavailable`、`provider.chat()` 未被调用。
2. 实现分流（外部队列判定：session.model 前缀 `cli:` 或 `acp:`，实现在 detect/registry 一处，不散落）。
3. Run → PASS。回归：`pnpm --filter @delta/core test` 全量零失败。 Commit: `feat(core): F-55 hub 第 4 引擎分支 + RunContext 兼容（UnavailableProvider 注入）`

### Task 6: CLI headless 引擎选择 + e2e

**Files:**
- Modify: `packages/cli/src/headless-run.ts`（引擎选择表加外部分支）
- Modify: `e2e/cli/e2e-cli.mjs`（追加 1 条：`DELTA_FAKE_CLI` + 隔离 HOME，断言退出码协议 0/1/2/3/4/5 与三引擎一致）
- Test/验证: `node e2e/cli/e2e-cli.mjs`；`pnpm typecheck && pnpm test && pnpm smoke`

**Steps:**
1. e2e 用例先写（跑当前代码 FAIL）。
2. 实现选择表。3. e2e PASS + 全量门禁 PASS。
4. Commit: `feat(cli): F-55 headless 外部引擎选择 + e2e 退出码协议用例`

**P0 收尾：** `pnpm typecheck && pnpm test && pnpm smoke` 全绿后，方可进 P1。

---

## P1：ACP 适配器（Tier A）+ 权限桥接

出口标准：至少 1 个真实 ACP agent 端到端跑通；`plan` 档确认拦截生效。

### Task 7: ACP 客户端（JSON-RPC over stdio）

**Files:**
- Create: `packages/core/src/external/acp.ts`
- Test: `packages/core/test/external-acp.test.ts`

**Steps:**
1. 先实测协议（设计稿 §2 警示项）：`initialize` capability 字段、`session/update` chunk 类型枚举、`session/request_permission` option 形状、`session/cancel` 语义、spec 版本。结果写入 design-f55 附录表 + fixture 场景文件。
2. 失败测试：fake ACP agent fixture（走 Task 3 的 spawn）——initialize 握手、session/update → ExternalEvent、乱序 id 响应匹配、cancel 后进程退出。
3. 实现 adapter：协议 → `ExternalEvent`，零映射逻辑。 Run → PASS。
4. Commit: `feat(core): F-55 ACP 适配器（JSON-RPC over stdio）`

### Task 8: 权限桥接（三档映射）

**Files:**
- Modify: `packages/core/src/engine/external.ts` 或新增 `external/permission.ts`
- Test: `packages/core/test/external-permission.test.ts`

**断言（设计稿 §5.1 全表）：**
- `plan` 档：ACP 逐次拦截 write/exec 的 permission request 直接 reject；Tier B/C 上游无只读档 → 抛 `external_no_plan_mode` 拒绝启动；
- `default` 档：ACP `session/request_permission` → delta `ConfirmDecision`（allow / allow_session / reject）；headless 非交互宿主自动 reject（沿用 `AUTO_REJECT_REASON` 文案）；
- `yolo` 档：自动 allow 仍发 `tool_call_start` 审计；Tier C 必须叠加 delta 双重确认。

**Steps:**
1. 失败测试：三档 × 三协议启动参数断言 + `external_no_plan_mode` + headless 自动 reject。
2. 实现。 Run → PASS。 Commit: `feat(core): F-55 外部权限桥接——三档映射与能力降级拒绝`

---

## P2：Claude stream-json（Tier B）+ 检测 + MCP 透传

出口标准：无 Key 用户可用订阅跑通一次真实改码任务（本机手工 smoke，记兼容性表）。

### Task 9: detect.ts + external.json

**Files:**
- Create: `packages/core/src/external/detect.ts`
- Test: `packages/core/test/external-detect.test.ts`

**要点（设计稿 §10）：** `command --version` 探测 3s 超时静默跳过；优先级 `DELTA_EXTERNAL_<ID>_PATH` > `~/.delta/external.json` > PATH；`external.json` 无 token 字段（AC-55-9 加测试断言：序列化结果 grep 不到 `token`/`key`）。

### Task 10: stream-json.ts 适配器 + MCP 透传

**Files:**
- Create: `packages/core/src/external/stream-json.ts`
- Test: `packages/core/test/external-stream-json.test.ts`
- Modify: engine 分派处接 MCP 临时文件（`os.tmpdir()/delta-mcp-<sessionId>.json`，退出即删；重名条目加 `delta-` 前缀别名，冲突记 warn —— 设计稿 §6/§15）

**Steps:** 失败测试（fixture 吐 Claude stream-json 事件行：assistant 增量 / tool_use / tool_result / usage / session id）→ 实现 → PASS → `feat(core): F-55 Claude stream-json 适配器 + MCP 配置透传`

### Task 11: `delta models list` 外部区块 + 登录态存在性检测

**Files:**
- Modify: `packages/cli` models list 命令；doctor 前置探测逻辑复用 detect.ts
- Test: `packages/cli` 对应单测

---

## P3：Codex（Tier C）+ resume + Web 面板 + doctor

出口标准：会话续跑可用；`doctor` 输出完整。

### Task 12: codex app-server 适配器（弱权限档，整档位 flags）
- Create `external/codex.ts` + `test/external-codex.test.ts`；`plan` 档无只读能力时 `external_no_plan_mode`。

### Task 13: 会话续跑（设计稿 §8 单一权威规则）
- `delta -r <id>` 命中外部会话 → `resumeArgs(external_id)`；令牌失效 → 丢弃令牌、以 delta history 摘要为首条 prompt 重建并提示一次，不崩溃。
- Test: `test/external-resume.test.ts`。红线：不读 CLI 自己的历史文件；v1 禁止反向切换（provider 会话 → 外部）。

### Task 14: doctor 外部 Agent 检查节 + Web 设置面板
- Modify `packages/cli/src/doctor.ts`（版本/三档支持度/登录态存在性——只判断文件存在，不解析内容）。
- Create `packages/web/src/components/settings/ExternalAgentsPanel.vue`（探测列表 + 三档勾选表）；会话头部能力降级提示条（沙箱/内置 Function/压缩/预算四项 —— AC-55-7）；新建会话模型选择器 `cli:` 前缀区分。
- Web 门禁：`pnpm smoke:web`。

---

## P4：多外部 agent 并发

出口标准：两会话并行不串事件。

### Task 15: 每会话独立进程 + dispose 收尾
- 适配器实例注册到 `serve` 的 dispose 列表（与 F-54 `BackgroundTaskManager` 同一路径）；并发事件按 sessionId 隔离。
- Test: `test/external-concurrent.test.ts`（两个 fake CLI 会话并行，事件不互串；dispose 后无孤儿进程 —— AC-55-5）。

---

## 收尾验收核对（对照设计稿 §14）

- [ ] AC-55-1 无 Key 启动 + models list 展示
- [ ] AC-55-2 同一 AgentEvent 流、无散落 `if (external)`
- [ ] AC-55-3 plan 档 write/exec 全拒 / Tier C 拒启
- [ ] AC-55-4 default 档 Web 确认卡 + allow_session 记忆
- [ ] AC-55-5 停止 1s 内进程退出、无孤儿
- [ ] AC-55-6 usage.billing='subscription'、报表不误计金额
- [ ] AC-55-7 四项能力降级显式提示（UI/doctor/debug 日志）
- [ ] AC-55-8 resume 令牌 + 失效降级重建
- [ ] AC-55-9 external.json 无凭证字段（测试断言）

最终验证：`pnpm typecheck && pnpm test && pnpm smoke && pnpm smoke:web`；真机手工 smoke 一次（Claude Code + 一个 ACP agent），结果回写 design-f55 兼容性表（docs 单独提交）。

## 风险提示（实现期守则）

1. 协议字段实测为准，禁止照抄文档拼写；版本不匹配明确报错，不降级瞎跑。
2. `react.ts` / `orchestrator.ts` / `pump.ts` 不许改动 —— 改了说明接缝选错，停下来重新评审。
3. 每完成一个 Phase 回归一次三引擎全量测试，防止映射引擎副作用泄漏。
