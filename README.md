# y-zero-agent

y-zero-agent 是一个基于 TypeScript 的 AI Coding Agent，以 **CLI 为核心入口**、Vue Web 控制台为可视化前端，支持 **ReAct / Plan-and-Execute / Multi-Agent** 三种执行模式，通过 MCP 协议动态扩展工具能力，帮助开发者在终端与浏览器中完成编码、调试、重构等软件工程任务。

## 核心特性

- **三种执行模式**：`--mode react | plan | multi` 按任务复杂度切换 —— 快问快答用 ReAct，复杂任务用 Plan-and-Execute，大型工程用 Multi-Agent 子代理协作。
- **模型无关接入层**：内置 Anthropic / OpenAI / DeepSeek / Qwen 四家 Provider，支持任意 OpenAI 兼容网关，API Key 加密存储于本地；支持流式输出与模型路由。
- **工具生态开放**：内置核心工具（文件读写 / exec / web / memory / skill / task）+ MCP Server 动态扩展 + Skills 技能包。
- **长对话不失控**：token 预算管理 + 自动上下文压缩 + 三层记忆（会话内 / 项目 L2 长期记忆 / 蒸馏沉淀）。
- **权限与 Git 策略**：`plan`（只读）/ `default`（写需确认）/ `yolo`（双重确认后全放行）三档权限；`off | suggest | auto` 三档 git 提交策略。
- **沙箱执行**：macOS Seatbelt 为主要后端，Docker 可选；提供状态查看、启用/关闭、镜像拉取与 GC 运维命令。
- **CLI + Web 双形态**：终端里干活（Ink TUI），浏览器里管理项目、会话与模型配置（Vite + Vue）。
- **工程化配套**：桌面通知（F-33）、项目引导（F-34）、成本报告（F-31）、evals 评测集运行。

## 仓库结构（pnpm monorepo）

```
y-zero-agent/
├── packages/
│   ├── cli/      # @y-zero/cli —— CLI 入口与 Ink TUI，bin 命令 yzero
│   ├── core/     # @y-zero/core —— 引擎核心：会话、LLM 接入、工具、MCP、沙箱、记忆
│   ├── shared/   # @y-zero/shared —— 跨包共享的类型与工具函数
│   └── web/      # Web 控制台（Vite + Vue）
├── docs/         # PRD、各功能 PRD（prd-f30~f36）与技术设计文档
├── prototype/    # 原型
└── scripts/      # 构建/冒烟/钩子安装脚本
```

## 环境要求

- Node.js >= 20
- pnpm 9.15.9（`packageManager` 字段已锁定，可用 corepack 启用）

## 快速开始

```bash
# 安装依赖
pnpm install

# 构建全部子包
pnpm build

# 配置模型 Provider（Key 加密存储于 ~/.y-zero/models.json）
node packages/cli/dist/index.js models add anthropic -k <API_KEY> --default
# 或使用 openai 兼容网关
node packages/cli/dist/index.js models add my-gateway -k <API_KEY> --base-url https://example.com/v1

# 启动交互式 TUI
node packages/cli/dist/index.js
```

## 常用命令

根命令 `yzero`（开发阶段为 `node packages/cli/dist/index.js`）：

```bash
yzero [options]                     # 启动交互式 TUI 会话
  -r, --resume [sessionId]          # 恢复指定会话（缺省恢复项目最近会话）
  -m, --model <model>               # 指定模型名
  -p, --provider <name>             # anthropic | deepseek | qwen | openai
  --mode <mode>                     # react | plan | multi
  --permission <mode>               # plan | default | yolo（yolo 需再叠加 --yolo）
  --git <mode>                      # off | suggest | auto
  --max-turns <n>                   # 单任务最大轮次（默认 50）
  --db <path>                       # SQLite 路径（默认 ~/.y-zero/agent.db）
```

子命令：

| 子命令 | 说明 |
|--------|------|
| `yzero models add/list/remove` | 管理 Provider 配置（Key 加密存储） |
| `yzero memory` | 管理 L2 长期动态记忆 |
| `yzero sandbox status/enable/disable/pull/gc` | 沙箱运维（Seatbelt / Docker） |
| `yzero notify status/enable/disable/test` | 桌面通知（macOS / Windows） |

另有 `usage`（费用统计）、`evals`（评测集）、onboarding（项目引导）等子命令，详见 `docs/PRD.md` 与各功能设计文档。

## 开发

```bash
pnpm build        # 构建全部子包
pnpm test         # 运行全部测试（core 使用 vitest）
pnpm typecheck    # 类型检查
pnpm smoke        # 冒烟验证（web 冒烟：pnpm smoke:web）
pnpm clean        # 清理构建产物
```

在单个子包内执行：

```bash
pnpm --filter @y-zero/core test
pnpm --filter @y-zero/cli build
```

## 文档

- [docs/PRD.md](docs/PRD.md) —— 产品需求文档总览
- [docs/technical-design.md](docs/technical-design.md) —— 总体技术设计
- `docs/prd-f30~f36*.md` / `docs/design-f30~f36*.md` —— 各功能（容器沙箱、费用报告、模型路由、桌面通知、项目引导、CLI TUI）的 PRD 与设计
- [docs/prompt-design.md](docs/prompt-design.md) —— 提示词设计
- [docs/memory-design.md](docs/memory-design.md) —— 三层记忆设计
