/**
 * Skill Hub 内置目录（seed catalog）
 *
 * 10 个真实可用的技能模板，供「Skill Hub」面板浏览 / 预览 / 一键安装到
 * 用户级或项目级 skills 目录。frontmatter 由安装时 serializeSkillMd 生成，
 * 此处只保存结构化字段（body 为 SKILL.md 正文，有干货的中文实操指导）。
 */

export interface HubEntry {
  /** Skill 名称（目录名，需通过 validateConfigName 校验） */
  name: string;
  /** 一句话描述（何时使用该技能） */
  description: string;
  /** 分类标签（代码质量 / 提交协作 / 测试 / 设计 / 文档 / 性能） */
  category: string;
  /** 语义化版本 */
  version: string;
  /** 作者 */
  author: string;
  /** 触发关键词（2–4 个，中英文混合） */
  triggers: string[];
  /** 工具白名单（与 core ToolRegistry 内置工具名一致） */
  toolsAllowlist: string[];
  /** SKILL.md 正文（Markdown 实操指导） */
  body: string;
}

export const SEED_SKILLS: HubEntry[] = [
  {
    name: 'code-review',
    description: '按结构化清单对当前改动做代码审查，输出分级问题报告（阻塞/建议/风格）',
    category: '代码质量',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['review', '审查', 'code review', '帮我看看代码'],
    toolsAllowlist: ['read_file', 'grep_search', 'glob_search', 'list_dir'],
    body: `# 代码审查清单

对目标改动（未指定时用 \`git diff\` 或最近修改的文件）逐条执行以下清单，最后输出分级报告。

## 流程

1. **圈定范围**：确定本次审查涉及的文件与改动意图（commit message / PR 描述 / 用户说明）。
2. **通读一遍**：先不改细节，理解整体设计是否合理、是否遗漏边界场景。
3. **逐文件细查**：按下述清单逐项核对，每发现一个问题记录【文件:行号 + 问题描述 + 建议修法】。

## 检查清单

### 正确性（阻塞级）
- [ ] 空值 / undefined / 越界 / 并发竞态是否处理
- [ ] 错误处理是否吞异常（catch 后不记日志不上抛）
- [ ] 边界条件：空集合、超长输入、并发重复提交
- [ ] 事务/一致性：多次写操作是否需要原子性

### 安全（阻塞级）
- [ ] 用户输入是否直接拼接 SQL / shell / HTML
- [ ] 密钥、token 是否硬编码或写进日志
- [ ] 权限校验是否在服务端强制执行

### 可维护性（建议级）
- [ ] 单函数是否超过 ~60 行、嵌套超过 3 层
- [ ] 命名是否表意（禁止 data2、tmp、foo）
- [ ] 重复逻辑是否应抽函数/模块

### 风格（可后续批量处理）
- [ ] 与项目既有 lint/格式规则是否一致

## 输出格式

\`\`\`
## 审查报告：<范围>
### 🔴 阻塞（必须修）
- file.ts:42 — 说明 + 建议修法
### 🟡 建议
### 🟢 风格
### 总结
总体评价 1–2 句 + 优先修复顺序。
\`\`\`

## 注意

- 不要为了凑数报不重要的问题；没有问题的分区写「未发现」。
- 对不确定的设计取舍，标注「需人工确认」而不是直接下结论。`,
  },
  {
    name: 'commit-message',
    description: '按 Conventional Commits 规范生成约定式提交信息，自动判断 type 与 scope',
    category: '提交协作',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['commit', '提交信息', 'commit message'],
    toolsAllowlist: ['run_command', 'read_file', 'grep_search'],
    body: `# 约定式提交（Conventional Commits）

根据 staged diff（或用户描述的改动）生成规范提交信息。

## 格式

\`\`\`
<type>(<scope>?): <subject>

<body?>

<footer?>
\`\`\`

## type 枚举（只允许以下取值）

| type | 含义 |
|------|------|
| feat | 新功能 |
| fix | 缺陷修复 |
| refactor | 重构（不改行为） |
| perf | 性能优化 |
| test | 测试相关 |
| docs | 文档 |
| style | 格式（不改逻辑） |
| build | 构建/依赖 |
| ci | CI 配置 |
| chore | 杂项维护 |

## 生成步骤

1. \`git diff --staged --stat\` 了解涉及文件；必要时 \`git diff --staged\` 看关键 hunk。
2. 判断主 type：以「本次改动的主要意图」为准（一个 feat 里顺手修的 bug 在 body 里提，不拆两条）。
3. scope 取受影响模块名（如 core / web / server），跨多模块时省略 scope。
4. subject：中文或英文均可，祈使句、不超过 50 字符、结尾不加句号。
5. body（可选）：解释「为什么改」，而不是复述 diff「改了什么」；每行不超过 72 字符。
6. 破坏性变更：footer 加 \`BREAKING CHANGE: <说明>\`，且 subject 后加 \`!\`。

## 示例

\`\`\`
fix(server): 修复会话删除时 SSE 订阅未取消导致的内存泄漏

removeSession 只清了 DB 记录，hub 侧 subscribe 缓存仍持有回调。
改为在 removeSession 内统一调用 hub.unsubscribeAll(sessionId)。
\`\`\`

## 注意

- 不要生成「update code」「fix bug」这类无信息量的 subject。
- 单条提交应单一意图；发现混入无关改动时提醒用户拆分（\`git add -p\`）。`,
  },
  {
    name: 'test-writer',
    description: '为指定模块编写单元测试：分析分支覆盖、构造边界用例、遵循既有测试风格',
    category: '测试',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['test', '单测', '写测试', 'unit test'],
    toolsAllowlist: ['read_file', 'glob_search', 'grep_search', 'write_file', 'run_tests'],
    body: `# 单元测试编写流程

为指定模块（未指定时请用户澄清）编写高质量单测。

## 步骤

1. **读懂被测对象**：读源码，列出所有分支：正常路径 / 异常路径 / 边界值 / 幂等重入。
2. **找范式**：用 glob_search 找同目录既有 \`*.test.ts\`，沿用其框架（vitest/jest）、目录约定与命名风格（\`describe('被测函数', ...)\` + 中文用例描述）。
3. **写用例**，优先级从高到低：
   - 核心正常路径（每个导出函数至少 1 条）
   - 每个显式抛错分支各 1 条（\`expect(...).rejects.toThrow()\` / \`expect(() => ...).toThrow()\`）
   - 边界：空输入、0、负数、超长、Unicode、并发
   - 回归：如果是在修 bug，先写复现测试再修
4. **隔离外部依赖**：文件系统用 \`fs.mkdtemp(os.tmpdir())\`；时间用注入时钟；网络 mock 掉。测试之间不得共享可变状态。
5. **运行验证**：执行项目测试命令，确保全绿；失败先怀疑测试自身（断言错、异步没等），再怀疑源码。

## 用例命名模板

\`\`\`ts
it('<条件> 时 <期望行为>（<为什么>）', async () => { ... });
// 例：it('scope=project 而 projectId 无效时返回 404（权限边界）', ...)
\`\`\`

## 红线

- 禁止为凑覆盖率写「expect(true).toBe(true)」式废测试。
- 禁止修改被测源码让测试通过（除非明确是修 bug 任务）。
- mock 只 mock 边界（fs/net/时钟），不 mock 被测函数内部逻辑。`,
  },
  {
    name: 'refactor',
    description: '在保证行为不变的前提下执行安全重构：识别坏味道、小步快跑、每步可验证',
    category: '代码质量',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['refactor', '重构', '优化结构'],
    toolsAllowlist: ['read_file', 'edit_file', 'write_file', 'grep_search', 'glob_search', 'run_command', 'run_tests'],
    body: `# 安全重构流程

目标：改善内部结构，**外部行为完全不变**。

## 前置条件（不满足先补齐，不做裸重构）

1. 确认目标模块有测试覆盖；没有就先按 test-writer 流程补「特征测试」钉住现状。
2. 跑一遍测试确认基线全绿，记下耗时（重构后对比防意外变慢）。

## 坏味道识别（按收益排序）

- **重复代码**：出现 ≥3 次的相同逻辑 → 抽函数/模块
- **超长函数**：>60 行或嵌套 >3 层 → 提取小函数，用意图命名
- **散弹式修改**：一个需求要改 N 处 → 收拢到单一模块
- **数据泥团**：总是一起传的参数 → 聚成对象
- **发散/霰弹式条件**：switch 在多处重复 → 多态或查表

## 执行纪律（小步快跑）

1. 每次只做**一种**重构手法（提取函数 / 内联函数 / 移动模块 / 改名…）。
2. 每步完成立即跑测试；红了立刻回滚这一步（\`git checkout -- <file>\`），不要在红色状态上继续堆改动。
3. 改名用工具/编辑器全局重构能力，禁止手改漏改。
4. 保持提交粒度：一个重构手法一个 commit，方便逐条 review 与回滚。

## 禁区

- 重构与新功能/修 bug 混在同一批改动里。
- 借「重构」之名改变 API 行为或删除「看起来没用」的代码（先确认调用方）。
- 对无测试、无类型、无调用的三方代码做大规模改动。`,
  },
  {
    name: 'api-design',
    description: '设计或评审 REST API：资源建模、状态码、错误结构、分页与版本化规范',
    category: '设计',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['api', '接口设计', 'REST', 'api design'],
    toolsAllowlist: ['read_file', 'glob_search', 'grep_search', 'write_file'],
    body: `# REST API 设计规范

为给定业务设计新端点，或按本规范评审既有端点。

## 资源建模

- URL 用**名词复数**：\`/api/projects\`、\`/api/projects/:id/sessions\`
- 层级表达从属关系，但不超过两层嵌套：过深改用查询参数 \`?projectId=\`
- 动作用子资源表达非 CRUD 语义：\`POST /api/sessions/:id/abort\`

## 方法与状态码

| 场景 | 方法 | 成功码 |
|------|------|--------|
| 列表 | GET | 200 |
| 详情 | GET | 200（无 → 404） |
| 创建 | POST | 200/201 |
| 全量/部分更新 | PUT / PATCH | 200 |
| 删除 | DELETE | 200/204 |

- 400 参数校验失败；401 未认证；403 无权限；404 不存在；409 冲突（如「会话运行中」）；500 兜底。
- 错误响应统一结构：\`{ "error": "<人可读中文说明>" }\`，说明里写清**怎么修**。

## 请求/响应约定

- 字段命名与项目现状一致（本项目 REST 层 snake_case / 内部 camelCase 混合时，端点内保持一致并注释）。
- 列表分页：\`?limit=&offset=\`（或 cursor），响应带总数；默认 limit ≤ 100 防拖垮。
- 时间一律 ISO 8601 字符串（UTC）。

## 版本与兼容

- 加字段 = 兼容变更（直接加）；改字段语义/删字段 = 破坏性（需新版本或迁移期双读）。
- 服务端对客户端传参要做**宽容读取、严格校验**：未知字段忽略，已知字段类型不对就 400。

## 检查清单（评审用）

- [ ] 每个端点是否可从 URL + 方法推断出意图
- [ ] 错误路径是否都有测试覆盖
- [ ] 是否有未鉴权的写端点
- [ ] 列表端点是否限制了默认分页大小`,
  },
  {
    name: 'bug-triage',
    description: '系统化定位 Bug：从复现到根因的最短路径，输出定位链与修复建议',
    category: '测试',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['bug', '排查', '定位问题', 'triage'],
    toolsAllowlist: ['read_file', 'grep_search', 'glob_search', 'run_command', 'run_tests'],
    body: `# Bug 定位流程（复现 → 二分 → 根因）

## 1. 先复现，再动手

- 拿到最小复现步骤：输入是什么、期望 vs 实际、是否必现。
- 不能复现的：问清环境（OS / 版本 / 数据 / 并发量），先修「不可复现」本身（加日志、要求录屏）。

## 2. 定位链（从现象往回推）

1. **错误信息全文**读一遍（含堆栈最上层用户帧，不要只看第一行）。
2. 确认故障层：前端显示问题？接口返回错？服务端逻辑错？数据错了？—— curl/直接查库逐层排除。
3. **二分历史**：\`git log --oneline\` + \`git bisect\` 找引入点；「上周还好」的 bug 几乎都能 bisect。
4. **二分代码**：在嫌疑链路上加日志或断点，缩小到具体函数 → 具体行。
5. 提出根因假设，用实验证实/证伪（改一行、跑一次，变量唯一）。

## 3. 常见陷阱

- **先入为主**：第一个看起来可疑的点往往不是根因，修完症状还在就要回头。
- **修症状不修根因**：catch 住异常 = 藏雷；要在源头修。
- **环境差异**：本地好的生产坏 → 先 diff 配置/依赖/数据形态，别急着改代码。

## 4. 收尾

- 修复前先写一个**失败的复现测试**，修复后转绿（防止回归）。
- 输出定位链：\`现象 → 排除了 A/B → 锁定 C → 根因是 D → 修复方式 E\`，供 review 与复盘。`,
  },
  {
    name: 'sql-review',
    description: '审查 SQL 与表结构变更：索引、锁、注入、迁移安全，逐项给出依据',
    category: '代码质量',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['sql', '数据库', 'sql review', '慢查询'],
    toolsAllowlist: ['read_file', 'grep_search', 'glob_search', 'run_command'],
    body: `# SQL 审查清单

对新增/变更的 SQL、ORM 查询与 DDL 迁移逐项核对。

## 查询类

- [ ] **索引**：WHERE / JOIN / ORDER BY 涉及的列是否有可用索引；复合索引遵循最左前缀。
- [ ] **全表扫描**：大表上禁用无索引条件 + \`SELECT *\`；只取需要的列。
- [ ] **N+1**：循环内逐条查询 → 合并为 IN / JOIN / 批量接口。
- [ ] **分页**：大 offset 深翻页性能差 → 游标分页（WHERE id > last_id LIMIT n）。
- [ ] **模糊查询**：前置通配 \`LIKE '%x'\` 必然全扫 → 全文索引或限定前缀。
- [ ] **事务**：多写操作包事务；事务内禁止网络调用/长等待（锁放大）。
- [ ] **注入**：一律参数化查询，禁止字符串拼接（含 ORDER BY / 表名的动态部分 → 白名单映射）。

## DDL / 迁移类（线上表尤其小心）

- [ ] 加列：给默认值或允许 NULL，避免全表重写（视数据库实现）。
- [ ] 加索引：用 CONCURRENTLY / ONLINE 方式（如支持），避开高峰。
- [ ] 改列类型/收窄长度：先确认存量数据兼容。
- [ ] 删列：两段式——先停用（代码不再读写）→ 观察期 → 再物理删除。
- [ ] 每个迁移必须提供可回滚路径，并在预发/数据量相近环境演练过。

## 输出格式

每个问题一条：\`【级别 阻塞/建议】位置 — 问题 + 依据（为什么慢/危险）+ 建议写法示例\`。
没有把握的执行计划，建议用户先 \`EXPLAIN\` 验证，不要拍脑袋。`,
  },
  {
    name: 'docs-writer',
    description: '撰写面向读者的项目文档：README/API 说明/指南，强调可运行示例',
    category: '文档',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['docs', '文档', '写文档', 'readme'],
    toolsAllowlist: ['read_file', 'glob_search', 'write_file', 'run_command'],
    body: `# 技术文档撰写指南

## 动笔前先回答三个问题

1. **读者是谁**：新人上手 / 日常查阅 / 运维部署 —— 决定详略与术语量。
2. **读完能做什么**：每篇文档定义一个「成功标准」（如：5 分钟内跑通 Hello World）。
3. **放在哪**：README（入口）/ docs/（专题）/ 代码内注释（局部），不重复维护同一内容，互相链接。

## 结构模板（指南类）

\`\`\`markdown
# <主题>
## 简述（一段话：是什么 + 什么时候用）
## 快速开始（复制即可运行的完整示例）
## 核心概念（3 个以内，每个配图或示例）
## 常见用法（按场景组织小节）
## FAQ / 故障排查
## 参考（链接到 API 文档 / 源码）
\`\`\`

## 硬性要求

- **示例必须真实可运行**：写完后实际执行一遍；粘贴的输出与命令版本一致。
- **先「做」，再「解释」**：Quick Start 里不塞设计原理，原理放后文或链接。
- 命令、路径、代码用代码块；占位符统一 \`<大写>\`（如 \`<PROJECT_ID>\`）并解释如何取得。
- 中文文档使用中文标点；中英文之间加空格。
- 与代码同步：改了行为必查文档；文档里的接口签名以代码为准。

## 自查

- [ ] 新人按文档从头做一遍能否成功（最好真找一次）
- [ ] 每个代码块是否标了语言（\`\`\`ts / \`\`\`bash）
- [ ] 截图/示例是否与当前版本一致（过期截图比没有更糟）`,
  },
  {
    name: 'perf-tips',
    description: '性能问题排查：先测量后优化，CPU/内存/IO/渲染四象限定位法',
    category: '性能',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['性能', '慢', '优化', 'perf'],
    toolsAllowlist: ['read_file', 'grep_search', 'run_command', 'run_tests'],
    body: `# 性能排查流程

铁律：**先测量，后优化**。没有 profile 数据的优化都是猜。

## 1. 定义指标

- 慢在哪：接口 P95？页面首屏？构建时间？内存占用？
- 量化目标：如「P95 从 3s 降到 500ms」，否则无法验收。

## 2. 测量工具（Node/前端常用）

- **CPU**：\`node --cpu-prof\` / Chrome DevTools Performance → 找热点函数（self time 排序）
- **内存**：\`node --heap-prof\` / heap snapshot diff（两次快照看增长对象）
- **IO**：网络面板看请求数与瀑布；DB 用慢查询日志 + EXPLAIN
- **前端渲染**：Performance 面板录制的 Long Task / Layout Shift

## 3. 常见根因速查

| 症状 | 高频根因 |
|------|----------|
| 接口慢 | N+1 查询、缺索引、串行可并行化、无缓存的重复计算 |
| 内存涨 | 未取消的监听器/定时器、大数组常驻、闭包持有大对象 |
| 页面卡 | 长任务阻塞主线程、频繁强制重排、过大列表未虚拟化 |
| 构建慢 | 全量 typecheck 重复执行、依赖被重复打包、无缓存 |

## 4. 优化纪律

1. 每次只改一处，改完重测同一指标，记录前后数据。
2. 算法/数据结构优化 > 缓存 > 微优化（微优化通常不值得牺牲可读性）。
3. 优化完成后留下基准测试（bench 脚本或 perf 测试），防止回退。
4. 无效优化果断回滚，不留半吊子复杂度。`,
  },
  {
    name: 'git-flow',
    description: 'Git 协作工作流：分支策略、rebase/merge 选择、冲突解决与紧急回滚',
    category: '提交协作',
    version: '1.0.0',
    author: 'delta-agent',
    triggers: ['git', '分支', '合并', 'rebase'],
    toolsAllowlist: ['run_command', 'read_file'],
    body: `# Git 工作流速查

## 分支模型

- \`main\`：随时可发布，受保护，只经 PR 合入。
- 功能分支：\`feat/<短名>\` / \`fix/<短名>\`，从 main 切出，生命周期 ≤ 数天，越小越好。
- 长期分支（release/hotfix）仅在真有多版本维护需求时引入，否则一律省略。

## 日常操作

\`\`\`bash
# 开工前同步（rebase 本地未推送提交，保持线性）
git fetch origin && git rebase origin/main

# 提交粒度：一个意图一个 commit；暂存部分文件用
git add -p

# 已推送之前整理历史（仅在未推送时）
git rebase -i HEAD~3

# 功能完成合入：优先 squash（保持 main 历史一功能一提交）
\`\`\`

## rebase vs merge

- **个人未推送分支**：rebase，历史线性。
- **多人共享分支 / main**：merge（squash merge），禁止 rebase 已公开提交。
- 铁律：**rebase 只对只有自己有的提交做**。

## 冲突解决

1. \`git status\` 列出冲突文件，逐个处理 \`<<<<<<< ======= >>>>>>>\`。
2. 语义理解两边意图后合并，不要无脑「取我的/取他的」。
3. 解决完跑测试，再 \`git add\` + \`git rebase --continue\`。

## 紧急回滚

- 已推送的错误提交：\`git revert <sha>\`（生成反向提交，安全）。
- 本地未推送：\`git reset --hard origin/main\`。
- **禁止**对共享分支 \`push --force\`；确需强推用 \`--force-with-lease\`。
- 线上事故先 revert 回滚止血，再慢慢排查根因修复。`,
  },
];

/** 内置目录（name → entry），供 O(1) 查找 */
const BUILTIN_INDEX = new Map(SEED_SKILLS.map((s) => [s.name, s]));

/** 按名称查找内置 seed 技能 */
export function findBuiltinHubEntry(name: string): HubEntry | undefined {
  return BUILTIN_INDEX.get(name);
}
