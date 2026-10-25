# F-34 项目 onboarding —— PRD 增量

> 状态：已实现 ｜ 日期：2026-10-23 ｜ 关联：docs/PRD.md §3.2 F-34、docs/memory-design.md（三层记忆）

## 1. 需求回顾

PRD F-34：**新项目首次启动自动扫描：生成项目摘要、目录结构、初始静态记忆，引导确认**。

痛点：agent 在一个新项目里冷启动时对项目一无所知——技术栈、模块划分、构建/测试命令都要靠当轮摸索或人工口述。三层记忆（memory-design.md）中 L3 静态记忆（`.delta/agent.md` / `MEMORY.md`）只有"读"（注入 Prompt）没有"写"，项目知识无法沉淀。

## 2. 需求细化为验收标准

| # | 验收项 |
|---|--------|
| AC-1 | 新项目首次注册（`ensureProject` 首次创建）时自动触发一次扫描：收集目录树（限深限条、跳过 node_modules/.git/dist 等噪声目录）、README 头部、根目录工程清单（package.json / pom.xml / go.mod 等），全程只读 |
| AC-2 | 用一次 LLM 调用（仿 distillMemories 的一次性调用模式）生成三件产物：项目摘要（一段话）、agent.md 草案（项目摘要 + 目录结构 + 工作约定，只依据材料可推断的事实，无把握标注（待确认））、MEMORY.md 草案（5-10 条团队共享静态记忆条目）；输出按分段标记承载（缺标记时兜底围栏 JSON），对弱模型的未转义字符稳健 |
| AC-3 | 产物先落**草案文件**（`.delta/agent.md.draft` / `MEMORY.md.draft`）+ 状态文件 `.delta/onboarding.json`（status=draft），**引导确认**而非直接生效 |
| AC-4 | `delta onboarding confirm` 采纳草案改名到位；目标文件已存在时**绝不覆盖**（团队共享文件可能含手工维护内容），草案保留并提示手工合并 |
| AC-5 | `delta onboarding status / run / confirm / skip` 子命令组；`run --force` 可忽略状态重新生成；`skip` 后不再自动扫描 |
| AC-6 | 三端生效：TUI（后台 fire-and-forget，不阻塞启动）、Headless（同步扫描一次，失败静默）、Web serve（后台触发，完成后打印提示）；扫描/生成失败一律静默或提示，状态留在 pending 下次重试，**绝不影响主流程** |
| AC-7 | 状态文件读写永不 throw（坏 JSON 视为 pending）；写入 tmp+rename 原子写；`auto: false` 可关闭自动扫描 |
| AC-8 | 单测覆盖：目录扫描（噪声过滤、空目录）、生成（含围栏 JSON 容错、解析失败保持 pending）、确认（改名到位、拒绝覆盖目标）、跳过/自动开关；不真调 LLM（伪 provider） |

## 3. 范围外（本期不做）

- L2 动态记忆的初始写入（PRD 只要求"初始静态记忆"；L2 走既有 distill 待确认队列）
- TUI 内的确认卡交互（CLI `confirm` 已闭环；TUI 用 CLI 命令采纳）
- F-32 模型路由接入（草案生成暂用会话主模型，后续可注册路由 kind）
- Web 控制台 onboarding 面板
