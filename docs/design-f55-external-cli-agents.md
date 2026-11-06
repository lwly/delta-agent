# F-55 设计：外部 CLI Agent 接入（ACP / stream-json 适配层）

> 状态：已评审 ｜ 日期：2026-11-04 ｜ 编号：F-55（F-54 之后第一个空闲号）  
> 实施计划：`docs/plans/2026-11-04-f55-external-cli-agents.md`（P0–P4 任务分解）  
> 目标：让 delta 可以在**不自带 API Key** 的前提下跑任务 —— 复用用户已有的 Claude Code / Codex / 任意 ACP agent 的订阅登录态，作为 ReAct / Plan / Multi-Agent 之外的**第 4 种执行后端**。  
> 竞品参照：`nightly-labs/openbot`（Electron 工作区，同一思路的成熟实现，但权限模型为 `approvalPolicy: never`）。

---

## 1. 结论先行

**外部 CLI 必须实现成「引擎（Engine）」，不能实现成「Provider（LLMProvider）」。**

现有代码里已经有干净的接缝：

- `packages/core/src/headless.ts:104` 的 `engine: (ctx, history, input, images) => AsyncIterable<AgentEvent>`
- `packages/core/src/server/hub.ts:792` 的三元分派 `runPlanExecute / runMultiAgent / runReAct`

F-55 就是往这个分派里加第 4 个分支 `runExternalAgent`。会话、消息落库、SSE 广播、usage 报表、TUI 渲染**全部零改动复用**。

### 1.1 为什么不能塞进 LLMProvider（三条硬理由）

| # | 理由                   | 后果                                                                                                                      |
| - | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 | CLI agent **自己执行工具** | `StreamEvent.tool_call_delta` 是「请求工具」，`pump`/`react.ts` 会拿它去 `registry.executeAll` 二次执行 → 同一命令跑两遍（`rm`、`git push` 都是事故） |
| 2 | 工具集不可替换              | CLI 的 Bash/Edit/Read 是内置的，delta 的 16 个 Function 注入不进去；Provider 契约假设「工具由宿主执行」这一前提不成立                                     |
| 3 | 多轮不由宿主控制             | `react.ts` 的主循环按 turn 计费、压缩、预算断点；CLI 内部是黑盒多轮，宿主只看到一条事件流                                                                 |

一句话：`LLMProvider` 是「一次推理」，CLI agent 是「一整轮任务」。抽象层级不同，硬塞会同时污染 `react.ts` 和 `pump.ts`。

---

## 2. 协议选型：ACP 优先，两家特化

| 层级         | 协议                                                 | 覆盖                                                                           | 权限可拦截性                                         |
| ---------- | -------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| **Tier A** | **ACP**（Agent Client Protocol，JSON-RPC over stdio） | 任意声明支持 ACP 的 agent：Grok / Gemini / Cursor / Cline / Kimi / Devin / OpenCode… | **可逐次拦截**：`session/request_permission` 是协议内建方法 |
| **Tier B** | Claude Code `--output-format stream-json`          | 仅 Claude Code                                                                | 部分：需靠 hook 桥接，行为随版本漂移                          |
| **Tier C** | `codex app-server`（stdio JSONL）                    | 仅 Codex                                                                      | 弱：只能整档位（只读 / 全放行）                              |

**先做 A，再补 B/C**。理由：ACP 一份适配器就能覆盖十来个 agent，而且它是唯一能把 delta 的 `PermissionState` 真正接进去的协议 —— 这正是 OpenBot 主动放弃的东西。

> ⚠️ 实现前必须实测的协议细节（本设计不锁定具体字段名，避免文档比代码先腐烂）：  
> `initialize` 的 capability 协商字段、`session/update` 的 chunk 类型枚举、`session/request_permission` 的 option 形状、`session/cancel` 语义、ACP spec 版本号。各家 CLI 的 flags（`--permission-mode` 的取值、`--mcp-config` 路径形态、`--resume` 参数名）同样按实测为准，**只依赖语义，不依赖拼写**。

---

## 3. 适配器接口

新增 `packages/core/src/external/`（与 `llm/` 平级，互不 import）：

```ts
// external/types.ts
export type ExternalTier = 'A' | 'B' | 'C';

export interface ExternalAgentSpec {
  /** 稳定 id，同时也是会话 model 字段的值：cli:claude-code / cli:codex / acp:<cmd> */
  id: string;
  kind: 'acp' | 'stream-json-jsonl';
  /** 绝对路径（detect 阶段解析，避免 PATH 漂移） */
  command: string;
  args: string[];
  tier: ExternalTier;
  version: string;
  /** 三档权限对应的追加 flags（plan 档必须为空数组或只读 flags） */
  permissionArgs: { plan: string[]; default: string[]; yolo: string[] };
  resumeArgs?: (sessionId: string) => string[];
  /** 可透传 delta 的 MCP 配置（写临时 mcp.json 后传路径） */
  mcpArgs?: (configPath: string) => string[];
}

/** 归一化后的外部事件 —— 与 delta 协议无关，便于单测 */
export type ExternalEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; argsJson: string }
  | { type: 'tool_result'; id: string; ok: boolean; content: string }
  | { type: 'permission_request'; id: string; tool: string; argsJson: string; options: string[] }
  | { type: 'plan'; steps: Array<{ title: string; status: string }> }
  | { type: 'usage'; input: number; output: number }
  | { type: 'external_session'; id: string }   // 用于 --resume
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'done'; exitCode: number };

export interface ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec;
  run(req: {
    prompt: string;
    cwd: string;
    permissionMode: 'plan' | 'default' | 'yolo';
    resumeSessionId?: string;
    mcpConfigPath?: string;
    signal: AbortSignal;
  }): AsyncIterable<ExternalEvent>;
}
```

**职责切分**：`adapter` 只懂协议（ACP/JSONL → `ExternalEvent`），`engine/external.ts` 只懂映射（`ExternalEvent` → `AgentEvent` + 落库语义）。协议改版时只动 adapter，映射逻辑不动；映射要改时不必重跑协议实测。

---

## 4. 事件映射表（本设计的核心，逐条实现）

| CLI 事件              | 产出 `AgentEvent`                                 | 细节                                                                                                                                                                      |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| assistant 文本增量      | `text_delta`                                    | 直接透传；`thinking` 走 `thinking_delta`，不进上下文                                                                                                                                |
| tool_use start      | `tool_call_start`                               | `call.id` 用 CLI 的 tool_use_id，`argsJson` 原样（不 parse，避免二次序列化改变字节）                                                                                                        |
| tool_result         | `tool_result`                                   | `ms` 由本地收到 start 时打点算；`result.content` 截断到 50k（与 F-54 `task_output` 同口径保尾）                                                                                              |
| permission request  | `confirm_request`                               | **Tier A 走这条**：把 ACP 的 options 映射成 `ConfirmDecision`（allow / allow_session / reject），用户拒绝则回 `reject` 让 CLI 自行处理；`allow_session` 记入 `PermissionState.allowSession(tool)` |
| plan 通知             | `plan_created`                                  | **只展示，不进 DAG**：`Plan.nodes` 用占位节点承载，`revision: 0`；需在 `Plan` 上加可选 `external?: true`，UI 侧据此禁用「编辑节点 / 重新执行」按钮（避免用户编辑后无法回灌 CLI）                                             |
| usage               | `usage`                                         | `costUsd` 置 `0` 且 `meta.billing='subscription'`，见 §7                                                                                                                    |
| 进程退出码 0             | `done`                                          | 必须有 `done`：hub 的 `saveTurnAssistant()` 依赖收尾                                                                                                                             |
| 非零退出 / stderr fatal | `error`                                         | `fatal: true` 仅当「无任何 text 产出 且 退出码非 0」，否则 `fatal: false`（对齐 headless 退出码协议）                                                                                             |
| 用户 abort            | `error{message:'aborted by user', fatal:false}` | 与三引擎现有文案完全一致                                                                                                                                                            |

**不发的事件**：`compact_*`（CLI 自己管上下文）、`budget_degraded`（无法降级黑盒）、`subtask_*` / `review_verdict`（无 DAG）。

---

## 5. 权限：三档映射 + 能力降级声明

这是与 OpenBot 的核心分歧点，也是最容易翻车的地方。

### 5.1 档位映射

| delta 档位  | 语义   | Tier A（ACP）                                                                             | Tier B/C（flag）                                                                                           |
| --------- | ---- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `plan`    | 只读   | `permissionArgs.plan`（只读 / plan 模式），并**拦截**任何 write/exec 的 permission request 直接 reject | 只读 flags；若上游无只读档 → **拒绝启动**，报 `external_no_plan_mode`                                                    |
| `default` | 写需确认 | `session/request_permission` → delta 确认流（TUI/Web 弹卡）                                    | 上游自带确认 UI 时直通；非交互宿主（headless）→ 自动 reject（沿用 `AUTO_REJECT_REASON` 文案）                                     |
| `yolo`    | 全放行  | 自动 allow（仍发 `tool_call_start` 供审计）                                                      | 传全放行 flags（如 `--dangerously-skip-permissions`），**必须叠加 delta 自己的双重确认**（与现有 `--permission yolo --yolo` 一致） |

### 5.2 必须显式告知的能力降级

外部会话在以下四项上**不可用**，需要在 UI 与 `doctor` 里明说，不能静默失效：

- **F-30 沙箱**：CLI 自己 spawn 进程，Seatbelt/Docker 包不住 → 外部会话下 `ctx.toolContext.sandbox = undefined`，输入框上方常驻提示「本会话不使用 delta 沙箱」。
- **16 个内置 Function**：无法注入（只有 MCP 可透传，见 §6）。
- **上下文压缩 / 三层记忆蒸馏**：`ctx.summarizeRoute` 与 `distillMemories` 在外部会话下跳过（记 `debug` 日志，不打扰用户）。
- **费用预算**：订阅制无 per-token 账单 → 预算只按 token 计，UI 上隐藏金额列。

---

## 6. 工具与技能边界

| delta 能力          | 外部会话下 | 做法                                                                                                                                         |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP servers（F-48） | ✅ 可透传 | 把 `~/.delta/mcp.json` + 项目级合并视图写成临时文件 `os.tmpdir()/delta-mcp-<sessionId>.json`，经 `mcpArgs` 传给 CLI；进程退出即删。Tier A 也可走 ACP 的 mcpServers 初始化字段 |
| Skills 技能包        | ❌     | 不做文本注入（会和 CLI 自己的 skill 机制打架）。仅在提示词前缀里提一句「项目根有 `.delta/skills/` 可自行读取」                                                                     |
| `task` 子代理        | ❌     | `ctx.subagent = undefined` → 工具自带 `task_unavailable` 报错，模型会自行降级（既有行为）                                                                      |
| Hooks（F-27）       | 部分    | `PreToolUse` 无法拦截（工具在 CLI 进程内执行）；`SessionStart/Stop` 仍可触发                                                                                  |

---

## 7. 成本口径（F-31 兼容）

订阅内调用 **不是零成本**，但也拿不到单价。三者都不能选「如实报 0」——那会让费用报表失去意义。

做法：`usage` 表加 `billing TEXT NOT NULL DEFAULT 'metered'`（迁移 v6）；外部会话写入 `subscription`。

- F-31 报表新增一个口径：`metered` 与 `subscription` 分开汇总，订阅会话显示「订阅内 N 次调用（未计量）」而不是「¥0.00」。
- `pricing.ts` 不新增虚拟单价，避免污染历史成本曲线。

---

## 8. 会话续跑与历史单一权威

CLI 自己有 session 文件（`~/.claude`、`~/.codex` …），delta 也有 SQLite。**两份历史绝不能双读**，否则 ReAct/外部会话之间切换会出现消息错位。

定规：

1. **delta 的 SQLite 是唯一展示权威**：所有 UI 只读 `messages` 表，由事件流重建。
2. **CLI 的 session id 只作为 resume 令牌**存起来，不读它的历史文件。
3. 迁移 v6：`sessions ADD COLUMN external_id TEXT DEFAULT NULL` + `sessions ADD COLUMN external_agent TEXT DEFAULT NULL`。
4. `delta -r <sessionId>` 命中外部会话时：`resumeArgs(external_id)` 续跑；令牌失效（CLI 侧清理过）则丢弃令牌、以「把 delta 的 history 摘要作为首条 prompt」重建上下文，并提示一次。

> 反向能力（把 delta 的 provider 会话切到外部 agent）**v1 不做**：历史格式不可逆，硬切会丢工具调用链。

---

## 9. 进程生命周期

| 关注点     | 做法                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| cwd     | `projectRoot`（F-17 的硬边界），不继承 `process.cwd()`                                                                                               |
| 环境变量    | 白名单透传（`PATH`/`HOME`/`SHELL`/`LANG` + provider 自身变量如 `ANTHROPIC_API_KEY`）；**不注入** delta 的密钥                                                 |
| 输出背压    | 逐行读 `stdout`，单行上限 1 MiB（超限截断并记 `stderr` 警告，防深色序列化爆内存）                                                                                      |
| stderr  | 全量捕获环形缓冲（最近 200 行），进程异常时随 `error` 事件带出前 20 行，其余落 `debug` 日志                                                                                |
| 取消      | `AbortSignal` → 先发协议取消（ACP `session/cancel`），300ms 后仍未退则杀进程组：POSIX `kill(-pid)`，Windows `taskkill /T /F /PID`                              |
| 超时      | 无全局超时（长任务是常态）；`ctx.maxTurns` 不适用，改用「无事件静默 10 分钟」健康检查，命中记 `sandbox_notice` 同类提示                                                             |
| 孤儿清理    | 适配器实例注册到 `serve` 的 dispose 列表，与 F-54 `BackgroundTaskManager` 同一收尾路径（**实现偏差**：P4 落地为进程级全局 lifecycle 追踪（`external/lifecycle.ts` 的 track/untrack/cancelAllExternalRuns），engine 不感知 serve，dispose 在 `server.close()` 之后全杀——比实例级注册更稳，每 run 独立实例下进程句柄即取消入口）                                                                        |
| Windows | `command` 解析到 `.cmd`/`.ps1` shim 时必须 `shell: true`，引号包装走逐段引用（`command` 与各 arg 独立判断，含空格/`&"\|<>^` 的 token 加双引号、内部 `\"` 转义，见 `defaultWindowsShellQuote`）——不采用整条串包法：`cmd /d /s /c` 会剥掉首尾引号，外层单引号 + `JSON.stringify` 会被当命令名一部分报「文件名、目录名或卷标语法不正确」（2026-11 实测 5/5 npm CLI 探测失败后修正）；`detect` 阶段依次尝试 `claude.cmd` / `claude.bat` / `claude` |

---

## 10. 检测与配置

- **不自动下载、不自动安装**（与 OpenBot 相反）。只探测：`command --version`，超时 3s，失败静默跳过。
- 探测结果落到 `~/.delta/external.json`（**非密钥文件，无加密**），形状：

```json
{ "agents": [
    { "id": "cli:claude-code", "kind": "stream-json-jsonl", "command": "/usr/local/bin/claude",
      "version": "2.x", "tier": "B", "enabled": true, "lastProbeAt": "2026-11-04T09:00:00Z" } ] }
```

- 优先级：显式 `DELTA_EXTERNAL_<ID>_PATH` > `~/.delta/external.json` > PATH 探测。
- CLI：`delta models list` 尾部追加「外部 Agent」区块；`delta doctor` 新增一节（版本 / 权限档支持度 / 登录态是否存在）。
- Web：设置 → 模型 页新增卡片，列出探测到的 agent + 三档支持度勾选表；新建会话时模型选择器里以 `cli:` 前缀区分。
- 登录态检测只做**存在性判断**（如 `~/.claude.json` 是否存在），**不解析内容、不复制、不上报**。

---

## 11. 模块落点与改动清单

| 文件                                                    | 改动                                                                                                    | 量级     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| `core/src/external/types.ts`                          | 新增：`ExternalAgentSpec` / `ExternalEvent` / `ExternalAgentAdapter`                                     | ~60 行  |
| `core/src/external/detect.ts`                         | 新增：探测 + `external.json` 读写 + 优先级                                                                      | ~120 行 |
| `core/src/external/acp.ts`                            | 新增：ACP 客户端（JSON-RPC over stdio）                                                                       | ~320 行 |
| `core/src/external/stream-json.ts`                    | 新增：Claude/Codex JSONL 解析                                                                              | ~200 行 |
| `core/src/external/spawn.ts`                          | 新增：跨平台 spawn / 杀进程组 / 环形 stderr                                                                       | ~140 行 |
| `core/src/engine/external.ts`                         | 新增：`runExternalAgent`（`ExternalEvent` → `AgentEvent` 映射 + 预算巡检）                                       | ~200 行 |
| `core/src/server/hub.ts`                              | `resolveProvider()` 前置分流：命中外部队列 → `placeholderProvider`；引擎分派加第 4 分支；`subagent`/`distill`/`sandbox` 置空 | ~50 行改 |
| `core/src/headless.ts`                                | `HeadlessDeps.engine` 已可注入，仅需在 CLI 侧按模式选取                                                             | 0 行    |
| `core/src/session/migrations.ts`                      | v6：`sessions.external_id/external_agent` + `usage.billing`                                            | ~25 行  |
| `core/src/session/store.ts`                           | 会话读写带上新字段                                                                                             | ~15 行  |
| `core/src/llm/placeholders.ts`                        | 新增 `UnavailableProvider`（`chat()` 抛 `external_agent_no_llm`，`estimateTokens()` 返回 0）                  | ~25 行  |
| `cli/src/headless-run.ts`                             | 引擎选择表加外部分支                                                                                            | ~20 行  |
| `cli/src/doctor.ts`                                   | 新增外部 Agent 检查节                                                                                        | ~40 行  |
| `web/src/components/settings/ExternalAgentsPanel.vue` | 新增卡片                                                                                                  | ~150 行 |
| `web` 会话头部                                            | 外部会话能力降级提示条                                                                                           | ~40 行  |

**总新增约 1.4k 行 + 改 150 行**，不动 `react.ts` / `orchestrator.ts` / `pump.ts` —— 这是选「引擎接缝」而非「Provider 接缝」换来的最大好处。

### 11.1 `RunContext` 兼容策略

`RunContext.provider` 保持**必填**，外部会话注入 `UnavailableProvider`（null-object）。理由：`provider` 在 `react.ts`、`roles.ts`、`reviewer.ts`、`subagent` 里被广泛引用，改成可选会引发大面积 `!` 断言与运行期 undefined，收益为负。


`ctx.model` 写 `cli:claude-code` 这类虚拟 id，供 UI 区分与报表归类；不要在 `defaultModelFor(provider.id)` 处炸掉 —— hub 分流后跳过该调用。

---

## 12. 测试策略

零密钥、零网络、零真实 CLI，全部可进 CI：

1. **假 CLI（fixture）**：`packages/core/test/fixtures/fake-cli.mjs`，读 `FAKE_CLI_SCRIPT` 指向的 JSON 场景文件，按脚本逐步往 stdout 吐事件（含乱序、半行、超大行、stderr 混杂、非零退出）。`DELTA_FAKE_CLI=<abs path>` 让 detect 直接命中它。
2. **单测**（`test/external-mapper.test.ts`）：每条映射规则一个用例；重点覆盖 `done` 必达、`fatal` 判定、tool_result 截断、permission → ConfirmDecision 三值。
3. **单测**（`test/external-permission.test.ts`）：三档 × 三协议的启动参数断言；`plan` 档上游无只读能力时必须抛 `external_no_plan_mode`。
4. **进程测试**（`test/external-spawn.test.ts`）：abort 后进程确实消失（POSIX 查 pid、Windows 查 `tasklist`）；stderr 环形缓冲不超过 200 行。
5. **E2E**（`e2e/cli/e2e-cli.mjs` 追加一条）：`DELTA_FAKE_CLI` + 隔离 HOME，跑一次外部会话，断言退出码协议 0/1/2/3/4/5 与三引擎一致。
6. **回归护栏**：新增 lint 规则（对齐 OpenBot 的做法）——禁止测试里 `sleep`、禁止按 `data-testid` 定位、禁止 `.only`。

**不做真机测试进 CI**：真实 CLI 版本漂移会让 CI 变成随机红。真机只在发布前手工 smoke 一次，结果记 `docs/` 的兼容性表。

---

## 13. 分阶段落地

| 阶段     | 范围                                        | 出口标准                                    |
| ------ | ----------------------------------------- | --------------------------------------- |
| **P0** | 引擎接缝 + `ExternalEvent` 映射 + 假 CLI + 迁移 v6 | 假 CLI 全场景通过，三引擎回归零失败                    |
| **P1** | ACP 适配器（Tier A）+ 权限桥接                     | 至少 1 个真实 ACP agent 端到端跑通；`plan` 档确认拦截生效 |
| **P2** | Claude stream-json（Tier B）+ MCP 透传        | 无 key 用户可用订阅跑通一次真实改码任务                  |
| **P3** | Codex app-server（Tier C）+ resume + Web 面板 | 会话续跑可用；`doctor` 输出完整                    |
| **P4** | 多外部 agent 并发（每会话独立进程）                     | 两会话并行不串事件                               |

---

## 14. 验收标准

- **AC-55-1** 未配置任何 Provider Key 时，`delta --external cli:claude-code` 能启动并完成一次任务；`delta models list` 显示探测到的外部 agent。
- **AC-55-2** 外部会话的全部产出走同一 `AgentEvent` 流：TUI/Web 渲染、消息落库、usage 报表与内置引擎**无差异分支**（代码上不出现 `if (external)` 散落判断，仅 `ctx.model` 前缀可用于展示）。
- **AC-55-3** `plan` 档下，外部 agent 的任何 write/exec 请求被拒绝；Tier A 逐次拦截、Tier C 拒绝启动并报 `external_no_plan_mode`。
- **AC-55-4** `default` 档下 Tier A 的每次工具调用在 Web 端弹出确认卡，`allow_session` 后同工具不再询问（与 F-23 会话记忆同语义）。
- **AC-55-5** 用户点停止后 1s 内进程退出（跨平台）；serve dispose 后无孤儿进程。
- **AC-55-6** 外部会话 `usage` 行 `billing='subscription'`；F-31 报表金额列不把订阅调用计入「已花费」。
- **AC-55-7** 外部会话下沙箱 / 压缩 / 蒸馏 / `task` 四项能力显式降级：UI 有提示条，`doctor` 有说明，日志有 `debug` 记录，但**不弹错误**。
- **AC-55-8** 会话续跑：`delta -r <id>` 命中外部会话时用 resume 令牌；令牌失效时降级为摘要重建并提示一次，不崩溃。
- **AC-55-9** 外部会话不写任何凭证到 `~/.delta/`；`external.json` 中不含 token 字段（测试断言）。

---

## 15. 风险

| 风险                             | 影响      | 缓解                                                    |
| ------------------------------ | ------- | ----------------------------------------------------- |
| 上游 CLI 版本漂移（flags / 事件字段）      | 适配器静默失效 | adapters 全部走「能力探测 + 运行时实测」，版本不匹配时明确报错而非降级瞎跑；发布前 smoke |
| 契约错位：用户以为 delta 的权限/沙箱在生效      | 安全事故    | §5.2 的显式提示条 + `doctor` 章节，**不静默**                     |
| 插件/CLI 自带 MCP 与 delta 的 MCP 重名 | 工具冲突    | 透传时给每个条目加 `delta-` 前缀别名；冲突记 `warn`                    |
| 长任务无事件但进程活着                    | 用户以为卡死  | 静默 10 分钟健康检查 + 「仍在运行，最近输出：…」提示                        |
| 会话历史双写导致切换错位                   | 上下文污染   | §8 单一权威规则 + 禁止反向切换（v1）                                |

---

## 16. 明确不做

- 不自动下载 / 自动更新外部 CLI（`delta update` 只管自己）。
- 不内置任何 provider 的许可条款文本，也不代用户接受。
- 不把外部 agent 接入 Plan DAG（`multi-agent` 模式与外部后端 v1 互斥，选中时 UI 置灰并说明）。
- 不提供「外部 agent 之间互相通信」的编排（OpenBot 的 channels / agent-to-agent 是另一个量级的产品形态，不在本特性内）。

---

## 附录 A：协议实测兼容性表（实现期回写）

> §2 警示项的实测记录。字段名以实测为准，本表随 P1/P2/P3 推进逐行回填。

| Agent | 协议 / spec 版本 | `initialize` capability 字段 | `session/update` chunk 枚举 | `request_permission` option 形状 | `session/cancel` 语义 | CLI flags 实测 | 实测日期 |
| ----- | -------------- | -------------------------- | -------------------------- | ------------------------------ | -------------------- | ------------- | ------- |
| （fixture：fake-acp-agent.mjs） | ACP / protocolVersion 1（JSON-RPC 2.0 over stdio，换行分隔） | 已验证：initialize→agentCapabilities 协商（版本不一致宽容处理） | agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update / plan，未知值忽略 | `{optionId, name?, kind: allow_once\|allow_always\|reject_once\|reject_always}`，回 `{outcome:{outcome:'selected', optionId}}` | 通知形式 `{sessionId}`，agent 停止后自然退出 | N/A（fixture） | 2026-11-05 |
| Claude Code 2.1.168 | 无原生 ACP 标志（`claude --help` 无 acp 项）——需 Zed `claude-code-acp` 包装器方可作为 Tier A 接入 | 待真机实测 | 待真机实测 | 待真机实测 | 待真机实测 | 待真机实测 | 2026-11-05（探测） |
| Claude Code 2.1.168（Tier B stream-json，真机） | `-p <prompt> --output-format stream-json`（**--print 下必须叠加 `--verbose`，否则报错退出**）；prompt 走 argv + 立即关 stdin（`-p` 会等 stdin 3s）；`--permission-mode plan` / `--dangerously-skip-permissions` / `-r <sessionId>` / `--mcp-config <file>` 均实测存在 | N/A（Tier B 无协议握手） | system(init, session_id) → assistant(content 块 text/thinking/tool_use) → user(tool_result) → result(usage, total_cost_usd 忽略) | 无逐次回包通道（-p 非交互上游自行拒绝）；plan/yolo 走 flags | 杀进程组即可 | `claude -p "..." --output-format stream-json --verbose`（delta 侧已实装 `cli:claude-code`） | 2026-11-05（真机管线 smoke：全链路 spawn→解析→done exit 0 ✓；**claude 自身登录态 401 失效**，需用户重新 `claude` 登录后复跑真实改码任务） |
| cursor-agent（本机） | 二进制损坏（dyld Symbol not found），本机不可测 | — | — | — | — | — | 2026-11-05（探测） |
| codex-cli 0.162.0-alpha.17.2 | `app-server` 子命令存在（Tier C，P3 范围） | — | — | — | — | 待 P3 实测 | 2026-11-05（探测） |
| codex-cli 0.162.0-alpha.17.2（Tier C app-server v2，真机 + schema 实测） | `codex app-server generate-json-schema --out <dir>` 产出完整协议 schema；**线上 method 拼写与 v2 schema 零差异**：斜杠式 `initialize`/`thread/start`/`thread/resume`/`turn/start`/`turn/interrupt`/`initialized`，通知 `thread/started`/`turn/completed`/`item/started`/`item/completed`/`item/agentMessage/delta`/`item/reasoning/textDelta`/`thread/tokenUsage/updated`/`error`（少数 camel 无斜杠） | v2 JSON-RPC 2.0 over stdio；`thread/start` {cwd, model?...} → `thread/started`{thread.id}；`thread/resume`{threadId} | agentMessage delta / reasoning textDelta / 命令执行与文件变更 item（started/completed） | **审批桥**：`item/commandExecution/requestApproval` / `item/fileChange/requestApproval` → decision {accept, acceptForSession, decline, cancel}（legacy: execCommandApproval/applyPatchApproval → ReviewDecision approved/approved_for_session/denied）；映射 allow→accept/approved、allow_session→acceptForSession/approved_for_session、reject→decline/denied | abort → `turn/interrupt`（required threadId+turnId，turn 未建立时直接杀进程组） | `codex app-server`（delta 侧已实装 `cli:codex`）；plan 档无只读模式 → external_no_plan_mode 门禁拒绝启动；yolo `--dangerously-bypass-approvals-and-sandbox`；error 通知 CodexErrorInfo 枚举（unauthorized 等）宽容透传 | 2026-11-05（协议层握手实测 ✓，与登录态无关；真实 turn 待用户 `codex login`） |

> 真机端到端 smoke（P1 出口标准「至少 1 个真实 ACP agent」）因本机无可用 ACP 原生 agent 而未执行；fixture 全场景覆盖协议语义。待用户机器具备条件（安装 claude-code-acp 或其他 ACP agent）后按本表回填。
