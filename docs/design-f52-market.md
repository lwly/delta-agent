# F-52 Skills/MCP 市场最小闭环 —— 技术设计

> 版本：v1.0 ｜ 日期：2026-10-29 ｜ 配套：docs/prd-f52-market.md（PASI-20）
> 编号冲突标注同 PRD 文首：旧规划稿 f41-f53 的 F-52（安全护栏）与本项编号冲突，以 issue 口径为准。

## 1. 总体结构

在既有抽象上扩展，不旁路另起一套：

```
packages/core/src/market/
├── registry.ts   # ~/.delta/registry.json 订阅源读写（含旧 skill-hub.json 兼容回退）
├── catalog.ts    # 内置市场清单：Skills 复用 skill-hub-catalog SEED_SKILLS + 内置 MCP 条目
└── install.ts    # 清单合并快照 / 条目定位 / Skill 安装（scripts 闸门）/ MCP 测试+写入
packages/cli/src/market.ts        # delta market 子命令组
packages/web/src/components/settings/MarketPanel.vue   # 市场面板（替换 SkillHubPanel）
```

依赖方向合法：cli → core → shared；web 独立消费（DTO 在 `web/src/api/client.ts` 同构声明）。

## 2. registry 配置（`~/.delta/registry.json`）

```json
{ "sources": [ { "name": "community", "url": "https://example.com/registry.json", "kind": "skills" } ] }
```

- `kind: 'skills' | 'mcp'`（必填）。
- **旧配置兼容（读时迁移）**：`registry.json` 不存在时回退读 `skill-hub.json` 的 `sources`（视为 skills 源），保证既有 Web Skill Hub 用户无缝升级；一旦写入 registry.json 即以它为准。
- 原子写（tmp+rename）；坏 JSON 读取降级为空列表 + error 提示，不阻塞目录浏览。
- paths.ts 新增 `FILES.registry = 'registry.json'`（单一事实来源）。

## 3. registry 清单协议

订阅源 URL 返回 JSON（每次实时拉取，10s 超时，单源失败不阻塞）：

```jsonc
{
  "skills": [{
    "name": "deploy-check", "description": "...", "category": "运维",
    "version": "1.0.0", "author": "...", "triggers": ["deploy"],
    "toolsAllowlist": ["run_command"],
    "body": "# SKILL.md 正文（Markdown）",
    "scripts": [{ "name": "check.sh", "content": "#!/bin/sh\n..." }]   // 可选
  }],
  "mcpServers": [{
    "name": "everything", "description": "MCP 官方演示服务",
    "draft": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
    // 或 { "url": "https://...", "headers": { "Authorization": "..." } }
  }]
}
```

- Skill 条目字段沿用 `HubEntry`（skill-hub-catalog.ts），扩展可选 `scripts[]`；name 过 `validateConfigName` 校验。
- MCP 条目 `draft` 形状与 `McpServerConfig` 一致（command/url 二选一）。

## 4. 安装链路

### 4.1 Skill 安装（含 scripts 闸门，AC-52-3）

```
定位条目 → entry.scripts 非空？
  ├─ 是 & 未确认 → 返回 { status: 'scripts_required', scripts }（CLI 打印逐脚本内容后退出码 1；
  │                Web 返回 409 + scripts 清单，前端弹窗逐脚本展示）
  └─ 否/已确认 → writeSkill（SKILL.md，复用 config-store：名称校验 + safeJoin 防逃逸）
                → 逐脚本写入 <skillDir>/scripts/<name>（文件名过 validateConfigName，
                  拒绝路径分隔符/`..`；覆盖 = 先 deleteSkill 再写）
```

- **plan 权限模式拒绝安装（CLI）**：`delta market install --permission plan` 直接拒绝（退出码 1）。plan 是会话级只读语义，安装是写配置动作，两者互斥；Web 设置页无会话上下文，不做该检查（设计取舍，记录于交付摘要）。
- CLI 非交互（无 TTY）下 scripts 确认同样要求显式 `--yes`，保证脚本化场景确定性。

### 4.2 MCP 一键安装（AC-52-4）

```
定位条目 → testMcpConnectivity(draft)：McpManager.connect + listTools（Promise.race 15s 超时）
  ├─ 失败 → { status: 'connect_failed', error }（不写盘；报错附「下一步」：
  │          检查命令/URL/网络，或 delta mcp add 手工配置）
  └─ 成功 → readMcpConfigFile(scope) 合并新条目（headers 经 encryptMcpHeaders 加密落盘）
          → saveMcpConfig 原子覆盖 → { status: 'installed', toolCount }
```

- 连通性测试用一次性 `McpManager` 实例（name `__market_probe__`），测完 `disconnectAll`，不污染运行时连接。
- stdio 草案 spawn 前不校验命令白名单——连通测试本身就是执行；安装是用户显式行为，确认责任在清单条目的展示环节（描述经 untrusted 包裹提示）。

### 4.3 F-44 untrusted 口径（AC-52-1）

registry 拉取的远程条目 description/body 属外部内容，凡进入「预览」路径统一经 `wrapUntrusted(content, source)` 包裹，source 形如 `market:<源名>/<name>`：

- `GET /api/market/item` 响应附 `preview` 字段（wrapped 后文本），Web 预览与 CLI 确认卡显示 wrapped 内容并标注「不可信内容」。
- 安装落盘后的 SKILL.md 为用户确认过的本地文件，不再包裹（信任边界 = 确认动作）。
- 单测快照锁定远程条目预览必含 `<untrusted_content source="market:...">`。

## 5. 接口

### 5.1 CLI（`delta market`，注册进 KNOWN_SUBCOMMANDS）

| 命令 | 说明 |
|------|------|
| `delta market list [--source <name>]` | 合并清单（内置 + 订阅源），标注 kind / 来源 / 已装层；离线回退仅内置并提示 |
| `delta market search <query>` | 关键词过滤合并清单（清单式协议，客户端过滤） |
| `delta market install <name> [--kind skill\|mcp] [--source S] [--project] [--force] [--yes] [--permission <mode>]` | 安装；同名歧义要求 `--kind` |
| `delta market remove <name> [--kind] [--project]` | 卸载：skill 删对应层目录（内置拒绝）；mcp 从对应作用域 mcp.json 移除 |
| `delta market source list/add/remove` | 管理 `~/.delta/registry.json` 订阅源 |

### 5.2 Web 端点（packages/core/src/server/http.ts，挂在 /api/skill-hub 组之后）

| 端点 | 说明 |
|------|------|
| `GET /api/market?projectId=` | 快照 `{ items, sources, errors }`；items 含 kind/source/installedIn |
| `GET /api/market/item?kind=&source=&name=&projectId=` | 完整条目 + `preview`（远程内容 wrapped） |
| `POST /api/market/install` | `{ kind, source, name, scope, confirmScripts?, projectId? }`；skill scripts 未确认 → 409 + scripts；mcp 测试失败 → 502 |
| `DELETE /api/market/item?kind=&name=&scope=&projectId=` | 卸载（内置 Skill 拒绝 403） |
| `GET/PUT /api/market/sources` | registry.json sources 读写（PUT 走形状校验） |

既有 `/api/skill-hub*` 端点保留不动（向后兼容、既有测试不破坏）；Web 面板切换到 `/api/market`。

### 5.3 Web 面板

- `MarketPanel.vue` 替换 `SkillHubPanel.vue`（设置页分区 key `hub` → `market`，`?tab=hub` 兼容映射）。
- 两个页签：Skills（沿用原面板交互：搜索/分类/卡片/预览/按层安装/覆盖重装/卸载/源管理）+ MCP Server（卡片/连通测试进度/安装结果）。
- 安装进度态：`idle → fetching → testing（仅 mcp）→ writing → done/error`；scripts 409 弹窗逐脚本展示内容，确认后带 `confirmScripts: true` 重发。

## 6. 测试与门禁

- core 单测 `test/market.test.ts`：registry 读写/校验/旧配置回退；快照合并与离线降级（本地 http mock）；scripts 闸门全流程；MCP 连通测试失败（不可达 URL）与成功（本地假 JSON-RPC 服务，复用 mcp-f48 模式）；header 加密落盘；untrusted 预览包裹。
- core 端点测试 `test/market-server.test.ts`：/api/market 五端点（含 409/502/403 分支与写盘断言）。
- cli 单测 `test/market.test.ts`：plan 拒绝、scripts 未确认拒绝（纯守卫函数）。
- E2E：`e2e/cli/e2e-cli.mjs` 增市场段（脚本内起本地 registry http 服务：list → search → install（scripts 拒绝 → --yes 通过）→ skill list 加载可见 → remove）；Web Playwright `settings.spec.ts` 增市场面板路径（装内置 Skill → Skills 页签可见）。
- 门禁：`pnpm typecheck`、`pnpm test`、`pnpm smoke`、`pnpm smoke:web`。

## 7. 设计取舍与已知限制

| # | 取舍 | 理由 |
|---|------|------|
| D52-1 | registry.json 取代 skill-hub.json 作为市场源配置（读时兼容） | issue AC-52-1 指定路径；单文件统一 skills/mcp 源 |
| D52-2 | 清单式协议（JSON 内联 scripts/body）而非 zip 包 | 最小闭环；zip 安装保留在既有 `delta skill install`（skillhub.cn 协议） |
| D52-3 | plan 拒绝检查只落 CLI，Web 不做 | plan 是会话级权限，Web 设置页无会话上下文 |
| D52-4 | scripts 确认 CLI 用 `--yes` 而非交互 TTY prompt | 非交互确定性可测；交互式确认留待 TUI 后续 |
| D52-5 | MCP 连通测试 = connect + listTools | 「能连上且能列工具」是可安装的最小判据；不做工具试调用（有副作用风险） |
| D52-6 | 旧 /api/skill-hub 端点保留 | 向后兼容；MarketPanel 迁移后可在后续版本清理 |
