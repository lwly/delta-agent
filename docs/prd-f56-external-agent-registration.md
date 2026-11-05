# F-56 PRD：外部 Agent 手动注册 + 探测扩展至 6 CLI

> 状态：已评审 ｜ 日期：2026-11-05 ｜ 编号：F-56 ｜ 设计：`docs/design-f56-external-agent-registration.md` ｜ 跟踪：PASI-87

## 背景与目标

F-55 把外部 CLI Agent 做成了 delta 的第 4 种执行后端，但接入通道只有**被动探测**（PATH 扫描 `claude`/`codex`），用户无法主动注册。产品要求：

1. **自动探测与手动注册双通道并存**：保留 PATH 探测，新增手动注册——交互模式对齐 Multica「新建自定义运行时」两步向导（第 1 步从内置 CLI 模板网格点选基础运行时，第 2 步填显示名称 / 命令 / 描述）。
2. **覆盖 6 个 CLI**：claude / codex / codebuddy / cursor / opencode / dsh。

**与 F-55 设计稿 §10 的决策冲突修订（显式声明）**：F-55 曾定「只探测不注册、不做手动添加」；F-56 推翻「不做手动注册」半边——手动注册的是**本机已存在 CLI 的入口信息**（命令/名称/描述），不是安装包，凭证红线（AC-55-9）不变。「不自动下载/安装」仍然成立。

## 用户故事

1. **订阅用户（CLI 未在 PATH）**：本机装了 codebuddy 但不在 PATH——向导第 1 步点选「CodeBuddy Code」，第 2 步填绝对路径与名称，注册后模型选择器出现 `cli:codebuddy`。
2. **多实例用户**：PATH 上的 claude 用默认探测，另注册一个自定义命令的条目打不同登录态；两者在面板中按 displayName 区分。
3. **无适配器 CLI 用户**：注册 dsh（Tier D 预留档）成功，选它启动会话时收到 `external_unsupported_protocol` 明确报错，不静默。

## 范围

- **做**：内置模板注册表（6 CLI：label/description/executable/kind/tier/protocolArgs）；`external.json` schema 扩展（`manual`/`displayName`/`description` 白名单字段，旧文件零迁移）；探测四级优先级（env > 手动 > 缓存 > PATH）；手动条目探测失败不移除、探测不覆盖手动字段；ACP 适配器工厂接线（codebuddy `--acp` / cursor `acp` / opencode `acp`）；Tier D 预留档 stub（`external_unsupported_protocol`）；Web 两步向导 + `GET templates`/`POST`/`DELETE` 三端点；CLI `delta agents templates|add|list|remove`。
- **不做**：自动下载/安装/代登录；同一模板多实例（v1 一个模板一个手动条目，upsert 语义）；无模板的完全自定义条目（第 1 步必须点选模板）；dsh 协议适配器实现（仅预留）。

## 验收标准

- **AC-56-1** 向导第 2 步注册 codebuddy 后，`~/.delta/external.json` 出现 `manual:true` 条目，含 displayName/command/description。
- **AC-56-2** 手动条目在面板与模型选择器可见，displayName 优先展示；来源标签为「手动注册」。
- **AC-56-3** opencode/cursor 注册后本机可启动则按 ACP 跑通；不可用时启动报明确协议错误，不静默。
- **AC-56-4** dsh 注册成功但启动时报 `external_unsupported_protocol`（预留档）。
- **AC-56-5** 手动条目优先于探测缓存；探测失败不移除手动条目；探测刷新不覆盖 manual/displayName/description。

## 里程碑

单阶段（PASI-87 一次交付）：模板表 + 探测合并 + 适配器接线 → Web 向导/端点 → CLI 命令 → 成对文档。

## 风险与声明

- cursor-agent 本机二进制损坏（dyld，macOS 版本不匹配）、opencode 本机未安装——协议经官方文档核实但**运行时实测待真机验证**，与 F-55 兼容性表同口径记录。
- 手动条目 probe 失败时版本串为注册时快照（可能过期）——面板照常展示，不虚报。
- Web 向导不做模板外自由注册：防止用户把非 agent CLI 注册进来后启动行为不可预期。
