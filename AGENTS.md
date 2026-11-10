# AGENTS.md

本文件面向在本仓库工作的 AI 编码代理（agent）与人类贡献者，描述项目概况、模块边界与硬性限制。文档与代码冲突时以既有代码为准，并把冲突点写入交付摘要。

## 1. 项目信息

**delta-agent** 是一个基于 TypeScript 的 AI Coding Agent：CLI 为核心入口（Ink TUI），Vue Web 控制台为可视化前端，支持 **ReAct / Plan-and-Execute / Multi-Agent** 三种执行模式，通过 MCP 协议动态扩展工具能力。

### 技术栈

- 语言：TypeScript（Node ESM），Node >= 20，pnpm 9.15.9（`packageManager` 已锁定）
- CLI/TUI：commander + Ink；Web 控制台：Vue 3 + Vite + Pinia；桌面壳：Electron
- 存储：SQLite（better-sqlite3，WAL 模式），路径默认 `~/.delta/agent.db`
- 外部集成：Anthropic / OpenAI / DeepSeek / Qwen Provider + OpenAI 兼容网关、MCP 协议（stdio + SSE）、Skills 技能包
- 测试：Vitest（单测）+ Playwright（Web E2E）

### 仓库结构（pnpm monorepo，以实际目录为准）

```
delta-agent/
├── packages/
│   ├── cli/       # @delta/cli —— CLI 入口与 Ink TUI，bin 命令 delta
│   ├── core/      # @delta/core —— 引擎核心：会话、LLM 接入、工具、MCP、沙箱、记忆
│   ├── shared/    # @delta/shared —— 跨包共享的类型与工具函数
│   ├── host/      # @delta/host —— 服务托管：组装 core + 内置插件，serve 运行时
│   ├── web/       # @delta/web —— Web 控制台前端（经 HTTP/SSE 访问 host，不直接依赖 core 运行时）
│   ├── desktop/   # @delta/desktop —— Electron 桌面壳（main 进程内托管 core serve）
│   └── plugins/   # @delta/plugin-builtin-* —— 内置插件：engines / routes / services / views / commands
├── docs/          # PRD、总体技术设计、各功能 prd-f*.md 与 design-f*.md 成对文档
├── e2e/           # CLI 黄金路径 + Web Playwright 套件（假 Provider，零密钥）
├── scripts/       # 构建 / 冒烟 / 安装钩子脚本
└── prototype/     # 原型
```

### 文档权威顺序

1. `docs/PRD.md` 与 `docs/technical-design.md` —— 总览
2. `docs/prd-f*.md` + `docs/design-f*.md` —— 单功能成对文档（先 PRD 定范围，再 design 定实现）
3. `docs/architecture-glossary.md` —— 术语表；`docs/architecture-consolidation-plan.md` —— 架构收口规格

已知文档漂移：`docs/technical-design.md` §1.1 仍写 `apps/web` + turborepo，实际为 `packages/web` + 纯 pnpm workspace；README 仓库结构未列 `host/`、`plugins/`。以实际代码为准。

## 2. 模块边界

### 依赖方向（合法方向，禁止反向依赖）

```
shared（零内部依赖，最底层）
  ↑
core（引擎核心，只依赖 shared）
  ↑
plugins/*（内置插件，只依赖 core）
  ↑
host（组装 core + 全部内置插件）
  ↑
cli（依赖 core / host / shared）        desktop（依赖 core / host / shared）

web —— 独立前端包，通过 HTTP/SSE 与 host 通信，不 import core 运行时
```

- 跨 package 改动前先确认依赖方向合法；不得在 shared 中引入 core/cli 类型，不得让 core 反向感知 cli/web。
- 新增能力优先在既有抽象上扩展：Provider 接入层、工具注册表（ToolRegistry）、MCP 客户端、Skills 加载器、权限档位、记忆分层（L1 会话 / L2 SQLite 动态 / L3 静态 MD）、内置插件包；不旁路另起一套。
- `packages/core/src/server/http.ts` 是 REST API 路由所在；新路由按收口方案优先走 `plugin-builtin-routes` 声明式路由表，不再往 http.ts 手写 if/else 里堆。
- 运行前门禁（权限/配额/scope）以 `RunGateway` 收口方案为目标，不在各入口自行复制校验。

### 范围纪律

- 只改被指派任务范围内的代码，不顺手重构无关模块。
- 改文档与改代码分两个提交；提交信息格式 `类型(模块): 描述`（feat/fix/refactor/docs/test/chore）。
- 禁止直接提交 master；未经任务明确要求不 `git push`、不自行合并分支。

## 3. 限制（硬性约束）

### 环境与构建

- Node >= 20，pnpm 9.15.9；`@delta/shared`、`@delta/core` 的类型入口指向 `dist/*.d.ts`，单独跑某包 typecheck 前需先 `pnpm build:deps`。
- `delta serve` 默认托管 cron 调度器；本地调试可用 `DELTA_CRON_DISABLE_AUTOTICK=1` 关闭。

### 提交前门禁（必须通过）

```bash
pnpm typecheck   # 全量类型检查（内置 build:deps）
pnpm test        # 单测
pnpm smoke       # 冒烟；Web 界面改动另跑 pnpm smoke:web
```

- 新增或修改的逻辑必须补单测；只跑自己碰过的 package 也算通过，但交付摘要需写明跑了哪些命令。
- 涉及 `packages/core/src/server/http.ts` 的改动，`pnpm smoke` / `pnpm smoke:web` 为硬门禁。
- Web 单测需带 TMP 三件套（`TMP="$PWD/.tmp-vitest" TEMP=... TMPDIR=... pnpm --filter @delta/web test`）；首跑偶发 1 个 unhandled error + exit 1 是已知环境竞态，重跑即绿，不是回归，勿为此改代码。
- 真实 spawn 子进程的用例沿用 `skipIf(win32)` 口径。

### 安全与隐私

- 仓库中不得出现任何密钥、API Key 或本机配置：Provider Key 属 `~/.delta/models.json`（AES-256-GCM 加密、0600），项目级配置属 `<项目>/.delta/`，均已 gitignore。
- 密钥只经环境变量或命令参数传入，不落代码、不写文档、不进测试快照。
- 权限三档 `plan`（只读）/ `default`（写需确认）/ `yolo`（双重确认后全放行）不可绕过；沙箱（macOS Seatbelt 为主、Docker 可选）相关改动不得降低默认隔离级别。
- git 提交策略三档 `off | suggest | auto`；agent 侧默认不执行破坏性 git 操作（force push、reset --hard、改历史）。
- E2E 全程使用假 Provider（`DELTA_FAKE_PROVIDER`）与隔离 HOME，不发起真实网络请求。

### 行为约定

- 动手前先 `ls` / `grep` 摸清既有实现与命名习惯，不臆造接口、字段、状态值、配置键；查不到就标注待确认。
- 长任务默认参数：单任务最大轮次 50（`--max-turns`），会话级 token 预算默认 200k tokens / ¥5。
