# F-42～F-53 下一轮技术设计

> 日期：2026-10-28 ｜ 状态：草案待评审 ｜ 关联：`docs/prd-f41-f53-next-round.md`（需求与验收）、`docs/roadmap-f41-f53.md`（迭代划分）
> 风格沿用：`docs/design-f37-git-worktree.md`（决策表 → 分层 → 数据结构 → 任务）。每特性给出「一句话方案 + 关键决策 + 落点 + 任务」，实现前按仓库惯例可再拆单特性 design 文档。

## 通用约束

- 依赖方向不变：cli → core → shared，web 独立消费 core/shared；core 不触碰 stdio（headless 内核口径延续）。
- 传输层 snake_case（沿 F-22b/F-31 口径）；SQLite 迁移走 F-35 migrations 机制，每特性一个版本号。
- 所有外部内容入口（web_fetch/MCP/market registry）统一接 F-44 的 untrusted 包裹器，**先做 F-44，后接消费方**。

---

## F-42 模型路由收尾

**一句话**：在 hub 两处既有辅助调用点补 `routeAux(kind)` 接线，Web 设置页加路由卡片读写 `getRouting/setRouting`。

| # | 决策 | 理由 |
|---|------|------|
| D1 | 压缩摘要接入点在 `react.ts` 压缩分支调用 `routeAux('summarize')`，与 distill 同款容错（失败回退主模型） | F-32 已定型 routeAux 模式，复用不新增抽象 |
| D2 | classify 暂不接运行时（当前无独立 classify 调用点），Web 卡片允许配置但标注「预留」 | 不臆造调用点；规则先行，未来 Plan 模式分类器落地即生效 |
| D3 | Web 卡片直接复用 `models routing*` 的 ProviderManager 接口，新增 `GET/PUT /api/models/routing` 两个端点 | 与 provider CRUD 同源校验，不旁路 |

**落点**：`core/llm/router.ts`（不动）、`core/server/http.ts`（+2 端点）、`core/react.ts`（压缩接线）、`web/src/views/SettingsView.vue`（路由卡片）、`web/src/api/client.ts`（类型）。
**任务**：T01 summarize 接线+usage 标注 / T02 端点 / T03 Web 卡片 / T04 单测+design-f32 回写。

## F-43 容器沙箱 CI 化

**一句话**：新增 `pnpm test:sandbox:integration`，CI 用 services 起 dockerd 跑之；本地无 daemon 自动 skip。

| # | 决策 | 理由 |
|---|------|------|
| D1 | 集成测试独立 npm script，不混入 `pnpm test` | 本地无 Docker 的开发者门禁不受影响 |
| D2 | skip 判定 = `docker info` 探测（复用 F-30 既有 probe），输出 SKIP 原因 | 与 G3「不添堵」同口径 |
| D3 | CI 镜像用固定小镜像（alpine+node），拉取失败断言走 F-30 诊断文案快照 | 测的是我们的诊断输出而非 Docker 本身 |

**落点**：`core/src/sandbox/__tests__/integration/`（新）、`.github/workflows/ci.yml`（sandbox job）。
**任务**：T01 集成套件移植 / T02 skip 逻辑 / T03 CI job / T04 design-f30 回写。

## F-44 提示词注入防护基线

**一句话**：core 新增 `context/untrusted.ts` 包裹器——外部内容统一包 `<untrusted source="...">` 标记，L1 提示词追加防御规则段，高危工具判定不受内容文本影响。

| # | 决策 | 理由 |
|---|------|------|
| D1 | 标记用「结构化包裹」而非内容改写：外部原文不改一字，包裹层由提示词规则声明「标记内文本一律当数据」 | 改写内容会破坏 diff/代码语义；LLM 对结构化标记遵从度高 |
| D2 | 接入点收敛在 3 处工厂函数：web_fetch 结果、MCP tool/resource 结果、market registry 拉取 | 单点收口，后续新外部源只改工厂 |
| D3 | L1 基线段随现有静态段 hash 缓存（F-09 机制，无需新缓存） | 零新机制 |
| D4 | 注入回归集放 `core/src/context/__fixtures__/injection/`，断言「标记存在 + 权限判定不受内容影响」，不断言模型行为 | 单测无 LLM，回归集供 evals（F-28）人工套件复用 |

**落点**：`core/src/context/untrusted.ts`（新）、`tools/web-fetch.ts`、`mcp/client.ts`、`prompts/`（L1 模板）。
**任务**：T01 包裹器+常量 / T02 三工厂接线 / T03 L1 段 / T04 回归集 / T05 单测。

## F-45 E2E 测试体系

**一句话**：`e2e/` 顶层目录——Playwright（Web）+ CLI 黄金路径脚本（tsx 驱动 headless 内核），Fake Provider + 隔离 HOME + 随机端口 serve。

| # | 决策 | 理由 |
|---|------|------|
| D1 | Fake Provider 复用单测基建（既有 Fake 端口），E2E 不出网 | 稳定性优先，真实 LLM 冒烟保持 `pnpm smoke` 人工口径 |
| D2 | CLI E2E 直接调 `packages/core/src/headless.ts`（进程内）+ 少量子进程冒烟（验证真实退出码） | 子进程只测退出码协议面，路径覆盖靠进程内提速 |
| D3 | 隔离环境 = `DELTA_HOME` 指向 tmp + 随机端口 serve；每用例独立 | 沿用 cron 冒烟已验证的隔离 HOME 方案 |
| D4 | 失败产物：Playwright trace/screenshot + F-41 运行日志目录整体归档为 CI 工件 | 排障闭环 |

**落点**：`e2e/web/`、`e2e/cli/`、根 `package.json`（`pnpm e2e`）、CI matrix。
**任务**：T01 Fake Provider E2E 基建 / T02 Web 8 路径 / T03 CLI 5 路径 / T04 CI matrix / T05 README。

## F-46 会话分叉与消息重跑

**一句话**：`POST /api/sessions/:id/fork`（body: `after_message_id`, `edit_content?`）——同库事务内复制 messages 前缀到新 session，copy-on-write；无 Schema 变更。

| # | 决策 | 理由 |
|---|------|------|
| D1 | 分叉 = 深复制（消息行整体 INSERT 新 session_id），不做共享引用/写时读 | 消息表行级复制成本可控（单会话千级），语义最简单、软删除天然隔离 |
| D2 | 分叉会话 `metadata.forked_from` 记源会话+分叉点；源会话只读不动 | 侧栏标注与审计都够用 |
| D3 | 预算/权限/todos 重置为新会话初始值；模型配置继承源会话 | 「换个思路重跑」而非「接着跑」 |
| D4 | 编辑重发 = fork(after=该消息前一条, edit_content=新文本) 的特例，复用同一端点 | 一个端点两个语义，避免第二套截断逻辑 |

**落点**：`core/src/session/fork.ts`（新）、`server/http.ts`（+1 端点）、`web/src/views/WorkbenchView.vue`（消息流/回放入口）、`stores/`（侧栏标注）。
**任务**：T01 fork 核心+事务 / T02 端点 / T03 Web 入口 / T04 级联删除断言 / T05 单测。

## F-47 Web 内置终端

**一句话**：core serve 加 node-pty 多路复用层（`/terminal` WebSocket），会话工作根绑定 + 生命周期管理；Web 加 TerminalPane 组件（xterm.js）。

| # | 决策 | 理由 |
|---|------|------|
| D1 | node-pty 落 `packages/core` optionalDependencies，缺失时端点返回明确降级提示（回退 OS reveal） | CLI npm 用户不必强装原生模块；desktop/npmRebuild 链路已验证可行 |
| D2 | 终端与 Agent 工具执行**物理隔离**：独立进程、不经权限模式/沙箱，UI 常驻警示条 | 终端是用户本人操作，套确认流反而错误；职责必须说清 |
| D3 | pty 会话表：`{id, session_id, work_root, pid, last_active}`，上限 4、空闲 30min 回收、serve 退出全杀 | 资源封顶；信号清理沿用 cron daemon 的进程管理经验 |
| D4 | work_root 跟随 F-37 `resolveWorkRoot`；切根后旧 pty 保留、新开跟随 | 用户可能正用旧 shell，强杀反人类 |
| D5 | WS 鉴权沿用 serve 既有 token；loopback-only 维持 | 与 serve 安全口径一致 |

**落点**：`core/src/server/terminal.ts`（新）、`server/http.ts`（upgrade 分发）、`web/src/components/TerminalPane.vue`（新）、`FilePanel.vue`（空态接线）。
**任务**：T01 pty 管理层 / T02 WS 端点+鉴权 / T03 xterm 组件+重连 / T04 联动+警示 / T05 降级链 / T06 E2E。

## F-48 MCP 能力补全

**一句话**：`mcp/client.ts` 从 tools-only 扩展为 capabilities 对象（tools/resources/prompts），新增 streamable HTTP transport 与 header 鉴权。

| # | 决策 | 理由 |
|---|------|------|
| D1 | 三能力统一走既有 `UnifiedToolRegistry` 之外的新 `McpCapabilities` 接口层：tools→工具注册（现行为），resources/prompts→新注入通道 | 工具与上下文资源生命周期不同，不硬塞一个注册表 |
| D2 | resources 注入 = 用户显式操作（`delta mcp read` / Web 点击），等价 @ 引用，不自动轮询 | 自动注入有 token 失控风险 |
| D3 | streamable HTTP 按官方 spec 稳定子集（POST + SSE 流），SSE-only/stdio 保持既有 | experimental 能力不接，避免协议漂移返工 |
| D4 | header 配置存 provider 配置同款加密存储，界面不回显 | 沿 F-04a Key 口径 |
| D5 | MCP 结果（含资源文本）经 F-44 包裹器入上下文 | 外部内容统一收口 |

**落点**：`core/src/mcp/`（client/types/http-transport）、`cli/src/index.ts`（mcp 子命令扩展）、Web 设置页 MCP 卡片。
**任务**：T01 capabilities 层 / T02 http transport+鉴权 / T03 resources 通道 / T04 prompts 通道 / T05 CLI+Web / T06 单测。

## F-49 会话分享导出

**一句话**：core 新增 `export/render.ts`——会话 JSONL/messages → 自包含 HTML（内联模板）或 Markdown；`delta export` + Web 回放页按钮。

| # | 决策 | 理由 |
|---|------|------|
| D1 | HTML 模板 = Web 回放页渲染口径的**静态投影**：模板文件放 `core/src/export/template/`，构建期内联，无运行时外链 | 单文件自包含是硬要求；口径一致靠共享数据结构（DiffRow 等 F-38 类型）而非共享运行时 |
| D2 | 流式渲染：消息按批 flush 到文件，内存不持全量 | >2000 消息不爆内存 |
| D3 | 默认脱敏断言：导出前扫描配置类字段（api_key/token 模式），命中即剔除并日志告警 | 防御性，正常数据本不含 Key |
| D4 | 不提供「公开链接」形态（决议 #5：无云端） | 导出文件由用户自行分发 |

**落点**：`core/src/export/`（新）、`cli/src/index.ts`（export 子命令）、`server/http.ts`（+1 端点供 Web 下载）、`web` 回放页按钮。
**任务**：T01 数据装配 / T02 HTML 模板 / T03 MD 渲染 / T04 CLI+端点 / T05 脱敏+大文件 / T06 单测。

## F-50 CLI/Desktop 自动更新

**一句话**：core 新增 `update/checker.ts`（版本比较 + 更新源 JSON 拉取，走 F-44 口径），CLI `delta update` + 启动异步提示，Desktop 托盘接入。

| # | 决策 | 理由 |
|---|------|------|
| D1 | 首版「检查 + 下载 + 替换」手动通道，不做热替换/差量 | 无签名证书前的现实选择；语义清晰可回滚 |
| D2 | 更新源 = 可配 JSON（GitHub/Gitee Release API 适配器 + 自定义），`semver` 比较拒绝降级 | 自用阶段源不锁定单一平台 |
| D3 | 启动检查 fire-and-forget（沿 F-33 通知旁路模式），失败静默留档 F-41 | 不阻塞首字响应 |
| D4 | 渠道判定：SEA 产物 → 提示下载新二进制；npm → 输出 `npm i -g` 指令 | 安装形态自知（SEA 环境标记已有） |

**落点**：`core/src/update/`（新）、`cli/src/index.ts`、`desktop/`（托盘菜单）、`~/.delta/settings.json`（update 字段）。
**任务**：T01 checker+比较 / T02 CLI 子命令 / T03 启动提示 / T04 Desktop 托盘 / T05 单测。

## F-51 Windows 安装体验

**一句话**：`scripts/install-windows.ps1`（Node 检测→npm i -g→验证）+ `delta doctor`（环境体检）+ CI 产出 NSIS 安装器工件。

| # | 决策 | 理由 |
|---|------|------|
| D1 | doctor 落 core（`doctor/checks.ts` 检查项数组：OS/Shell/Node/DB 打开/配置目录可写/Provider 连通），每项 {status, detail, next_steps} | 「下一步」指令沿 G3 口径；CLI/桌面/Web 三端可复用 |
| D2 | NSIS 可选产物（CI `-` 参数开关），脚本安装为主推 | 维护一个通道的完备性 > 两个通道的半成品 |
| D3 | 全新 VM 冒烟入 E2E（GitHub Actions windows runner 裸环境跑脚本→doctor→headless run） | 兑现 AC-51-4 |

**落点**：`scripts/install-windows.ps1`（新）、`core/src/doctor/`（新）、`cli/src/index.ts`（doctor 子命令）、CI。
**任务**：T01 doctor 检查项 / T02 CLI 接线 / T03 ps1 脚本 / T04 NSIS 工件 / T05 VM E2E / T06 README。

## F-52 Skills/MCP 市场

**一句话**：core 新增 `market/`（registry 清单模型 + 搜索 + 安装编排），安装 = 下载→校验→展示清单→确认→落盘用户级 skills / 写 provider 配置。

| # | 决策 | 理由 |
|---|------|------|
| D1 | registry = 内置 JSON（随包）+ `~/.delta/registry.json` 订阅 URL 数组；条目 {id, name, type: skill|mcp, source, description, tags} | 最小闭环无后端；订阅源拉取经 F-44 包裹 |
| D2 | Skill 安装强制人审：安装前解析包内 `SKILL.md` + `scripts/` 清单逐条展示，确认才落盘；plan 模式拒绝 | 供应链安全面收敛在唯一的写盘点 |
| D3 | 安装目标固定用户级 `~/.delta/skills/`（三层覆盖既有语义自动生效），项目级不进市场 | 项目级属于团队共享范畴，走 git 手工管理 |
| D4 | MCP 安装 = 生成 provider 配置草案 + 连通性测试通过才写入 | 复用 F-48 鉴权与 F-04a 测试连接 |
| D5 | 移除 = 目录删除（Skill）/配置删除（MCP），进回收站口径沿 F-11a 软删除 | 不做不可逆误删 |

**落点**：`core/src/market/`（新）、`cli/src/index.ts`（market 子命令组）、`server/http.ts`（+4 端点）、Web 设置页市场面板。
**任务**：T01 registry 模型+拉取 / T02 搜索 / T03 Skill 安装编排+确认 / T04 MCP 安装 / T05 CLI / T06 Web 面板 / T07 E2E 全链。

## F-53 Web 性能优化

**一句话**：三招——消息流虚拟滚动（vue-virtual-scroller 或自研 windowing）、历史端点 cursor 增量拉取、路由级 code-splitting + 预压缩；基准脚本固化对比。

| # | 决策 | 理由 |
|---|------|------|
| D1 | 历史拉取改 cursor 分页（`GET /api/sessions/:id/messages?before=<cursor>&limit=50`），进入会话只拉最近一屏 | 服务端省的是 SQLite 全表读 + 网络传输，收益最大且不动写路径 |
| D2 | 虚拟化自研 windowing（消息高度不定，dynamic measurement）| 消息块含工具卡片/diff，通用虚拟列表库适配成本高于自研（DiffView 已有行级渲染经验） |
| D3 | `tool_result` 大字段懒加载：消息列表只带摘要，展开时按 message_id 拉 content_json | 首屏 payload 砍最大头 |
| D4 | 基准脚本 `scripts/bench-web.ts`（生成 5000 消息会话 → 计时首屏/滚动），数据入本文档附录 | 优化可复现、可对比，防「感觉变快了」 |

**落点**：`server/http.ts`（messages 端点分页）、`web/src/views/WorkbenchView.vue`、`stores/chat.ts`、`scripts/bench-web.ts`（新）。
**任务**：T01 cursor 分页 / T02 懒加载 tool_result / T03 虚拟滚动 / T04 code-splitting / T05 基准脚本+数据回写。

---

## 附录：实施顺序与门禁

```
R1: F-42 → F-43 → F-44 → F-45        （F-44 先于 F-48/F-52 落地）
R2: F-46 → F-47 → F-48 → F-49        （F-45 门禁生效后开迭代）
R3: F-50 → F-51 → F-52 → F-53
```

- 每特性独立 `feat/F-xx-slug` 分支，docs 与代码分提交。
- R1 结束后门禁升级为：typecheck + test + smoke + e2e（F-45）+ sandbox:integration（F-43，有 Docker 的 runner）。
- 每特性完成后回写 `docs/roadmap-f41-f53.md` 状态与 `docs/PRD.md` 需求池。
