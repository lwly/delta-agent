# F-32 模型路由 —— 增量 PRD

> 版本：v1.0 ｜ 日期：2026-10-23 ｜ 状态：已实现（随本次提交交付）
> 上游：docs/PRD.md P2 需求池 F-32 ｜ 本文只描述**相对现有系统的增量**，不重复整体产品定义

---

## 1. 一句话定位与背景

**一句话**：为 y-zero-agent 增加「按任务类型分流模型」的路由能力——提炼 / 分类 / 摘要等轻量辅助调用走可配置的小模型（省成本、提速），规划 / 执行等核心调用固定走会话主模型；路由规则存于 `~/.y-zero/models.json`，CLI 可配，任何异常自动回退主模型。

**背景**：引擎内目前只有两类 LLM 调用——主链路（规划 / 执行 / 压缩摘要）与辅助调用（记忆自动提炼 distill）。此前两者一律用会话主模型：提炼只是「从历史里挑几句话存起来」的轻量任务，却按主模型计费，既慢又贵。PRD 决议 #10 已明确「压缩摘要跟随会话主模型；记忆自动提炼用小模型（衔接 F-32）」，本特性把这条路打通并做成可配置的路由框架，为后续更多辅助调用点（标题生成、意图分类等）预留扩展位。

---

## 2. 用户故事

| 编号 | 角色 | 故事 | 验收标准 |
|------|------|------|----------|
| US-32-1 | 开发者 | 记忆提炼这类杂活别烧我的主模型额度 | 配置 `distill` 路由规则后，任务结束的自动提炼请求发往规则指定的小模型 |
| US-32-2 | 效率工具玩家 | 我有 DeepSeek / Qwen 的小模型 Key，想让杂活走那边 | 路由规则可指定目标 provider（`--provider`），与主 provider 不同源 |
| US-32-3 | 谨慎型用户 | 路由配置写错了不能影响正常任务 | 配置非法 / 总开关关闭 / 目标 provider 不可用时，一律回退主模型，主链路零感知 |
| US-32-4 | 自动化用户 | 我想在脚本 / 设置页里开关路由 | `yzero models routing` 系列子命令可查看 / 设置 / 删除规则与开关；配置即时生效（下次运行读取） |

---

## 3. 需求拆解

### FR-1 路由配置存储（P0）

`ModelsFile`（keychain.ts）扩展可选字段 `routing`：

```jsonc
{
  "version": 1,
  "providers": [ ... ],
  "routing": {
    "enabled": true,
    "rules": {
      "distill": { "provider": "deepseek", "model": "deepseek-chat" },
      "classify": { "model": "qwen-turbo" }
    }
  }
}
```

- `enabled`：总开关，关闭时全部调用走主模型
- `rules[kind].model`：目标模型 id（必填非空）；`provider`：目标 provider id（可省，省略 = 跟随会话主 Provider）
- kind 为任意字符串；内置已知 kind：`distill`（记忆提炼）/ `classify`（意图分类，预留）/ `summarize`（摘要，预留）
- 与 providers 同文件、同 0600 权限、同一加载/保存路径，不新增配置文件

**容错语义（关键决策）**：`loadModelsFile` 对 routing 字段做 all-or-nothing 校验——任一规则缺 model 或形状非法，**整块 routing 忽略**（providers 不受影响）。理由：配置文件允许手工编辑，部分生效会让「为什么这条规则没走」难以排查；宁可不生效也不半生效。写入侧 `setRouting()` 前置校验兜底，CLI 写出的配置永远合法。

### FR-2 模型路由器 ModelRouter（core，P0）

`packages/core/src/llm/router.ts` 新增 `ModelRouter`：

- `resolve(kind)` → `{ provider?, model, kind }` 或 `undefined`：仅当总开关开启且该 kind 配置了合法规则时返回
- `config()` → 当前配置（供 CLI / Web 展示）
- 构造器接受 `file` 参数（DI，测试不碰真实 `~/.y-zero`）

### FR-3 运行时接线：辅助调用走路由（P0）

`SessionHub` 新增可选依赖 `modelRouter` 与 `resolveProviderById`，私有方法 `routeAux(kind)`：

- 命中规则：rule.provider 存在时用 `resolveProviderById(id)` 构建目标 provider（CLI 注入 `resolveProviderFromEnv(id)`，与主 provider 同一解析链：env → 存储配置）；缺省复用 `resolveProvider()`
- **回退语义**：未注入路由器 / 未启用 / 规则缺失 / provider 构建失败 → 返回 undefined，调用方回退主模型主 provider。路由永不阻塞、永不抛错到主任务
- 本期接入点：**记忆提炼（distill）**——任务结束的自动提炼按 `distill` 规则选模型；提炼失败不阻塞交付的既有语义不变

### FR-4 CLI 路由管理命令（P1）

`yzero models` 子命令组追加（commander 平铺注册，对齐既有 add/list/default 风格）：

- `models routing` —— 查看状态与规则表
- `models routing-set <kind> <model> [--provider <id>]` —— 设置规则并自动启用路由
- `models routing-remove <kind>` —— 删除规则（该类任务回退主模型）
- `models routing-on` / `routing-off` —— 开关总开关（off 保留规则）

**验收要点**：临时 HOME 下全流程冒烟通过；`setRouting` 对空 model 报错；规则配置与 provider CRUD 同文件互不覆盖。

---

## 4. 非目标（Out of Scope）

- **不做实时难度分类**：PRD 原文「按任务难度自动选模型」本期落地为「按任务类型」路由。让 LLM 先分类再路由会额外消耗一次调用（省的又被吃回去），且分类错误直接污染主链路；待辅助调用点变多、收益明确后再立项（kind 体系已为其预留）
- **规划 / 执行不走路由**：PRD 决议 #10 明确压缩摘要跟随主模型，规划与执行是质量关键路径，固定主模型
- **不做 Web 设置页 / HTTP API**：本期 CLI 可配；Web 设置页路由规则编辑器随设置中心后续迭代
- **不做 usage 归因**：distill 走 `provider.chat` 直连、不经引擎，不产生 usage 事件，其费用**不进 F-31 报告**（口径：报告只统计会话主链路）。限制已知，若后续要求全口径可让 distill 也上报（记录 kind 归因）
- **不做规则优先级 / 权重 / 降级链**：单规则命中即用，回退目标固定为主模型

---

## 5. 关键决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | 路由按任务类型（kind）而非实时难度 | 难度分类本身是一次 LLM 调用，成本抵消收益；kind 由调用点自证语义，零额外开销、行为确定 |
| 2 | 配置并入 models.json 而非新文件 | 复用同一加密 / 权限 / 加载体系；路由规则与 provider 强关联（引用 provider id），同文件便于一致性 |
| 3 | 非法配置整体忽略（all-or-nothing） | 手工编辑容错；避免「部分规则生效」的排查黑洞 |
| 4 | 回退是默认行为而非错误 | 路由是优化手段，任何异常都应退回「不路由」的稳定态 |
| 5 | distill 为首个接入点 | 当前唯一存量的辅助 LLM 调用；决议 #10 点名场景 |

---

## 6. 与现有能力的衔接说明

- **Provider 体系（F-04a）**：路由目标 provider 复用 `resolveProviderFromEnv(id)` 的既有解析链与 `ProviderManager` 存储；`createProvider` / `test` 等能力自动适用于路由目标
- **记忆里程碑（F-06a / memory-design）**：distill 调用签名不变，仅「用哪个 provider + model」由路由决定；提炼候选置信度封顶、pending 队列、Web 采纳流程全部不动
- **F-31 用量报告**：per-turn model 列已就绪；本期路由不产生新 usage 行，口径不变
- **测试**：`test/router.test.ts` 10 例覆盖解析 / 开关 / 容错 / CRUD / 共存；全量 558 例回归通过
