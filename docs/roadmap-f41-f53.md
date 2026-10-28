# delta-agent 下一轮路线图与任务拆解（F-41 ~ F-53）

> 版本：v0.1 ｜ 日期：2026-10-28 ｜ 对应：docs/prd-f41-f53-next-round.md · docs/design-f41-f53-next-round.md

## 1. 里程碑划分

| 里程碑 | 范围 | 目标 | 串行预估 | 备注 |
|--------|------|------|----------|------|
| **R1 生态互通** | F-41 / F-42 / F-43 / F-44（S 档） | 编辑器可接入、APM 可观测、社区生态进出零成本 | ~5 周 | 两人并行可压到 ~3 周 |
| **R2 效率与差异化** | F-45 / F-46 / F-47 / F-48 / F-49（A 档） | 成本可诊断、运行中可控、评审可进 CI、符号可查、任务可派 | ~8–10 周 | 五项可两线并行，F-48 独立无依赖 |
| **R3 企业化** | F-50 / F-51 / F-52 / F-53（B 档） | 治理、信创、护栏、Windows 沙箱 | ~7–9 周 | F-50 依赖待确认 #3；F-53 spike 先行 |

跨里程碑依赖：F-47 规则注入依赖 F-41（R1 先行，无阻塞）；F-51 内网 OTLP 依赖 F-43（R1 先行）；F-52 无硬依赖但建议在 F-42/44（扩大攻击面的功能）之后合入。

## 2. R1 任务拆解（S 档）

| 任务 | 内容 | 产出 | 依赖 | 预估 |
|------|------|------|------|------|
| T1.1 F-41 拆稿 | 从合并 PRD/设计拆出 prd-f41 / design-f41 | 成对文档 | — | 0.5 天 |
| T1.2 F-41 core 模块 | `core/src/instructions/`（发现/软链/嵌套合并）+ 单测 | core 代码 | T1.1 | 1 天 |
| T1.3 F-41 接线 | cli loadInstructions 下沉切换 + onboarding AGENTS.md 分支 + 三端冒烟 | 全链路生效 | T1.2 | 0.5–1 天 |
| T1.4 F-42 协议层 | `core/src/acp/rpc.ts`（JSON-RPC 帧）+ 帧单测 | 协议底座 | — | 2 天 |
| T1.5 F-42 bridge | AgentEvent → session/update 映射 + request_permission 桥 + cancel | acp/server 可跑 | T1.4 | 4–5 天 |
| T1.6 F-42 CLI 与联调 | `delta acp` 子命令 + Zed 实机联调 + 问题记录 | 编辑器可用 | T1.5 | 2–3 天 |
| T1.7 F-43 SDK 引入 | otel 依赖引入 + config/redact/sink 模块 + 单测 | sink 可用 | — | 2 天 |
| T1.8 F-43 三端接线 | AppOptions/SessionHubDeps/headless 注入 + flush + smoke | trace 可见 | T1.7 | 1–2 天 |
| T1.9 F-44 技能互通 | skills/portable.ts import/export + CLI + roundtrip 单测 | 技能进出 | — | 2 天 |
| T1.10 F-44 MCP registry | mcp/registry.ts + `delta mcp search/install` + 预览确认流 | 一键装 MCP | — | 2 天 |
| T1.11 R1 收口 | prd-f44/design-f44 补稿（含 skill-hub 缺口）+ 全量门禁 + docs/PRD.md 主文档登记 F-41~F-44 | R1 合并 | 全部 | 1 天 |

## 3. R2 任务拆解（A 档）

| 任务 | 内容 | 产出 | 依赖 | 预估 |
|------|------|------|------|------|
| T2.1 cache 透传（先决） | StreamEvent usage 扩展 + usage 表 v4 加列 + 两家 Provider 透传 + 回填 | cache 数据可用 | — | 1–2 天 |
| T2.2 F-45 规则引擎 | cost/ 模块 + r1–r4 规则 + fixture 单测 | CLI 报告可用 | T2.1（r5） | 4 天 |
| T2.3 F-45 出口 | `delta cost audit` + /api/usage/audit + Web 概览卡 | 三端可见 | T2.2 | 2–3 天 |
| T2.4 F-46 引擎控制通道 | ControlChannel + react 轮间 drain + inject/restrict 语义 + 单测 | 引擎能力 | — | 4–5 天 |
| T2.5 F-46 端点与 UI | hub.control + POST control + TUI 斜杠命令 + Web 控制条 + control_applied | 可操控 | T2.4 | 3–4 天 |
| T2.6 F-47 评审内核 | review/ 模块（prompt/schema/runner）+ 后验过滤 + 单测 | findings 可产出 | T1.2 | 4 天 |
| T2.7 F-47 形态 | `delta review` CLI + TUI findings 卡 + 一键修（restrict）+ CI 模式 + evals 套件 | 可进 CI | T2.6 | 4–5 天 |
| T2.8 F-48 索引内核 | 依赖引入（web-tree-sitter + 三门 grammar）+ extract/store/indexer + golden 单测 | TS/JS/Python 索引 | — | 6–8 天 |
| T2.9 F-48 出口 | `delta symbols` CLI + symbol_query 工具 + 大仓性能实测 | 可查询 | T2.8 | 2–3 天 |
| T2.10 F-49 队列内核 | jobs 表迁移 + queue/store+runner+executor + 租约/恢复单测 | 队列可用 | — | 3–4 天 |
| T2.11 F-49 出口 | `delta job` CLI + /api/jobs + JobsView 任务板 + cron target=queue | 闭环可派活 | T2.10 | 3–4 天 |
| T2.12 R2 收口 | 全量门禁 + 主文档登记 + Go/Java grammar 取舍决策（待确认 #4） | R2 合并 | 全部 | 1 天 |

并行建议：A 线 T2.1→T2.2→T2.3→T2.10→T2.11（成本+队列）；B 线 T2.4→T2.5→T2.6→T2.7→T2.8→T2.9（操控+评审+索引）。两线无共享文件冲突（除 migrations 序号，见设计文档 §14）。

## 4. R3 任务拆解（B 档）

| 任务 | 内容 | 产出 | 依赖 | 预估 |
|------|------|------|------|------|
| T3.1 F-50 决策 | 待确认 #3 拍板：内网多人 serve 是否立项；范围裁定 | 范围结论 | 产品评审 | 0.5 天 |
| T3.2 F-50 路由表重构 | http.ts if/else → 路由表数组（机械重构 + 行为快照） | 重构前提 | T3.1 | 2–3 天 |
| T3.3 F-50 鉴权 | auth 中间件链 + OIDC（Web 授权码 + CLI device flow）+ JWT | 登录可用 | T3.2 | 4–5 天 |
| T3.4 F-50 RBAC + 审计 | 角色标注 + audit JSONL + webhook sink + 打点 | 治理闭环 | T3.3 | 3–4 天 |
| T3.5 F-50 配额 + license | QuotaStore + BudgetManager 前置检查 + Ed25519 验签 | 计费与许可 | T3.4 | 2–3 天 |
| T3.6 F-52 检测器 | guard/detect + fixture 基准（检出/误报实测）+ 性能基准 | 检测可用 | — | 3 天 |
| T3.7 F-52 接线 | registry 管线 + MCP 快照 + trust 锁定 + 提交扫描 + guard.json 档位 | 护栏生效 | T3.6 | 3–4 天 |
| T3.8 F-51 预设与离线 | presets.ts + pricing 扩展 + air-gapped 守卫 + pack-offline 脚本 | 可离线交付 | F-43 | 4–5 天 |
| T3.9 F-51 适配验证 | linux-arm64 CI + 干净容器离线安装冒烟 + 内网 OTLP 打通 + 麒麟/统信手测清单归档 | 适配报告 | T3.8 | 2–3 天 |
| T3.10 F-53 spike | wsl 探测/包装/翻译/性能验证 → 可行性报告 + 三选一终裁 | spike 报告 | — | 1 周 |
| T3.11 F-53 实现 | WslExecutor + config/runtime 扩展 + golden 逃逸套件 + Windows 实机冒烟 | Windows 沙箱 | T3.10 | 2–3 周 |
| T3.12 R3 收口 | 全量门禁 + 主文档登记 + 交付摘要（含待确认项清单回填） | R3 合并 | 全部 | 1 天 |

## 5. 评审决议清单（开工前须确认）

| # | 决议点 | 影响范围 |
|---|--------|----------|
| 1 | F-42 手写 JSON-RPC vs 官方库 | T1.4 实现路径 |
| 2 | cache 透传是否随 R1 末尾提前做 | T2.1 时点 |
| 3 | F-50 内网多人 serve 形态是否立项 | T3.1，R3 范围 ±2 周 |
| 4 | F-48 语言首期三门还是五门 | T2.8 工作量 ±4 天 |
| 5 | F-51 驱动（真实客户 vs 前瞻储备） | R3 排期松紧 |

## 6. 通用交付纪律

- 每任务一分支 `feat/{任务ID}`；docs 与代码分开提交；未经明确要求不 push、不合并。
- 门禁：`pnpm typecheck` / `pnpm test` / `pnpm smoke`（涉 Web 加 `pnpm smoke:web`）；新增逻辑必带单测。
- 每个功能开工前从合并文档拆出成对 prf/design 单文件；交付摘要写明改动面、验证命令与遗留风险。
