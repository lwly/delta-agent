# F-52 Skills/MCP 市场最小闭环 —— PRD

> 版本：v1.0 ｜ 日期：2026-10-29 ｜ 状态：已实现
> 来源：PASI-20（迭代 R3 ｜ P3 ｜ 依赖：F-44、F-48）
>
> **编号冲突标注**：旧规划稿 `docs/prd-f41-f53-next-round.md` §13 的「F-52」为**安全护栏**，
> 与本项（issue PASI-20 口径的「Skills/MCP 市场最小闭环」）编号冲突。本对文档以 issue 口径为准，
> 安全护栏需求不在本轮 issue 清单内，后续如立项应另取编号（沿用 F-50 的处理先例）。

## 1. 背景与目标

F-16 Skills 系统与 F-07/F-48 MCP 接入已就绪，F-21（插件市场）的远期目标先落地一个**不依赖评分/账号/云端的单机最小闭环**：本地 registry 清单（内置 + 订阅源）→ 浏览/搜索 → 一键安装 Skill 包或 MCP Server 配置。

既有 Skill Hub（`delta skill search/install`、Web Skill Hub 面板）只覆盖「纯 SKILL.md」技能；本项把市场统一为 `delta market` + Web 设置页市场面板，补齐三块缺口：

1. **统一 registry**：内置清单 + `~/.delta/registry.json` 订阅源（拉取内容走 F-44 untrusted 口径）。
2. **scripts/ 安全闸门**：含脚本的 Skill 包安装前强制逐脚本确认；plan 权限模式拒绝安装。
3. **MCP 一键安装**：配置草案 + 连通性测试通过才写入 mcp.json。

## 2. 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| US-52-1 | 进阶用户订阅社区 registry 源，浏览并搜索可装的 Skill 与 MCP Server | 清单 = 内置 + 订阅源合并，来源与安装状态可见 |
| US-52-2 | 用户一键安装一个 Skill | 落盘用户级 skills 目录，三层覆盖自动生效，无需重启 |
| US-52-3 | 用户安装含 scripts/ 的 Skill | 强制逐脚本展示内容并确认；plan 模式直接拒绝 |
| US-52-4 | 用户一键安装一个 MCP Server | 先连通性测试（列工具），通过才写 mcp.json；失败不落盘并给「下一步」 |
| US-52-5 | 离线用户打开市场 | registry 拉取失败自动回退仅内置清单，明确提示而非报错中断 |

## 3. 范围

**做**：
- `~/.delta/registry.json` 订阅源配置（`{ sources: [{ name, url, kind: skills|mcp }] }`；旧 `skill-hub.json` 的 `sources` 读取时自动兼容为 skills 源）。
- registry 清单协议：URL 返回 JSON `{ skills?: MarketSkillEntry[], mcpServers?: McpMarketEntry[] }`；Skill 条目可内联 `scripts: [{ name, content }]`。
- CLI `delta market list/search/install/remove/source`；安装含 scripts 的 Skill 强制确认（CLI 逐脚本打印 + `--yes`）；`--permission plan` 拒绝安装。
- MCP 一键安装 = 配置草案（stdio 或 streamable HTTP，含 header 模板）→ 连通性测试（连接 + listTools）→ 通过才写入（header 加密落盘，沿用 F-48 口径）。
- Web 设置页市场面板（卡片 / 搜索 / 安装进度 / scripts 二次确认弹窗 / MCP 连通测试进度），替换原 Skill Hub 面板。
- 离线降级：registry 拉取失败回退仅内置清单，单源失败不阻塞其他源。

**不做**：评分 / 账号 / 云端服务；版本对比与更新（沿用「覆盖重装」口径）；zip 包下载安装（既有 `delta skill install` 走 skillhub.cn 协议，保持不动）；MCP 配置的 UI 编辑（既有 MCP 设置页已覆盖）。

## 4. 验收标准（AC）

- **AC-52-1** registry = 内置清单 + `~/.delta/registry.json` 订阅源（拉取走 F-44 untrusted 口径：远程条目 description/body 在预览路径经 `wrapUntrusted` 包裹）。
- **AC-52-2** `delta market list/search/install/remove` 可用；Skill 装用户级目录（`--project` 装项目级），三层覆盖自动生效。
- **AC-52-3** 安装含 scripts/ 的 Skill 强制确认（逐脚本展示，CLI 未带 `--yes` 拒绝并展示；Web 弹窗二次确认）；plan 权限模式拒绝安装。
- **AC-52-4** MCP 一键安装 = provider 配置草案 + 连通性测试通过才写入；失败不落盘、报错附「下一步」。
- **AC-52-5** Web 设置页市场面板（卡片/搜索/安装进度）；E2E 覆盖安装→加载全链（触发由 Skill 触发匹配既有单测覆盖）。
- **AC-52-6** 离线降级：registry 拉取失败回退仅内置清单，单源失败不阻塞，错误状态可见。

## 5. 参考

- docs/design-f52-market.md（本项设计）
- docs/prd-f41-f53-next-round.md（旧规划稿，编号冲突见文首标注）
- F-44：docs 内 untrusted 口径（core/context/untrusted.ts）
- F-48：MCP streamable HTTP + header 加密（core/mcp/client.ts）
