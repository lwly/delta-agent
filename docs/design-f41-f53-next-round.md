# delta-agent 下一轮技术方案设计（F-41 ~ F-53）

> 版本：v0.1 ｜ 日期：2026-10-28 ｜ 对应 PRD：docs/prd-f41-f53-next-round.md
> 各功能进入实施前，从本文对应章节拆出独立的 `docs/design-fXX-*.md`（对齐 f30~f40 惯例），以拆出稿为实施权威。
> 代码引用基于当前 agent 分支实况（包内路径均相对 `packages/`）。

## 0. 横切结论（先读）

1. **引擎事件流是唯一脊柱**：`AgentEvent`（shared/src/index.ts:161-223）→ `runReAct`（core/src/engine/react.ts:87）/ plan-execute / orchestrator → headless（core/src/headless.ts）与 SessionHub（core/src/server/hub.ts:189）两条消费线。F-42/F-43/F-45/F-46 都挂在这条脊柱上，不旁路。
2. **入口层注入模式已定型**：F-33 的 Notifier 三端注入（`AppOptions.notify` / `SessionHubDeps.notify` / headless-run 构造）是 F-43 OTel sink、F-49 通知回调的标准范式。
3. **决策等待器模式可复用**：hub.ts:152 的 createDecisionWaiter（confirm/answer/plan 三种 30min 超时等待）是 F-42 request_permission 的现成桥。
4. **依赖纪律**：当前运行时依赖仅 `@modelcontextprotocol/sdk`、`better-sqlite3`、`ajv`、`fflate`；tree-sitter / opentelemetry 零命中。新增依赖须逐项过评审（本文各决策表标注）。
5. **SQLite 迁移纪律**：版本号存 `PRAGMA user_version`（core/src/session/migrations.ts），v1 baseline → v2 检索 → v3 usage 扩展；F-45/F-48/F-49 的表变更续接 v4+。
6. **CLI 注册纪律**：commander 单文件注册（cli/src/index.ts），新子命令必须加入 `KNOWN_SUBCOMMANDS`（裸任务路由白名单）。

---

## 1. F-41 AGENTS.md 兼容

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D41-1 | 逻辑下沉 core：新增 `core/src/instructions/`，CLI `loadInstructions`（cli/src/prompt.ts:73-84）改为调用它 | 现状逻辑在 CLI 组装层，Web/headless 链路无法同源；下沉后三端一致。备选（CLI 内改）被否：F-46/F-47 也要读指令，避免再复制 |
| D41-2 | 发现规则：从会话工作根向上收集 AGENTS.md 直到项目根（含 git root），不越过项目根 | 嵌套覆盖语义 = "越近优先"；越出项目根会吸入无关指引 |
| D41-3 | 合并策略：近层 section 同名覆盖远层，未同名段落按近→远拼接；`.delta/agent.md` 最后追加（优先级最高） | 简单可解释；不做字段级语义合并（AGENTS.md 是自由 Markdown） |
| D41-4 | 软链识别：`fs.lstat` + `realpath` 归一化；CLAUDE.md/GEMINI.md 若 realpath 指向已收集的 AGENTS.md 则跳过；坏软链 warning 跳过 | 覆盖社区常见共存写法；普通 CLAUDE.md 直读不做（PRD 已定范围） |
| D41-5 | onboarding 目标扩展：仓库无 AGENTS.md 且无 `.delta/agent.md` 时，草案/确认产物改为 AGENTS.md；否则维持现状（`.delta/agent.md`） | 已有 AGENTS.md 的仓库不覆盖（复用 F-34 confirm 不覆盖语义，core/src/onboarding/index.ts:259） |

### 改动面

```
core/src/instructions/index.ts     新增：discoverInstructions(root, workRoot): InstructionFile[]
                                   （发现 + 软链归一 + 嵌套合并，产出 { text, sources[] }）
core/src/onboarding/index.ts       草案/目标路径逻辑（:57-:72 一带）加 AGENTS.md 分支
cli/src/prompt.ts                  loadInstructions 改调 core（保留 README 前 2000 字逻辑）
core/test/instructions.test.ts     新增
```

L3 ProjectLayer（core/src/prompt/layers.ts:54）不改——它只消费 `ctx.projectInstructions`，注入文本变了而已。

### 测试策略

发现顺序（根/子目录/git root 边界）、嵌套覆盖（同名 section / 异名追加）、软链三种（→AGENTS.md 去重、坏链、自环保护）、onboarding 四象限（有/无 AGENTS.md × 有/无 .delta/agent.md）。

---

## 2. F-42 ACP Agent Server

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D42-1 | 手写 JSON-RPC over stdio（newline-delimited），不引官方协议库 | 协议面小（4 方法 + 1 通知 + 1 服务端请求），可控且零依赖；官方库（@zed-industries/agent-client-protocol）作为备选记录，若协议演进加速可切换 |
| D42-2 | 复用 headless 组装链而非 SessionHub | ACP 进程是单会话服务端：SessionHub 的 SSE/多会话能力用不上；headless 的引擎组装 + 权限注入已验证。但确认等待逻辑**不复用** headless 的"自动拒绝"，改接 ACP request_permission round-trip |
| D42-3 | 一个 ACP session ↔ 一个 delta session（复用 SessionStore）；session/new 的 cwd → ensureProject | 项目注册复用 F-34 ensureProject 语义 |
| D42-4 | 权限映射：PermissionCheck.confirm → 服务端发 `session/request_permission`，outcome：approve → allow、proceed_always → allow_session、reject → deny；yolo/plan 档不发起请求 | 与 ConfirmDecision（shared/src/index.ts:227-263）语义逐一对齐 |
| D42-5 | diff 回传：edit/write 的 tool_call_update 带 unified diff，取 FileChangeStore.get 快照（core/src/session/changes.ts:122） | 复用 F-36 DiffView 同一数据源 |

### 模块与事件映射

```
core/src/acp/
├── rpc.ts        JSON-RPC 帧（读行 / 写行 / id 关联 / cancel 传播）
├── server.ts     方法分发：initialize / session/new / session/prompt / session/cancel
├── bridge.ts     AgentEvent → session/update 映射（核心）
└── permission.ts request_permission 桥（复用 confirm 回调注入 ctx.confirm）
```

| AgentEvent | ACP session/update |
|------------|--------------------|
| text_delta | agent_message_chunk |
| tool_call_start | tool_call（kind 映射：read/search/fetch/execute/edit/delete/move/other） |
| tool_result | tool_call_update（completed；edit/write 附 diff；失败附 error） |
| plan_created / plan_updated | plan（entries 只读展示） |
| thinking_delta / budget_alert / sandbox_notice | 丢弃（或 debug 级日志），首版不映射 |
| done / error | 收尾（结束本轮 prompt，session 保持存活） |

`ctx.confirm` 注入：registry.ts:241 的 ConfirmResponder 协议与 ACP 请求-响应天然同构——bridge 收到 confirm_request 时暂挂工具 promise，rpc 层把 outcome 写回，超时策略对齐 hub（30min）。

### 接线

- CLI：`delta acp [--permission <mode>] [--model]`，注册 KNOWN_SUBCOMMANDS；进程级单会话，stdin 关闭即退出（退出码复用 headlessExitCode 语义）。
- 引擎取消：session/cancel → AbortSignal 传播（RunContext.signal，复用 headless 中断路径）。

### 测试策略

rpc 帧解析（分帧/坏 JSON/超长行）；bridge 映射表快照测试（Mock LLM 脚本化事件流）；request_permission 三态 round-trip（伪客户端）；cancel 后无残留（进程树断言）；与真实 Zed 的联调留到集成阶段手工验收。

### 风险

| 风险 | 对策 |
|------|------|
| ACP 规范版本演进 | initialize 协商版本；bridge 层隔离协议差异，升级只改 acp/ |
| 大 diff 帧 | tool_call_update diff 复用 compactDiff 折叠（DIFF_MAX_LINES 保护） |
| 客户端实现差异 | fixture 化已知客户端行为；联调问题记录 docs/design-f42 附录 |

---

## 3. F-43 OTel GenAI 导出

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D43-1 | 引官方 SDK：`@opentelemetry/api` + `sdk-trace-base` + `exporter-trace-otlp-http` | OTLP 编码/重试/批量自己写成本高且易错；sdk-trace-base 不带自动 instrumentation，依赖树可控。手写 OTLP JSON exporter 备选被否：可靠性关键 |
| D43-2 | 旁路 sink 模式（对齐 F-33 D1/D8）：三端注入 `OtelSink`，引擎与工具零改动 | AgentEvent 已含全部所需信息；sink 失败静默 |
| D43-3 | span 模型：run → `invoke_agent`；每轮 LLM → `chat`（子 span）；每次工具 → `execute_tool`（子 span） | GenAI semconv 对应；父子关系由事件序重建（turn_start 开 chat，tool_call_start 开 execute_tool，tool_result 关闭） |
| D43-4 | 内容采集三档 off（默认）/ masked / full，span 属性 `gen_ai.prompt` / `gen_ai.completion` | off 档零敏感面；masked 走 redact.ts（已知模式 + Shannon 熵 > 4.5/字节段替换 [REDACTED] + 长度截断 2k） |
| D43-5 | 配置两级文件 `~/.delta/otel.json` < `.delta/otel.json`：{enabled, endpoint, protocol, headers, sampleRate, contentCapture} | 对齐 notify.json / sandbox.json 惯例；永不 throw，坏 JSON 降级默认 |

### 模块

```
core/src/otel/
├── types.ts      OtelConfig / OtelSink 接口
├── config.ts     两级加载 + 归一化
├── redact.ts     脱敏（模式表 + 熵检测）
└── sink.ts       OtelSink：AgentEvent 流 → span 树 → BatchSpanProcessor → OTLP
```

属性映射：`gen_ai.system`（provider id）、`gen_ai.request.model`、`gen_ai.usage.input_tokens/output_tokens`（usage 事件）、自定义 `delta.cost_usd`、`delta.tool.name/args_summary`、`delta.session.id`。cache token 若 F-45 已透传（见 §6 D45-2）则带 `gen_ai.usage.cache_read_tokens`。

### 接线（对齐 F-33 三端注入）

| 端 | 注入点 |
|----|--------|
| TUI | `AppOptions.otel`（index.ts start() 构造，缺省 no-op sink） |
| Web | `SessionHubDeps.otel`（serve 构造） |
| Headless | runHeadlessCommand 构造；`runHeadless` finally flush（BatchSpanProcessor 强制 flush 防丢尾） |

### 测试策略

配置加载/降级；redact fixture（AWS key / 私钥 / 普通高熵 uuid 不误杀全量？——uuid 命中仅 masked 不阻断）；span 树重建（Mock 事件流 → 断言 span 序列与属性）；off 档零初始化。不真发 OTLP（exporter 注入 fake）。

---

## 4. F-44 skills.sh / MCP Registry 互通

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D44-1 | SKILL.md 导入走独立 `skills/portable.ts`（校验 + 字段映射），不动 `skills/loader.ts` 的发现逻辑 | loader 语义（三层覆盖）不变，portable 只负责"外部格式 → SkillMeta" |
| D44-2 | frontmatter 兼容矩阵：必需 name/description；delta 超集 triggers/tools_allowlist 缺省容忍；未知字段保留原样写回 | 社区技能最小集可进；roundtrip 不丢信息 |
| D44-3 | 导出打包复用 fflate（skill-hub 下载已在用） | 零新依赖 |
| D44-4 | MCP registry 走官方 HTTP API（registry.modelcontextprotocol.io），仅 stdio 传输安装；写 mcp.json 前展示预览、需确认 | OAuth/HTTP 型 server 预留不做（PRD 范围）；mcp.json 写入复用 `loadMcpConfig` 合并语义（mcp/client.ts:168），只增改目标条目 |
| D44-5 | 安全校验复用 skill-hub 既有管线（zip-slip、64MB 上限、scripts/ 目录人工审阅提醒） | hub.ts 已实现并测试过，不重写 |

### 模块

```
core/src/skills/portable.ts     importSkill(dir, target: 'user'|'project') / exportSkill(name, outDir)
core/src/mcp/registry.ts        searchRegistry(query) / fetchServerDefinition(name) / buildMcpJsonEntry(def)
cli/src/skill.ts                skill import/export 子命令
cli/src/index.ts                delta mcp search/install 子命令（mcp 现无 CLI 组，新增 cli/src/mcp.ts）
server/http.ts                  /api/skill-hub/* 旁已有；新增 /api/mcp/registry/* 代理（复用 skill-hub 代理模式 http.ts:452-552）
```

### 测试策略

roundtrip（export→import 逐段比对）；最小社区技能导入；超集字段容忍与未知字段保留；zip-slip/超大包拒收；registry 响应 fixture → mcp.json 条目构造；写入预览 diff 与确认流。

---

## 5. F-45 成本体检（cache token 透传先决）

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D45-1 | 规则引擎接口化：`interface AuditRule { id; run(ctx: AuditContext): Finding[] }`，R1 六规则逐条实现独立注册 | 规则可持续新增；每规则独立单测 |
| D45-2 | cache token 透传作为先决小项：StreamEvent usage 扩展 `cache_read_tokens?`（anthropic: cache_read_input_tokens；openai-compatible: prompt_tokens_details.cached_tokens），usage 表 v4 加列 `cache_read_tokens`（可空，历史回填 NULL） | 无此数据规则 5 无法实现；只改 anthropic + openai-compatible 基类即覆盖主力（待确认 #2） |
| D45-3 | 数据源：UsageStore.bySession（金额真值）+ SessionStore messages.content_json（工具调用参数/结果）+ FileChangeStore（文件是否真变更） | 全部只读，零引擎改动 |
| D45-4 | 金额估算统一 `pricing.priceFor / computeCostUsd`（core/src/llm/pricing.ts:67/:78） | 与 usage 表口径一致，避免两套价 |
| D45-5 | 阈值集中 `.delta/cost.json`（各规则阈值 + 开关），缺省内置 | 项目级可调，用户级兜底 |

### 模块

```
core/src/cost/
├── types.ts      AuditFinding { ruleId, severity, wasteUsd, evidence[], suggestion }
├── context.ts    AuditContext（懒加载 messages/changes，避免大会话全量驻留）
├── rules/        r1-reread.ts / r2-dup-call.ts / r3-oversize.ts / r4-no-routing.ts / r5-cache.ts / r6-subagent.ts
└── audit.ts      auditSession(sessionId) / auditRange(filter)
cli/src/cost-audit.ts           delta cost audit [--session|--range] [--json]
server/http.ts                  GET /api/usage/audit（复用 UsageFilter 归一化）
web（UsageView.vue 扩展）        浪费概览卡 + 明细弹层
```

### 测试策略

每规则一个 fixture（构造 usage 行 + messages JSON），断言 Finding 与金额；priceFor 一致性（同输入与 usage 表 cost_usd 对账）；数据缺失降级（cache 列 NULL → 规则 5 跳过并注明）；阈值配置覆盖。

---

## 6. F-46 中途操控

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D46-1 | 控制通道挂在引擎轮间：RunContext 增加 `control?: ControlChannel`，react.ts 轮首 `drain()` | 轮边界是唯一安全检查点（LLM 流中途打断成本高，PRD 已排除）；plan-execute/orchestrator 在节点间同样 drain（仅编排层） |
| D46-2 | ControlCommand 联合：`{type:'inject', text}` / `{type:'restrict', paths:string[]}` / `{type:'pause'}` / `{type:'resume'}`；channel 为有界队列（100），满则丢弃最新并告警 | 防失控注入；命令幂等 |
| D46-3 | inject 实现：暂存队列，轮首作为 `{role:'user', content:'[运行中追加指令] …'}` 入 history；同一轮多条合并为一条 | 模型视角与普通用户消息同构，无新机制；标注防压缩误判 |
| D46-4 | restrict 实现：ToolContext 增加 `pathRestriction?: { allow: string[] }`；registry 执行前对 write/edit/run_command（cwd 相关）做路径包含校验，越界 → confirm 请求改走 deny（reason 注明新约束）；已挂起 waiter 越界 → 直接 reject | 复用 ConfirmResponder 协议；不新造权限层 |
| D46-5 | 事件回显：shared AgentEvent 新增 `control_applied { command, turn }`；落库（复用事件消息通道），F-18 回放可见 | 三端一致的操控反馈 |
| D46-6 | pause 语义对齐 Web 已有实现（hub.ts:308）并下沉 core 引擎轮间检查；CLI 补对等入口 | 避免两端两套语义 |

### 改动面

```
shared/src/index.ts             ControlCommand / control_applied 事件
core/src/engine/control.ts      新增：ControlChannel（push/drain）
core/src/engine/react.ts        轮首 drain + inject 入 history + restrict 注入 toolContext
core/src/engine/plan-execute.ts / orchestrator.ts   节点间 drain（inject 作用于编排指令）
core/src/tools/registry.ts      pathRestriction 前置校验（:202 管线内、hooks 之后）
core/src/server/hub.ts          SessionHub.control(sessionId, cmd)（waiters 复用 :152 模式）
core/src/server/http.ts         POST /api/sessions/:sid/control
cli/src/ui/app.tsx              /inject /restrict 斜杠命令 + control_applied 渲染
web 控制条                       注入输入框 + 约束设置 + 暂停/继续
```

### 测试策略

channel drain 顺序与有界丢弃；inject 下轮生效（Mock LLM 断言 messages 序列）；restrict 三路径（未执行调用 / 新 confirm / 已挂起越界）；pause-resume 状态机；plan/multi 模式编排层注入；事件落库与回放。

---

## 7. F-47 独立评审模式

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D47-1 | 复用 headless 内核跑评审任务：专用 review prompt + 结构化 findings 输出，不新写执行引擎 | headless 的预算/权限/退出码/JSON 报告全部现成（core/src/headless.ts:93-131） |
| D47-2 | findings 输出走"模型产 JSON + ajv schema 校验 + 后验过滤"（行号越界/文件不在 diff 内剔除并计数） | 解析失败一次重试（对齐自愈语义），再失败报错而非静默 |
| D47-3 | 规则注入：AGENTS.md/MEMORY.md（依赖 F-41 的 discoverInstructions）+ `.delta/review.json`（focus/ignore/额外规则文本） | 规则来源与 F-41 统一 |
| D47-4 | diff 输入：git diff（--staged / --range / --paths），经 WorktreeManager 当前工作根；超限（DIFF_MAX_LINES）分批评审合并 findings | 复用 F-36/F-37 既有能力 |
| D47-5 | 一键修 = 生成修复任务走 headless run（带 finding 上下文 + 允许文件列表 = restrict 语义），修复后变更入 FileChangeStore 可回滚 | F-46 restrict 复用；权限三档正常生效 |
| D47-6 | CI 退出码：0 clean / 1 存在 blocker / 2 执行错误；`--json` 输出 findings | 与 headless 退出码协议并列（headless 协议不变） |

### 模块

```
core/src/review/
├── types.ts      ReviewFinding { file, line, endLine?, severity, category, message, suggestion? }
├── schema.ts     ajv schema
├── prompt.ts     评审 system prompt（含规则注入与输出格式约束）
├── runner.ts     runReview(deps, opts): Promise<ReviewResult>（内部走 runHeadless）
└── fix.ts        buildFixTask(finding, context) → headless 任务串
cli/src/review.ts               delta review [--staged|--range|--paths] [--json] [--check] + TUI findings 卡
evals/suites.ts                 内置 review-fixtures 套件（注入已知缺陷 → 判 finding 命中，复用 evaluateChecks 扩展 check 类型）
```

### 测试策略

schema 校验与后验过滤；分批合并；规则注入（含/不含 AGENTS.md）；CI 退出码三态；fix 任务 restrict 生效（越界拒绝）；evals 基线回归。

---

## 8. F-48 代码符号索引

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D48-1 | web-tree-sitter（wasm），不引 node 原生 tree-sitter | better-sqlite3 已是唯一原生依赖，不再增加编译矩阵负担（尤其 F-51 信创 arm64）；wasm 性能足够索引场景 |
| D48-2 | grammar 打包策略：TS/JS/Python 三门 wasm 随包分发；Go/Java 走"首次使用下载 + 离线包附带"（衔接 F-51） | 平衡包体积与离线可用；待确认 #4 可再收敛 |
| D48-3 | 存储：v4 迁移加 `symbols` + `symbol_refs` 表（project_id, path, name, kind, start/end line, file_hash）；查询走 SQL + FTS 可选 | 沿用 migrations 纪律；embedding 可选叠加（复用 F-17 /embeddings 管线，Float32 BLOB 同款） |
| D48-4 | 增量索引：目录扫描 → mtime+size 快速筛 → file_hash 精筛 → 变更文件重解析；删除级联清理 | 大仓预算的关键；索引在独立进程/分批 tick 中执行不阻塞对话 |
| D48-5 | agent 侧暴露只读工具 `symbol_query`（注册进 RestrictedRegistry 白名单语义），受权限三档管理 | 供主循环与 F-47 review 调用 |

### 模块

```
core/src/symbols/
├── langs.ts      grammar 注册与懒加载（wasm 路径、语言探测按扩展名）
├── extract.ts    tree-sitter query：def/ref 抽取（每语言一份 query 文件）
├── store.ts      symbols 表读写 + 增量（v4 迁移）
├── indexer.ts    indexProject(projectRoot, opts)（分批 + 单文件超时 + 进度事件）
├── query.ts      querySymbol(projectId, name) → { defs, refs }
└── tool.ts       symbol_query AgentTool
cli/src/symbols.ts              delta symbols index/status/query
```

### 测试策略

每语言 golden（定义/引用/重载/别名/import as）；增量（改/删/不动三类）；超时与降级（语法错误文件跳过计数）；大仓性能验收实测记录；工具只读断言。

### 风险

| 风险 | 对策 |
|------|------|
| wasm 解析大文件慢 | 单文件超时 + 大文件跳过标记；索引异步不阻塞 |
| query 覆盖不全（语言特性） | golden 达标制；未覆盖特性记 known-limitations |
| grammar 下载依赖外网 | F-51 离线包附带；查询失败明确提示 |

---

## 9. F-49 后台任务队列

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D49-1 | jobs 表入 SQLite（v4/v5 迁移，与 F-48 迁移序号协调）：id/project_id/title/payload_json/status/schedule/lease/created/started/finished/result_json | 单机持久化与恢复都靠它；复用 F-15b 租约语义（60s 租约 + 心跳） |
| D49-2 | 执行器 = createSpawnExecutor 变体（core/src/cron/spawn-executor.ts:60）：spawn `delta run --json` + 可选 worktree 隔离 + 完成通知回调 | 与 cron 同一执行形态，cron 入队模式（D49-4）后行为收敛 |
| D49-3 | worktree 隔离复用 WorktreeManager（core/src/git/worktree.ts:43）addWorktree；任务结束清理策略可配（keep|auto-prune） | 会话级隔离语义（F-37）平移到任务级 |
| D49-4 | cron 目标扩展：CronJob 增加 `target: 'direct'|'queue'`，queue 模式到点入队不 spawn | cron 变纯调度源，执行池统一；direct 保持向后兼容 |
| D49-5 | 通知复用 Notifier 接口（notifyDone 已有 trigger 语义），Web 端任务状态变更走既有 state 事件通道 | 零新事件机制 |

### 模块

```
core/src/queue/
├── store.ts      jobs 表 CRUD + 租约领取（claimDue(limit)）/ 孤儿回收
├── runner.ts     JobRunner（start/stop、并发上限、失败重试上限、通知回调）
└── executor.ts   spawn 执行（复用/泛化 cron spawn-executor；--worktree 透传给 run）
cli/src/job.ts                  delta job add/list/show/logs/rm/cancel
core/src/cron/store.ts          CronJob.target 字段
core/src/server/http.ts         /api/jobs 端点组（list/create/show/logs/cancel/rerun）
web（新 JobsView.vue + 路由）    任务板：列表/详情/日志 tail/重跑/取消
session/migrations.ts           v4（或 v5，与 F-48 协调）jobs 表
```

### 测试策略

租约领取与并发上限；孤儿回收（F-15b 模式复用断言）；worktree 生命周期；取消终止子进程；cron queue/direct 双模式等价；API 端点与 store 一致性。

---

## 10. F-50 企业治理层

> **前置依赖待确认 #3**：内网多人共用 serve 形态是否立项。以下按"立项"写；若否，只保留审计 + license 两个子项。

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D50-1 | 鉴权从 ServeOptions.authToken（server/http.ts:88, :235-242）扩展为中间件链：`authToken`（兼容现状）→ `jwt`（OIDC 会话）→ 匿名拒绝 | 默认形态行为不变（AC-50-1）；桌面宿主不受影响 |
| D50-2 | OIDC 引 `openid-client`（唯一新增重依赖，理由：token 刷新/发现文档/JWK 轮换自写易错）；CLI 走 device flow | 备选手写 PKCE 流被否：安全关键不自研 |
| D50-3 | RBAC：三角色常量 + http.ts 路由表标注 `requiredRole`。**前提重构**：http.ts 手写 if/else 路由（:277-1141）先抽成路由表数组（纯机械重构，行为不变），再逐组标注 | 不重构则权限标注散落 800 行 if/else，不可维护 |
| D50-4 | 审计：core/src/audit/log.ts JSONL append（fs.appendFile + 日切 rotate + 大小上限）；SIEM sink 为 webhook POST（失败缓冲重试 + 告警，不静默）；事件在鉴权层/确认决策点/配置写入点打点 | 审计写入失败静默是合规红线（AC-50-3） |
| D50-5 | 配额：QuotaStore（月度窗口聚合 UsageStore.bySession 口径）+ BudgetManager 前置检查（run 创建前拒绝，进行中不杀） | 复用既有聚合与预算状态机 |
| D50-6 | license：Ed25519 验签（node:crypto 内建，零依赖），`~/.delta/license.json` { lic, expiresAt, features } | 离线可验；公钥随包内置 |

### 模块

```
core/src/server/auth.ts         中间件链 + JWT 校验 + 角色注入
core/src/server/routes.ts       路由表抽取（机械重构，先行独立提交）
core/src/audit/{types,log}.ts   事件 schema + JSONL + webhook sink
core/src/quota/store.ts         QuotaStore
core/src/license/verify.ts      Ed25519 验签
cli/src/auth.ts                 delta auth login/logout/status（device flow）
```

### 测试策略

角色矩阵端点级表驱动测试；JWT 过期/篡改；审计 rotate 与失败重试；配额边界（耗尽拒绝 / 进行中完成）；license 三异常路径；**重构前后路由行为快照等价**（先锁定快照再抽表）。

---

## 11. F-51 信创私有化

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D51-1 | 预设库 `core/src/llm/presets.ts`：{id, label, type:'openai-compatible', baseUrl, defaultModel, pricing 条目}，`models add --preset <id>` 预填 | 全部国产模型走 openai-compatible 基类（providers/openai-compatible.ts），无新 Provider 实现 |
| D51-2 | 计价条目进 pricing.ts 表（可被 DELTA_MODEL_PRICES_JSON 覆盖，机制已有 pricing.ts:36） | 成本体检/预算口径统一 |
| D51-3 | air-gapped 模式：`DELTA_AIR_GAPPED=1` 或 otel/skill-hub/registry 配置全缺省时，外呼端点统一经 `isExternalCallAllowed()` 守卫（skill-hub hub.ts、mcp registry、otel sink、连通性测试） | 单点开关而非散落 if |
| D51-4 | 离线包：scripts/pack-offline.mjs 产出 {npm 离线 tarball 集 + better-sqlite3/ripgrep 平台预编译件 + grammar wasm}，附离线安装文档 | pnpm store 打包最稳；不重造安装器 |
| D51-5 | 平台矩阵：CI 增 linux-arm64 job；麒麟/统信以手测清单归档（CI 无官方镜像，不硬造） | 务实；鲲鹏=arm64 linux 同矩阵 |

### 测试策略

预设连通性（逐预设 mock baseUrl fixture + 真实环境记录）；air-gapped 守卫（断网沙箱 DNS/连接零请求）；离线包在干净容器安装冒烟；arm64 CI。

---

## 12. F-52 安全护栏

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D52-1 | 护栏内建在 registry 工具管线（tools/registry.ts:202 hooks 之后、执行之前），独立于用户 hooks.json | 用户 hook 先行、护栏兜底；两者都可阻断（AC-52-3） |
| D52-2 | 检测器零新依赖：已知模式表（AWS/GitHub/私钥 PEM/jwt/连接串）+ Shannon 熵滑窗；实现在 core/src/guard/detect.ts | gitleaks 集成留接口（detector 可插拔） |
| D52-3 | 扫描面（R1）：run_command 命令串、write_file/edit_file content、web_fetch 结果；PostToolUse 旁路扫描工具结果（只告警不阻断） | 出站（发往模型/写入盘）与入站（fetch 结果入上下文）两个方向 |
| D52-4 | MCP 清单快照：McpManager.connect 后 listTools 序列化哈希，比对 `~/.delta/mcp-snapshot.json`；变更 → `sandbox_notice` 式事件告警；strict 档未在快照内工具直接拒调 | 复用既有告警事件通道 |
| D52-5 | 配置信任锁定：hooks.json/mcp.json 首次运行记录哈希进 `~/.delta/trust.json`；变更下次启动时要求确认（TUI/Web），strict 档未确认则拒绝加载该配置 | 防"改配置即注入" |
| D52-6 | 提交扫描：git auto 策略提交前对 staged diff 跑 guard 检测，命中阻断并报告位置（复用 GitPolicy 挂点） | 独立于 F-52 其余能力也可单独关 |
| D52-7 | 档位 `.delta/guard.json` { mode: 'off'|'standard'|'strict' }，默认 standard；off 完全旁路 | standard=命中即拦截提示（可放行一次），strict=deny-by-default |

### 模块

```
core/src/guard/
├── detect.ts     模式表 + 熵检测 → Detection { kind, span, snippet }
├── guard.ts      checkContent(surface, text, mode): Verdict（allow|mask|block）
├── snapshot.ts   mcp 快照 / trust.json 哈希
cli/src/guard.ts                delta guard status/test/allow（放行记录）
registry.ts / hub.ts / GitPolicy 接线点
```

### 测试策略

fixture 基准（密钥样集检出率、正常高熵文本误报率实测记录）；性能基准（< 5ms/次）；三档行为矩阵；与用户 hooks 共存顺序；MCP 快照变更三态（告警/strict 拒/确认后更新）。

---

## 13. F-53 Windows 原生沙箱

### 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D53-1 | 裁决：**WSL2 为主**；AppContainer 不做（需 C#/WinRT 工具链、安装面复杂、收益不成比例）；Job Object 不作隔离档位（无文件系统/网络边界，仅资源限制，可后置为独立小项） | SandboxExecutor 接口（core/src/sandbox/executor.ts:57）已抽象，WslExecutor 是第四个后端（local/seatbelt/docker 之后） |
| D53-2 | spike 先行（1 周）：wsl.exe 探测（`wsl -l -q`）、命令包装（`wsl -e bash -lc`）、/mnt 路径翻译、NTFS vs WSL fs 性能与语义（inode/权限/信号）、stdin/stdout 透传 → 报告定稿 | PRD AC-53-1；spike 产物直接决定实现细节 |
| D53-3 | 配置：`{"mode":"wsl"}` 加入 SandboxRuntime 三模式枚举（sandbox/runtime.ts:71 → 四模式）；无 WSL 时探测失败 → 明确降级提示（docker/off），不静默 | 对齐 F-30 模式语义与 AC-53-3 |
| D53-4 | 逃逸用例复用 F-30 golden 套件（逐字符一致 + 逃逸零调用） | 不新造安全基准 |

### 模块

```
core/src/sandbox/wsl.ts         WslExecutor（探测/包装/翻译/执行）
core/src/sandbox/config.ts      mode 枚举扩展 + probe
core/src/sandbox/runtime.ts     后端分发
cli/src/sandbox.ts              status 展示 wsl 后端与探测详情
```

### 测试策略

探测与降级（有/无 wsl.exe）；包装命令构造转义；路径翻译双向；golden 套件在 Windows 实机跑通（CI matrix 补 windows job 执行 sandbox 子集）。

---

## 14. 实施与门禁提醒（全功能通用）

- 迁移序号 v4+ 由 F-45（cache 列）与 F-48/F-49（新表）协调，先到先得、后来顺延，合并前 rebase 迁移号。
- 新 CLI 子命令一律进 `KNOWN_SUBCOMMANDS`；新事件进 shared `AgentEvent` 联合并过三端消费检查（TUI 渲染/Web SSE/headless 不炸）。
- 每功能实施前从本文与 PRD 拆出 `prd-fXX`/`design-fXX` 成对文档；本文与拆出稿冲突时以拆出稿为准并回改本文。
- 门禁：`pnpm typecheck` + `pnpm test` + `pnpm smoke`（涉 Web 界面加 `pnpm smoke:web`）；分支 `feat/{任务ID}`，docs 与代码分开提交。
