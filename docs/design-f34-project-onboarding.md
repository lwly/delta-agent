# F-34 项目 onboarding —— 技术设计

> 日期：2026-10-23 ｜ 关联：docs/prd-f34-project-onboarding.md、docs/memory-design.md §2.1（L3 静态记忆）｜ 样例沿用：F-33（原子写 / 子命令组 / 入口层接线）、distillMemories（一次性小模型调用模式）

## 1. 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D1 | 触发点在**入口层**：`ensureProject` 返回值增加 `created` 标记，三端在 `created=true` 后触发 onboarding；引擎与工具零改动 | 对齐 F-33 D1「入口层接线」；`ensureProject` 本就是唯一的新项目判定点（返回 `created` 为增量字段，既有调用点不受影响） |
| D2 | 扫描器限深（默认 3）限条（默认 300）、跳过噪声目录（SCAN_SKIP_DIRS）、只读根目录清单与 README 头部（各截断 2k）、全文输入截断 16k | 无预算控制的目录遍历会把 node_modules / dist 塞进 LLM 输入；16k 对齐 distill 的输入预算 |
| D3 | 生成走**一次 LLM 调用**，输出按分段标记 `===SUMMARY=== / ===AGENT_MD=== / ===MEMORY_MD===`（无标记时兜底尝试围栏 JSON）；解析失败 throw，状态留在 pending | 仿 distillMemories 的一次性调用模式；真机验证发现弱模型在 JSON 字符串里输出未转义字符导致解析失败——Markdown 正文经分段标记承载则无需任何转义，对弱/强模型都稳健 |
| D4 | 草案先落 `*.draft` 文件 + 状态文件，`confirm` 才改名到位；目标存在**绝不覆盖** | "引导确认"是 PRD 原文语义；L3 静态记忆团队共享（随 git 提交），自动覆盖用户手工维护的 MEMORY.md 属破坏性动作（对齐用户工作副本保护约定） |
| D5 | 状态 `.delta/onboarding.json`：`{status: pending\|draft\|confirmed\|skipped, generatedAt?, model?, summary?, auto?}`；读永不 throw（坏 JSON 视为 pending）、写 tmp+rename 原子 | 对齐 F-30/F-33「按特性分文件」与原子写惯例；pending 语义让失败可自然重试 |
| D6 | 自动触发策略：headless **同步**等待（一次性成本，打印进度与结果）；TUI / serve **fire-and-forget**（不阻塞启动/服务，TUI 完成后不向已挂接管的屏幕打印，靠状态文件沉淀结果） | headless 非交互可接受秒级延迟；TUI 启动延迟与 Ink 接管屏幕后的输出都不可靠；失败一律静默，AC-6 |
| D7 | 暂用会话主模型生成，不接 F-32 路由 | onboarding 低频（每项目一次）；后续可在 `routeAux` 增加 kind 无缝接入，接口已按 `provider + model` 注入留好缝 |
| D8 | 只产出 L3 静态草案，不动 L2 | PRD 范围即"初始静态记忆"；L2 初始知识可由首次会话的 distill 自然沉淀 |

## 2. 抽象分层

```
packages/core/src/onboarding/
├── scan.ts     scanProjectLayout：目录树（限深限条）+ 清单/README 头部 → 组装输入全文（只读、永不 throw）
└── index.ts    状态读写（load/save/shouldAutoOnboard）+ runOnboardingScan（LLM 一次调用 → 草案）
               + confirmOnboarding / skipOnboarding + autoOnboardProject（入口共用触发器）
```

```ts
interface OnboardingState {
  status: 'pending' | 'draft' | 'confirmed' | 'skipped';
  generatedAt?: string; model?: string; summary?: string;
  auto?: boolean;   // 显式 false 关闭首次注册自动扫描
}
function runOnboardingScan(opts: { projectRoot; provider; model; force? }): Promise<RunOnboardingResult>;
function confirmOnboarding(projectRoot): { applied: string[]; skipped: Array<{draft; target}> };
```

文件约定：

| 文件 | 角色 |
|------|------|
| `.delta/onboarding.json` | 状态（pending → draft → confirmed / skipped） |
| `.delta/agent.md.draft` → `.delta/agent.md` | 项目指令草案 → 正式（Prompt 组装 ProjectLayer 静态记忆来源之一） |
| `MEMORY.md.draft` → `MEMORY.md` | 团队共享静态记忆草案 → 正式 |

## 3. 三端接线

| 端 | 触发点 | 方式 |
|----|--------|------|
| TUI | `start()` 中 `ensureProject` 返回 `created` 后 | fire-and-forget；先打印一行提示（Ink 挂载前），完成后只写状态文件 |
| Headless | `runHeadlessCommand` 同位置 | 同步 await，打印进度/结果；失败提示可手动重试 |
| Web serve | `serve` 中 `ensureProject` 返回 `created` 后 | fire-and-forget 异步块，完成后 console.log 提示 |

三端失败均静默（状态留 pending，下次新项目启动自然重试）；`delta onboarding run` 手动兜底。

## 4. CLI 子命令

```
delta onboarding status    状态 + 草案/目标文件情况 + 下一步提示
delta onboarding run       扫描 + 生成草案（--force 忽略状态重新生成）
delta onboarding confirm   采纳草案（目标存在不覆盖，提示手工合并）
delta onboarding skip      跳过（不再自动扫描）
```

已加入 `KNOWN_SUBCOMMANDS` 裸任务路由白名单。

## 5. 测试策略

- 扫描：噪声目录过滤（node_modules 不出现）、清单/README 探测、空目录返回空树。
- 生成：草案落盘 + 状态 draft、分段标记解析、缺标记时兜底围栏 JSON、非 pending 跳过与 force、空目录跳过、解析失败保持 pending（报错附原始输出头尾便于排查）。
- 确认：改名到位 + status confirmed、目标已存在拒绝覆盖且草案保留。
- 跳过/自动：skip 后不自动跑、`auto:false` 阻断、pending 自动跑、坏状态 JSON 降级 pending。
- 全部用伪 provider（只 yield 一条 text_delta），不真调 LLM、不触真实 `~/.delta`。

## 6. 风险与裁决

| 风险 | 裁决 |
|------|------|
| LLM 臆造项目事实 | system prompt 约束"只依据材料可推断，无把握标注（待确认）"；产物是草案，confirm 人工把关 |
| 自动覆盖用户手工维护的 MEMORY.md / agent.md | D4：目标存在绝不覆盖，草案保留手工合并 |
| 首次启动被 LLM 调用拖慢 | TUI/serve 后台化；headless 一次性成本 + 失败静默；`auto:false` 可关 |
| 巨型仓库扫描超预算 | 限深/限条/截断三层预算（D2），超出部分静默省略 |
