# y-zero-agent 记忆系统设计（三层记忆）

> 版本：v1.0 ｜ 日期：2026-10-21 ｜ 参考：PaiCLI 三层记忆方案 ｜ 关联：technical-design.md §5/§6

---

## 1. 设计目标

让 Agent"越用越懂你"：当前对话不丢上下文（短期），个人偏好与项目经验可沉淀复用（动态），团队共识与项目规则版本化共享（静态）——**短期管当前，动态记个人，静态记项目**。

## 2. 三层架构

```
┌────────────────────────────────────────────────────────┐
│ L1 短期记忆 · 消息列表（内存）                            │
│    当前会话 · 上下文窗口内 · 快速变化 · 随压缩滚动         │
├────────────────────────────────────────────────────────┤
│ L2 长期动态记忆 · SQLite（memories 表）                   │
│    用户私有 · 项目隔离 · 可检索 · 高频变更                │
│    内容：偏好、经验、决策、踩坑记录、代码约定              │
├────────────────────────────────────────────────────────┤
│ L3 长期静态记忆 · MEMORY.md / .y-zero/agent.md（文件）    │
│    项目规则 · 团队共享（git 版本追踪） · 低频变更          │
└────────────────────────────────────────────────────────┘
   从稳定到即时 ↑          长期信息支撑当前对话 ↓
```

### 2.1 静态 vs 动态分工

| 维度 | L3 静态记忆（MD 文件） | L2 动态记忆（SQLite） |
|------|----------------------|---------------------|
| 存储方式 | 文件（`MEMORY.md`、`.y-zero/agent.md`） | 数据库（`memories` 表） |
| 变更频率 | 低（人工/评审后修改） | 高（Agent 运行中自动读写） |
| 共享范围 | 团队共享（随 git 提交） | 用户私有 / 项目隔离 |
| 适用场景 | 项目规则、编码规范、架构共识 | 个人偏好、历史经验、任务上下文 |
| 修改者 | 人为主（Agent 建议草案 → 人确认） | Agent 自动 + 工具显式 |

**组合结论：静态记团队共识，动态记个人经验。**

## 3. 数据模型（SQLite）

```sql
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,          -- uuid
  scope       TEXT NOT NULL,             -- 'global' | 'project:<id>' | 'session:<id>'
  kind        TEXT NOT NULL,             -- 'preference' | 'fact' | 'decision' | 'pitfall' | 'workflow'
  content     TEXT NOT NULL,             -- 记忆正文（一句话一条）
  keywords    TEXT,                      -- 空格分词索引（无分词器方案的检索键）
  importance  REAL DEFAULT 0.5,          -- 重要性 0-1（写入时模型自评）
  confidence  REAL DEFAULT 0.8,          -- 置信度 0-1（来源越直接越高）
  access_count INTEGER DEFAULT 0,        -- 被召回次数
  last_access_at INTEGER,
  content_hash TEXT NOT NULL,            -- SHA256(content)，去重键
  source      TEXT,                      -- 'tool' | 'auto-distill' | 'user'
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER                    -- 软删除（淘汰进回收站）
);
CREATE INDEX idx_mem_scope ON memories(scope, deleted_at);
CREATE INDEX idx_mem_hash  ON memories(content_hash);
```

**token 估算（无分词器快速估算）**：中文 ≈ 1 token/字，英文 ≈ 3 chars/token；用于配额检查与压缩触发的估算，代价 O(n) 无依赖。
**配额**：默认每 scope 512 条 / 约 64k token，可配；另为系统与回复预留 **1024 token** 安全空间。

## 4. 写入管线（save_memory）

```
① save_memory 触发（工具调用 / 会话结束自动提炼）
        ↓
② SHA256 去重：content_hash 已存在 → 停止（命中则合并来源、confidence 取最大）
        ↓
③ 配额检查：未超额 → 直接写入
        ↓ 超额
④ 淘汰选择：候选集合按 FIFO 取"最旧一批"，
   再按 importance 升序排列 → 淘汰低价值项（进软删除回收站）
        ↓
⑤ 写入 SQLite，返回保存成功 + 淘汰明细
```

> 口诀：**先去重，再查配额，必要时淘汰低价值旧记忆。**

写入来源双通道：
- **显式**：`save_memory` 内置工具（模型在对话中判断"值得记"时调用，需带 kind/importance 自评）
- **自动提炼**：会话结束/压缩时，后台用小模型从本会话提炼 0–3 条候选，**进"待确认"队列**（Web 通知用户一键采纳，避免记忆污染）。**默认开启**（`memory.autoDistill: true`，可在设置中关闭）

## 5. 召回评分（recall_memory）

每轮对话开始 + 用户输入包含明确指代（"上次""之前"）时触发召回，取 Top-K（默认 5）注入动态 Prompt：

```
score = 0.72 × 词汇覆盖率      ← 记忆 keywords/content 与当前查询的匹配度（核心指标）
      + 0.12 × importance      ← 记忆本身重要程度
      + 0.08 × confidence      ← 越可信越值得参考
      + 0.06 × 时间衰减        ← 半衰期 30 天，越久越低
      + 0.02 × 访问频率        ← 常用记忆值得召回（log 归一化）
```

- 词汇覆盖率：查询与记忆的 token 集合 Jaccard + 关键词命中加权（无分词器：中文按字 bigram + 英文按词）
- 召回即反馈：被召回的记录 `access_count += 1`、刷新 `last_access_at`（喂养时间衰减与频率项）
- 阈值：score < 0.25 不召回，避免噪声

> 口诀：**相关性占主导，重要性与时效性共同校正。**

## 6. 与上下文压缩的协作（参数对齐）

压缩器（technical-design §6）参数统一为：

| 参数 | 值 | 说明 |
|------|----|------|
| 触发阈值 | **80%** | 上下文使用达窗口 80% 触发压缩 |
| 压缩目标 | **55%** | 压缩后控制在窗口 55% 左右 |
| 安全预留 | **1024 token** | 为系统提示与回复预留 |
| 保留区 | **最近 6 轮** 原文 | 消息边界切割，不截断半轮 |
| 工具结果截断 | **4000 字** | 超长工具输出截断后进滚动摘要 |
| 摘要方式 | 滚动摘要 | 与已有摘要合并重写，不重复堆叠 |

单次压缩比 ≈ (80−55)/80 ≈ 31%；长会话经多轮滚动摘要累计，**等效压缩率 70%–80%**（相对完全不压缩的累计 token）。

## 7. Prompt 集成（静态/动态分工 + 模式切换）

与 7 层提示词组装（technical-design §5）对齐：

```
静态 Prompt（稳定内容，缓存复用）          动态 Prompt（每轮更新）
├─ L1 Identity 人格/安全基线              ├─ 当前时间 / 环境
├─ L2 Environment 行为准则               ├─ 模型信息
├─ L3 Project 项目指令（含 L3 静态记忆）   ├─ L2 记忆召回块（Top-K）
└─ L4 Tools 工具清单                      └─ Skill 索引
        │
        ▼ 缓存复用（内容 hash 命中则直接复用组装结果，未命中才重组装）
   Prompt Builder（组装/去重/裁剪/格式化）
        ↓ 最后追加
   模式提示词：Plan 模式 │ ReAct 模式 │ Multi-Agent 模式
```

> 口诀：**稳定内容复用缓存，动态信息按轮注入，模式提示最后切换。**
> 收益：静态块对应 LLM Provider 的 prompt cache 前缀（Anthropic/OpenAI 均支持），命中可降低输入费用与首字延迟。

## 8. 记忆生命周期与治理

| 环节 | 策略 |
|------|------|
| 查看 | Web 控制台"记忆"面板：按 scope/kind 列表、score 预览、来源、访问统计 |
| 编辑 | 用户可手动修改/置顶（importance=1）/停用 |
| 恢复 | 淘汰项进回收站（复用软删除机制，30 天） |
| 冲突 | 同类事实新旧冲突 → 保留新、旧条降 confidence 至 0.3 并标注 superseded_by |
| 导出 | `agent memory export > memories.json`（可迁移、可备份） |
| 隔离 | global / project / session 三级 scope 严格隔离，召回时按当前 scope 逐级向上合并 |

## 9. 接口摘要

```typescript
interface MemoryService {
  save(input: { scope: string; kind: string; content: string;
                importance?: number; confidence?: number }): SaveResult;  // 走 §4 管线
  recall(query: string, scope: string, k?: number): MemoryHit[];        // 走 §5 评分
  list(filter: { scope?: string; kind?: string }): MemoryItem[];
  update(id, patch: Partial<MemoryItem>): void;
  remove(id: string, hard?: boolean): void;        // 软删/硬删
  listTrash(scope?: string): MemoryItem[];
  distill(sessionId: string): Promise<MemoryProposal[]>;  // 自动提炼候选（待确认）
}
```

内置工具由 11 个扩展至 **13 个**：新增 `save_memory`、`recall_memory`（均标记 `safe`，免确认）。

## 10. 里程碑归属

- M1（Agent 核心）：L1 短期 + token 估算 + 压缩参数（§6）——压缩器本就依赖此设计
- M2（接入层）：Prompt 静态/动态缓存分工（§7）
- M3（提示词体系）：L3 静态记忆接入 MemoryLayer + L2 动态记忆 MVP（写入管线 + 评分召回）
- M4（Web 控制台）：记忆管理面板 + 自动提炼待确认队列
