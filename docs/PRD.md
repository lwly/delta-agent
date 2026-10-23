# y-zero-agent 产品需求文档（PRD）

> 版本：v1.0 ｜ 日期：2026-10-21 ｜ 状态：待评审
> 产品名称：y-zero-agent —— AI 编程命令行工具（AI Coding Agent）

---

## 1. 产品概述

### 1.1 一句话定位

y-zero-agent 是一个基于 TypeScript 开发的 AI Coding Agent，以 CLI 为核心入口、Vue Web 控制台为可视化前端，支持 **ReAct / Plan-and-Execute / Multi-Agent** 三种执行模式，通过 MCP 协议动态扩展工具能力，帮助开发者在终端与浏览器中完成编码、调试、重构等软件工程任务。

### 1.2 背景与机会

- 开发者已在终端中度过大量工作时间，现有 AI 编程工具要么是 IDE 插件（离开 IDE 能力受限），要么是纯 CLI（可视化与历史管理薄弱）。
- 多模型（Claude / GPT / DeepSeek / Qwen / 本地模型）快速演进，用户需要**模型无关**的接入层，而非绑定单一厂商。
- 工具生态碎片化：MCP（Model Context Protocol）正在成为工具接入事实标准，先支持 MCP 动态扩展的产品具备生态卡位优势。
- 长会话场景下上下文爆炸是普遍痛点，**自动上下文压缩 + 三层记忆**是核心差异化能力。

### 1.3 产品目标

| 目标 | 衡量指标 |
|------|----------|
| 完整任务闭环率 | 在 SWE-bench-like 本地任务集上端到端完成率 ≥ 60%（P1） |
| 上下文压缩有效性 | 长会话累计等效压缩率 70%–80%（单次 80%→55%），任务成功率下降 ≤ 5% |
| 多模型一致性 | 同一任务在不同 Provider 下工具调用解析成功率 ≥ 99.5% |
| 跨平台体验 | Windows / macOS 一条命令安装，功能无差异 |
| 会话可管理性 | 多项目 × 多对话，历史可检索、可恢复、可回放 |

### 1.4 目标用户

1. **主力用户**：日常使用终端的全栈/后端开发者（个人开发者、小团队）。
2. **次级用户**：需要批量处理代码任务、跑自动化 Agent 流程的效率工具玩家。
3. **扩展用户**：希望通过 MCP/Skills 定制私有工具链的进阶用户。

### 1.5 核心价值主张

- **三种执行模式**按需切换：快问快答用 ReAct，复杂任务用 Plan-and-Execute，大型工程用 Multi-Agent。
- **工具生态开放**：内置 11 个核心工具 + MCP 动态扩展 + Skills 技能包。
- **长对话不失控**：预算管理 + 自动上下文压缩。
- **CLI + Web 双形态**：终端里干活，浏览器里管理项目与会话。

---

## 2. 用户故事

| 编号 | 角色 | 故事 | 验收标准 |
|------|------|------|----------|
| US-01 | 开发者 | 我在终端输入自然语言需求，Agent 自动读写代码完成任务 | 任务完成后输出变更文件清单与 diff 摘要 |
| US-02 | 开发者 | 我可以为不同仓库分别创建"项目"，互不干扰 | 项目级配置（模型/提示词/工具）相互隔离 |
| US-03 | 开发者 | 在同一项目下开多个对话，分别处理不同任务 | 对话历史独立保存、可切换、可恢复上下文 |
| US-04 | 开发者 | 复杂重构任务我希望 Agent 先规划再执行 | Plan-and-Execute 模式先生成计划，逐步执行并汇报 |
| US-05 | 开发者 | 大型任务我希望多个子 Agent 分工协作 | Multi-Agent 模式展示子 Agent 分工与汇合结果 |
| US-06 | 进阶用户 | 我接入自己的 MCP Server 扩展工具 | 配置后工具自动出现在工具列表，可被模型调用 |
| US-07 | 进阶用户 | 我把常用工作流沉淀为 Skill 复用 | Skill 可被 `skills` 命令列出、加载、在对话中触发 |
| US-08 | 开发者 | 会话太长时我不希望手动清理上下文 | 超过阈值自动压缩，并明确告知压缩了什么 |
| US-09 | 开发者 | 我可以限制本次任务的 token/费用预算 | 预算耗尽时安全停下并给出摘要 |
| US-10 | 开发者 | 我在浏览器中查看/管理所有项目与会话 | Web 控制台支持项目、对话、模型配置管理 |
| US-11 | 开发者 | 我可以随时切换底层模型（含流式输出） | 基于 SSE 的流式响应，ToolCall 分片正确累积解析 |
| US-12 | 团队成员 | Windows 与 macOS 上体验一致 | 两平台 CI 均通过 E2E 冒烟测试 |
| US-13 | 开发者 | 我可以删除不再需要的会话 | 删除前二次确认；默认软删除可从回收站恢复；删除后上下文立即释放 |
| US-14 | 开发者 | 我可以移除整个项目（含其下所有会话） | 二次确认需输入项目名；项目配置保留但会话按软删除策略处理；MCP/Skills 项目级配置一并停用 |
| US-15 | 开发者 | 我可以配置多家模型服务（API Key / Base URL / 参数）并随时切换 | Web 设置页与 CLI 均可增删改查 Provider；Key 本地加密存储不回显；保存前可一键连通性测试；配置即时生效到新对话 |
| US-16 | 开发者 | 我习惯直接敲 Markdown（代码块/列表/加粗），不想被工具栏打扰 | 输入框隐形支持 Markdown：无工具栏、无预览按钮，按自然语法输入即可；发送后消息流按 Markdown 渲染（代码块高亮 + 复制按钮，表格/任务列表支持） |
| US-17 | 开发者 | Agent 能记住我的偏好和项目经验，下次对话不用重复交代 | 三层记忆：短期（会话内）+ 动态（SQLite，个人偏好/经验，评分召回）+ 静态（MD 文件，项目规则，git 共享）；记忆可查看/编辑/停用，自动提炼需确认后入库 |

---

## 3. 功能需求

### 3.1 功能架构总览

```
y-zero-agent
├── A. Agent 执行核心
│   ├── A1 ReAct 主循环引擎（含预算管理、自动上下文压缩）
│   ├── A2 Plan-and-Execute 模式
│   └── A3 Multi-Agent 模式
├── B. 模型接入层
│   ├── B1 多 Provider 适配（SSE 流式）
│   └── B2 ToolCall 分片累积解析
├── C. 工具体系
│   ├── C1 11 个内置核心工具
│   ├── C2 MCP 动态扩展
│   └── C3 多工具并行执行
├── D. 提示词体系
│   ├── D1 7 层系统提示词组装架构
│   └── D2 三级覆盖机制
├── E. 上下文管理
│   ├── E1 Token 预算管理
│   └── E2 上下文压缩引擎（80% 触发 / 55% 目标，累计 70%–80%）
├── F. Skills 技能系统
├── G. 会话与项目管理（多项目 × 多对话）
└── H. 前端 Web 控制台（Vue 3）
```

### 3.2 需求池（P0 / P1 / P2）

#### P0 —— MVP 必须交付

| 编号 | 需求 | 描述 |
|------|------|------|
| F-01 | ReAct 主循环引擎 | Thought → Action → Observation 循环；每轮注入剩余预算；异常（工具报错/解析失败）可自愈重试（上限可配） |
| F-02 | Token 预算管理 | **会话级为主**（默认 200k tokens / ¥5，超限可临时追加）；任务级预算为可选开关（默认关闭）；每轮循环前检查；耗尽时优雅终止并输出摘要 |
| F-03 | 自动上下文压缩 | 达到阈值（默认窗口 80%）自动触发，压缩后控制在 55% 左右；保留系统提示词、最近 6 轮原文、滚动摘要；工具结果 >4000 字截断；长会话累计等效压缩率 70%–80% |
| F-04 | SSE 多模型接入层 | Provider 抽象 + **4 家实现**（Anthropic / OpenAI 兼容 / DeepSeek / Qwen），随 M2 全量交付；统一 SSE 事件模型；断流重连 |
| F-04a | 大模型配置管理 | Provider 配置增删改查：名称、类型（anthropic / openai-compatible / deepseek / qwen…）、Base URL、API Key、默认模型、参数（temperature / max_tokens / top_p）；Key 经系统钥匙串或本地加密文件存储、界面不回显；保存前连通性测试；支持配置启停与排序（决定下拉列表顺序）；CLI `agent models` 与 Web 设置页双入口 |
| F-05 | ToolCall 分片累积解析 | 流式 delta 中 tool_call 分片按 index 累积拼接，结束时统一校验 JSON；兼容不同厂商分片格式差异 |
| F-06 | 11 个内置核心工具 | 见 §3.3 工具清单；M3 已扩展至 13 个（+load_skill / unload_skill）；✅ 记忆里程碑再加 save_memory / recall_memory 至 15 个（2026-10-22 交付）；✅ F-26 子代理工具再加 task 至 16 个（2026-10-22 交付） |
| F-06a | 三层记忆系统 | L1 短期（会话消息列表）；L2 长期动态记忆（SQLite：SHA256 去重 → 配额检查 → FIFO+importance 淘汰的写入管线；词汇覆盖率 72%+重要性 12%+置信度 8%+时间衰减 6%+访问频率 2% 的召回评分）；L3 长期静态记忆（MEMORY.md/.y-zero/agent.md，团队共享、git 版本追踪）；工具再扩展 +2（save_memory / recall_memory，至 15 个）；自动提炼默认开启（可关闭），候选进"待确认"队列防记忆污染；Web 提供记忆管理面板（查看/编辑/停用/待确认）。详见 docs/memory-design.md |
| F-07 | MCP 动态扩展 | stdio + SSE 两种 MCP transport；`agent mcp add/list/remove`；MCP 工具与内置工具统一注册 |
| F-08 | 多工具并行执行 | 模型单轮返回多个 tool_call 时并行执行（Promise.allSettled），结果按序回填 |
| F-09 | 7 层系统提示词组装 | 见 §3.4；启动时组装一次，工具/技能变更时增量重组装；静态段（人格/准则/项目/工具）hash 缓存复用并对齐 Provider prompt cache 前缀，动态段（时间/模型/记忆/Skill 索引）每轮注入，模式提示词（Plan/ReAct/Team）最后追加。详见 docs/prompt-design.md |
| F-10 | 三级覆盖机制 | 内置默认 < 项目级（`.y-zero/` 目录） < 对话级（运行时覆盖），逐层 merge |
| F-11 | 多项目 × 多对话 | 项目注册/切换；项目下多对话；对话持久化（本地存储），可恢复继续 |
| F-11a | 项目/会话移除 | 会话删除（CLI `agent session rm` + Web 右键/悬浮删除）默认软删除（回收站保留 30 天，可彻底清除）；项目移除需输入项目名二次确认，级联软删除其下会话；正在运行的会话先中止再删除；软删除数据不参与上下文与检索 |
| F-12 | Vue Web 控制台 | 项目管理、对话管理、对话可视化（含工具调用卡片）、模型配置、记忆面板；**纯本地部署**：静态资源内嵌 CLI 包 + `agent serve` 本地 server（默认 127.0.0.1:7900） |
| F-12a | 输入框隐形 Markdown | 输入框保持极简（无工具栏/预览 UI），Markdown 语法透明生效：`**粗**`、`` `码` ``、` ``` 代码块 ``` `、`- 列表`、`> 引用`、`[链接](url)` 等按原样输入；发送后消息流以 markdown-it 完整渲染（DOMPurify 消毒、代码块高亮 + 一键复制）；`@文件` 引用与 Markdown 语法共存 |
| F-13 | 跨平台支持 | Windows 10+ / macOS 12+；路径、shell、信号处理差异抹平；npm 全局安装即用 |

#### P1 —— 第二迭代

| 编号 | 需求 | 描述 |
|------|------|------|
| F-14 | Plan-and-Execute 模式 | 简单任务检测路由（规则+LLM 兜底，`/plan`/`/direct` 可强制）：简单直达，复杂 LLM 规划 → 生成 DAG → 拓扑排序 → 按层并行执行 → 汇总；计划卡可编辑/调整依赖后确认；节点失败可标 critical 终止。详见 docs/agent-modes-design.md §3——✅ 2026-10-23 增量补齐：TUI 新增 `/plan` / `/direct` / `/auto` 斜杠命令（一次性强制路由，ReAct 模式下提示切换）；plan/multi 模式编排段（分类/规划/审查/汇总）用量入账（此前费用口径缺失该部分） |
| F-15 | Multi-Agent 模式 | 四角色闭环：编排器（纯调度）→ 规划者（产出 DAG，可按反馈调整）→ 执行者并行工作池（节点级隔离上下文）→ 检查者（质量检查，不通过返回规划者或重试，上限可配默认 2）；**完整角色集为四层十角色**（决策/执行/质量/协调层），MVP 实现核心五角色（Orchestrator/Planner/Worker/Reviewer/Verifier），Researcher/Writer/Tool Caller/Memory Keeper/Router 按任务类型动态启用。详见 docs/agent-modes-design.md §4——✅ 2026-10-23 增量交付（代码核验）：multi-agent 接入 F-14 计划确认流（规划后 approve / edit（validatePlan 校验，非法回退原计划）/ reject 取消执行；hub 与 TUI 双端接线，TUI 拒绝语义=取消本次任务）；编排层用量入账闭环（planner/classifier/reviewer/summarize 增 onUsage 回调 → settleUsage 统一 record 预算 + 发 usage 事件，worker 用量经泵截获累计，done.usage 真实反映整轮用量）；修复子任务内层 done/error/budget_exhausted 外传导致消费端误判运行结束的问题；单测 8 例（orchestrator.test.ts：审批四路 + 确认流故障降级 + 用量入账 + 生命周期过滤） |
| F-15a | Worker Pool 并行调度 | 共享任务队列，多 worker 竞争领取（默认 4，可配 1–8）；审查失败任务回队首重新排队；节点状态以事件流推送 CLI/Web。详见 docs/agent-modes-design.md §5 |
| F-15b | 后台任务可靠恢复 | 任务状态机（queued/running/completed/failed/canceled）持久化 SQLite；租约 60s + 心跳 15s 防重复执行；启动时扫描孤儿任务（租约过期）回队列重排；checkpoint 幂等重试。详见 docs/agent-modes-design.md §6 |
| F-16 | Skills 系统 | **三层覆盖**：内置 < 用户级 ~/.y-zero/skills < 项目级 .y-zero/skills（同名覆盖，离项目越近优先级越高）；包结构 SKILL.md + references/ + scripts/ 按需加载；**两阶段加载**：索引常驻 Prompt → `load_skill` 工具读取全文写入跨轮次缓冲区 → 下一轮注入生效（工具扩展至 14 个）；**匹配评分**：精确命中 +10000、名称×12、标签×6、描述×2，滑动窗口中文分词提高召回。详见 docs/agent-modes-design.md §7 |
| F-17 | 对话检索 | 全文/语义搜索历史对话——✅ 2026-10-22 交付：SQLite FTS5 全文索引（中文 bigram 预分词，随写入同步 + 存量懒回填 + 硬删级联清理）+ 语义向量（OpenAI 兼容 /embeddings，Float32 BLOB 入库，余弦相似度，模型切换自动重建）；RRF 混合排序，embedding 不可用自动降级全文；`yzero search` 子命令 + TUI `/search` + `GET /api/search/messages` + Web 项目页消息命中列表（含片段与命中方式标注） |
| F-18 | 会话回放 | 以时间线回放一次任务的完整执行轨迹（含工具调用）——✅ 2026-10-22 交付：按 user 消息切分任务边界，GET /runs 与 /runs/:index，Web 回放页（任务列表 + 时间线 + 工具调用/结果按 callId 配对），CLI/Web 入口 |

#### P2 —— 远期

| 编号 | 需求 | 描述 |
|------|------|------|
| F-19 | 远程会话同步 | 会话云端同步，多设备续接 |
| F-20 | 团队协作 | 项目/会话共享，权限管理 |
| F-21 | 插件市场 | MCP Server 与 Skill 的一键安装市场 |
| F-22 | 定时任务/自动化 | Agent 任务的 cron 调度——✅ 2026-10-23 交付（代码核验）：core/cron 内核（5 字段 cron 解析 + nextRun 纯函数本地时区 / `~/.y-zero/cron.json` 存储（CRUD + tmp+rename 原子写 + 坏 JSON 拒写降级 + 运行历史 20 条滚动）/ 到期执行编排（runningSince 跨进程运行锁 + 崩溃残留 24h 自动解除 + 失败隔离 + 补跑语义）/ 常驻 tick 调度循环（busy 保护 + signal 停止））+ CLI `yzero cron list/add/remove/enable/disable/run/daemon`（daemon 支持 `--once` 配合系统 cron）+ 默认执行器 spawn `yzero run --json` 子进程完全隔离（超时 30min SIGTERM 记 timeout，输出解析失败收敛 error）；单测 36 例（parse 15 / store 9 / runner+scheduler 12）+ 隔离 HOME 端到端冒烟；✅ Web 调度面板（2026-10-23 增量）：/api/cron 端点组（清单/增改删/立即运行 202+锁轮询，cronHomeDir 注入隔离，snake_case 传输）+ 工作台「⏰ 定时」CronModal 弹窗（任务卡/新增/启停/删除二次确认/立即运行轮询/运行历史），与 CLI 共用 ~/.y-zero/cron.json 与 spawn 执行器，端点单测 6 例 + serve 冒烟；详见 docs/design-f22-cron.md |
| F-23 | 权限模式体系 | 三级模式：`plan`（只读，禁写禁执行）/ `default`（写需确认）/ `yolo`（全放行，双重开启）；工具级 allowlist 规则 + "本会话不再询问"；Web/CLI 统一确认协议——✅ 已交付（代码核验 2026-10-22：PermissionState 三级模式 + allowlist + sessionAllowed 记忆） |
| F-24 | 文件变更管理 | 每次写操作前自动快照（checkpoint）；会话级 diff 汇总；一键回滚到任意检查点；git 集成（建议分支/自动 commit 策略）——与 agent-modes-design §6 任务恢复 checkpoint 打通——✅ 已交付（代码核验 2026-10-22：FileChangeStore + `/changes` + `/rollback` + git suggest/auto 策略） |
| F-25 | 多模态输入 | 消息支持图片附件（截图报错/UI 走查），视觉模型透传；图片 token 计价与压缩策略——✅ 2026-10-22 交付：`ChatMessage.images`（png/jpeg/gif/webp 魔数嗅探防伪造后缀）；压缩策略：单张 ≤4MB、单条 ≤5 张（超限拒绝并提示，不做有损重编码避免原生图像库依赖）；token 计价按「封顶面积/750」（长边 1568px 封顶，≈Anthropic 口径；无尺寸时按原始字节退化估算并封顶 1600）；Provider 透传：Anthropic content block（`image` + base64 source）/ OpenAI 兼容 content parts（`image_url` data URL，覆盖 openai/deepseek/qwen）；三端入口：CLI `/image <路径...>` 暂存随下一条消息发送、Headless `yzero run --image <path>`（可重复）、Web 聊天输入区 🖼 附件（前端预览/预检 + 服务端二次校验）；附件随 user 消息整体 JSON 落库（messages.content_json，无需 Schema 迁移）；预算/压缩自动计入图片 token；单测 18 例（嗅探/尺寸解析/计价/校验/双 Provider 映射/token 估算） |
| F-26 | 子代理即工具（Task 工具） | 主循环中模型可自主派生隔离子代理执行探索/搜索类任务，结果摘要回填主上下文（区别于 Multi-Agent 的引擎级编排）——✅ 2026-10-22 交付：`task` 内置工具（16 个）；子代理复用 ReAct 主循环（预算/压缩/自愈同源），上下文隔离（独立消息循环、历史不落主会话）、工具隔离（RestrictedRegistry 只读白名单 read/list/glob/grep/web_fetch/todo + plan 权限模式双保险）、成本隔离（独立 BudgetManager + 用量回写父预算保持会话费用口径完整）、深度上限（子代理不可再派生）；无确认流/无交互（ask 自动应答）；三端注入（TUI App / Web Hub / Headless run）；最终汇报截断 4000 字回填，meta 带 turns/tool_calls/usage；单测 7 例（回填、只读强制不落盘、未注入降级、深度上限、脚本耗尽） |
| F-27 | Hook 系统 | 生命周期钩子：PreToolUse / PostToolUse / SessionStart / SessionEnd / Stop；用户注入自定义逻辑（保存前 lint、禁改 main、结束后跑测试）——✅ 2026-10-22 交付：配置 `~/.y-zero/hooks.json`（用户级）+ `.y-zero/hooks.json`（项目级，两级都执行用户先项目后），`{hooks:[{event,tool?,command,timeout_ms?}]}`；事件上下文以 JSON 写入钩子 stdin（event/session_id/project_id/tool/args/result）；退出码语义：PreToolUse exit 2=阻断（stderr 回传模型为 hook_blocked，调整方案引导）其余非 0 与超时=告警放行，PostToolUse/生命周期仅记录永不影响主流程；注册表接线（PreToolUse 在权限判定前、PostToolUse 旁路异步）；生命周期：TUI（挂载/每轮 finally/卸载）、Web Hub（会话首跑/每轮 finally）、Headless run（起止）三端触发；`yzero hooks` 查看配置；钩子输出观察口接 CLI stderr 告警；单测 17 例（加载合并/匹配/阻断/payload/超时/注册表集成） |
| F-28 | Evals 评测体系 | 本地任务基准集；多 Provider 横向对比报告；提示词/压缩参数变更后的回归保护——✅ 2026-10-22 交付：内置基准集 `builtin-core`（5 用例：算术/文件读取/目录检索/纯文本禁工具/组合任务）+ 自定义 JSON 套件（`--suite`，`.y-zero/evals/suite.json` 自动发现）；确定性判分 7 种 checks（completed/result_contains/result_not_contains/tool_used/tool_used_any/tool_not_used/no_tools + max_turns/max_cost_usd 上限），无 LLM 评审保证回归对比可复现；复用 F-29 headless 内核逐用例隔离运行（独立会话/预算/权限状态）；`yzero evals list/run/baseline`——run 支持多 Provider 横评（`--provider a,b,c` → 对比表 + 综合最优标注，`--only/--tag` 过滤，`--output` 落 Markdown）；回归保护：`baseline --save` 存基线（.y-zero/evals/baseline.json，逐用例通过状态）+ `baseline --check` 逐用例对比（通过→失败即回归，退出码 1 供 CI 拦截；改进/新增/移除分别标注）；单测 19 例（判分/运行器/套件校验/报告/基线往返与回归检测）；顺带修复 CLI 根命令与子命令同名选项（--model/--provider/--db）被父级遮蔽丢失的问题（enablePositionalOptions） |
| F-29 | Headless / SDK 形态 | 非交互运行 `agent -p "任务" --json`；退出码协议；结构化输出，供 CI 流水线与脚本集成——✅ 2026-10-22 交付：`yzero run "任务"`（裸任务 `yzero "任务"` 自动路由，`-p/--prompt` 等价）；`--json` 输出单份 snake_case JSON 报告（result/usage/tool_calls/todos/denied_confirmations/error/exit_code）；退出码协议 0 成功 / 1 配置错误 / 2 引擎致命错误 / 3 达最大轮次 / 4 预算耗尽 / 5 SIGINT 中断；非交互语义：高危确认自动拒绝（记录在案）、ask_user 自动应答、计划自动批准，写任务放行用 `--allow`/`--permission yolo`；`--output` 落文件、`--max-cost` 费用预算、`-r` 续会话、git auto 策略成功后自动提交；内核 `packages/core/src/headless.ts` 不触碰 stdio，可作 SDK 复用，单测覆盖 5 种状态 × 退出码映射 |
| F-30 | 容器级沙箱 | `run_command` 可选沙箱执行模式，隔离高危命令（现有白名单+确认之外的增强）——**方案 C（2026-10-23 裁定）**：macOS 原生 Seatbelt（sandbox-exec）为主隔离后端，Docker 保留为可选后端；配置 `{"mode":"seatbelt"}` 即启用。已交付：内核（配置/探测/参数组装/执行器/降级编排 + SeatbeltExecutor）、headless sandbox 上报段、工具接线测试（Z1 golden 逐字符一致 + AC-30-4 逃逸零调用 + run_tests 历史口径锁定）、`yzero sandbox status/enable/disable/pull/gc` 子命令组（enable/disable 原子写只改 mode）、三端徽标（CLI 工具卡片 🛡 / Web 实时 SSE 徽标（历史回看不显示，R8）/ headless JSON sandbox 段）；挂起：Docker 集成测试（等有 Docker daemon 环境再补，单测已用 Fake 端口全覆盖） |
| F-31 | 成本与用量报告 | 按项目/会话/模型的费用统计面板；预算分级告警（现有 session 级预算之上）——✅ 2026-10-23 交付（代码核验）：v3 迁移（usage 表补 model/created_at 并回填，session/migrations.ts）+ 聚合查询层 UsageStore（summary 按 totals/byProject/byModel 三路聚合 + bySession 逐会话明细，range today/7d/30d/all 归一化、软删除沉没成本口径，session/usage.ts）+ 双端点 GET /api/usage/summary、/api/usage/sessions（server/http.ts）+ Web 用量面板（范围切换/项目筛选/总览卡/三分组占比条，web UsageView.vue + /usage 路由）+ `yzero usage`（--range/--project 支持 id 或名称/--json 与 API 同构，cli/usage.ts）+ 预算分级告警 BudgetManager.takeAlert() 50/80/100 一次性状态机（record 后立即判定，react.ts 发 budget_alert）三端消费（TUI app.tsx / headless-run.ts / Web chat.ts）+ hub 逐轮落库带 model；单测 usage.test.ts 16 例 + budget takeAlert 7 例 + react 事件 3 例 + smoke-web 2 例；详见 docs/design-f31-cost-report.md |
| F-32 | 模型路由 | 按任务难度自动选模型：分类/提炼/摘要用小模型，规划与执行用大模型；可配路由规则——✅ 2026-10-23 交付（代码核验）：ModelRouter（resolve(kind)/config，规则存 ~/.y-zero/models.json routing 字段，KNOWN_TASK_KINDS distill/classify/summarize + 任意扩展 kind，异常/缺配置一律返回 undefined 回退主模型，llm/router.ts）+ 规则存取 ProviderManager.getRouting/setRouting（写入校验 model 非空，与 provider CRUD 同文件互不覆盖，llm/manager.ts）+ hub 运行时接线 routeAux(kind)（provider 构建失败捕获回退，server/hub.ts），distill 接入点（done 分支记忆提炼走小模型；压缩/规划/执行按决议 #10 固定主模型不路由）+ CLI `models routing/routing-set/routing-remove/routing-on/routing-off` 五子命令（cli/src/index.ts）+ serve 装配；单测 router.test.ts 9 例（含规则容错与 ProviderManager CRUD 共存）；classify/summarize 运行时接入点与 Web 设置页路由卡片为设计预留位，详见 docs/design-f32-model-routing.md |
| F-33 | 桌面通知 | 长任务完成、需人工确认时系统级通知（macOS 通知中心 / Windows 通知）——✅ 2026-10-23 交付：DesktopNotifier（macOS osascript / Windows PowerShell BalloonTip / Linux notify-send，其它平台 no-op）+ 两级配置（~/.y-zero/notify.json < .y-zero/notify.json：enabled/onDone/onConfirm/minDurationMs 默认 30s 防噪）+ 三端接线（TUI App / Web SessionHub / Headless run）+ `yzero notify status/enable/disable/test`；旁路 fire-and-forget（detached spawn、10s 超时强杀、失败静默），引擎零改动；详见 docs/design-f33-desktop-notify.md |
| F-34 | 项目 onboarding | 新项目首次启动自动扫描：生成项目摘要、目录结构、初始静态记忆，引导确认——✅ 2026-10-23 交付：ensureProject 带 `created` 标记三端自动触发（TUI/serve 后台、headless 同步）+ scanProjectLayout 只读扫描（限深限条、跳过噪声目录）+ 一次 LLM 调用生成草案（.y-zero/agent.md.draft / MEMORY.md.draft + 状态 .y-zero/onboarding.json）+ `yzero onboarding status/run/confirm/skip`（confirm 目标存在绝不覆盖，提示手工合并）；失败静默状态留 pending 可重试，`auto:false` 可关；详见 docs/design-f34-project-onboarding.md |
| F-35 | Schema migration | SQLite 版本升级的数据迁移机制（migrations 目录 + 版本号管理）——✅ 2026-10-22 交付：`session/migrations.ts` 迁移列表（version/name/sql），版本号存 `PRAGMA user_version`，每迁移独立事务原子生效，SQL 强制幂等使空库与历史库收敛到最新；打开数据库自动执行，版本高于程序支持时拒绝打开防降级写坏；`yzero migrate` 核对版本与迁移历史；v1 baseline 核心表 + v2 F-17 检索索引 |
| F-36 | CLI TUI 细节 | diff 彩色渲染、任务进度条、流式输出光标、主题适配——✅ 2026-10-23 交付：行级 diff 生成（core diffLines LCS + compactDiff 上下文折叠/截断，超大文件降级占位，单测 8 例）+ DiffView 彩色渲染（edit/write 工具结果自动附 diff，取 FileChangeStore 快照；edit_file 确认卡新旧内容彩色对照）+ 运行状态行动态化（盲文 spinner + 当前轮次 + 有限 maxTurns 进度条 + tokens/费用）+ todo_write 后即时 N/M 进度 + 流式光标（assistant/thinking 尾部 ▋，运行结束收起）+ thinking_delta 可见（暗色流式块，不入库）+ 主题集中（ui/theme.ts 语义色 token + 图标常量，NO_COLOR 全色降级，零新增依赖）；详见 docs/design-f36-cli-tui.md |
| F-37 | git 分支切换 + Worktree 会话级隔离 | 底栏三段式「项目名 + 当前分支 + Worktree 开关」（TUI `/branch`、`/worktree` 与 Web 底栏双端一致）：分支选择为**会话内 checkout**（影响当前会话工作根，非全局切换）；勾选 Worktree 自动 `git worktree add` 独立目录（仓库外 `../<repo>.worktrees/<sessionId8>`）并切换会话工作根，可随时切回主工作区；核心逻辑落 core WorktreeManager 双端复用；运行中禁切、脏工作区禁 checkout、沙箱/权限/沙箱根随工作根联动、GitPolicy 与 F-24 变更管理跟随当前工作根；详见 docs/prd-f37-git-worktree.md |

> 注：F-23~F-26 虽列 P2，但其中权限模式（F-23）与文件变更管理（F-24）对日常使用影响较大，若评审认为必要可提前至 P1。

### 3.3 内置 11 个核心工具清单

| # | 工具名 | 职责 | 关键参数 |
|---|--------|------|----------|
| 1 | `read_file` | 读取文件（支持行号范围） | path, offset, limit |
| 2 | `write_file` | 写入/覆盖文件 | path, content |
| 3 | `edit_file` | 精确字符串替换编辑 | path, old_string, new_string |
| 4 | `list_dir` | 列目录树（深度可配） | path, depth |
| 5 | `glob_search` | 按模式匹配文件 | pattern, path |
| 6 | `grep_search` | 正则内容搜索（基于 ripgrep） | pattern, path, glob |
| 7 | `run_command` | 执行 shell 命令（白名单+确认机制） | command, cwd, timeout |
| 8 | `run_tests` | 探测并运行项目测试 | filter |
| 9 | `web_fetch` | 抓取网页转 Markdown | url |
| 10 | `todo_write` | 维护任务清单（计划可视化的最小闭环） | todos[] |
| 11 | `ask_user` | 向用户提问澄清（交互阻塞点） | question, options |

> 安全约束：`write_file` / `edit_file` / `run_command` 属高危工具，默认需要用户确认（yolo 模式可关闭确认）；所有路径限制在项目根目录沙箱内。

### 3.4 7 层系统提示词组装架构 + 三级覆盖

组装顺序（自底向上叠加，下层为上层兜底）：

```
L1 Identity        身份与安全基线（内置，不可覆盖）
L2 Environment     运行环境：OS/Shell/CWD/时间/平台差异（自动探测）
L3 Project         项目上下文：README 摘要、目录结构、技术栈、代码规范
L4 Tools           工具清单与使用规范（内置 + MCP 动态生成）
L5 Skills          已加载 Skills 的指令注入
L6 Memory          项目记忆 / 用户偏好（跨会话沉淀）
L7 Session         对话级临时指令（运行时覆盖）
```

三级覆盖机制：

| 级别 | 来源 | 位置 | 可覆盖层 |
|------|------|------|----------|
| L1 内置级 | 包内默认模板 | `packages/core/prompts/` | — |
| L2 项目级 | `.y-zero/agent.md`、`.y-zero/settings.json` | 项目根目录 | L3–L6 |
| L3 对话级 | 运行时参数 / Web 控制台设置 | 会话配置 | L5–L7 |

合并规则：同名 section 深度合并，数组取并集，L1 安全基线不可被覆盖；最终组装结果在 debug 模式可导出审查。

---

## 4. 非功能需求

| 类别 | 需求 |
|------|------|
| 性能 | 首字响应 ≤ 2s（网络正常）；工具调用调度开销 ≤ 50ms；Web 控制台首屏 ≤ 1.5s |
| 可靠性 | SSE 断流自动重连（指数退避）；工具执行崩溃不影响主循环；会话数据写入原子化（防损坏） |
| 安全 | 路径沙箱（禁止逃逸项目根目录）；命令执行白名单 + 确认；API Key 仅存本地（系统钥匙串可选）；提示词注入基线防护 |
| 兼容 | Node.js ≥ 20；Windows PowerShell/cmd + macOS zsh/bash；主流 Chromium/Firefox/Safari |
| 可扩展 | Provider / Tool / Skill / MCP 均为插件式接口，新增不改核心代码 |
| 可观测 | 全链路 trace 日志（轮次、token 消耗、工具耗时）；`--debug` 模式输出提示词组装结果 |

---

## 5. 信息架构与页面清单（Web 控制台）

```
Web 控制台
├── 侧边栏：项目列表（多项目）→ 项目下对话列表（多对话）
├── 对话主界面
│   ├── 消息流（用户/助手/工具调用卡片/压缩事件/预算事件）
│   ├── 执行模式切换（ReAct / Plan / Multi-Agent）
│   ├── 模型选择器 + Token 预算显示
│   └── 输入框（支持 @文件 引用）
├── 设置页：模型 Provider / MCP Server / Skills / 覆盖层级管理
└── 会话详情：执行轨迹回放、Token 消耗统计
```

高保真原型见 `prototype/index.html`。

---

## 6. 里程碑规划

| 里程碑 | 范围 | 交付物 |
|--------|------|--------|
| M1（4 周） | Agent 核心：ReAct 引擎 + 预算 + 压缩 + 11 工具 + 单 Provider + ink TUI 确认卡 | CLI 可用（命令名 `yzero`） |
| M2（3 周） | 接入层：4 家 Provider SSE（Anthropic / OpenAI 兼容 / DeepSeek / Qwen）+ ToolCall 分片解析 + MCP 扩展 + 并行工具 | 多模型 + MCP |
| M3（3 周） | 提示词体系：7 层组装 + 三级覆盖 + Skill 三层加载/两阶段按需加载/匹配评分（内置 commit-review / test-fix / project-summarize） | 提示词架构 ✅ 2026-10-22 交付（5 commits，141 tests） |
| M4（4 周） | Web 控制台：多项目多对话 + 对话可视化 + 设置中心 + 记忆面板 | Vue 前端 ✅ 2026-10-22 交付（7 任务/7 commits，167 tests + Web 冒烟 7/7；记忆面板为空态，接记忆里程碑；Plan/Multi-Agent 模式 UI 已预留） |
| 记忆里程碑 | 三层记忆系统（F-06a）：L2 动态记忆 + save/recall 工具 + 自动提炼 + Web 面板 | ✅ 2026-10-22 交付：memories 表写入管线（SHA256 去重 → 配额 512 条 → FIFO+importance 淘汰 → 冲突 superseded）、召回评分（覆盖率 0.72/重要性 0.12/置信度 0.08/时间衰减 0.06/频率 0.02，阈值 0.25，召回即反馈）、save_memory/recall_memory 工具（15 个内置）、小模型自动提炼 0-3 条进待确认队列、Top-K 注入动态 Prompt、Web 记忆面板（列表/编辑/停用/回收站/采纳/召回预览）、CLI `yzero memory list/export/rm`（207 tests + Web 冒烟全绿） |
| M5（2 周） | Plan DAG 引擎 + Worker Pool + Reviewer 闭环 + 任务恢复 + 跨平台加固 | ✅ 2026-10-22 交付：Plan-and-Execute（简单任务检测 + Planner DAG + 拓扑分层并行）、Multi-Agent 闭环（Worker Pool 竞争领取 + Reviewer/Verifier 打回重试）、任务恢复（tasks 表 + 60s 租约 + 15s 心跳 + 孤儿扫描）、跨平台加固（ShellAdapter PS→cmd 降级 + CI matrix）；CLI `--mode` / Web 模式分发接通 |

---

## 7. 待确认问题（已于 2026-10-22 全部确认）

| # | 问题 | 决议 |
|---|------|------|
| 1 | 会话存储选型 | **本地 SQLite**（better-sqlite3，WAL 模式），不做 JSON 降级之外的其他方案 |
| 2 | Web 控制台部署形态 | **纯本地**：CLI 内嵌静态资源（Vue 构建产物打包进 npm 包）+ 本地 server（`agent serve`，默认 127.0.0.1），不做远程部署形态 |
| 3 | 确认策略默认值 | 高危工具（write_file / edit_file / run_command）默认**每次确认**；yolo 模式需双重开启（会话级 + 配置级） |
| 4 | Multi-Agent 角色集 | 采用**四层十角色**体系（决策层 Orchestrator/Planner，执行层 Worker/Researcher/Writer/Tool Caller，质量层 Reviewer/Verifier，协调层 Memory Keeper/Router）；MVP 先实现核心五角色，其余按任务类型动态启用。详见 agent-modes-design.md §4 |
| 5 | 商业形态 | **先自用，后续再开源**；开源前不设计云端增值/团队协作付费能力（F-19/F-20 维持 P2 不提前），代码按可开源标准编写（License 头、无硬编码密钥） |
| 6 | CLI 命令名 / npm 包名 | **`yzero`**（2026-10-22 确认） |
| 7 | Token 预算层级 | **会话级为主**：默认 200k tokens / ¥5，超限可临时追加；任务级预算作为可选开关（默认关闭） |
| 8 | 首发模型服务范围 | **全部 4 家**（Anthropic / OpenAI 兼容 / DeepSeek / Qwen），随 M2 全量交付 |
| 9 | CLI 确认交互形态 | **TUI 选择卡**（基于 ink）：方向键选择 允许 / 拒绝 / 编辑参数，M1 即实现 |
| 10 | 压缩与提炼模型 | 压缩摘要**跟随会话主模型**；记忆自动提炼用**小模型**（衔接 F-32 模型路由） |
| 11 | 首发内置 Skills | 3 个示范：`commit-review`（审查提交）、`test-fix`（跑测试修错）、`project-summarize`（生成项目摘要） |
