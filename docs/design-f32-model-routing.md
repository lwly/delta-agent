# F-32 模型路由 —— 增量技术设计

> 版本：v1.0 ｜ 日期：2026-10-23 ｜ 状态：已实现
> 上游：docs/PRD.md F-32 ｜ 增量 PRD 见 docs/prd-f32-model-routing.md ｜ 本文对应实现细节

---

## 1. 模块与文件清单

| 文件 | 类型 | 职责 |
|------|------|------|
| `packages/core/src/llm/keychain.ts` | 改 | `RoutingRule` / `RoutingConfig` 类型；`ModelsFile.routing?` 字段；`loadModelsFile` 容错校验 |
| `packages/core/src/llm/router.ts` | 新 | `ModelRouter`（resolve / config）+ `KNOWN_TASK_KINDS` |
| `packages/core/src/llm/manager.ts` | 改 | `ProviderManager.getRouting()` / `setRouting()`（写入前校验） |
| `packages/core/src/server/hub.ts` | 改 | `SessionHubDeps.modelRouter` / `resolveProviderById`；`routeAux(kind)`；distill 接线 |
| `packages/core/src/index.ts` | 改 | 导出 ModelRouter / 类型 |
| `packages/cli/src/index.ts` | 改 | serve 装配路由器；`models routing` 五个子命令 |
| `packages/core/test/router.test.ts` | 新 | 9 例单测 |

---

## 2. 数据结构（keychain.ts）

```ts
/** F-32 单条路由规则：某类辅助任务使用的目标模型（provider 缺省 = 会话主 Provider） */
export interface RoutingRule {
  provider?: string;   // 须已在 providers 中配置且启用
  model: string;       // 目标模型 id，非空
}

export interface RoutingConfig {
  enabled: boolean;    // 总开关
  rules: Record<string, RoutingRule>;
}

export interface ModelsFile {
  version: 1;
  providers: StoredProvider[];
  routing?: RoutingConfig;   // 可选；旧文件无此字段 = 未启用路由
}
```

**loadModelsFile 容错（all-or-nothing）**：`version === 1 && providers` 合法的前提下，routing 仅当 `enabled` 为 boolean、`rules` 为非数组对象、且**每条**规则 model 为非空字符串时才保留；否则整体丢弃 routing、保留 providers。单测覆盖「model 类型错误 → 整块忽略且 providers 可读」。

> 写入侧 `setRouting()` 逐条校验 model 非空，非法即抛错——CLI 写出的文件必然通过 load 校验；all-or-nothing 只为兜住手工编辑。

---

## 3. ModelRouter（router.ts）

```ts
export const KNOWN_TASK_KINDS = ['distill', 'classify', 'summarize'] as const;
export type RoutingTaskKind = ...;          // 已知 kind + 任意 string 扩展
export interface RoutedTarget { provider?: string; model: string; kind: string; }
```

- `resolve(kind)`：读配置 → `enabled` 为假返回 undefined → 取 `rules[kind]`，缺 / model 空返回 undefined → 返回目标（provider 空 / 空白归一为 undefined = 跟随主 Provider）
- `config()`：透出当前配置（CLI `models routing` 展示用）
- 构造器 `file?`：DI 覆盖配置路径，测试用临时文件（沿用 keychain-manager.test.ts 的 tmpfile 模式；vitest worker 中 HOME hack 不可靠的既有坑见 F-04a 记录）

---

## 4. 运行时接线（hub.ts）

### 4.1 依赖注入

```ts
export interface SessionHubDeps {
  ...
  /** F-32 模型路由器（缺省不路由：辅助调用跟随会话主模型） */
  modelRouter?: ModelRouter;
  /** F-32 按 provider id 构建 LLM 实例（缺省复用 resolveProvider） */
  resolveProviderById?: (id: string) => Promise<LLMProvider>;
}
```

CLI `serve` 装配：

```ts
const hub = new SessionHub({
  ...
  resolveProvider: () => resolveProviderFromEnv(undefined),
  modelRouter: new ModelRouter(),                       // 每次运行即时读文件，设置后即时生效
  resolveProviderById: (id) => resolveProviderFromEnv(id),
});
```

`resolveProviderFromEnv(id)` 传入显式 id 时走「env key → 存储配置」既有链路，与主 provider 同源，天然兼容加密 Key。

### 4.2 routeAux 与回退矩阵

```ts
private async routeAux(kind): Promise<{ provider, model } | undefined>
```

| 场景 | 行为 |
|------|------|
| 未注入 modelRouter | undefined → 主模型 |
| routing 未配置 / enabled=false | undefined → 主模型 |
| kind 无规则 / model 空白 | undefined → 主模型 |
| rule.provider 指定且构建成功 | 目标 provider + 规则 model |
| rule.provider 缺省 | 主 provider + 规则 model |
| provider 构建抛错（未配置 / 解密失败 / 网关 id 无配置） | 捕获 → undefined → 主模型，**不向主任务传播** |

### 4.3 distill 接入点（hub.ts `done` 分支）

```ts
const routed = await this.routeAux('distill');
void distillMemories(service.memory, routed?.provider ?? provider, routed?.model ?? ctx.model, {...})
  .catch(() => undefined);
```

`routeAux` 在此处 await（provider 构建为异步动态 import），随后的提炼仍是 fire-and-forget；abort 信号照旧透传。其余主链路调用点（planner / reviewer / react / plan-execute / 压缩摘要）**一律不动**——决议 #10 口径。

---

## 5. CLI 子命令（cli/src/index.ts）

| 命令 | 行为 |
|------|------|
| `models routing` | 展示开关状态 + 规则表（`kind → model @ provider`）；未配置时空态提示 |
| `models routing-set <kind> <model> [--provider <id>]` | 读现有配置（无则 `{enabled:true, rules:{}}`）→ 写规则 → 强制 `enabled=true` |
| `models routing-remove <kind>` | 删规则；目标不存在时非零退出 |
| `models routing-on` | 启用；无任何规则时拒绝并提示先 set |
| `models routing-off` | 停用（保留规则，可再 on） |

实现全部走 `ProviderManager.getRouting()/setRouting()`，与 providers CRUD 共用同一文件读写（互不覆盖，单测覆盖「setDefault 后 routing 仍在」）。

---

## 6. 测试矩阵（test/router.test.ts，9 例）

| 组 | 用例 |
|----|------|
| ModelRouter | 无配置文件 / 无 routing 字段 → undefined；enabled=false → undefined；命中规则含 provider / 缺省 provider；未知 kind → undefined；blank model → undefined |
| 容错 | model 类型非法 → 整块 routing 忽略且 providers 正常读出 |
| ProviderManager CRUD | setRouting 往返 + undefined 清除；空 model 抛错；与 provider CRUD（add / setDefault）同文件共存不互踩 |

**已知环境坑（与本特性无关但影响验证）**：本机 `better-sqlite3@11.10.0` 原生绑定缺失（prebuild 未落盘），sqlite 相关 131 例会以 `Could not locate the bindings file` 挂掉。修复：在包目录执行 `npx prebuild-install`（或 `npm run build-release`）重建 `build/Release/better_sqlite3.node`。另：WorkBuddy 注入的 `NODE_OPTIONS` shim 会使 vitest SIGSEGV，本地跑测用 `NODE_OPTIONS= pnpm test`（F-30 设计文档 §9 已记录）。

---

## 7. 时序（任务结束的提炼路由）

```
runReAct done ─▶ SessionHub
                  ├─ routeAux('distill')
                  │    ├─ ModelRouter.resolve('distill')      ← models.json（每次即时读）
                  │    ├─ 命中 → resolveProviderById(rule.provider)（未指定则复用主 provider）
                  │    └─ 任一步失败 → undefined（回退）
                  └─ distillMemories(memory, routed?.provider ?? 主provider,
                                                routed?.model ?? ctx.model, …)  // fire-and-forget
```

---

## 8. 后续演进位（本期不实现）

1. **按难度自动分类**：新增 `classify` 接入点（会话首输入 → 分类器选 execute 档模型），kind 体系与路由器零改动
2. **Web 设置页**：设置中心增「模型路由」卡片，HTTP 层包 `getRouting/setRouting` 即可
3. **usage 归因**：distill 调用上报带 `kind` 的 usage 行，F-31 报表增「辅助调用」分组
4. **子代理模型路由**：`tools/builtin/task.ts` 的 `ctx.subagent.model` 可按 `subagent` kind 路由
