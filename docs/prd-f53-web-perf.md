# F-53 Web 性能优化：虚拟滚动 + 增量拉取 —— PRD

> 版本：v1.0 ｜ 日期：2026-10-29 ｜ 状态：已实现
> 来源：PASI-21（迭代 R3 ｜ P3 ｜ 依赖：无）
>
> **编号冲突标注**：旧规划稿 `docs/prd-f41-f53-next-round.md` §14 的「F-53」为 **Windows 原生沙箱**，
> 与本项（issue PASI-21 口径的「Web 性能优化」）编号冲突。本对文档以 issue 口径为准，
> Windows 沙箱需求不在本轮 issue 清单内，后续如立项应另取编号（沿用 F-50/F-52 的处理先例）。

## 1. 背景与目标

PRD 非功能指标中有两项 Web 侧承诺：**首屏 ≤ 1.5s**、**大会话不卡**。现状是消息历史端点一次性返回全量
`ChatMessage[]`（5000 条 + 大 tool 输出可达数 MB），chat store 打开会话与每次 `done` 都整体重拉重渲染；
消息流 `v-for` 无窗口化，DOM 节点数随消息总量线性增长。本项交付 Web 侧性能闭环：**游标分页增量拉取 +
tool 大字段懒加载 + 消息流窗口化渲染 + 构建/传输层预压缩**，并把基准脚本与性能预算固化进 E2E。

## 2. 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-53-1 | 用户打开一个 5000 条消息的历史会话 | 首屏只拉最近一屏，秒级可见；滚动/跳转不卡 |
| US-53-2 | 用户向上翻阅历史 | 「载入更早消息」按需前缀加载，视口无跳动 |
| US-53-3 | 用户展开一个大输出的工具卡 | 摘要即看；点「加载完整输出」才拉全文 |
| US-53-4 | 用户的会话列表有上百个会话 | 侧栏分页加载，触底自动续拉 |
| US-53-5 | 团队维护性能基线 | 基准脚本入库，优化前后数据回写设计文档；预算写入 E2E 断言 |

## 3. 范围

**做**：
- 消息历史游标分页端点：`GET /api/sessions/:id/messages?limit|before|after`（seq 游标，首屏 = 最近一屏）。
- tool_result 摘要化：分页端点对超 4000 字符的 tool 消息只下发头部 + `contentTruncated/contentLength` 标记；
  全文走 `GET /api/sessions/:id/messages/:seq/content` 懒加载。
- 会话元信息端点 `GET /api/sessions/:id/meta`（打开会话不再连带全量消息）。
- 会话列表游标分页：`GET /api/projects/:id/sessions?limit&before`（`updated_at|id` 复合游标，同毫秒不丢页）。
- Web：chat store 首屏分页 + `loadOlder` 前缀加载 + `done` 事件改 `after` 增量校准（替代全量重拉）；
  消息流窗口化渲染（常驻 DOM 有界）；ToolCallCard「加载完整输出」；侧栏触底分页。
- 构建：vite `manualChunks`（vendor / markdown 共享 chunk）+ 构建期预压缩 `.gz`；
  `delta serve` 静态托管按 `Accept-Encoding` 优先回预压缩文件。
- 基准脚本 `scripts/bench-web-perf.mjs`（优化前后端点对比）+ `e2e/web/perf.spec.ts`（5000 消息性能预算）。

**不做**：动态高度真虚拟列表（窗口化渲染 + 分页已满足 DOM 有界目标，见设计文档 §4 权衡）；
服务端 HTTP 压缩中间件（构建期预压缩已覆盖）；旧全量端点下线（CLI / 回放 / 导出仍在用，兼容保留）。

## 4. 验收标准（AC）

- **AC-53-1** ≥5000 条消息会话滚动/跳转流畅；性能预算写入 E2E 断言（`e2e/web/perf.spec.ts`：首屏 ≤ 8s、
  `.msg` 节点 ≤ 60、展开后 < 210）。
- **AC-53-2** 会话列表 cursor 分页；侧栏搜索走 F-17 索引（`SearchModal → /api/search*`，既有链路未变）。
- **AC-53-3** 消息历史端点支持 before-cursor 增量拉取；首屏只拉最近一屏（50 条）。
- **AC-53-4** tool_result 摘要化列表 + 按需拉取全文（`contentTruncated` 标记 + `:seq/content` 端点）。
- **AC-53-5** code-splitting + 静态资源预压缩；基准脚本入库，优化前后数据回写设计文档 §6。

## 5. 依赖与影响面

- 无前置依赖；`GET /api/sessions/:id` 全量端点保持不变（CLI/回放/导出兼容）。
- 影响：packages/core（server/session）、packages/shared（ChatMessage 协议字段）、packages/web、scripts、e2e。
