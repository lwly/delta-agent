# F-53 Web 性能优化：虚拟滚动 + 增量拉取 —— 设计文档

> 版本：v1.0 ｜ 日期：2026-10-29 ｜ 状态：已实现 ｜ 成对 PRD：`docs/prd-f53-web-perf.md`
> 来源：PASI-21。编号冲突标注见 PRD 卷首（旧规划稿 F-53 = Windows 沙箱，以 issue 口径为准）。

## 1. 总体方案

三层解耦，每层独立可测：

```
存储层   messages 表 (session_id, seq) 索引 + seq 游标 SQL        → store.getMessagesPage / getMessageBySeq
         sessions 表 (updated_at DESC, id DESC) 复合游标            → store.listSessionsPage
协议层   GET /api/sessions/:id/messages?limit|before|after          → 分页 + tool 摘要化（summarizeToolContent）
         GET /api/sessions/:id/messages/:seq/content                → 大字段全文懒加载
         GET /api/sessions/:id/meta                                 → 打开会话不再连带全量消息
         GET /api/projects/:id/sessions?limit&before                → 会话列表分页
渲染层   chat store：首屏一页 + loadOlder 前缀 + done 用 after 增量校准
         WorkbenchView：窗口化渲染（RENDER_WINDOW=120，步长 80）+ scrollTop 补偿
```

## 2. 关键决策

| # | 决策 | 理由 | 放弃的替代方案 |
|---|------|------|----------------|
| D1 | 游标用落库 `seq`（消息）/`updated_at\|id` 复合（会话） | `idx_messages_session(session_id, seq)` 索引已存在（migrations v1）；复合游标解决同毫秒 created 批量会话丢页 | offset 分页（深翻页 O(n) 且新消息写入会漂移） |
| D2 | 分页端点独立于旧 `GET /api/sessions/:id` | CLI resume、回放、导出仍依赖全量语义；避免大爆炸迁移 | 给旧端点加 `?messages=page` 参数（语义混杂） |
| D3 | tool 摘要化在 HTTP 层做（`summarizeToolContent`），存储不动 | 摘要是传输/展示关注点；CLI/导出仍需全文；免迁移 | 新列拆分 content（v6 迁移，成本高收益低） |
| D4 | done 增量校准：`after=lastSeq` 循环拉取（上限 500/页 × 50 轮） | 原全量重拉在大会话是最大卡点；SSE 未锚定的本地尾部消息整体替换，UI 字段按 `role\0content` 回带（沿用原机制） | SSE 逐条 ack 对账（协议改动面大） |
| D5 | 消息流用**窗口化渲染**而非动态高度真虚拟列表 | 消息高度差异极大（md/图片/details/工具卡），自研测量缓存易抖动；窗口化 + 分页后常驻 DOM ≤ WINDOW+步长，5000 条会话实测首屏 837ms（见 §6），已满足预算 | `vue-virtual-scroller` 等依赖（引入动态高度场景仍需逐项适配，收益边际） |
| D6 | 预压缩在 vite `closeBundle` 钩子内做，不引第三方插件 | node:zlib 直用，产物确定性；serve 端按 `Accept-Encoding` 回 `.gz`，无 `.gz` 回退原文件 | vite-plugin-compression2（多一个依赖，收益相同） |

## 3. 协议细节

- `messages` 分页响应：`{ messages: [{ seq, message }], has_more, next_before }`；无 `before/after` = 最近 limit 条
  （升序返回）；`before` = seq 之前一页（向上翻）；`after` = seq 之后增量（done 校准）。limit 钳制 1..500，缺省 50。
- 摘要化阈值：tool 消息 content > 4000 字符 → 下发头 1200 字符 + `…[已摘要化：完整输出共 N 字符…]`，
  `contentTruncated: true`、`contentLength: N`（shared ChatMessage 协议字段）。小输出原样。
- Web 客户端（client.ts）把 `{seq, message}` 展平为 `ChatMessage & {seq}`，store 统一消费。

## 4. 前端窗口化与滚动锚定

- `visibleMessages = messages.slice(-RENDER_WINDOW - windowExtra)`；折叠数 `hiddenCount > 0` 时顶部出
  「载入更早消息（已折叠 N 条）」；点击先扩窗口（纯本地），耗尽后再走 `chat.loadOlder()` 前缀拉取。
- 滚动锚定：前缀插入/窗口扩大后按 `scrollHeight` 差值补偿 `scrollTop`；补偿经 `pendingScrollAdjust`
  交给 messages watcher 消费（避免旧「任何长度变化都滚到底」逻辑把翻页打回底部）。
- 消息 `:key` 从数组下标改为 `m.seq ?? local-<i>`，前缀插入不再触发整窗重挂载。
- 侧栏：`.sidebar-scroll` 触底 40px 内调 `ws.loadMoreSessions()`（防重入），页大小 50。

## 5. 构建与静态托管

- `manualChunks`：`vendor`（vue/router/pinia）+ `markdown`（markdown-it + highlight.js，1.05MB → 独立 chunk）。
- 预压缩：`packages/web/vite.config.ts` 内联插件 `f53-precompress-assets`（≥1KB 文本产物 gzip -9，压后不省则跳过）。
- `createWebServer` 静态分支：`Accept-Encoding: gzip` 且存在 `file.gz` → 回 `.gz`（`content-encoding: gzip`，
  `vary: Accept-Encoding`）；SPA fallback 的 index.html 同口径。

## 6. 基准数据回写（AC-53-5，scripts/bench-web-perf.mjs）

环境：macOS arm64，临时 DB，5000 条消息（含 500 条 6KB tool 输出）+ 100 个会话，各预热一次后测量：

| 指标 | 旧口径（全量） | 新口径（分页/懒加载） | 改善 |
|------|---------------:|----------------------:|------|
| 消息历史 首屏 | 19.8 ms / 3165 KB | 2.7 ms / **10 KB**（?limit=50） | 传输 ↓ 316× |
| 向上翻页（50 条） | —（只能全量） | 1.0 ms / 10 KB（?before） | — |
| done 增量校准 | ≈19.8 ms / 3165 KB（原全量重拉） | 2.1 ms / 2 KB（?after 10 条新增） | 传输 ↓ 1500× |
| tool 全文 | 随全量下发 | 2.1 ms / 6 KB（按 seq 懒加载） | 不再随页传输 |
| 会话列表 | 3.8 ms / 31 KB | 2.4 ms / 16 KB（?limit=50） | 会话数越多差距越大 |
| E2E：5000 消息会话首屏（点击→消息可见） | — | **837 ms**（预算 ≤ 8000 ms，`e2e/web/perf.spec.ts`） | DOM 节点 ≤ 60（与总量无关） |

## 7. 测试与发布口径

- 单测：`packages/core/test/messages-page-api.test.ts`（7 用例：首屏/翻页/after 增量/边界/摘要化/懒加载/会话分页）；
  `packages/web/src/stores/chat-page.test.ts`（4 用例：open 分页/loadOlder/done 增量/expandToolContent）。
- E2E：`e2e/web/perf.spec.ts` 需 `E2E_SEED_MESSAGES=5000` 启动 serve（`scripts/e2e-serve.mjs` 预置种子会话）；
  常规套件未注入种子时自动 skip，不阻塞普通 CI。
