# F-36 CLI TUI 细节 —— PRD 增量

> 状态：已实现 ｜ 日期：2026-10-23 ｜ 关联：docs/PRD.md §3.2 F-36

## 1. 需求回顾

PRD F-36：**diff 彩色渲染、任务进度条、流式输出光标、主题适配**。

现状痛点（实现前）：TUI 只有 2 个文件、零着色库依赖；工具结果纯文本（edit/write 只有 "edited path" 一句话）；运行状态是静态文本 `任务运行中…`；思考过程（thinking_delta）被直接丢弃；颜色硬编码散布 11 处；无 `NO_COLOR` 处理。

## 2. 需求细化为验收标准

| # | 验收项 |
|---|--------|
| AC-1 | diff 彩色渲染：edit_file / write_file 工具结果自动附行级 diff（+ 绿 / - 红 / 上下文暗色），数据取 FileChangeStore 已落库的 before/after 快照；超大文件（任一侧 >2000 行）降级占位不卡 UI；渲染截断到 40 行（变更行 ±2 行上下文，连续省略折叠为单行占位） |
| AC-2 | 确认前预览：edit_file 确认卡对 old_string/new_string 逐行彩色对照（旧红 / 新绿，各截 10 行），先看后批 |
| AC-3 | 任务进度：运行状态行动态化——盲文 spinner 动画帧 + 当前轮次（turn_start 驱动）+ 显式设置有限 maxTurns 时渲染 `[████░░░░░░]` 进度条 + 进程累计 tokens/费用；todo_write 后立即显示 `N/M 完成`（不必手动 /todos） |
| AC-4 | 流式光标：assistant 流式输出与思考流尾部带 `▋` 光标（暗色），运行结束/工具调用打断时收起 |
| AC-5 | 思考过程可见：thinking_delta 渲染为暗色流式块（原先被丢弃），不写入会话历史 |
| AC-6 | 主题适配：语义色 token 与状态图标收拢到 `ui/theme.ts` 单一模块；`NO_COLOR` 置位时全部颜色降级为纯文本；颜色只用 Ink 内置 16 色命名色（深浅色终端均安全），零新增依赖 |
| AC-7 | 行级 diff 生成落 core（`diffLines` LCS + `compactDiff` 上下文折叠），单测覆盖（增删/上下文/空输入/超大降级/折叠截断）；diff 失败静默不影响主流程 |

## 3. 范围外（本期不做）

- 历史消息移入 Ink `<Static>`（长会话全量重渲染的性能优化，独立议题）
- Multi-Agent 子任务聚合视图（N/M 节点 DAG 缩略；现保持逐事件行）
- truecolor 主题 / 自定义配色文件（16 色命名色已够用）
- thinking 块折叠/展开交互
