# delta-agent 下一轮需求 PRD（F-41 ~ F-53）

> 版本：v0.1 ｜ 日期：2026-10-28 ｜ 状态：待评审
> 本文为下一轮 13 项需求的合并 PRD。各功能进入实施前，从本文对应章节拆出独立的 `docs/prd-fXX-*.md`（对齐 f30~f40 惯例），以拆出稿为实施权威。
> 技术方案见 `docs/design-f41-f53-next-round.md`，排期见 `docs/roadmap-f41-f53.md`。

---

## 1. 总览

| 编号 | 名称 | 档 | 一句话 | 预估 | 关键依赖 |
|------|------|----|--------|------|----------|
| F-41 | AGENTS.md 兼容 | S | 读最近的 AGENTS.md（嵌套覆盖、软链识别），onboarding 产出它 | 2–3 天 | — |
| F-42 | ACP Agent Server | S | `delta acp`：JSON-RPC over stdio，接入 ACP 编辑器客户端 | 1–2 周 | 引擎事件流 |
| F-43 | OTel GenAI 导出 | S | 事件流 → invoke_agent / chat / execute_tool span，OTLP 上报，内容采集开关+脱敏 | 3–5 天 | — |
| F-44 | skills.sh / MCP Registry 互通 | S | SKILL.md 双向导入导出；MCP 官方 registry 安装 | 1 周 | skill-hub（已有） |
| F-45 | 成本体检 | A | 扫描 usage+事件流定位浪费，输出"这次浪费了 ¥X" | 1–2 周 | UsageStore / 路由（已有） |
| F-46 | 中途操控 | A | 运行中注入指令、暂停/改约束、限制可改文件 | 2 周 | 引擎轮间检查点 |
| F-47 | 独立评审模式 | A | `delta review`：行级 findings + 一键修 + CI 模式 | 2–3 周 | F-41（规则来源）、F-29 headless |
| F-48 | 代码符号索引 | A | tree-sitter 符号/引用图，供 review 与大仓重构 | 3–4 周 | — |
| F-49 | 后台任务队列 | A | cron+worktree+notify+headless 拼成"派活—跑—回 PR"，Web 任务板 | 1–2 周 | F-22/F-33/F-37/F-29（均已有） |
| F-50 | 企业治理层 | B | OIDC/SSO + RBAC + 审计导出 + 团队配额 + 离线 license | 2–4 周 | — |
| F-51 | 信创私有化 | B | 国产模型预设、离线安装包、麒麟/统信+鲲鹏/昇腾适配、内网 OTLP | 2–3 周 | F-43（内网 OTLP） |
| F-52 | 安全护栏 | B | 出站脱敏、MCP 清单变更告警、配置锁定、提交前密钥扫描 | 2 周 | hooks 管线（已有） |
| F-53 | Windows 原生沙箱 | B | AppContainer / Job Object / WSL2 三选一 | 1 周 spike + 2–3 周 | — |

优先级语义：**S = 生态卡位与互操作，越早收益越大**；**A = 差异化体验与效率**；**B = 企业化与合规，取决于商业化节奏**。档内顺序即建议实施顺序。

---

## 2. F-41 AGENTS.md 兼容

### 2.1 背景与目标

AGENTS.md 已成为跨工具通用的"仓库级 agent 指引"开放约定；Claude Code 用 CLAUDE.md、Gemini CLI 用 GEMINI.md，大量存量仓库已有其一。delta 当前只读 `.delta/agent.md` + `MEMORY.md`（CLI 组装层 `loadInstructions`），对存量仓库零适配，onboarding 产出的也是私有格式。目标：**进一个已有指引文件的仓库，零配置生效；onboarding 产出通用格式**。

### 2.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-41-1 | 开发者 clone 一个已有 AGENTS.md 的仓库，直接启动 delta | 指令内容注入 L3 Project 层，首条回复即遵守（如"提交信息用中文"） |
| US-41-2 | monorepo 用户在前端/后端子目录里开不同会话 | 各子目录最近的 AGENTS.md 生效，并覆盖上层同名约定；上层未被覆盖的内容仍生效 |
| US-41-3 | 仓库用 CLAUDE.md/GEMINI.md 软链到 AGENTS.md（常见共存写法） | 识别软链目标，按 AGENTS.md 读取，同一文件不重复注入 |
| US-41-4 | 用户在新项目跑 onboarding | 草案与确认产物为 AGENTS.md（仓库无 AGENTS.md 且无 .delta/agent.md 时），格式对其它 agent 工具同样可用 |

### 2.3 范围

**做**：AGENTS.md 发现（cwd 向上到项目根/git 根）、嵌套覆盖合并、CLAUDE.md/GEMINI.md 软链识别、onboarding 产出目标扩展。
**不做**：`.cursor/rules`、`.github/copilot-instructions.md` 等其它格式；AGENTS.md 自动写回/同步；普通（非软链）CLAUDE.md 内容读取——先验证软链场景，直读留到有真实需求再加。

### 2.4 验收标准（AC）

- AC-41-1 优先级：`.delta/agent.md`（delta 专属）与 AGENTS.md 共存时两者都注入，`.delta/agent.md` 在后（优先级高）；来源在 debug 导出的组装结果中可见。
- AC-41-2 嵌套：从子目录发起的会话，按"越近优先"合并子目录与上层的 AGENTS.md；冲突段落取最近的。
- AC-41-3 软链去重：CLAUDE.md/GEMINI.md → AGENTS.md 的软链只读一次；坏软链告警但不中断。
- AC-41-4 onboarding：目标存在绝不覆盖（沿用 F-34 语义）；产出 AGENTS.md 后 `.delta/onboarding.json` 记录目标路径。
- AC-41-5 单测覆盖发现顺序 / 嵌套覆盖 / 软链 / 坏链降级四类用例；三端（TUI/Web/headless）指令来源一致。

---

## 3. F-42 ACP Agent Server

### 3.1 背景与目标

ACP（Agent Client Protocol）是编辑器侧接入 coding agent 的开放协议（JSON-RPC over stdio，Zed 等编辑器已内置客户端）。delta 引擎已是 `AsyncIterable<AgentEvent>`，headless（F-29）已验证引擎可脱离 TUI 消费；权限三档（F-23）与 FileChangeStore（F-24）天然对应 ACP 的 request_permission 与 diff 回传。目标：**编辑器里把 delta 选为 agent，获得与 TUI 同级的交互能力**。

### 3.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-42-1 | 用户在支持 ACP 的编辑器中添加 `delta acp` 为自定义 agent | 握手成功，能发起新会话并收到流式回复 |
| US-42-2 | Agent 请求写文件/执行命令 | 编辑器弹权限卡片；approve 后继续、reject 后模型收到拒绝原因并调整 |
| US-42-3 | Agent 编辑文件 | 编辑器内展示 diff 视图 |
| US-42-4 | Plan 模式产出计划 | 计划条目在编辑器侧可读（只读展示） |

### 3.3 范围

**做**：`delta acp` 子命令；方法面：`initialize` / `session/new` / `session/prompt` / `session/cancel` + 通知 `session/update`；`session/request_permission`（映射确认流）；AgentEvent → session/update 映射（消息增量、工具调用及状态、计划、diff）。
**不做**：MCP over ACP 透传、fs 扩展方法（read/write text file 由客户端提供时）首版接（协议有则映射，标 P2）；多 agent 并发会话；Web 端 ACP。

### 3.4 验收标准（AC）

- AC-42-1 握手：initialize 返回协议版本与能力；版本不匹配给出明确错误。
- AC-42-2 prompt：一条任务产生合法 update 序列（message chunk / tool_call / tool_call_update / plan），客户端无解析错误。
- AC-42-3 权限：request_permission 的 outcome 三态（approve / reject / proceed_always）正确映射 PermissionState（含 allow_session 白名单记忆）。
- AC-42-4 diff：edit/write 类工具调用回传 unified diff（取 FileChangeStore 快照）。
- AC-42-5 cancel：中止后无残留子进程，后续 prompt 可正常发起新轮。
- AC-42-6 `--permission plan|default|yolo` 透传生效；yolo 双重开启语义与 TUI 一致。

---

## 4. F-43 OTel GenAI 导出

### 4.1 背景与目标

团队与企业普遍已有 APM（Jaeger / Tempo / SigNoz 等），GenAI 语义约定（GenAI semconv）正在标准化。delta 已有全链路事件流（AgentEvent）与 usage 落库，缺一条**旁路导出**即可获得可观测性。目标：零侵入接入标准可观测后端，默认不泄露任何提示词/补全内容。

### 4.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-43-1 | 开发者把 delta 会话 trace 汇入公司 APM | 后端看到 invoke_agent → chat / execute_tool 的父子 span 树，含模型名与 token 数 |
| US-43-2 | 安全团队要求先灰度内容采集 | 默认内容不采集；开启 masked 模式后文本截断且密钥类内容被替换为 `[REDACTED]` |
| US-43-3 | 内网环境 | endpoint 指向内网 collector，协议可选 OTLP/http-protobuf 或 http-json |

### 4.3 范围

**做**：span 模型（一次 run = `invoke_agent`；每轮 LLM 调用 = `chat`；每次工具调用 = `execute_tool`）；GenAI 属性（system/model/request_tokens/response_tokens，费用与 cache 命中为自定义属性）；OTLP 导出；两级配置文件（`~/.delta/otel.json` < `.delta/otel.json`）；内容采集三档 off / masked / full；三端接线。
**不做**：metrics/logs 信号（P2）；采样策略高级配置（固定 sample_rate 即可）；自动 instrumentation。

### 4.4 验收标准（AC）

- AC-43-1 标准后端可解析：OTLP 报文被 Jaeger/Tempo 正确渲染 span 树。
- AC-43-2 零开销：未配置 endpoint 时模块不初始化、无导出动作。
- AC-43-3 内容默认不采：off 档下 span 不含任何提示词/补全文本属性。
- AC-43-4 脱敏：masked 档下构造含 AWS key / 私钥块的 fixture，导出内容中不出现明文。
- AC-43-5 导出失败静默（旁路 sink 语义，对齐 F-33 D6），不阻塞引擎；headless 退出前 flush。

---

## 5. F-44 skills.sh / MCP Registry 互通

### 5.1 背景与目标

SKILL.md 格式（frontmatter + 正文）已是社区事实标准（skills.sh 等分发渠道 `npx skills add` 同源）；MCP 官方 registry 上线后 server 发现有了标准入口。delta 已有 SKILL.md 三层加载（F-16）与 skill-hub 客户端（search + download zip + 校验安装），缺的是**通用生态双向互通**。目标：社区技能零转换进出，MCP server 一键装。

### 5.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-44-1 | 用户从社区下载一个 SKILL.md 目录 | `delta skill import <dir>` 校验后装入用户层/项目层，`delta skill list` 可见、对话中可用 |
| US-44-2 | 用户想分享自己写的 delta skill | `delta skill export <name> -o` 产出符合社区标准的包，`npx skills add` 可安装 |
| US-44-3 | 用户要装一个 MCP server | `delta mcp search <kw>` 查官方 registry，`delta mcp install <name>` 展示将写入的配置（dry-run 确认）后写入 mcp.json |

### 5.3 范围

**做**：SKILL.md 导入（frontmatter 校验：delta 超集字段 triggers/tools_allowlist 容忍缺失，映射规则文档化）、导出（目录打包 + manifest）；MCP registry 查询与安装（HTTP API，stdio 传输）；顺手补齐 skill-hub 缺失的成对文档缺口（在拆出的 prd-f44/design-f44 中一并覆盖）。
**不做**：私有 registry 自建服务端；OAuth 型 MCP server 安装（协议预留）；技能评分/排行榜。

### 5.4 验收标准（AC）

- AC-44-1 roundtrip：export → import 后 SKILL.md 语义等价（frontmatter 字段与正文逐段一致）。
- AC-44-2 兼容导入：仅含 name/description 的最小社区技能可导入，triggers 缺省不炸。
- AC-44-3 安全：导入/安装沿用 skill-hub 的 zip-slip 校验与大小上限；scripts/ 目录提醒用户审阅。
- AC-44-4 mcp install：写入前展示 diff 式预览，需确认；写坏不覆盖既有 mcp.json 其他条目（复用 mcp.json 合并语义）。

---

## 6. F-45 成本体检

### 6.1 背景与目标

usage 报表（F-31）回答"花了多少"，不回答"哪些是浪费"。重复读文件、同参重复调用、超长工具结果、该走小模型的路由缺失（F-32 已有机制但无人配置）、cache 命中率低、子代理超卖——这些模式在 usage + 消息记录里都可检出。目标：**每次任务结束能回答"这次浪费了约 ¥X、浪费在哪、怎么改"**。

### 6.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-45-1 | 开发者跑完一个大任务 | `delta cost audit` 给出分项发现（规则、证据、浪费金额）与总额 |
| US-45-2 | 团队负责人想推动大家配路由 | 报告指出"distill 类调用走了主模型且未配置 routing"并给出一条配置命令建议 |
| US-45-3 | Web 用户在用量页 | 看到最近会话的浪费概览卡，点入看明细 |

### 6.3 规则集（R1 版）

| 规则 | 检测逻辑 | 浪费口径 |
|------|----------|----------|
| 重复读同一文件 | read_file 同 path 多次，且期间内容未变（FileChangeStore 判定） | 后续次数 × 单次 input+output 费用 |
| 同参重复调用 | 工具名 + 参数 hash 重复（排除 todo/记忆类） | 重复次数 × 单次费用 |
| 工具结果超长 | 单次工具结果超长阈值且随后被压缩折叠 | 溢出部分 token 费用 |
| 路由缺失 | classify/distill/summarize/subagent kind 走主模型且 routing 未配置 | 主辅模型差价估算 |
| cache 命中率 | 可用时 cache_read / total_input 低于阈值（需 Provider 透传 cache token） | 未命中部分按未折扣价计 |
| 子代理超卖 | task 工具 usage 占会话总用量超阈 | 超出预算份额部分 |

金额估算统一走 `pricing.ts` 单价表；证据必须可点开（工具调用序号 + 参数摘要），避免黑盒报告。

### 6.4 验收标准（AC）

- AC-45-1 每条规则有 fixture 单测（构造 usage+messages），金额计算与 usage 表口径一致（同一 priceFor）。
- AC-45-2 输出：CLI 人类可读 + `--json` 与 API 同构；Web 用量页新增概览卡。
- AC-45-3 无 usage 数据 / 单轮短会话不出报告（避免噪声）；规则阈值可配（`.delta/cost.json`）。
- AC-45-4 cache 规则在 Provider 不透传 cache token 时自动跳过并注明"数据不可用"，不误报。

---

## 7. F-46 中途操控

### 7.1 背景与目标

长任务跑到一半，常见三种诉求：补充指令（"另外把 X 也改了"）、暂停改主意、收紧权限（"只准改这两个文件"）。现状：Web 端已有 pause 雏形（SessionHub），确认流双向通道已通（confirm/answer/plan 端点），但**引擎在轮间没有控制通道**。目标：运行中操控不重启、不丢上下文。

### 7.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-46-1 | 任务运行中用户输入补充指令 | 当前轮不受打断，下一轮把指令作为运行中追加消息注入，带醒目标注 |
| US-46-2 | 用户暂停后修改计划（Plan 模式） | 暂停点安全（无半写文件），恢复后按修改后的计划继续 |
| US-46-3 | 用户说"只准改 a.ts 和 b/" | 立即生效：后续写操作越界走确认流拒绝路径；已挂起的确认请求按新约束重判 |

### 7.3 范围

**做**：引擎轮间 ControlChannel（inject / restrict / pause / resume）；路径限制注入 PermissionState（写类工具 args.path 前置校验）；上行端点 `POST /api/sessions/:sid/control`；TUI 斜杠命令（`/inject`、`/restrict`）与 Web 控制条；`control_applied` 事件回显三端。
**不做**：中断当轮 LLM 流（半截响应作废成本高、收益低，标 P2）；multi 模式 worker 内部注入（只作用主循环与编排层）；headless（非交互无操控语义）。

### 7.4 验收标准（AC）

- AC-46-1 注入不打断当前轮、不重置上下文；注入消息在消息流有明确"运行中追加"标识。
- AC-46-2 restrict 立即生效：对尚未执行的写调用生效；已挂起 confirm 请求若越界，默认拒绝并提示新约束。
- AC-46-3 pause/resume 在 TUI 与 Web 行为一致（Web 已有 pause 的部分，补齐 CLI 对等入口）。
- AC-46-4 操控命令有审计痕迹（消息/事件落库），回放（F-18）可见。

---

## 8. F-47 独立评审模式

### 8.1 背景与目标

delta 会干活，也能当"不知疲倦的同事"做评审：规则来自仓库自己的 AGENTS.md/MEMORY.md（F-41 之后来源统一），输出行级 findings，可一键修，可进 CI。diffLines（F-36）与 headless（F-29）、evals 判分（F-28）都已就绪，缺的是一个**专用形态**。

### 8.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-47-1 | 提交前跑 `delta review --staged` | 每条 finding 有 file:line、severity（blocker/major/minor/nit）、说明与建议 |
| US-47-2 | 对某条 finding 一键修 | 生成修复子任务（带上 finding 上下文）执行并回报结果；不满意可回滚（FileChangeStore） |
| US-47-3 | CI 里 `delta review --check --json` | 存在 blocker 时退出码非 0，JSON 供流水线消费 |
| US-47-4 | 仓库 AGENTS.md 有规范条目 | 评审 prompt 携带这些规则，违规可被检出 |

### 8.3 范围

**做**：`delta review --staged|--range a..b|--paths`；findings 结构化 schema；规则注入（AGENTS.md/MEMORY.md + `.delta/review.json` 聚焦/忽略）；TUI 交互（findings 列表 → 一键修）；CI 模式（exit 0 clean / 1 blocker / 2 错误）；evals review 套件（注入已知缺陷的 fixture 判命中率）。
**不做**：PR 平台集成（拉 PR diff、回评 comment，P2）；自动修复全部 findings 的批处理模式；LLM 评审打分。

### 8.4 验收标准（AC）

- AC-47-1 输出稳定：findings 通过 JSON schema 校验；行号无效/文件不在 diff 范围内的 finding 被过滤并计数告警。
- AC-47-2 误报控制：同文件同问题合并；nit 不触发 CI 失败。
- AC-47-3 规则生效：含"禁止使用 any"类规则的仓库，fixture 中 any 用法被检出。
- AC-47-4 一键修走权限三档与变更快照，修复后可选自动复审该文件。
- AC-47-5 evals：内置 review 套件，基线对比防提示词回归。

---

## 9. F-48 代码符号索引

### 9.1 背景与目标

grep 只能查文本，回答不了"谁引用了这个函数 / 这个类在哪些文件被实例化"。符号与引用图是 F-47 review 精准定位、大仓重构影响面分析的地基。选 **web-tree-sitter（wasm）** 避免原生编译（better-sqlite3 已是唯一原生依赖，不再增加）。embedding 语义搜索可选叠加（F-17 已有 embeddings 管线可复用）。

### 9.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-48-1 | 开发者在大仓里问"改这个函数会影响哪些地方" | `delta symbols query <name>` 返回定义 + 引用列表（file:line），agent 可在对话中直接调用 |
| US-48-2 | 仓库 10k+ 文件 | 首次索引在可接受时间内完成；改一个文件后增量索引秒级 |
| US-48-3 | review 模式 | finding 定位到符号定义/引用（联动 F-47） |

### 9.3 范围

**做**：语言首期 TS/JS/Python/Go/Java；符号定义与引用抽取、SQLite 符号表、按文件 hash 增量索引；`delta symbols index/status/query`；注册为 agent 内置工具（只读类）；可选 embedding（reuse F-17）。
**不做**：跨语言调用图；运行时/动态调用解析；IDE 级实时索引（按会话按需刷新）。

### 9.4 验收标准（AC）

- AC-48-1 每语言 golden 用例（定义/引用/重载/别名）抽取得分达标。
- AC-48-2 增量：单文件变更只重索引该文件；删除文件级联清理。
- AC-48-3 大仓预算：10k 文件首索引有明确时间上限（验收时实测记录），索引不阻塞对话。
- AC-48-4 工具只读、受权限三档管理；语言 grammar 不可用时明确降级提示。

---

## 10. F-49 后台任务队列

### 10.1 背景与目标

cron（F-22）、worktree 隔离（F-37）、桌面通知（F-33）、headless（F-29）四块都已存在，但 cron 是"到点即 spawn"，无队列、无并发控制、无统一任务板。目标：**派活（CLI/Web）→ 排队 → worktree 隔离执行 → 通知回报 →（git suggest）回 PR 的完整闭环**。

### 10.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-49-1 | 开发者派 5 个重构任务 | 任务排队，默认并发上限内逐个执行，各自在独立 worktree，互不干扰 |
| US-49-2 | 任务跑完 | 桌面通知（复用 F-33），Web 任务板看到结果与日志，git 策略 suggest 时给出建议提交 |
| US-49-3 | 进程崩溃重启 | 未完成任务按租约过期回队（复用 F-15b 恢复语义），不重复执行 |
| US-49-4 | 定时任务改走队列 | cron 任务可选入队执行，到点不再直接 spawn |

### 10.3 范围

**做**：jobs 表（SQLite 迁移）；JobRunner（租约领取、并发上限、失败重试上限）；执行器（spawn delta run + worktree 隔离 + 通知回调）；CLI `delta job add/list/show/logs/rm/cancel`；Web `/api/jobs` 端点组 + 任务板视图；cron 目标扩展（direct | queue）。
**不做**：分布式队列（单机即可）；任务依赖 DAG（Plan 引擎内已有）；Web 端实时日志流（先 tail 刷新，SSE 流式 P2）。

### 10.4 验收标准（AC）

- AC-49-1 并发上限可配（默认 2），超额任务状态 queued 不丢失。
- AC-49-2 worktree 任务结束时留有产物路径与变更摘要；worktree 清理策略可配。
- AC-49-3 崩溃恢复：杀进程后重启，running 租约过期任务回队，已完成任务不受影响。
- AC-49-4 任务板：列表/详情/重跑/取消；取消时子进程被终止。
- AC-49-5 cron 入队模式与 direct 模式行为等价（同一执行器最终形态）。

---

## 11. F-50 企业治理层

### 11.1 背景与目标

服务端当前**零鉴权**（仅桌面宿主使用随机 authToken 单值校验），要进企业必须补：SSO 登录、角色权限、审计留痕、团队配额、license。**前提决策（待评审确认）**：部署形态从"纯本机"扩展出"内网服务器多人共用"形态——serve 监听地址可配（默认仍 127.0.0.1），鉴权在该形态下强制开启。

### 11.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-50-1 | 员工用公司 OIDC 登录 Web 控制台 | 授权码 + PKCE 登录；会话过期自动续；CLI 走 device flow 登录 |
| US-50-2 | 管理员分配角色 | admin 管项目/配额；member 跑任务；viewer 只读；矩阵外操作 403 |
| US-50-3 | 安全团队要审计 | 登录/项目/会话/确认决策/配置变更全量 JSONL 落盘，可导出 SIEM webhook |
| US-50-4 | 团队配额 | 项目/用户月度 token 与费用上限，耗尽拒绝新 run 并提示管理员 |
| US-50-5 | 离线企业 | license 文件（Ed25519 签名）过期或缺失时高级能力停用、基础功能可用 |

### 11.3 范围

**做**：OIDC（授权码 + device flow，轻量实现或 openid-client）；JWT 会话中间件；RBAC 三角色 + 端点分组；审计 JSONL（rotate + SIEM webhook sink）；配额存储与前置检查（复用 BudgetManager/UsageStore 聚合口径）；离线 license 验签。
**不做**：自建用户库（身份全部来自 IdP）；SCIM 同步（P2）；细粒度 ACL（项目级角色够用）。

### 11.4 验收标准（AC）

- AC-50-1 未认证请求全部 401；本机默认形态（无鉴权配置）行为不变（向后兼容）。
- AC-50-2 角色矩阵有端点级测试；JWT 过期/篡改被拒。
- AC-50-3 审计写入失败不静默（告警 + 内存缓冲重试），事件含 actor/action/target/结果。
- AC-50-4 配额耗尽：新 run 被拒且进行中 run 可完成（不半途杀）。
- AC-50-5 license 验签：篡改/过期/缺公钥三种异常路径。

---

## 12. F-51 信创私有化

### 12.1 背景与目标

国产化环境三件事：模型可得（GLM/Kimi/MiniMax/豆包/内网 DeepSeek 预设）、安装可得（离线包）、平台可得（麒麟/统信 + 鲲鹏/昇腾 arm64）。delta 的 openai-compatible Provider 与打包链路已具备底座，缺预设、离线组装与适配验证。

### 12.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-51-1 | 用户选国产模型 | `delta models add --preset glm`（kimi/minimax/douban/deepseek-intranet 同理）预填 baseUrl/默认模型/计价，填 Key 即用 |
| US-51-2 | 无外网内网安装 | 离线安装包（npm 离线 tarball + 平台预编译件 + ripgrep 二进制）一键安装，skill-hub/registry/OTel 外呼全关 |
| US-51-3 | 麒麟/统信 + 鲲鹏 | arm64 Linux 安装运行冒烟通过；better-sqlite3 / ripgrep 有 arm64 产物 |

### 12.3 范围

**做**：Provider 预设库（含计价条目扩展 pricing.ts）；离线打包脚本 + 安装文档；air-gapped 模式（环境变量/配置一刀切禁外呼）；内网 OTLP（F-43 的 endpoint 指向内网 collector，验证打通）；linux-arm64 CI job + 麒麟/统信手测清单。
**不做**：昇腾 NPU 推理直连（模型经 API 网关，不涉及本地推理）；国产 OS 桌面通知深度适配（notify-send 已覆盖 best-effort）；信创认证申报。

### 12.4 验收标准（AC）

- AC-51-1 预设连通性测试通过（逐预设记录验证日期与模型版本）。
- AC-51-2 离线环境（断网沙箱）安装 → 建会话 → 国产模型对话 → 内网 OTLP 导出全链路冒烟通过。
- AC-51-3 air-gapped 模式下无任何外呼（断网沙箱实测，DNS/连接零请求）。
- AC-51-4 linux-arm64 CI 绿；麒麟/统信手测清单归档 docs。

---

## 13. F-52 安全护栏

### 13.1 背景与目标

Agent 的攻击面在"内容进出"：模型可能把密钥写进命令、抓取的网页可能携带注入、MCP server 可能被替换、提交可能带密钥。hooks 系统（F-27）已提供 PreToolUse 阻断语义，但用户自写 hook 门槛高。目标：**内建一层默认合理的护栏，挂钩最快路径，无需用户配置即生效**。

### 13.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-52-1 | 模型试图把疑似密钥写进文件/命令 | standard 档：拦截并提示；strict 档：一律阻断 |
| US-52-2 | 已安装的 MCP server 工具清单变了 | 事件告警（Web + 通知）；strict 档直接拒绝调用未在锁定清单内的工具 |
| US-52-3 | hooks.json/mcp.json 被意外修改 | 首次信任锁定后，变更需确认才生效 |
| US-52-4 | git auto 提交 | 提交前扫描 staged diff，命中密钥阻断提交并报告位置 |

### 13.3 范围

**做**：内建护栏检查器（已知模式 + 熵检测，零新依赖）挂在 registry 工具执行管线（PreToolUse 之后、执行之前，独立于用户 hooks.json）；出站内容扫描（web_fetch 结果、run_command 命令串、write/edit 内容）；MCP 工具清单快照与变更告警；配置信任锁定（`~/.delta/trust.json` 哈希）；提交前 staged diff 扫描（git auto 策略内嵌）；档位 `off / standard / strict`（`.delta/guard.json`，默认 standard）。
**不做**：gitleaks 等外部扫描器集成（接口预留）；进程级 EDR 类防护；提示词注入的语义级检测（先模式级）。

### 13.4 验收标准（AC）

- AC-52-1 漏报/误报基准：密钥 fixture 集（AWS/GitHub/私钥/随机熵）检出率达标，普通文本（uuid、base64 图片、哈希值）误报率可控（实测记录）。
- AC-52-2 性能：单次检查 < 5ms，不出现在工具耗时热点。
- AC-52-3 与用户 hooks 共存：护栏不占 hooks.json，用户 hook 先行、护栏兜底，两者都可阻断。
- AC-52-4 off 档完全旁路（零开销）；strict 档 deny-by-default 行为文档化。

---

## 14. F-53 Windows 原生沙箱

### 14.1 背景与目标

Seatbelt 仅 macOS，Windows 当前只有 Docker 可选后端与提示级兼容。目标：Windows 用户提供开箱可用的隔离档位。三个候选：AppContainer（隔离强、工程量大、需额外工具链）、Job Object（仅资源限制，无文件系统/网络隔离，不满足安全档位）、WSL2（强隔离，复用现有 SandboxExecutor 抽象）。**建议裁决：WSL2 为主，spike 一周验证后定稿**。

### 14.2 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-53-1 | Windows 用户启用沙箱 | `delta sandbox enable` 后端显示 wsl，命令经 WSL 执行，逃逸用例全拒 |
| US-53-2 | 无 WSL2 环境 | 明确提示安装路径，降级 docker 或关闭（不静默） |

### 14.3 范围

**做**：Spike（1 周）：wsl.exe 探测、命令包装、路径翻译（/mnt/…）、项目在 NTFS 盘 vs WSL 文件系统的性能与语义差异、stdin/stdout/信号透传 → 可行性报告；随后实现 WslExecutor（实现 SandboxExecutor 接口）、`delta sandbox status` 后端展示、逃逸用例套件复用 F-30 golden。
**不做**：AppContainer（裁决不做，理由见设计文档）；Job Object（不作为隔离档位，资源限制另立小项可后置）。

### 14.4 验收标准（AC）

- AC-53-1 spike 报告给出三选一最终裁决与依据（性能数据 + 逃逸测试结果）。
- AC-53-2 Windows 10 21H2+ / 11 实机冒烟：enable → 高危命令被隔离执行 → 逃逸用例零逃逸。
- AC-53-3 无 WSL 时降级路径明确（docker / off），`sandbox status` 如实展示。

---

## 15. 待确认问题

| # | 问题 | 倾向 |
|---|------|------|
| 1 | F-42 ACP 是否引入官方协议库 vs 手写 JSON-RPC | 手写（协议面小、依赖少），详见设计文档 D42-1 |
| 2 | F-45 cache 命中率需 Provider 透传 cache token（StreamEvent 扩展 + usage 表加列），是否随 R1 做 | 是，只改 anthropic + openai-compatible 两家即可覆盖主力 |
| 3 | F-50 部署形态：内网多人共用 serve 是否立项 | 影响 F-50 全部范围，需产品拍板；若不做，F-50 缩水为"审计 + license" |
| 4 | F-48 语言首期范围（TS/JS/Python/Go/Java 五门）是否收敛 | 可先 TS/JS + Python 三门，Go/Java 看用户反馈 |
| 5 | F-51 信创的优先驱动：真实客户需求 or 前瞻储备 | 决定 R3 排期松紧 |
