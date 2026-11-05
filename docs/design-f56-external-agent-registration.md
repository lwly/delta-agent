# F-56 设计：外部 Agent 手动注册 + 探测扩展至 6 CLI

> 日期：2026-11-05 ｜ PRD：`docs/prd-f56-external-agent-registration.md` ｜ 上游：`docs/design-f55-external-cli-agents.md`（§10 修订）｜ 跟踪：PASI-87

## 1. 总体方案

在 F-55 探测层（`core/src/external/detect.ts`）上做**增量扩展**，不改适配器协议层与映射引擎：

```
手动注册（Web 向导 / CLI agents add）
        │ upsertManualEntry()（校验 + 白名单写 external.json）
        ▼
~/.delta/external.json（manual:true 条目）
        │
        ▼
detectExternalAgents() 四级优先级：env > manual 缓存 > 探测缓存 > PATH
        │
        ▼
ensureExternalAdapters() 按 kind 分派工厂：acp→AcpExternalAdapter /
app-server-jsonl→CodexExternalAdapter / stream-json-jsonl→StreamJsonExternalAdapter /
reserved→ReservedExternalAdapter（stub）
```

## 2. 模板注册表（KNOWN_AGENTS 扩展）

`KnownAgentDef` 新增字段：`label`（展示名）、`description`（向导卡片描述）、`protocolArgs?`（协议入口参数，`detectedToSpec` 透传到 `spec.args`，适配器组装启动行时前置）、`modelArgs?`（F-56 指定模型的 flag 形态与放置位置）。

6 模板协议矩阵（2026-11-05 本机 `--help` 实测 + 官方文档核实）：

| id | executable | kind | tier | protocolArgs | 指定模型 flag | 启动形态 | 权限档 |
|---|---|---|---|---|---|---|---|
| cli:claude-code | claude | stream-json-jsonl | B | —（适配器自组 `-p`） | `--model`（适配器组装） | F-55 既有 | plan/yolo flags 既有 |
| cli:codex | codex | app-server-jsonl | C | —（适配器自带 `app-server`） | `-c model=…`（适配器组装，app-server 无 --model flag） | F-55 既有 | F-55 既有 |
| cli:codebuddy | codebuddy | acp | A | `['--acp']` | `--model`（protocolArgs 之后） | `codebuddy --acp`（ndJsonStream，--help 实测） | plan: `--permission-mode plan`；yolo: `--dangerously-skip-permissions` |
| cli:cursor-agent | cursor-agent | acp | A | `['acp']` | `--model`（acp 之后，官方 docs/cli/acp） | `cursor-agent acp` | 会话内协商，flags 空 |
| cli:opencode | opencode | acp | A | `['acp']` | `-m`（acp **之前**，根命令全局 flag，官方 docs/models） | `opencode acp` | 会话内协商，flags 空 |
| cli:dsh | dsh | reserved | D | — | —（预留档不支持） | 不启动 | —（stub 报错） |

登录态文件（只判存在性）：codebuddy `~/.codebuddy`；cursor `~/.cursor`；opencode `~/.local/share/opencode/auth.json`（+ 目录兜底）；dsh `~/.dsh`。

**指定模型的接缝**（F-56 增补）：`ExternalAgentSpec.model?: string`（来自 external.json 条目）。两条组装路径：

1. **ACP 系（kind 'acp'）**：`detectedToSpec` 按 `def.modelArgs(model)` 把 flag 折叠进 `spec.args`（before = protocolArgs 之前 / after = 之后）——模型 flag 的位置差异归模板注册表，适配器无感知；
2. **stream-json / app-server-jsonl**：适配器按 `spec.model` 自行组装（协议知识归适配器）：stream-json 追加 `['--model', model]`；codex 追加 `['-c', 'model=<model>']`。

模型变更生效时机：spec 在 detect 时冻结（工厂闭包），改 external.json 后下次探测/重探测生效。

## 3. external.json schema 扩展

白名单新增三字段（条件展开：无手动信息的条目回读键不增，F-55 旧文件零迁移）：

```json
{ "agents": [
  { "id": "cli:codebuddy", "kind": "acp", "command": "/opt/cb/codebuddy",
    "version": "2.171.0", "tier": "A", "enabled": true, "lastProbeAt": "…",
    "manual": true, "displayName": "CodeBuddy 自建", "description": "本地构建",
    "model": "glm-5.3" } ] }
```

白名单新增四字段（条件展开：无手动信息的条目回读键不增，F-55 旧文件零迁移）：`manual`/`displayName`/`description`/`model`。红线不变（AC-55-9）：白名单外的 token/key/secret 字段读入即丢弃。`model` 空串 = 清除（再注册不带 model 即恢复 CLI 默认模型）。

## 4. 探测合并语义（resolveCommand 四级 + detect 写回）

1. **env**（`DELTA_EXTERNAL_<ID>_PATH`）：probe 失败 → warn 放弃（F-55 既有语义）。
2. **manual 缓存条目**：probe 成功 → `source:'manual'`，version 刷新；**失败 → 保留条目、沿用缓存 version 产出 DetectedAgent**（手动 = 显式意图，不移除不降级）。
3. **探测缓存条目**：probe 失败 → 降级 PATH（F-55 既有语义）。
4. **PATH**：静默探测。

detect 写回时 `manual/displayName/description` 只增不抹：命中刷新 command/version/lastProbeAt，三个手动字段一律沿用既有条目。manual 条目在 resolveCommand 第 2 级必然命中，不会进入「probe 失败 splice」分支。

`upsertManualEntry`（upsert，一个模板一个手动条目）：`templateId` 必须 ∈ KNOWN_AGENTS（否则 `ManualRegisterError('unknown_template')`）；`command` 缺省 = 模板 executable；`displayName` ≤ 100 字、`description` ≤ 500 字；注册时不做版本探测（version 置空，version 沿用规则：覆盖既有手动条目时保留其 version），下次 detect 回填。`removeManualEntry` 只删 `manual:true` 条目。

## 5. 适配器分派与 Tier D stub

`ensureExternalAdapters` 按 `spec.kind` 分派（F-55 的 ACP「工厂待补」警告移除——acp.ts 已实现）：

- `acp` → `AcpExternalAdapter`（启动行 = `command + spec.args(protocolArgs) + permissionArgs[mode]`）
- `reserved` → `ReservedExternalAdapter`（`external/reserved.ts`，~30 行）：`run()` 走正常事件流 yield `{type:'error', fatal:true, message:'external_unsupported_protocol: …'}` + `{type:'done', exitCode:1}`——映射引擎零改动，UI 呈现明确错误（AC-56-4）。

## 6. HTTP 端点（server/http.ts）

| 端点 | 语义 |
|---|---|
| `GET /api/external-agents/templates` | 向导第 1 步：6 模板（id/label/description/executable/kind/tier） |
| `POST /api/external-agents` | 手动注册 upsert；`ManualRegisterError` → 400 `code: message` |
| `DELETE /api/external-agents/:id` | 移除手动条目；非 manual / 不存在 → 404 |
| `GET /api/external-agents`（既有） | 响应扩展：`kind`/`manual`/`displayName`/`description`/`label`/`source:'manual'` |

`ServeOptions` 新增 `externalRegister` / `externalRemove` 注入口（与 `externalDetect` 同口径，测试隔离）。

## 7. Web 两步向导（ExternalAgentsPanel）

- 头部新增「＋ 添加」；弹窗复用 `ModalShell`。
- **第 1 步**：模板网格（2 列卡片：label + executable + Tier 徽标 + description），点选进第 2 步。
- **第 2 步**：基础运行时（锁定只读：label + id + Tier）、显示名称（必填，预填 label）、命令（必填，预填 executable）、模型（可选，hint 说明各 CLI 的 flag 形态）、描述（可选）；400 校验错误就地展示。
- 列表行展示：名称取 `displayName || label || id`；指定模型的条目带 `⚙ model` 徽标；手动条目带「移除」按钮；`kind:'reserved'` 行显示预留提示；手动条目不显示「未检测到登录态」警告（避免注册即红字）。

## 8. CLI（`delta agents`）

`packages/cli/src/agents.ts`：`templates`（列模板）/ `add <templateId> [--command] [--name] [--description] [--model]`（upsert，未知模板打印全部可用 id）/ `list`（external.json 全条目，[手动]/[缓存] 标，含模型）/ `remove <id>`。与 Web 共用 core 的 upsert/remove。

## 9. 实现偏差说明

- **cursor-agent / opencode 未真机跑通**：本机 cursor-agent 二进制损坏（dyld，构建目标 macOS 13.5）、opencode 未安装。协议入口经官方文档核实，适配器复用 F-55 ACP 层；实测结论回填 F-55 §15 兼容性表（待真机验证列）。
- **注册时探一次版本 vs 惰性**：选择注册时不探测（POST 不阻塞 3s），version 由下次 detect 回填——面板首次显示版本为空，属已知简化。
- **同 id 手动 + 探测缓存并存**：resolveCommand 手动优先；detect 写回只更新首个匹配条目，重复条目残留无副作用（下次全量写回收敛）。

## 10. 模块落点与改动清单

| 文件 | 改动 | 量级 |
|---|---|---|
| `core/src/external/types.ts` | `ExternalTier` 加 `'D'`；`kind` 加 `'reserved'` | ~4 行 |
| `core/src/external/reserved.ts` | 新增：Tier D stub 适配器 | ~30 行 |
| `core/src/external/detect.ts` | KnownAgentDef 三字段 + 4 新模板 + 四级优先级 + manual 三字段白名单/写回 + upsert/remove | ~200 行 |
| `core/src/server/http.ts` | templates/POST/DELETE 三端点 + GET 响应扩展 + 两个注入口 | ~60 行 |
| `core/src/index.ts` | 导出 reserved / upsert / remove 等 | ~15 行 |
| `web/src/api/client.ts` | `ExternalAgentInfo` 扩展 + `ExternalAgentTemplate` + 3 个 API 方法 | ~40 行 |
| `web/src/components/settings/ExternalAgentsPanel.vue` | 两步向导 + 手动条目展示/移除 | ~150 行 |
| `cli/src/agents.ts` + `cli/src/index.ts` | `delta agents` 子命令组 | ~120 行 |
| 测试 | `external-register-f56.test.ts`（14 例）+ `external-register-api.test.ts`（4 例） | ~400 行 |

## 11. 测试矩阵

- 模板注册表完整性（6 id、protocolArgs、reserved tier）
- upsert/remove：缺省值、错误码、覆盖语义、白名单剥离 token、model 写入/清除/超长校验
- 探测合并：manual probe 失败保留（AC-56-5）、成功刷新且手动字段保留、手动优先于缓存、非 manual 失效维持 F-55 移除语义
- 指定模型（AC-56-6）：detectedToSpec 三种 flag 放置（codebuddy after / opencode before / claude 走 spec.model）；stream-json 启动行 `--model`（fake-claude argv 断言）；codex 启动行 `-c model=…`（argv-dump fixture 断言）；探测写回 model 沿用
- 适配器分派：codebuddy → ACP（spec.args `--acp`）、dsh → stub（external_unsupported_protocol）
- HTTP：templates 6 条、POST 200/400、DELETE 200/404

## 12. 兼容性

- F-55 旧 `external.json`（无 manual 字段）零迁移直接可用；探测缓存条目行为不变。
- `models list` / `doctor` / 模型选择器走 `cli:` 前缀与 id 匹配，新条目 id 与 F-55 命名规则一致，自动可见。
