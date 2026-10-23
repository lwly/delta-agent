# F-36 CLI TUI 细节 —— 技术设计

> 日期：2026-10-23 ｜ 关联：docs/prd-f36-cli-tui.md ｜ 样例沿用：F-30/F-33/F-34（成对文档 / 失败静默）

## 1. 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D1 | diff 生成落 **core**（`diff/lines.ts`：`diffLines` LCS + `compactDiff`），渲染落 CLI（`ui/diff-view.tsx`）；**零新增 npm 依赖**（不引 `diff` 库） | 快照数据本就在 core（FileChangeStore before/after）；LCS 行对比 ~60 行可测代码优于新增依赖树；单测在 core 落地（cli 无测试设施） |
| D2 | diff 数据在 `tool_result` 事件时**取最新快照**（`changes.list(sessionId, 10)` 按路径+工具名匹配、排除已回滚行），而非工具层改 payload | 工具层与 UI 解耦（registry 不感知 TUI）；快照在工具执行期间同步落库，tool_result 时必已就绪；不匹配/超大/异常一律返回 undefined，锦上添花不阻塞 |
| D3 | 输入双侧 >2000 行降级为单行占位；输出经 `compactDiff` 截断 40 行（变更行 ±2 上下文、连续省略折叠单占位） | minified/锁文件类大文件会拖死 TUI；折叠保证 hunk 可读 |
| D4 | 主题 = `ui/theme.ts` 语义色 token + 图标常量；`NO_COLOR` 置位全色降级 undefined；只用 Ink 内置 16 色命名色，**不引 supports-color/truecolor** | 零依赖约束（对齐 F-33 D2 的"系统自带"取向）；16 色在深浅色终端均安全；token 替换 app.tsx 8 处 + confirm.tsx 3 处硬编码 |
| D5 | spinner 用盲文字符帧（80ms setInterval 自绘），**不引 ink-spinner** | 10 行代码 vs 新依赖；帧仅在 running 时启动，停止即清理 |
| D6 | 轮次进度条仅在**显式设置有限 maxTurns（≤1000）**时渲染 `[████░░░░]`；状态行常显 `第 n 轮 · tokens · $费用` | 默认 maxTurns 很大（无上限语义）时进度条无意义；tokens/费用复用既有 usage state（F-31） |
| D7 | 流式光标 = pending assistant/thinking 项尾部 `▋`（暗色），run finally 统一收起；thinking_delta 渲染为暗色流式块、**不入库** | 引擎本就 yield thinking_delta（此前 default 分支丢弃）；光标随 pending 状态自然进出，无额外状态机 |
| D8 | todo 进度：todo_write 工具结果成功后追加一行 `📋 N/M 完成`（ctx.todos 引用即 todosRef，无需新事件） | todo_write 无独立 AgentEvent；引新事件会动引擎，违背入口层改动原则 |

## 2. 抽象分层

```
packages/core/src/diff/lines.ts    diffLines（LCS 行对比）/ compactDiff（上下文折叠 + 截断）
packages/cli/src/ui/theme.ts       语义色 token + icons 常量 + NO_COLOR 降级
packages/cli/src/ui/diff-view.tsx  DiffView 组件（+绿 / -红 / ctx 暗）
packages/cli/src/ui/app.tsx        状态行（spinner/轮次/进度条/tokens/费用）、流式光标、
                                   thinking 流、tool_result 挂 diff、todo 进度行
packages/cli/src/ui/confirm.tsx    主题色替换 + edit_file 彩色对照预览（EditPreview）
```

关键接口：

```ts
function diffLines(before: string, after: string): DiffLine[];   // { type: 'add'|'del'|'ctx', text }
function compactDiff(lines: DiffLine[], maxLines?): DiffLine[];  // ±2 上下文 + 折叠省略
```

## 3. 测试策略

- core：`test/diff.test.ts` 8 例——增删/上下文标记、纯插入/纯删除、空输入（空串视为 0 行）、超大降级占位、中部 hunk 连续性、compactDiff 上下文窗口/折叠/截断/预算内原样。
- UI 组件不引入渲染测试（cli 包无测试设施，与既有惯例一致）；TUI 行为以 typecheck + 构建通过 + 人工冒烟兜底。

## 4. 风险与裁决

| 风险 | 裁决 |
|------|------|
| LCS O(n·m) 被超大文件卡死 | D3 双保险：输入侧 2000 行降级 + 输出侧 40 行截断 |
| 快照与工具结果不匹配（并发/乱序） | 按路径+工具名取最新一条且排除已回滚；不匹配就不显示 diff，不影响结果文本 |
| pending 项文本前缀匹配本就脆弱 | 顺手把工具成败从 `startsWith('⚙')` 前缀判断改为结构化 `ok` 字段着色；匹配机制本身维持不变（重构属 F-36 范围外） |
| 每帧全量重渲染的性能 | 本期不做 `<Static>` 改造（范围外）；spinner 帧独立 setState 不触碰 items |
