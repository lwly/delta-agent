# F-31 成本与用量报告 —— 增量 PRD

> 版本：v0.1 ｜ 日期：2026-10-23 ｜ 状态：待评审
> 上游：docs/PRD.md P2 需求池 F-31 ｜ 本文只描述**相对现有系统的增量**，不重复整体产品定义

---

## 1. 一句话定位与背景

**一句话**：为 delta-agent 增加按项目 / 会话 / 模型维度的费用与 token 统计查询能力（Web 面板 + CLI + HTTP API 三端），并在现有会话级预算之上增加 50% / 80% / 100% 三级告警。

**背景**：目前用量数据已经在 `usage` 表逐轮落库（`recordUsage()`，引擎每轮调用），会话级预算也已在 `BudgetManager` 中生效，但这些数据**只有写入、没有读取出口**——用户无法回答"这个项目花了多少钱""这个月哪个模型烧得最多"这类问题。同时现有预算只有 80% 提醒（`shouldWarn()`，且每轮重复触发）和 100% 硬停两级，缺乏渐进式的预警节奏。本特性把存量数据"盘活"成报告，并把预算告警补齐为分级一次性触发。

---

## 2. 用户故事

| 编号 | 角色 | 故事 | 验收标准 |
|------|------|------|----------|
| US-31-1 | 开发者 | 我想看某个项目累计花了多少钱、多少 token | Web 用量页选中项目后展示该项目费用 / token 汇总与逐会话明细 |
| US-31-2 | 开发者 | 我想对比各模型的消耗，决定主用哪个模型 | 用量页按模型分组展示费用 / token 占比（表格 + 横向条形），支持切换时间范围 |
| US-31-3 | 效率工具玩家 | 我在终端里不想开浏览器也能快速看用量 | `delta usage` 输出文本表格，`--json` 输出与 API 同构的结构化数据 |
| US-31-4 | 开发者 | 长任务跑到一半我想提前知道"快超预算了" | 会话费用 / token 达到 50% / 80% / 100% 阈值时各收到**一次**告警（CLI 通知 + Web 事件卡片），100% 时维持现有优雅终止行为 |
| US-31-5 | 自动化用户 | 我想在脚本里取用量数据做自己的看板 | `GET /api/usage/summary` 返回稳定结构的 JSON（汇总 + 按项目 + 按模型），支持时间范围与项目过滤 |

---

## 3. 需求拆解

### FR-1 Schema v3 迁移：usage 表补 model 与 created_at（P0）

`usage` 表当前缺 `model` 列和 `created_at` 列，模型维度统计与时间范围过滤均无法实现。按 F-35 迁移框架在 `MIGRATIONS` 末尾追加 v3（幂等 SQL，独立事务，历史库与空库收敛到同一版本）：

- `ALTER TABLE usage ADD COLUMN model TEXT NOT NULL DEFAULT ''`
- `ALTER TABLE usage ADD COLUMN created_at TEXT`（ISO 8601，对齐 projects/sessions 的存法）
- `recordUsage()`（store.ts:269）签名增加 `model` 参数并写入时间戳；调用链 service.ts → headless.ts / hub.ts 同步透传（引擎事件 usage 中已可拿到当前模型）
- 存量数据回填：`created_at` 用 `sessions.created_at` 近似回填（usage 无逐轮时间戳，接受会话开始时间的近似误差）；`model` 用 `sessions.model` 回填

**模型粒度决策（关键取舍）**：模型归属有两种做法——(a) 仅用 `sessions.model` join 出会话级粒度，零迁移但一旦接入 F-32 模型路由（同一会话内大小模型混用）统计即刻失真；(b) 本期在 usage 行上加 per-turn `model` 列。(b) 的迁移成本极低（两列 + 一次回填），且为 F-32 预埋了正确口径。**推荐 (b)**。

**验收要点**：旧库打开自动升到 v3 且数据不丢；回填后历史用量能按模型 / 时间聚合；迁移单测覆盖「空库」「v2 历史库」「重复打开」三种路径。

### FR-2 用量聚合查询层（core）（P0）

在 store/service 层新增只读聚合查询（SQL GROUP BY，无 ORM），维度与过滤：

- 维度：总计、按项目（join sessions.project_id）、按会话、按模型
- 过滤：时间范围 `today / 7d / 30d / all`（基于 usage.created_at）；项目 `project_id` 可选
- 返回字段：input_tokens、output_tokens、cost_usd、轮次数（usage 行数）、会话数
- 软删除口径：**费用计入汇总**（钱已实际消耗），by-session 明细列表仍只列活跃会话（对齐 F-11a 的软删除语义）

**验收要点**：聚合结果与逐行手算一致；时间边界（今天 0 点 / 7 天前）正确；空数据返回零值结构而非报错；单测覆盖多项目 / 多模型 / 跨范围用例。

### FR-3 HTTP API（P0）

沿用 server/http.ts 现有 `api/<resource>/...` 手写路由模式，新增：

- `GET /api/usage/summary?range=<today|7d|30d|all>&project=<id>` → `{ totals, byProject[], byModel[] }`
- `GET /api/usage/sessions?range=...&project=<id>` → 逐会话明细（含会话标题、模型、轮次）

仅本地 127.0.0.1 暴露，无鉴权增量（对齐 F-12 纯本地部署形态）。

**验收要点**：参数非法值回退默认 `all` 并在响应中回显实际生效范围；与 CLI `--json` 输出同构（同一查询层产出）。

### FR-4 Web 用量面板 UsageView（P0）

packages/web/src 新增 `UsageView.vue`，路由 `/usage`，侧边栏加入口，沿用现有视图（ProjectsView / MemoryView）的数据获取与布局模式：

- 顶部：时间范围切换（今天 / 7 天 / 30 天 / 全部）+ 项目筛选下拉
- 总览卡片：总费用、总 token（输入 / 输出）、总轮次
- 三个分组表格（费用 + token + 占比横条）：按项目、按模型、按会话（可展开显示轮次）
- 只读展示，本期无导出 / 图表库依赖（纯 CSS 条形即可）

**验收要点**：范围切换与项目筛选正确刷新；空项目 / 空范围有空态提示；Web 冒烟测试补 1-2 例。

### FR-5 CLI `delta usage` 命令（P1）

packages/cli/src/index.ts 注册子命令（对齐 models / memory / evals 的注册方式）：

- `delta usage [--range today|7d|30d|all] [--project <id|name>] [--json]`
- 默认输出文本表格（项目 / 模型两个分组 + 总计）；`--json` 输出与 FR-3 同构结构

**验收要点**：无数据时输出友好空态；`--json` 可被 `jq` 直接消费。

### FR-6 预算分级告警（P0）

在 BudgetManager（context/budget.ts）之上增强，**不改变** 100% 硬停与优雅终止的现有行为：

- 阈值：token 与费用两个维度各按 **50% / 80% / 100%** 三级判断（取两维度中更高者作为告警级别），阈值本期硬编码为常量，不暴露配置
- **一次性语义**：改造现有 `shouldWarn()`（当前 ≥80% 每轮重复触发）为「每级只触发一次」——BudgetManager 内记录已告警的最高级别，`guard()` / record 路径返回本次是否需发告警
- 事件：引擎发出 `budget_alert` 事件 `{ level: 0.5|0.8|1.0, usedTokenPct, usedCostPct, sessionId }`（100% 级别在现有 budget_exceeded / 终止摘要之前作为普通告警发出）
- 消费端：CLI（TUI 与 headless）收到事件打印一行 NOTICE；Web Hub 经现有 SSE 桥转发，前端以 toast + 消息流事件卡片呈现（对齐现有预算事件卡片的展示模式）
- 子代理（F-26）用量回写父预算时同样计入分级判断，无需单独告警通道

**验收要点**：50% → 80% → 100% 严格各告警一次，回看 / 回放不重复；未超阈值零告警；100% 后行为与现状完全一致（退出码 4、优雅终止摘要）；单测覆盖跨级跳变（一轮从 40% 直接到 90%，只发 80% 一条）与双维度取高。

---

## 4. 非目标（Out of Scope）

- 不做导出（CSV / Markdown）、不做图表库引入（echarts 等）、不做历史趋势折线
- 不做成本二次计价 / 汇率换算：`cost_usd` 沿用 Provider 层已有计算，报告只做汇总
- 不做项目级 / 全局级预算上限与硬停（本期只做**告警**，分级预算上限是后续需求）
- 不做实时用量推送（面板为手动刷新 / 进入时拉取，不做轮询或 SSE 推送）
- 不改会话级默认预算值（200k tokens / $0.7）与 `--max-cost` 语义

---

## 5. 待确认问题（附推荐默认值）

| # | 问题 | 推荐默认 |
|---|------|----------|
| 1 | usage 表历史数据的时间回填用 `sessions.created_at` 近似（会话开始时间，非逐轮真实时间），是否接受？ | 接受——报告粒度是天级，近似误差可忽略；逐轮时间戳从 v3 起才有 |
| 2 | 模型粒度采用 per-turn `model` 列（FR-1 方案 b）还是仅 session 级 join？ | per-turn 列，历史回填 sessions.model，为 F-32 铺路 |
| 3 | 告警阈值是否需要可配置（配置文件 / CLI flag）？ | 本期硬编码 50/80/100，配置项推迟到有真实反馈后 |
| 4 | 软删除会话的费用是否计入项目汇总？ | 计入（费用是沉没成本），明细列表仅展示活跃会话 |
| 5 | Web 面板是否需要放在侧边栏一级入口，还是挂在项目详情下？ | 侧边栏一级入口 `/usage`，默认聚合全部项目 |

---

## 6. 与现有能力的衔接说明

- **迁移框架（F-35）**：v3 迁移按既有模式追加到 MIGRATIONS 数组末尾，零框架改动；`delta migrate` 自动覆盖新版本核对。
- **用量写入链路**：recordUsage 签名扩展沿 `engine → service → store` 现有调用链透传，headless 与 hub 两处调用点同步修改；写入频率不变（每轮一条）。
- **预算体系（BudgetManager）**：分级告警是 shouldWarn() 的语义升级（重复触发 → 分级一次性），guard() 的硬停逻辑与退出码协议（F-29 exit 4）完全不动。
- **Web / Server / CLI**：完全复用现有手写路由、Vue 视图模式、commander 子命令注册模式，无新依赖。
- **F-32 前瞻**：per-turn model 列是模型路由统计口径的前置条件，本期一次到位。
